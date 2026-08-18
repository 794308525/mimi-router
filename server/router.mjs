import { randomUUID } from "node:crypto";
import { getAdaptiveFirstTokenTimeout, getProvider, getRequest, getRouterSettings, listRoutes, publicProvider, resolveModelPricing } from "./db.mjs";
import { getSecret } from "./secrets.mjs";
import { DEFAULT_MODEL } from "./constants.mjs";
import { calculateOfficialCost } from "./pricing.mjs";
import { fetchWithNetworkTiming, networkTimingForError } from "./network-timing.mjs";
import {
  ChatCompatibilityError,
  chatRequestToResponses,
  chatUsageToResponseUsage,
  createResponsesToChatBridge,
  isChatEndpointUnsupported,
  upstreamEndpointUrl,
} from "./chat-protocol.mjs";

const ACTIVE_STATUSES = new Set(["received", "routing", "connecting", "streaming"]);
const CLIENT_TERMINATION_REASONS = new Set(["user_cancelled", "client_disconnected"]);
const LOCAL_REJECTION_CATEGORIES = new Set([
  "no_provider",
  "no_enabled_provider",
  "auth_unavailable",
  "circuit_open",
  "circuit_probe_in_progress",
  "concurrency_limited",
]);
const RETRYABLE_SEMANTIC_CATEGORIES = new Set([
  "capacity",
  "rate_limit",
  "server_error",
  "upstream_semantic_failure",
  "vector_store_timeout",
]);
const SAME_PROVIDER_RETRY_HTTP_STATUSES = new Set([
  408,
  425,
  502,
  503,
  504,
  520,
  521,
  522,
  523,
  524,
  525,
  526,
  527,
]);
class UpstreamSemanticFailureError extends Error {
  constructor(status, message, category = "upstream_semantic_failure", code = "") {
    super(message);
    this.name = "UpstreamSemanticFailureError";
    this.status = status;
    this.category = category;
    this.code = code;
    this.retryable = RETRYABLE_SEMANTIC_CATEGORIES.has(category);
  }
}
class FirstTokenTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`等待首字超过 ${Math.round(timeoutMs / 1000)} 秒`);
    this.name = "FirstTokenTimeoutError";
  }
}
class RouterTimeoutError extends Error {
  constructor(category, timeoutMs, message) {
    super(message);
    this.name = "RouterTimeoutError";
    this.category = category;
    this.code = category;
    this.status = 504;
    this.timeoutMs = timeoutMs;
  }
}
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function abortError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clientTerminationReason(controller) {
  if (!controller?.signal.aborted) return null;
  const reason = controller.signal.reason;
  if (CLIENT_TERMINATION_REASONS.has(reason?.code)) return reason.code;
  if (String(reason?.message || "").includes("用户从管理界面")) return "user_cancelled";
  return "client_disconnected";
}

function terminationMessage(reason) {
  if (reason === "user_cancelled") return "用户从管理界面取消请求";
  if (reason === "client_disconnected") return "客户端连接已断开";
  return "请求已中止";
}

function requestStatusForTermination(reason) {
  return reason === "user_cancelled" ? "cancelled" : "client_disconnected";
}

function effectiveAttemptError(error, attemptController) {
  const reason = attemptController?.signal.aborted ? attemptController.signal.reason : null;
  return reason instanceof RouterTimeoutError ? reason : error;
}

function streamFailureCategory(error) {
  return error instanceof RouterTimeoutError ? error.category : "stream_interrupted";
}

function createStreamProgressTracker(timeoutMs) {
  let started = false;
  let stopped = false;
  let lastProgressMono = null;
  return {
    start(observedAtMono = performance.now()) {
      if (started || stopped) return;
      started = true;
      lastProgressMono = observedAtMono;
    },
    note(observedAtMono = performance.now()) {
      if (stopped) return;
      started = true;
      lastProgressMono = observedAtMono;
    },
    stop() {
      stopped = true;
    },
    remaining(observedAtMono = performance.now()) {
      if (!started || stopped || !(timeoutMs > 0)) return Infinity;
      return Math.max(0, timeoutMs - (observedAtMono - lastProgressMono));
    },
    get timeoutMs() {
      return timeoutMs;
    },
  };
}

function streamPhaseForPayload(payload) {
  const type = String(payload?.type || payload?.object || "");
  if (type === "response.created") return "headers";
  if (type === "response.completed") return "completed";
  if (type === "response.incomplete") return "incomplete";
  if (type === "response.failed" || type === "error") return "failed";
  if (type === "chat.completion") return payload?.error ? "failed" : "completed";
  if (type === "chat.completion.chunk") {
    if (payload?.error) return "failed";
    if (payload?.choices?.some((choice) => choice?.finish_reason != null)) return "completed";
    return "streaming";
  }
  if (type.endsWith(".delta")) return "streaming";
  return null;
}

export class RouterEngine {
  constructor(db, dataDir, publish) {
    this.db = db;
    this.dataDir = dataDir;
    this.publish = publish;
    this.inFlight = new Map();
    this.halfOpenProbes = new Set();
    this.stickyResponses = new Map();
    this.controllers = new Map();
    this.attemptObservations = new Map();
    this.firstTokenTimeoutCache = new Map();
    this.streamSamples = new Map();
    this.streamSequenceNumbers = new Map();
    this.circuitWaiters = new Map();
  }

  async handle(req, res, { upstreamEndpoint = "responses", clientProtocol = "responses" } = {}) {
    const requestId = randomUUID();
    const startedAt = new Date();
    const startedMono = performance.now();
    this.createRequest(requestId, startedAt, clientProtocol);
    this.publish("request.created", { request: getRequest(this.db, requestId) });

    const clientController = new AbortController();
    this.controllers.set(requestId, clientController);
    req.once("aborted", () => {
      if (!clientController.signal.aborted) {
        clientController.abort(abortError("client_disconnected", "客户端请求已中止"));
      }
    });
    res.once("close", () => {
      if (!res.writableEnded && !clientController.signal.aborted) {
        clientController.abort(abortError("client_disconnected", "客户端连接已断开"));
      }
    });

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      this.finishRequest(requestId, startedMono, {
        status: "failed",
        http_status: 400,
        error_category: "invalid_json",
        error_message: safeMessage(error),
        cost_status: "not_applicable",
      });
      sendJson(res, 400, errorBody("请求正文不是有效 JSON", requestId));
      this.controllers.delete(requestId);
      return;
    }

    const requestedModel = String(body.model ?? DEFAULT_MODEL);
    const reasoningEffort = extractReasoningEffort(body);
    const isStream = upstreamEndpoint !== "responses/compact" && body.stream === true;
    this.updateRequest(requestId, {
      status: "routing",
      requested_model: requestedModel,
      reasoning_effort: reasoningEffort,
      is_stream: isStream ? 1 : 0,
      client_protocol: clientProtocol,
    });
    this.emitRequest(requestId, "request.status_changed");

    const route = this.resolveRoute(requestedModel);
    if (!route) {
      this.finishRequest(requestId, startedMono, {
        status: "failed",
        http_status: 503,
        error_category: "no_route",
        error_message: "没有匹配到可用路由",
        cost_status: "not_applicable",
      });
      sendJson(res, 503, errorBody("没有匹配到可用路由，请先配置并启用中转", requestId));
      this.controllers.delete(requestId);
      return;
    }

    this.updateRequest(requestId, {
      route_rule_id: route.rule.id,
      route_group_id: route.group.id,
    });

    const attempted = new Set();
    let maxAttempts = route.group.failover_enabled ? route.group.max_attempts : 1;
    const providerRetryLimit = route.group.provider_retry_attempts ?? 2;
    const providerRetryCounts = new Map();
    const chatWrappedProviders = new Set();
    let wrappedChatBody = null;
    const routerSettings = getRouterSettings(this.db);
    const requestedFirstTokenMode = routerSettings.first_token_timeout_mode;
    const firstTokenTimeoutMode = requestedFirstTokenMode.startsWith("race_") && !isRaceSafeRequest(body)
      ? "retry_then_switch"
      : requestedFirstTokenMode;
    let retryProviderId = null;
    let finalError = { status: 503, category: "no_provider", message: "路由组内没有可用中转" };

    for (let sequence = 1; sequence <= maxAttempts; sequence += 1) {
      let selection = null;
      if (retryProviderId) {
        const retryProvider = getProvider(this.db, retryProviderId);
        retryProviderId = null;
        if (retryProvider && this.providerAvailable(retryProvider)) {
          selection = this.claimSelection(retryProvider);
        }
      }
      if (!selection) {
        const recovery = this.selectCircuitRecovery(route, attempted);
        if (recovery?.waitProviderId) {
          const ready = await this.waitForCircuitChange(
            recovery.waitProviderId,
            recovery.waitMs ?? null,
            clientController.signal,
          );
          if (!ready) {
            const reason = clientTerminationReason(clientController) || "client_disconnected";
            const message = terminationMessage(reason);
            this.finishRequest(requestId, startedMono, {
              status: requestStatusForTermination(reason),
              http_status: 499,
              error_category: reason,
              error_message: message,
              termination_reason: reason,
              stream_phase: "routing",
              cost_status: attempted.size === 0 ? "not_applicable" : this.requestCostStatus(requestId),
            });
            if (!res.headersSent) sendJson(res, 499, errorBody(message, requestId));
            this.controllers.delete(requestId);
            return;
          }
          sequence -= 1;
          continue;
        }
        selection = recovery?.selection ?? null;
      }
      selection ??= this.selectProvider(route, body, attempted);
      if (!selection) {
        if (attempted.size === 0) finalError = this.routeUnavailable(route, attempted);
        break;
      }
      const { provider, probe } = selection;
      attempted.add(provider.id);

      const attemptId = randomUUID();
      const attemptStarted = new Date();
      const attemptMono = performance.now();
      const upstreamModel = requestedModel;
      const upstreamProtocol = clientProtocol === "chat"
        && (provider.chat_support_status === "unsupported" || chatWrappedProviders.has(provider.id))
        ? "responses"
        : clientProtocol;
      const protocolWrapped = clientProtocol === "chat" && upstreamProtocol === "responses";
      let upstreamBody;
      try {
        if (protocolWrapped) {
          wrappedChatBody ??= chatRequestToResponses({ ...body, model: upstreamModel });
          upstreamBody = wrappedChatBody;
        } else {
          upstreamBody = { ...body, model: upstreamModel };
        }
      } catch (error) {
        if (!(error instanceof ChatCompatibilityError)) throw error;
        this.finishRequest(requestId, startedMono, {
          status: "failed",
          http_status: error.status,
          error_category: "unsupported_chat_parameter",
          error_message: error.message,
          cost_status: "not_applicable",
        });
        sendJson(res, error.status, chatCompatibilityErrorBody(error, requestId));
        this.controllers.delete(requestId);
        return;
      }

      this.beginAttempt(
        requestId,
        attemptId,
        sequence,
        provider,
        attemptStarted,
        upstreamModel,
        upstreamProtocol,
        protocolWrapped,
      );
      this.acquireProvider(provider.id, probe);
      this.publish("request.attempt_started", {
        request_id: requestId,
        attempt: this.getAttempt(attemptId),
      });

      let upstream;
      const attemptController = new AbortController();
      const connectTimer = setTimeout(
        () => attemptController.abort(new DOMException("连接上游超时", "TimeoutError")),
        provider.connect_timeout_ms,
      );
      const clearConnectTimer = () => clearTimeout(connectTimer);
      const requestTimer = setTimeout(
        () => attemptController.abort(new RouterTimeoutError(
          "request_timeout",
          provider.request_timeout_ms,
          `请求总时长超过 ${Math.round(provider.request_timeout_ms / 1000)} 秒`,
        )),
        provider.request_timeout_ms,
      );
      try {
        const secret = getSecret(this.dataDir, provider.id);
        const signal = AbortSignal.any([clientController.signal, attemptController.signal]);
        const targetEndpoint = protocolWrapped ? "responses" : upstreamEndpoint;
        const timedFetch = await fetchWithNetworkTiming(
          responseEndpointUrl(provider.base_url, targetEndpoint),
          {
            method: "POST",
            headers: upstreamHeaders(req.headers, provider, secret, protocolWrapped ? "text/event-stream" : null),
            body: JSON.stringify(upstreamBody),
            signal,
          },
          {
            onConnected: clearConnectTimer,
            onRequestSent: clearConnectTimer,
            onBodySent: clearConnectTimer,
          },
        );
        upstream = timedFetch.response;
        clearConnectTimer();
        const headersAt = new Date();
        this.updateAttempt(attemptId, {
          headers_at: headersAt.toISOString(),
          headers_ms: Math.max(0, Math.round(performance.now() - attemptMono)),
          ...timedFetch.timing,
        });
        this.updateRequest(requestId, {
          headers_at: headersAt.toISOString(),
          headers_ms: Math.max(0, Math.round(performance.now() - startedMono)),
          ...timedFetch.timing,
        });
        this.emitRequest(requestId, "request.status_changed");
      } catch (error) {
        clearConnectTimer();
        clearTimeout(requestTimer);
        error = effectiveAttemptError(error, attemptController);
        this.updateAttempt(attemptId, networkTimingForError(error) ?? {});
        this.releaseProvider(provider.id, probe);
        const terminationReason = clientTerminationReason(clientController);
        const category = terminationReason
          || (error instanceof RouterTimeoutError ? error.category : error?.name === "TimeoutError" ? "timeout" : "network");
        const message = terminationReason ? terminationMessage(terminationReason) : safeMessage(error);
        this.finishAttempt(
          attemptId,
          attemptMono,
          terminationReason ? "cancelled" : "failed",
          null,
          category,
          message,
          { termination_reason: terminationReason, stream_phase: "connecting" },
        );
        if (!terminationReason) this.recordFailure(provider, category);
        this.publishAttempt(requestId, attemptId);

        if (terminationReason) {
          this.finishRequest(requestId, startedMono, {
            status: requestStatusForTermination(terminationReason),
            error_category: category,
            error_message: message,
            termination_reason: terminationReason,
            stream_phase: "connecting",
            cost_status: "unknown",
          });
          if (!res.headersSent) sendJson(res, 499, errorBody(message, requestId));
          this.controllers.delete(requestId);
          return;
        }
        finalError = { status: 502, category, message };
        if (!route.group.failover_enabled) break;
        continue;
      }

      let bufferedErrorResponse = null;
      if (clientProtocol === "chat" && upstreamProtocol === "chat" && !upstream.ok
        && [400, 404, 405, 501].includes(upstream.status)) {
        bufferedErrorResponse = Buffer.from(await upstream.arrayBuffer());
        const responseText = bufferedErrorResponse.toString("utf8");
        if (isChatEndpointUnsupported(upstream.status, responseText)) {
          clearTimeout(requestTimer);
          this.releaseProvider(provider.id, probe);
          const message = `${provider.name} 不支持 Chat Completions`;
          this.markChatSupport(provider.id, "unsupported", extractUpstreamError(responseText, upstream.status));
          this.finishAttempt(attemptId, attemptMono, "failed", upstream.status, "unsupported_endpoint", message, {
            termination_reason: "unsupported_endpoint",
            stream_phase: "failed",
            last_stream_event: "chat.unsupported",
          });
          this.publishAttempt(requestId, attemptId);
          chatWrappedProviders.add(provider.id);
          maxAttempts += 1;
          retryProviderId = provider.id;
          finalError = { status: 502, category: "unsupported_endpoint", message };
          continue;
        }
      }

      if (upstreamEndpoint === "responses/compact" && [404, 405].includes(upstream.status)) {
        await upstream.arrayBuffer().catch(() => null);
        clearTimeout(requestTimer);
        this.releaseProvider(provider.id, probe);
        const message = `${provider.name} 不支持 Responses Compact`;
        this.finishAttempt(attemptId, attemptMono, "failed", upstream.status, "unsupported_endpoint", message);
        this.publishAttempt(requestId, attemptId);
        finalError = { status: 502, category: "unsupported_endpoint", message };
        if (!route.group.failover_enabled) break;
        continue;
      }

      if (!bufferedErrorResponse && upstream.status === 400
        && upstream.headers.get("content-type")?.toLowerCase().includes("text/html")) {
        bufferedErrorResponse = Buffer.from(await upstream.arrayBuffer());
      }
      const responseText = bufferedErrorResponse?.toString("utf8") ?? "";
      const transientHtmlGatewayFailure = isTransientHtmlGatewayResponse(upstream, responseText);
      const classification = transientHtmlGatewayFailure
        ? { auth: false, retryable: true, category: "server_error" }
        : classifyStatus(upstream.status);
      if (classification.retryable || classification.auth) {
        const errorText = responseText || await upstream.text().catch(() => "");
        clearTimeout(requestTimer);
        this.releaseProvider(provider.id, probe);
        const message = extractUpstreamError(errorText, upstream.status);
        const retryCategory = transientHtmlGatewayFailure
          ? "server_error"
          : sameProviderRetryCategory(upstream.status, message);
        const category = retryCategory || classification.category;
        this.finishAttempt(attemptId, attemptMono, "failed", upstream.status, category, message);
        this.publishAttempt(requestId, attemptId);
        if (retryCategory) {
          const retries = providerRetryCounts.get(provider.id) ?? 0;
          if (retries < providerRetryLimit) {
            providerRetryCounts.set(provider.id, retries + 1);
            maxAttempts += 1;
            retryProviderId = provider.id;
            finalError = { status: upstream.status, category, message };
            continue;
          }
        }
        const cooldownMs = retryAfterMs(upstream.headers);
        this.recordFailure(provider, category, cooldownMs);
        finalError = { status: upstream.status, category, message, retryAfterMs: cooldownMs };
        if (!route.group.failover_enabled) break;
        continue;
      }

      if (!upstream.ok) {
        const responseBuffer = bufferedErrorResponse ?? Buffer.from(await upstream.arrayBuffer());
        clearTimeout(requestTimer);
        this.releaseProvider(provider.id, probe);
        this.finishAttempt(attemptId, attemptMono, "failed", upstream.status, "request_error", `上游返回 ${upstream.status}`);
        this.publishAttempt(requestId, attemptId);
        this.forwardHeaders(res, upstream, requestId);
        res.statusCode = upstream.status;
        res.end(responseBuffer);
        this.finishRequest(requestId, startedMono, {
          status: "failed",
          http_status: upstream.status,
          error_category: "request_error",
          error_message: `上游返回 ${upstream.status}`,
        });
        this.controllers.delete(requestId);
        return;
      }

      try {
        const firstTokenTimeoutMs = (isStream || protocolWrapped)
          ? this.resolveFirstTokenTimeoutMs(routerSettings, provider.id, requestedModel)
          : 0;
        if (firstTokenTimeoutMs > 0) {
          this.updateRequest(requestId, { first_token_timeout_ms: firstTokenTimeoutMs });
        }
        const forwardContext = {
          requestId,
          requestStartedMono: startedMono,
          attemptId,
          attemptMono,
          provider,
          upstreamModel,
          probe,
          upstream,
          res,
          isStream,
          clientProtocol,
          upstreamProtocol,
          protocolWrapped,
          chatIncludeUsage: clientProtocol === "chat" && body.stream_options?.include_usage === true,
          stickyTtlSeconds: route.group.sticky_enabled ? route.group.sticky_ttl_seconds : 0,
          streamIdleTimeoutMs: provider.stream_idle_timeout_ms,
          streamProgressTimeoutMs: provider.stream_progress_timeout_ms,
          firstTokenTimeoutMs,
          attemptController,
          requestTimer,
        };
        if (protocolWrapped) {
          await this.forwardWrappedChatSuccess(forwardContext);
        } else if (isStream && upstreamProtocol === "responses"
          && firstTokenTimeoutMode.startsWith("race_") && forwardContext.firstTokenTimeoutMs > 0) {
          await this.forwardRaceSuccess({
            ...forwardContext,
            clientController,
            startRaceAttempt: async () => {
              const raceSelection = firstTokenTimeoutMode === "race_same"
                ? (this.providerAvailable(provider) ? this.claimSelection(provider) : null)
                : this.selectProvider(route, body, attempted);
              if (!raceSelection) return null;
              attempted.add(raceSelection.provider.id);
              maxAttempts += 1;
              const raceAttempt = await this.openAttempt({
                req,
                body,
                requestId,
                requestStartedMono: startedMono,
                requestedModel,
                sequence: sequence + 1,
                provider: raceSelection.provider,
                probe: raceSelection.probe,
                clientController,
              });
              return { ...raceAttempt, requestId, provider: raceSelection.provider, probe: raceSelection.probe };
            },
          });
        } else {
          await this.forwardSuccess(forwardContext);
        }
        this.controllers.delete(requestId);
        return;
      } catch (error) {
        clearTimeout(requestTimer);
        error = effectiveAttemptError(error, attemptController);
        if (this.completeObservedSuccess({
          requestId,
          requestStartedMono: startedMono,
          attemptId,
          attemptMono,
          provider,
          upstreamModel,
          probe,
          upstream,
          res,
          stickyTtlSeconds: route.group.sticky_enabled ? route.group.sticky_ttl_seconds : 0,
        })) {
          this.controllers.delete(requestId);
          return;
        }
        if (error?.attemptHandled) {
          const terminationReason = clientTerminationReason(clientController);
          if (terminationReason) {
            this.finishRequest(requestId, startedMono, {
              status: requestStatusForTermination(terminationReason),
              error_category: terminationReason,
              error_message: terminationMessage(terminationReason),
              termination_reason: terminationReason,
              cost_status: this.requestCostStatus(requestId),
            });
            if (!res.headersSent) sendJson(res, 499, errorBody(terminationMessage(terminationReason), requestId));
            this.controllers.delete(requestId);
            return;
          }
          finalError = { status: 504, category: "first_token_timeout", message: safeMessage(error) };
          if (!route.group.failover_enabled) break;
          continue;
        }
        this.releaseProvider(provider.id, probe);
        if (error instanceof UpstreamSemanticFailureError && !clientTerminationReason(clientController)) {
          const retries = providerRetryCounts.get(provider.id) ?? 0;
          const canRetrySameProvider = error.retryable && retries < providerRetryLimit;
          this.finishAttempt(attemptId, attemptMono, "failed", upstream.status, error.category, error.message);
          this.publishAttempt(requestId, attemptId);
          if (canRetrySameProvider) {
            providerRetryCounts.set(provider.id, retries + 1);
            maxAttempts += 1;
            retryProviderId = provider.id;
            finalError = { status: error.status ?? upstream.status, category: error.category, message: error.message };
            continue;
          }
          this.recordFailure(provider, error.category);
          finalError = { status: error.status ?? upstream.status, category: error.category, message: error.message };
          if (!route.group.failover_enabled) break;
          continue;
        }
        if (error instanceof FirstTokenTimeoutError && !clientTerminationReason(clientController) && !res.headersSent) {
          const category = "first_token_timeout";
          const message = safeMessage(error);
          this.finishAttempt(attemptId, attemptMono, "failed", upstream.status, category, message);
          const consecutiveSlow = this.recordFirstTokenTimeout(provider);
          this.publishAttempt(requestId, attemptId);
          finalError = { status: 504, category, message };
          if (!route.group.failover_enabled) break;
          if (firstTokenTimeoutMode === "retry_then_switch" && consecutiveSlow === 1) {
            retryProviderId = provider.id;
          }
          continue;
        }
        const terminationReason = clientTerminationReason(clientController);
        const category = terminationReason || streamFailureCategory(error);
        const message = terminationReason ? terminationMessage(terminationReason) : safeMessage(error);
        const streamErrorSequence = !terminationReason && res.headersSent
          ? this.nextStreamSequence(requestId)
          : null;
        this.finishAttempt(
          attemptId,
          attemptMono,
          terminationReason ? "cancelled" : "failed",
          upstream.status,
          category,
          message,
          { termination_reason: terminationReason, stream_phase: this.getAttempt(attemptId)?.stream_phase || "streaming" },
        );
        if (!terminationReason) this.recordFailure(provider, category);
        this.publishAttempt(requestId, attemptId);
        this.finishRequest(requestId, startedMono, {
          status: terminationReason ? requestStatusForTermination(terminationReason) : "failed",
          http_status: upstream.status,
          error_category: category,
          error_message: message,
          termination_reason: terminationReason || category,
          stream_phase: this.getAttempt(attemptId)?.stream_phase || "streaming",
          cost_status: this.requestCostStatus(requestId),
        });
        if (!res.headersSent) sendJson(res, error?.status || 502, errorBody(message, requestId));
        else if (!terminationReason) {
          writeProtocolStreamError(res, clientProtocol, error, requestId, streamErrorSequence);
        }
        this.controllers.delete(requestId);
        return;
      }
    }

    this.finishRequest(requestId, startedMono, {
      status: "failed",
      http_status: finalError.status,
      error_category: finalError.category,
      error_message: finalError.message,
      cost_status: LOCAL_REJECTION_CATEGORIES.has(finalError.category) ? "not_applicable" : this.requestCostStatus(requestId),
    });
    if (finalError.retryAfterMs > 0 && !res.headersSent) {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil(finalError.retryAfterMs / 1000))));
    }
    sendJson(res, finalError.status || 503, errorBody(finalError.message, requestId));
    this.controllers.delete(requestId);
  }

  async openAttempt({
    req,
    body,
    requestId,
    requestStartedMono,
    requestedModel,
    sequence,
    provider,
    probe,
    clientController,
  }) {
    const attemptId = randomUUID();
    const attemptStarted = new Date();
    const attemptMono = performance.now();
    const upstreamBody = { ...body, model: requestedModel };
    this.beginAttempt(requestId, attemptId, sequence, provider, attemptStarted, requestedModel);
    this.acquireProvider(provider.id, probe);
    this.publish("request.attempt_started", {
      request_id: requestId,
      attempt: this.getAttempt(attemptId),
    });

    const attemptController = new AbortController();
    const connectTimer = setTimeout(
      () => attemptController.abort(new DOMException("连接上游超时", "TimeoutError")),
      provider.connect_timeout_ms,
    );
    const clearConnectTimer = () => clearTimeout(connectTimer);
    const requestTimer = setTimeout(
      () => attemptController.abort(new RouterTimeoutError(
        "request_timeout",
        provider.request_timeout_ms,
        `请求总时长超过 ${Math.round(provider.request_timeout_ms / 1000)} 秒`,
      )),
      provider.request_timeout_ms,
    );
    try {
      const secret = getSecret(this.dataDir, provider.id);
      const signal = AbortSignal.any([clientController.signal, attemptController.signal]);
      const timedFetch = await fetchWithNetworkTiming(
        responsesUrl(provider.base_url),
        {
          method: "POST",
          headers: upstreamHeaders(req.headers, provider, secret),
          body: JSON.stringify(upstreamBody),
          signal,
        },
        {
          onConnected: clearConnectTimer,
          onRequestSent: clearConnectTimer,
          onBodySent: clearConnectTimer,
        },
      );
      const upstream = timedFetch.response;
      clearConnectTimer();
      const headersAt = new Date();
      const headersMs = Math.max(0, Math.round(performance.now() - attemptMono));
      this.updateAttempt(attemptId, {
        headers_at: headersAt.toISOString(),
        headers_ms: headersMs,
        ...timedFetch.timing,
      });
      this.updateRequest(requestId, {
        headers_at: headersAt.toISOString(),
        headers_ms: Math.max(0, Math.round(performance.now() - requestStartedMono)),
        ...timedFetch.timing,
      });
      this.emitRequest(requestId, "request.status_changed");
      return {
        ok: true,
        attemptId,
        attemptMono,
        attemptController,
        requestTimer,
        upstream,
      };
    } catch (error) {
      clearConnectTimer();
      clearTimeout(requestTimer);
      error = effectiveAttemptError(error, attemptController);
      this.updateAttempt(attemptId, networkTimingForError(error) ?? {});
      this.releaseProvider(provider.id, probe);
      const terminationReason = clientTerminationReason(clientController);
      const category = terminationReason
        || (error instanceof RouterTimeoutError ? error.category : error?.name === "TimeoutError" ? "timeout" : "network");
      const message = terminationReason ? terminationMessage(terminationReason) : safeMessage(error);
      this.finishAttempt(
        attemptId,
        attemptMono,
        terminationReason ? "cancelled" : "failed",
        null,
        category,
        message,
        { termination_reason: terminationReason, stream_phase: "connecting" },
      );
      if (!terminationReason) this.recordFailure(provider, category);
      this.publishAttempt(requestId, attemptId);
      return {
        ok: false,
        cancelled: Boolean(terminationReason),
        termination_reason: terminationReason,
        error,
        attemptId,
        attemptMono,
        attemptController,
        requestTimer: null,
      };
    }
  }

  async forwardRaceSuccess(context) {
    const {
      requestId,
      requestStartedMono,
      attemptId,
      attemptMono,
      provider,
      upstreamModel,
      probe,
      upstream,
      attemptController,
      res,
      stickyTtlSeconds,
      streamIdleTimeoutMs,
      streamProgressTimeoutMs,
      firstTokenTimeoutMs,
      requestTimer,
      clientController,
      startRaceAttempt,
    } = context;
    const original = createRaceCandidate({
      requestId,
      attemptId,
      attemptMono,
      attemptController,
      requestTimer,
      provider,
      probe,
      upstream,
      onPayload: (payload) => this.observeAttemptPayload({
        requestId,
        attemptId,
        upstreamModel,
        payload,
      }),
      onMeaningfulOutput: () => this.noteMeaningfulStreamOutput(requestId),
      onTerminal: () => this.noteStreamTerminal(requestId),
    });
    startRaceCandidatePump(original);

    const remainingFirstTokenMs = Math.max(1, firstTokenTimeoutMs - (performance.now() - attemptMono));
    const initial = await raceWithTimeout(original.firstEvent, remainingFirstTokenMs);
    if (initial.kind === "output") {
      await this.forwardRaceCandidate({
        candidate: original,
        requestId,
        requestStartedMono,
        upstreamModel,
        res,
        stickyTtlSeconds,
        streamIdleTimeoutMs,
        streamProgressTimeoutMs,
        clientController,
      });
      return;
    }
    if (initial.kind === "semantic_failure") throw initial.error;
    if (initial.kind === "ended" || initial.kind === "error") {
      throw initial.error || new Error("上游在首字前结束流");
    }

    this.recordFirstTokenTimeout(provider);
    this.publish("provider.health_changed", { provider: getProvider(this.db, provider.id) });
    this.updateRequest(requestId, { race_triggered: 1 });
    const fallback = await startRaceAttempt();
    let fallbackCandidate = null;
    if (fallback?.ok && fallback.upstream?.ok) {
      fallbackCandidate = createRaceCandidate({
        requestId,
        attemptId: fallback.attemptId,
        attemptMono: fallback.attemptMono,
        attemptController: fallback.attemptController,
        requestTimer: fallback.requestTimer,
        provider: fallback.provider,
        probe: fallback.probe,
        upstream: fallback.upstream,
        onPayload: (payload) => this.observeAttemptPayload({
          requestId,
          attemptId: fallback.attemptId,
          upstreamModel,
          payload,
        }),
        onMeaningfulOutput: () => this.noteMeaningfulStreamOutput(requestId),
        onTerminal: () => this.noteStreamTerminal(requestId),
      });
      startRaceCandidatePump(fallbackCandidate);
    } else if (fallback?.ok) {
      await this.finishRaceNonStreamAttempt(fallback);
    }

    if (!fallbackCandidate) {
      const late = await original.firstEvent;
      if (late.kind === "output") {
        this.updateRequest(requestId, {
          race_winner_sequence: this.getAttempt(original.attemptId)?.sequence ?? null,
        });
        await this.forwardRaceCandidate({
          candidate: original,
          requestId,
          requestStartedMono,
          upstreamModel,
          res,
          stickyTtlSeconds,
          streamIdleTimeoutMs,
          streamProgressTimeoutMs,
          clientController,
        });
        return;
      }
      throw late.error || new FirstTokenTimeoutError(firstTokenTimeoutMs);
    }

    const winner = await waitForRaceWinner([original, fallbackCandidate]);
    if (!winner) {
      await this.cancelRaceCandidate(original, "first_token_timeout", "first_token_timeout");
      await this.cancelRaceCandidate(fallbackCandidate, "failed", "first_token_timeout");
      const error = new FirstTokenTimeoutError(firstTokenTimeoutMs);
      error.attemptHandled = true;
      throw error;
    }
    const loser = winner === original ? fallbackCandidate : original;
    this.updateRequest(requestId, {
      race_winner_sequence: this.getAttempt(winner.attemptId)?.sequence ?? null,
    });
    await this.cancelRaceCandidate(loser, "cancelled", "race_lost");
    await this.forwardRaceCandidate({
      candidate: winner,
      requestId,
      requestStartedMono,
      upstreamModel,
      res,
      stickyTtlSeconds,
      streamIdleTimeoutMs,
      streamProgressTimeoutMs,
      clientController,
    });
  }

  async forwardRaceCandidate({
    candidate,
    requestId,
    requestStartedMono,
    upstreamModel,
    res,
    stickyTtlSeconds,
    streamIdleTimeoutMs,
    streamProgressTimeoutMs,
    clientController,
  }) {
    const { upstream, reader, parser, buffered, provider, probe, attemptId, attemptMono, requestTimer } = candidate;
    const progressTracker = createStreamProgressTracker(streamProgressTimeoutMs);
    candidate.progressTracker = progressTracker;
    candidate.samplingEnabled = true;
    this.markRaceFirstOutput(candidate, requestId, requestStartedMono);
    progressTracker.start();
    try {
      this.forwardHeaders(res, upstream, requestId);
      res.statusCode = upstream.status;
      res.flushHeaders();
      for (const buffer of buffered) {
        if (!res.write(buffer)) await onceDrain(res);
      }
      if (!candidate.terminalReached) {
        for await (const chunk of streamReaderWithIdleTimeout(
          reader,
          streamIdleTimeoutMs,
          progressTracker,
          (idleMs, outcome) => this.noteStreamChunkWait(requestId, idleMs, outcome),
        )) {
          const buffer = Buffer.from(chunk);
          parser.push(buffer);
          if (candidate.semanticFailure && !candidate.firstOutputRecorded) throw candidate.semanticFailure;
          if (!res.write(buffer)) await onceDrain(res);
          if (candidate.terminalReached) break;
        }
      } else {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!candidate.terminalReached) parser.finish();
      if (candidate.semanticFailure && !candidate.firstOutputRecorded) throw candidate.semanticFailure;
      if (!candidate.terminalReached) throw new Error("Responses SSE 流缺少结束事件");
      res.end();
    } catch (error) {
      clearTimeout(requestTimer);
      error = effectiveAttemptError(error, candidate.attemptController);
      if (this.completeObservedSuccess({
        requestId,
        requestStartedMono,
        attemptId,
        attemptMono,
        provider,
        upstreamModel,
        probe,
        upstream,
        res,
        stickyTtlSeconds,
        usage: candidate.usage,
        responseId: candidate.responseId,
        actualUpstreamModel: candidate.actualUpstreamModel,
      })) return;
      this.releaseProvider(provider.id, probe);
      const terminationReason = clientTerminationReason(clientController);
      const category = terminationReason || streamFailureCategory(error);
      const message = terminationReason ? terminationMessage(terminationReason) : safeMessage(error);
      const streamErrorSequence = !terminationReason && res.headersSent
        ? this.nextStreamSequence(requestId)
        : null;
      this.finishAttempt(
        attemptId,
        attemptMono,
        terminationReason ? "cancelled" : "failed",
        upstream.status,
        category,
        message,
        { termination_reason: terminationReason || category, stream_phase: candidate.streamPhase || "streaming" },
      );
      if (!terminationReason) this.recordFailure(provider, category);
      this.publishAttempt(requestId, attemptId);
      this.finishRequest(requestId, requestStartedMono, {
        status: terminationReason ? requestStatusForTermination(terminationReason) : "failed",
        http_status: upstream.status,
        error_category: category,
        error_message: message,
        termination_reason: terminationReason || category,
        stream_phase: candidate.streamPhase || "streaming",
        cost_status: this.requestCostStatus(requestId),
      });
      if (!res.headersSent) sendJson(res, error?.status || 502, errorBody(message, requestId));
      else if (!terminationReason) {
        writeProtocolStreamError(res, "responses", error, requestId, streamErrorSequence);
      }
      return;
    }
    clearTimeout(requestTimer);
    if (candidate.semanticFailure) {
      this.completeTerminalFailure({
        requestId,
        requestStartedMono,
        attemptId,
        attemptMono,
        provider,
        upstreamModel,
        probe,
        upstream,
        usage: candidate.usage,
        responseId: candidate.responseId,
        actualUpstreamModel: candidate.actualUpstreamModel,
        failure: candidate.semanticFailure,
        affectsProviderHealth: true,
      });
      return;
    }
    if (candidate.incompleteFailure) {
      this.completeTerminalFailure({
        requestId,
        requestStartedMono,
        attemptId,
        attemptMono,
        provider,
        upstreamModel,
        probe,
        upstream,
        usage: candidate.usage,
        responseId: candidate.responseId,
        actualUpstreamModel: candidate.actualUpstreamModel,
        failure: candidate.incompleteFailure,
        affectsProviderHealth: false,
      });
      return;
    }
    this.completeSuccess({
      requestId,
      requestStartedMono,
      attemptId,
      attemptMono,
      provider,
      upstreamModel,
      probe,
      upstream,
      stickyTtlSeconds,
      usage: candidate.usage,
      responseId: candidate.responseId,
      actualUpstreamModel: candidate.actualUpstreamModel,
    });
  }

  markRaceFirstOutput(candidate, requestId, requestStartedMono) {
    if (candidate.firstOutputCommitted) return;
    candidate.firstOutputCommitted = true;
    this.startStreamSampling(requestId);
    if (isTerminalStreamPayload(candidate.lastStreamEvent)) {
      this.noteStreamTerminal(requestId);
    }
    const firstByteAt = new Date();
    const ttft = Math.max(0, Math.round(performance.now() - requestStartedMono));
    this.db.prepare("UPDATE request_attempts SET first_byte_at = ? WHERE id = ?")
      .run(firstByteAt.toISOString(), candidate.attemptId);
    this.updateRequest(requestId, {
      status: "streaming",
      first_byte_at: firstByteAt.toISOString(),
      ttft_ms: ttft,
      http_status: candidate.upstream.status,
      final_provider_id: candidate.provider.id,
      ...this.attemptNetworkTiming(candidate.attemptId),
    });
    this.recordFirstTokenSuccess(candidate.provider);
    this.emitRequest(requestId, "request.status_changed");
  }

  async cancelRaceCandidate(candidate, status, category) {
    if (!candidate || candidate.finished) return;
    candidate.finished = true;
    clearTimeout(candidate.requestTimer);
    candidate.attemptController.abort(new Error(category));
    await candidate.reader?.cancel().catch(() => {});
    this.releaseProvider(candidate.provider.id, candidate.probe);
    this.finishAttempt(
      candidate.attemptId,
      candidate.attemptMono,
      status,
      candidate.upstream.status,
      category,
      category === "race_lost" ? "竞速未胜出" : "首字超时",
      { termination_reason: category === "race_lost" ? "race_lost" : "relay_cancelled", stream_phase: candidate.streamPhase || "streaming" },
    );
    this.syncRequestUsage(candidate.requestId);
    this.publishAttempt(candidate.requestId, candidate.attemptId);
  }

  async finishRaceNonStreamAttempt(attempt) {
    clearTimeout(attempt.requestTimer);
    const status = attempt.upstream.status;
    const text = await attempt.upstream.text().catch(() => "");
    this.releaseProvider(attempt.provider.id, attempt.probe);
    this.finishAttempt(attempt.attemptId, attempt.attemptMono, "failed", status, "request_error", extractUpstreamError(text, status));
    this.recordFailure(attempt.provider, "request_error");
    this.publishAttempt(attempt.requestId, attempt.attemptId);
  }

  async forwardSuccess(context) {
    const {
      requestId,
      requestStartedMono,
      attemptId,
      attemptMono,
      provider,
      upstreamModel,
      probe,
      upstream,
      res,
      isStream,
      upstreamProtocol,
      protocolWrapped,
      stickyTtlSeconds,
      streamIdleTimeoutMs,
      streamProgressTimeoutMs,
      firstTokenTimeoutMs,
      requestTimer,
    } = context;

    let usage = {};
    let responseId = "";
    let actualUpstreamModel = "";
    let firstOutputRecorded = false;
    let semanticFailure = null;
    let incompleteFailure = null;
    let terminalEvent = upstreamProtocol === "chat" ? "chat.completion" : "response.completed";
    let terminalReached = false;
    let chatDone = false;
    const progressTracker = createStreamProgressTracker(streamProgressTimeoutMs);
    const markFirstOutput = () => {
      if (firstOutputRecorded) return;
      firstOutputRecorded = true;
      const firstByteAt = new Date();
      const ttft = Math.max(0, Math.round(performance.now() - requestStartedMono));
      this.db.prepare("UPDATE request_attempts SET first_byte_at = ? WHERE id = ?")
        .run(firstByteAt.toISOString(), attemptId);
      this.updateRequest(requestId, {
        status: isStream ? "streaming" : "connecting",
        first_byte_at: firstByteAt.toISOString(),
        ttft_ms: ttft,
        http_status: upstream.status,
        stream_phase: "streaming",
        ...this.attemptNetworkTiming(attemptId),
      });
      if (isStream) {
        this.startStreamSampling(requestId);
        progressTracker.start();
      }
      this.recordFirstTokenSuccess(provider);
      this.emitRequest(requestId, "request.status_changed");
    };

    try {
      if (isStream) {
        const parser = createSseInspector((payload) => {
          usage = extractUsage(payload) ?? usage;
          responseId = extractResponseId(payload) || responseId;
          actualUpstreamModel = this.observeAttemptPayload({ requestId, attemptId, upstreamModel, payload }) || actualUpstreamModel;
          semanticFailure ??= semanticFailureFromPayload(payload, upstream.status);
          incompleteFailure ??= incompleteFailureFromPayload(payload);
          if (!semanticFailure && isStreamProgressPayload(payload)) {
            progressTracker.note();
            this.noteMeaningfulStreamOutput(requestId);
          }
          if (!semanticFailure && isMeaningfulStreamOutput(payload)) markFirstOutput();
          if (upstreamProtocol === "responses" && isTerminalStreamPayload(payload)) {
            terminalReached = true;
            progressTracker.stop();
            this.noteStreamTerminal(requestId);
          }
        }, () => {
          if (upstreamProtocol === "chat") {
            chatDone = true;
            terminalReached = true;
            progressTracker.stop();
            this.noteStreamTerminal(requestId);
            terminalEvent = "chat.completion.done";
            this.updateAttempt(attemptId, { stream_phase: "completed", last_stream_event: terminalEvent });
          }
        });

        const reader = upstream.body?.getReader();
        if (!reader) throw new Error("上游响应正文为空");
        const buffered = [];
        await readUntilFirstOutput({
          reader,
          parser,
          buffered,
          firstOutputSeen: () => firstOutputRecorded || semanticFailure != null,
          attemptStartedMono: attemptMono,
          timeoutMs: firstTokenTimeoutMs,
        });
        if (semanticFailure) throw semanticFailure;
        if (!firstOutputRecorded && upstreamProtocol === "chat") {
          throw new Error("Chat Completions SSE 流缺少有效 choices 输出");
        }
        if (!firstOutputRecorded) markFirstOutput();
        this.forwardHeaders(res, upstream, requestId);
        res.statusCode = upstream.status;
        res.flushHeaders();
        for (const buffer of buffered) {
          if (!res.write(buffer)) await onceDrain(res);
        }
        if (!terminalReached) {
          for await (const chunk of streamReaderWithIdleTimeout(
            reader,
            streamIdleTimeoutMs,
            progressTracker,
            (idleMs, outcome) => this.noteStreamChunkWait(requestId, idleMs, outcome),
          )) {
            const buffer = Buffer.from(chunk);
            parser.push(buffer);
            if (semanticFailure && !firstOutputRecorded) throw semanticFailure;
            if (!res.write(buffer)) await onceDrain(res);
            if (terminalReached) break;
          }
        } else {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!terminalReached) parser.finish();
        if (semanticFailure && !firstOutputRecorded) throw semanticFailure;
        if (upstreamProtocol === "chat" && !chatDone) {
          throw new Error("Chat Completions SSE 流缺少 [DONE] 结束标记");
        }
        if (upstreamProtocol === "responses" && !terminalReached) {
          throw new Error("Responses SSE 流缺少结束事件");
        }
        if (!firstOutputRecorded) markFirstOutput();
        res.end();
      } else {
        const buffer = Buffer.from(await upstream.arrayBuffer());
        try {
          const payload = JSON.parse(buffer.toString("utf8"));
          semanticFailure = semanticFailureFromPayload(payload, upstream.status);
          incompleteFailure = incompleteFailureFromPayload(payload);
          usage = extractUsage(payload) ?? {};
          responseId = extractResponseId(payload);
          actualUpstreamModel = this.observeAttemptPayload({ requestId, attemptId, upstreamModel, payload }) || actualUpstreamModel;
        } catch {
          // The original upstream payload is still returned unchanged.
        }
        if (semanticFailure) throw semanticFailure;
        markFirstOutput();
        this.forwardHeaders(res, upstream, requestId);
        res.statusCode = upstream.status;
        res.end(buffer);
      }
    } finally {
      clearTimeout(requestTimer);
    }

    if (semanticFailure) {
      this.completeTerminalFailure({
        requestId,
        requestStartedMono,
        attemptId,
        attemptMono,
        provider,
        upstreamModel,
        probe,
        upstream,
        usage,
        responseId,
        actualUpstreamModel,
        failure: semanticFailure,
        affectsProviderHealth: true,
        upstreamProtocol,
        protocolWrapped,
      });
      return;
    }
    if (incompleteFailure) {
      this.completeTerminalFailure({
        requestId,
        requestStartedMono,
        attemptId,
        attemptMono,
        provider,
        upstreamModel,
        probe,
        upstream,
        usage,
        responseId,
        actualUpstreamModel,
        failure: incompleteFailure,
        affectsProviderHealth: false,
        upstreamProtocol,
        protocolWrapped,
      });
      return;
    }
    this.completeSuccess({
      requestId,
      requestStartedMono,
      attemptId,
      attemptMono,
      provider,
      upstreamModel,
      probe,
      upstream,
      stickyTtlSeconds,
      usage,
      responseId,
      actualUpstreamModel,
      upstreamProtocol,
      protocolWrapped,
      lastStreamEvent: terminalEvent,
    });
  }

  async forwardWrappedChatSuccess(context) {
    const {
      requestId,
      requestStartedMono,
      attemptId,
      attemptMono,
      provider,
      upstreamModel,
      probe,
      upstream,
      res,
      isStream,
      stickyTtlSeconds,
      streamIdleTimeoutMs,
      streamProgressTimeoutMs,
      firstTokenTimeoutMs,
      requestTimer,
    } = context;
    let usage = {};
    let responseId = "";
    let actualUpstreamModel = "";
    let semanticFailure = null;
    let firstOutputRecorded = false;
    let terminalReached = false;
    const progressTracker = createStreamProgressTracker(streamProgressTimeoutMs);
    const bridge = createResponsesToChatBridge({
      stream: isStream,
      includeUsage: Boolean(context.chatIncludeUsage),
      requestedModel: upstreamModel,
      onPayload: (payload) => {
        usage = extractUsage(payload) ?? usage;
        responseId = extractResponseId(payload) || responseId;
        actualUpstreamModel = this.observeAttemptPayload({ requestId, attemptId, upstreamModel, payload }) || actualUpstreamModel;
        semanticFailure ??= semanticFailureFromPayload(payload, upstream.status);
        if (!semanticFailure && isStreamProgressPayload(payload)) {
          progressTracker.note();
          this.noteMeaningfulStreamOutput(requestId);
        }
        if (isTerminalStreamPayload(payload)) {
          terminalReached = true;
          progressTracker.stop();
          this.noteStreamTerminal(requestId);
        }
      },
    });

    const markFirstOutput = () => {
      if (firstOutputRecorded) return;
      firstOutputRecorded = true;
      const firstByteAt = new Date();
      const ttft = Math.max(0, Math.round(performance.now() - requestStartedMono));
      this.db.prepare("UPDATE request_attempts SET first_byte_at = ? WHERE id = ?")
        .run(firstByteAt.toISOString(), attemptId);
      this.updateRequest(requestId, {
        status: isStream ? "streaming" : "connecting",
        first_byte_at: firstByteAt.toISOString(),
        ttft_ms: ttft,
        http_status: upstream.status,
        stream_phase: "streaming",
        ...this.attemptNetworkTiming(attemptId),
      });
      this.startStreamSampling(requestId);
      if (terminalReached) this.noteStreamTerminal(requestId);
      progressTracker.start();
      this.recordFirstTokenSuccess(provider);
      this.emitRequest(requestId, "request.status_changed");
    };

    try {
      const reader = upstream.body?.getReader();
      if (!reader) throw new Error("上游响应正文为空");
      const buffered = [];
      await readUntilFirstConvertedOutput({
        reader,
        bridge,
        buffered,
        attemptStartedMono: attemptMono,
        timeoutMs: firstTokenTimeoutMs,
      });
      if (semanticFailure || bridge.failure) throw semanticFailure || bridgeFailureError(bridge.failure, upstream.status);
      if (!bridge.meaningfulOutput) throw new Error("Responses SSE 流在首个输出前结束");
      if (!firstOutputRecorded) markFirstOutput();
      this.forwardTransformedHeaders(res, requestId, isStream);
      res.statusCode = 200;
      if (isStream) {
        res.flushHeaders();
        for (const buffer of buffered) {
          if (!res.write(buffer)) await onceDrain(res);
        }
      }
      if (!terminalReached) {
        for await (const chunk of streamReaderWithIdleTimeout(
          reader,
          streamIdleTimeoutMs,
          progressTracker,
          (idleMs, outcome) => this.noteStreamChunkWait(requestId, idleMs, outcome),
        )) {
          const output = bridge.push(Buffer.from(chunk));
          if (isStream) {
            for (const buffer of output) {
              if (!res.write(buffer)) await onceDrain(res);
            }
          }
          if (terminalReached) break;
        }
      } else {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const finalOutput = terminalReached ? [] : bridge.finish();
      if (isStream) {
        for (const buffer of finalOutput) {
          if (!res.write(buffer)) await onceDrain(res);
        }
      }
      if (!bridge.completed && !bridge.failure) throw new Error("Responses SSE 流缺少结束事件");
      if (!firstOutputRecorded && bridge.meaningfulOutput) markFirstOutput();
      if (!isStream) {
        if (bridge.failure || semanticFailure) {
          const failure = semanticFailure || bridgeFailureError(bridge.failure, upstream.status);
          res.statusCode = failure.status || 502;
          res.end(JSON.stringify({
            error: {
              message: failure.message,
              type: bridge.failure?.type || "server_error",
              param: bridge.failure?.param ?? null,
              code: bridge.failure?.code || failure.code || null,
            },
          }));
        } else {
          res.end(JSON.stringify(bridge.completion()));
        }
      } else {
        res.end();
      }
    } finally {
      clearTimeout(requestTimer);
    }

    if (bridge.failure || semanticFailure) {
      const failure = semanticFailure || bridgeFailureError(bridge.failure, upstream.status);
      this.completeTerminalFailure({
        requestId,
        requestStartedMono,
        attemptId,
        attemptMono,
        provider,
        upstreamModel,
        probe,
        upstream,
        usage,
        responseId,
        actualUpstreamModel,
        failure,
        affectsProviderHealth: true,
        upstreamProtocol: "responses",
        protocolWrapped: true,
        lastStreamEvent: failure.lastStreamEvent || "response.failed",
      });
      return;
    }
    this.completeSuccess({
      requestId,
      requestStartedMono,
      attemptId,
      attemptMono,
      provider,
      upstreamModel,
      probe,
      upstream,
      stickyTtlSeconds,
      usage,
      responseId,
      actualUpstreamModel,
      upstreamProtocol: "responses",
      protocolWrapped: true,
      lastStreamEvent: "response.completed",
    });
  }

  completeSuccess({
    requestId,
    requestStartedMono,
    attemptId,
    attemptMono,
    provider,
    upstreamModel,
    probe,
    upstream,
    stickyTtlSeconds,
    usage,
    responseId,
    actualUpstreamModel,
    upstreamProtocol = "responses",
    protocolWrapped = false,
    lastStreamEvent,
  }) {
    const terminalEvent = lastStreamEvent || (upstreamProtocol === "chat" ? "chat.completion.done" : "response.completed");
    if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
      this.updateAttempt(attemptId, {
        ...usageFieldsForModel(this.db, upstreamModel, usage, true),
        stream_phase: "completed",
        last_stream_event: terminalEvent,
        upstream_response_id: responseId || undefined,
        actual_upstream_model: actualUpstreamModel || "",
        upstream_protocol: upstreamProtocol,
        protocol_wrapped: protocolWrapped ? 1 : 0,
      });
    }
    this.syncRequestUsage(requestId);
    this.releaseProvider(provider.id, probe);
    if (upstreamProtocol === "chat") this.markChatSupport(provider.id, "supported");
    this.recordSuccess(provider);
    this.finishAttempt(attemptId, attemptMono, "completed", upstream.status, null, null, {
      termination_reason: null,
      stream_phase: "completed",
      last_stream_event: terminalEvent,
      upstream_response_id: responseId || undefined,
      actual_upstream_model: actualUpstreamModel || "",
      upstream_protocol: upstreamProtocol,
      protocol_wrapped: protocolWrapped ? 1 : 0,
      cost_status: this.requestCostStatus(requestId),
    });
    this.publishAttempt(requestId, attemptId);
    if (responseId) this.rememberSticky(responseId, provider.id, stickyTtlSeconds);
    this.finishRequest(requestId, requestStartedMono, {
      status: "completed",
      http_status: upstream.status,
      final_provider_id: provider.id,
      upstream_model: upstreamModel,
      actual_upstream_model: actualUpstreamModel || "",
      termination_reason: null,
      stream_phase: "completed",
      last_stream_event: terminalEvent,
      upstream_response_id: responseId || undefined,
      upstream_protocol: upstreamProtocol,
      protocol_wrapped: protocolWrapped ? 1 : 0,
      cost_status: this.requestCostStatus(requestId),
    });
  }

  completeTerminalFailure({
    requestId,
    requestStartedMono,
    attemptId,
    attemptMono,
    provider,
    upstreamModel,
    probe,
    upstream,
    usage,
    responseId,
    actualUpstreamModel,
    failure,
    affectsProviderHealth,
    upstreamProtocol = "responses",
    protocolWrapped = false,
    lastStreamEvent,
  }) {
    const terminalEvent = lastStreamEvent || failure.lastStreamEvent || "response.failed";
    const usageFields = usage && (usage.input_tokens != null || usage.output_tokens != null)
      ? usageFieldsForModel(this.db, upstreamModel, usage, true)
      : { cost_status: "unknown" };
    this.updateAttempt(attemptId, {
      ...usageFields,
      stream_phase: failure.streamPhase || "failed",
      last_stream_event: terminalEvent,
      upstream_response_id: responseId || undefined,
      actual_upstream_model: actualUpstreamModel || "",
      upstream_protocol: upstreamProtocol,
      protocol_wrapped: protocolWrapped ? 1 : 0,
    });
    this.releaseProvider(provider.id, probe);
    if (affectsProviderHealth) this.recordFailure(provider, failure.category);
    this.finishAttempt(attemptId, attemptMono, "failed", upstream.status, failure.category, failure.message, {
      termination_reason: failure.category,
      stream_phase: failure.streamPhase || "failed",
      last_stream_event: terminalEvent,
      upstream_response_id: responseId || undefined,
      actual_upstream_model: actualUpstreamModel || "",
      upstream_protocol: upstreamProtocol,
      protocol_wrapped: protocolWrapped ? 1 : 0,
      cost_status: usageFields.cost_status,
    });
    this.publishAttempt(requestId, attemptId);
    const costStatus = this.syncRequestUsage(requestId);
    this.finishRequest(requestId, requestStartedMono, {
      status: "failed",
      http_status: upstream.status,
      final_provider_id: provider.id,
      upstream_model: upstreamModel,
      actual_upstream_model: actualUpstreamModel || "",
      error_category: failure.category,
      error_message: failure.message,
      termination_reason: failure.category,
      stream_phase: failure.streamPhase || "failed",
      last_stream_event: terminalEvent,
      upstream_response_id: responseId || undefined,
      upstream_protocol: upstreamProtocol,
      protocol_wrapped: protocolWrapped ? 1 : 0,
      cost_status: costStatus,
    });
  }

  completeObservedSuccess(context) {
    const attempt = this.getAttempt(context.attemptId);
    if (attempt?.last_stream_event !== "response.completed") return false;
    if (!context.res.writableEnded && !context.res.destroyed) context.res.end();
    this.completeSuccess({
      ...context,
      usage: context.usage ?? null,
      responseId: context.responseId || attempt.upstream_response_id || "",
      actualUpstreamModel: context.actualUpstreamModel || attempt.actual_upstream_model || "",
    });
    return true;
  }

  resolveRoute(model) {
    const { rules, groups } = listRoutes(this.db);
    const rule = rules.find((candidate) => candidate.enabled && ruleMatches(candidate, model));
    if (!rule) return null;
    const group = groups.find((candidate) => candidate.id === rule.route_group_id && candidate.enabled);
    return group ? { rule, group } : null;
  }

  selectProvider(route, body, attempted) {
    const candidates = route.group.members
      .filter((member) => member.enabled && member.provider_enabled && !attempted.has(member.provider_id))
      .map((member) => ({ member, provider: getProvider(this.db, member.provider_id) }))
      .filter(({ provider }) => provider && this.providerAvailable(provider));

    if (candidates.length === 0) return null;
    const stickyId = route.group.sticky_enabled ? this.stickyProvider(body.previous_response_id) : null;
    const sticky = candidates.find(({ provider }) => provider.id === stickyId);
    if (sticky) return this.claimSelection(sticky.provider);

    const minimumPriority = Math.min(...candidates.map(({ member }) => member.priority));
    const tier = candidates.filter(({ member }) => member.priority === minimumPriority);
    const selected = route.group.strategy === "fixed" ? tier[0] : weightedChoice(tier);
    return this.claimSelection(selected.provider);
  }

  selectCircuitRecovery(route, attempted) {
    const candidates = route.group.members
      .filter((member) => member.enabled && member.provider_enabled && !attempted.has(member.provider_id))
      .map((member) => ({ member, provider: getProvider(this.db, member.provider_id) }))
      .filter(({ provider }) => provider?.enabled && provider.health_status !== "auth_error");
    if (candidates.length === 0) return null;
    if (candidates.some(({ provider }) => !["open", "half_open"].includes(provider.circuit_state))) return null;

    const now = Date.now();
    const ordered = candidates
      .map((candidate) => ({
        ...candidate,
        availableAt: candidate.provider.circuit_state === "half_open"
          ? 0
          : new Date(candidate.provider.circuit_open_until || "").getTime(),
      }))
      .filter((candidate) => Number.isFinite(candidate.availableAt))
      .sort((left, right) => left.availableAt - right.availableAt
        || left.member.priority - right.member.priority
        || left.provider.name.localeCompare(right.provider.name, "zh-CN"));
    const earliest = ordered[0];
    if (!earliest) return null;
    if (earliest.availableAt > now) {
      return { waitProviderId: earliest.provider.id, waitMs: earliest.availableAt - now };
    }

    if (earliest.provider.circuit_state === "open") {
      const timestamp = new Date().toISOString();
      this.db.prepare("UPDATE providers SET circuit_state = 'half_open', updated_at = ? WHERE id = ?")
        .run(timestamp, earliest.provider.id);
      this.publish("circuit.state_changed", { provider_id: earliest.provider.id, state: "half_open" });
      earliest.provider.circuit_state = "half_open";
    }
    if (this.halfOpenProbes.has(earliest.provider.id)) {
      return { waitProviderId: earliest.provider.id };
    }
    if ((this.inFlight.get(earliest.provider.id) ?? 0) >= earliest.provider.max_concurrency) {
      return { waitProviderId: earliest.provider.id, waitMs: 100 };
    }
    return { selection: this.claimSelection(earliest.provider) };
  }

  routeUnavailable(route, attempted) {
    const members = route.group.members
      .filter((member) => member.enabled && member.provider_enabled && !attempted.has(member.provider_id));
    if (members.length === 0) {
      return { status: 503, category: "no_enabled_provider", message: "路由组内没有启用的中转" };
    }
    const providers = members.map((member) => getProvider(this.db, member.provider_id)).filter(Boolean);
    if (providers.length === 0) {
      return { status: 503, category: "no_enabled_provider", message: "路由组内没有可用的中转配置" };
    }
    if (providers.every((provider) => provider.health_status === "auth_error")) {
      return { status: 503, category: "auth_unavailable", message: "所有中转均存在鉴权异常" };
    }
    const now = Date.now();
    const openProviders = providers.filter((provider) => (
      provider.circuit_state === "open"
      && provider.circuit_open_until
      && new Date(provider.circuit_open_until).getTime() > now
    ));
    if (openProviders.length === providers.length) {
      const retryAfterMs = Math.max(1, Math.min(...openProviders.map((provider) => (
        new Date(provider.circuit_open_until).getTime() - now
      ))));
      return {
        status: 503,
        category: "circuit_open",
        message: `中转熔断中，约 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`,
        retryAfterMs,
      };
    }
    if (providers.every((provider) => (
      provider.circuit_state === "half_open" && this.halfOpenProbes.has(provider.id)
    ))) {
      return { status: 503, category: "circuit_probe_in_progress", message: "中转正在进行恢复探测", retryAfterMs: 1000 };
    }
    if (providers.every((provider) => (
      (this.inFlight.get(provider.id) ?? 0) >= provider.max_concurrency
    ))) {
      return { status: 503, category: "concurrency_limited", message: "所有中转当前并发已满", retryAfterMs: 1000 };
    }
    return { status: 503, category: "no_provider", message: "路由组内暂时没有可用中转" };
  }

  claimSelection(provider) {
    const probe = provider.circuit_state === "half_open";
    if (probe) this.halfOpenProbes.add(provider.id);
    return { provider, probe };
  }

  providerAvailable(provider) {
    if (!provider.enabled || provider.health_status === "auth_error") return false;
    if ((this.inFlight.get(provider.id) ?? 0) >= provider.max_concurrency) return false;
    if (provider.circuit_state === "closed") return true;
    if (provider.circuit_state === "half_open") return !this.halfOpenProbes.has(provider.id);
    if (provider.circuit_state === "open" && provider.circuit_open_until) {
      if (new Date(provider.circuit_open_until).getTime() <= Date.now()) {
        this.db.prepare("UPDATE providers SET circuit_state = 'half_open', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), provider.id);
        this.publish("circuit.state_changed", { provider_id: provider.id, state: "half_open" });
        provider.circuit_state = "half_open";
        return !this.halfOpenProbes.has(provider.id);
      }
    }
    return false;
  }

  resolveFirstTokenTimeoutMs(settings, providerId, requestedModel) {
    if (settings.first_token_timeout_policy === "off") return 0;
    if (settings.first_token_timeout_policy === "fixed") return settings.first_token_timeout_ms;

    const cacheKey = `${providerId}\u0000${requestedModel}\u0000${settings.first_token_timeout_ms}`;
    const cached = this.firstTokenTimeoutCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.timeoutMs;

    const adaptive = getAdaptiveFirstTokenTimeout(
      this.db,
      providerId,
      requestedModel,
      settings.first_token_timeout_ms,
    );
    if (this.firstTokenTimeoutCache.size >= 256) {
      this.firstTokenTimeoutCache.delete(this.firstTokenTimeoutCache.keys().next().value);
    }
    this.firstTokenTimeoutCache.set(cacheKey, {
      timeoutMs: adaptive.timeout_ms,
      expiresAt: Date.now() + 60000,
    });
    return adaptive.timeout_ms;
  }

  invalidateFirstTokenTimeoutCache(request) {
    if (request?.status !== "completed" || request.attempt_count !== 1 || request.is_failover !== 0
      || request.race_triggered !== 0 || request.ttft_ms == null || !request.final_provider_id
      || !request.requested_model) return;
    const prefix = `${request.final_provider_id}\u0000${request.requested_model}\u0000`;
    for (const cacheKey of this.firstTokenTimeoutCache.keys()) {
      if (cacheKey.startsWith(prefix)) this.firstTokenTimeoutCache.delete(cacheKey);
    }
  }

  acquireProvider(providerId) {
    this.inFlight.set(providerId, (this.inFlight.get(providerId) ?? 0) + 1);
  }

  waitForCircuitChange(providerId, delayMs, signal) {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiters = this.circuitWaiters.get(providerId) ?? new Set();
      let timer = null;
      const finish = (ready) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waiters.delete(onCircuitChange);
        if (waiters.size === 0) this.circuitWaiters.delete(providerId);
        resolve(ready);
      };
      const onAbort = () => finish(false);
      const onCircuitChange = () => finish(true);
      waiters.add(onCircuitChange);
      this.circuitWaiters.set(providerId, waiters);
      signal.addEventListener("abort", onAbort, { once: true });
      if (delayMs != null) {
        timer = setTimeout(
          onCircuitChange,
          Math.max(1, Math.min(delayMs, 2_147_483_647)),
        );
      }
    });
  }

  notifyCircuitChange(providerId) {
    const waiters = this.circuitWaiters.get(providerId);
    if (!waiters) return;
    this.circuitWaiters.delete(providerId);
    for (const notify of [...waiters]) notify();
  }

  releaseProvider(providerId, probe) {
    this.inFlight.set(providerId, Math.max(0, (this.inFlight.get(providerId) ?? 1) - 1));
    if (probe) {
      this.halfOpenProbes.delete(providerId);
      queueMicrotask(() => this.notifyCircuitChange(providerId));
    }
  }

  recordSuccess(provider) {
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      UPDATE providers SET health_status = 'healthy', circuit_state = 'closed',
        circuit_open_until = NULL, consecutive_failures = 0,
        consecutive_slow_first_tokens = 0,
        last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
    `).run(timestamp, timestamp, provider.id);
    this.notifyCircuitChange(provider.id);
    this.publish("provider.health_changed", { provider: getProvider(this.db, provider.id) });
  }

  recordFirstTokenTimeout(provider) {
    const current = getProvider(this.db, provider.id);
    const consecutive = (current?.consecutive_slow_first_tokens ?? 0) + 1;
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      UPDATE providers SET consecutive_slow_first_tokens = ?,
        last_error_at = ?, last_error = 'first_token_timeout', updated_at = ?
      WHERE id = ?
    `).run(consecutive, timestamp, timestamp, provider.id);
    this.publish("provider.health_changed", { provider: getProvider(this.db, provider.id) });
    return consecutive;
  }

  recordFirstTokenSuccess(provider) {
    const current = getProvider(this.db, provider.id);
    if (!current?.consecutive_slow_first_tokens) return;
    this.db.prepare(`
      UPDATE providers SET consecutive_slow_first_tokens = 0,
        last_error = NULL, updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), provider.id);
    this.publish("provider.health_changed", { provider: getProvider(this.db, provider.id) });
  }

  recordFailure(provider, category, explicitCooldownMs) {
    const current = getProvider(this.db, provider.id);
    const failures = (current?.consecutive_failures ?? 0) + 1;
    const authError = category === "auth";
    const shouldOpen = authError || current?.circuit_state === "half_open" || failures >= current.failure_threshold;
    const cooldown = explicitCooldownMs || current.cooldown_ms;
    const openUntil = shouldOpen && !authError ? new Date(Date.now() + cooldown).toISOString() : null;
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      UPDATE providers SET health_status = ?, circuit_state = ?, circuit_open_until = ?,
        consecutive_failures = ?, last_error_at = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(
      authError ? "auth_error" : "unhealthy",
      shouldOpen ? "open" : "closed",
      openUntil,
      failures,
      timestamp,
      category,
      timestamp,
      provider.id,
    );
    this.notifyCircuitChange(provider.id);
    this.publish("provider.health_changed", { provider: getProvider(this.db, provider.id) });
    if (shouldOpen) {
      this.publish("circuit.state_changed", {
        provider_id: provider.id,
        state: "open",
        open_until: openUntil,
      });
    }
  }

  resetCircuit(providerId) {
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      UPDATE providers SET health_status = 'unknown', circuit_state = 'closed',
        circuit_open_until = NULL, consecutive_failures = 0,
        consecutive_slow_first_tokens = 0,
        last_error = NULL, updated_at = ? WHERE id = ?
    `).run(timestamp, providerId);
    this.halfOpenProbes.delete(providerId);
    this.notifyCircuitChange(providerId);
    this.publish("circuit.state_changed", { provider_id: providerId, state: "closed" });
    return getProvider(this.db, providerId);
  }

  cancelRequest(requestId) {
    const controller = this.controllers.get(requestId);
    if (!controller) return false;
    if (!controller.signal.aborted) controller.abort(abortError("user_cancelled", "用户从管理界面取消请求"));
    return true;
  }

  createRequest(id, startedAt, clientProtocol = "responses") {
    this.db.prepare(
      "INSERT INTO requests (id, started_at, status, requested_model, client_protocol) VALUES (?, ?, 'received', '', ?)",
    ).run(id, startedAt.toISOString(), clientProtocol);
  }

  beginAttempt(
    requestId,
    attemptId,
    sequence,
    provider,
    startedAt,
    upstreamModel,
    upstreamProtocol = "responses",
    protocolWrapped = false,
  ) {
    const current = this.db.prepare(
      "SELECT final_provider_id, is_failover FROM requests WHERE id = ?",
    ).get(requestId);
    const changedProvider = Boolean(current?.final_provider_id && current.final_provider_id !== provider.id);
    this.db.prepare(`
      INSERT INTO request_attempts
        (id, request_id, sequence, provider_id, upstream_protocol, protocol_wrapped, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'connecting')
    `).run(
      attemptId,
      requestId,
      sequence,
      provider.id,
      upstreamProtocol,
      protocolWrapped ? 1 : 0,
      startedAt.toISOString(),
    );
    this.updateRequest(requestId, {
      status: "connecting",
      final_provider_id: provider.id,
      upstream_model: upstreamModel,
      actual_upstream_model: "",
      upstream_protocol: upstreamProtocol,
      protocol_wrapped: protocolWrapped ? 1 : 0,
      attempt_count: sequence,
      is_failover: current?.is_failover || changedProvider ? 1 : 0,
      stream_phase: "connecting",
    });
    this.emitRequest(requestId, "request.status_changed");
  }

  finishAttempt(id, startedMono, status, httpStatus, errorCategory, errorMessage, metadata = {}) {
    const endedAt = new Date().toISOString();
    const duration = Math.max(0, Math.round(performance.now() - startedMono));
    const fields = {
      ended_at: endedAt,
      duration_ms: duration,
      status,
      http_status: httpStatus,
      error_category: errorCategory,
      error_message: errorMessage,
      ...metadata,
    };
    this.updateAttempt(id, fields);
    this.attemptObservations.delete(id);
  }

  getAttempt(id) {
    return this.db.prepare(`
      SELECT a.*, p.name AS provider_name FROM request_attempts a
      JOIN providers p ON p.id = a.provider_id WHERE a.id = ?
    `).get(id);
  }

  publishAttempt(requestId, attemptId) {
    this.publish("request.attempt_finished", {
      request_id: requestId,
      attempt: this.getAttempt(attemptId),
    });
  }

  updateRequest(id, fields) {
    const allowed = [
      "headers_at", "headers_ms", "connection_reused", "network_connect_ms", "request_upload_ms",
      "upstream_wait_ms", "first_byte_at", "ended_at", "duration_ms", "ttft_ms",
      "max_stream_chunk_idle_ms", "max_meaningful_output_idle_ms", "final_output_idle_ms",
      "stream_chunk_count", "meaningful_output_event_count",
      "first_token_timeout_ms", "race_triggered", "race_winner_sequence", "status",
      "requested_model", "upstream_model", "actual_upstream_model", "reasoning_effort", "route_rule_id", "route_group_id",
      "client_protocol", "upstream_protocol", "protocol_wrapped",
      "final_provider_id", "attempt_count", "is_stream", "is_failover",
      "input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens",
      "cache_creation_tokens", "input_cost_usd", "cached_input_cost_usd",
      "cache_creation_cost_usd", "output_cost_usd", "total_cost_usd",
      "pricing_model", "pricing_source",
      "http_status", "error_category", "error_message",
      "termination_reason", "stream_phase", "last_stream_event", "upstream_response_id", "cost_status",
    ];
    const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
    if (entries.length === 0) return;
    this.db.prepare(`UPDATE requests SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  }

  updateAttempt(id, fields) {
    const allowed = [
      "headers_at", "headers_ms", "connection_reused", "network_connect_ms", "request_upload_ms",
      "upstream_wait_ms", "ended_at", "duration_ms", "status", "http_status", "error_category", "error_message",
      "input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens", "reasoning_tokens",
      "input_cost_usd", "cached_input_cost_usd", "cache_creation_cost_usd", "output_cost_usd", "total_cost_usd",
      "pricing_model", "pricing_source", "termination_reason", "stream_phase", "last_stream_event",
      "upstream_response_id", "actual_upstream_model", "cost_status",
      "upstream_protocol", "protocol_wrapped",
    ];
    const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
    if (entries.length === 0) return;
    this.db.prepare(`UPDATE request_attempts SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  }

  attemptNetworkTiming(attemptId) {
    return this.db.prepare(`
      SELECT connection_reused, network_connect_ms, request_upload_ms, upstream_wait_ms
      FROM request_attempts WHERE id = ?
    `).get(attemptId) ?? {};
  }

  observeAttemptPayload({ requestId, attemptId, upstreamModel, payload }) {
    const eventType = String(payload?.type || payload?.object || "");
    const sequenceNumber = Number(payload?.sequence_number);
    if (Number.isInteger(sequenceNumber) && sequenceNumber >= 0) {
      const previousSequence = this.streamSequenceNumbers.get(requestId) ?? -1;
      this.streamSequenceNumbers.set(requestId, Math.max(previousSequence, sequenceNumber));
    }
    const phase = streamPhaseForPayload(payload);
    const usage = extractUsage(payload);
    const responseId = extractResponseId(payload);
    const actualUpstreamModel = extractResponseModel(payload);
    const previous = this.attemptObservations.get(attemptId) ?? {};
    const usageChanged = usage && JSON.stringify(usage) !== JSON.stringify(previous.usage);
    const phaseChanged = phase && phase !== previous.phase;
    const responseChanged = responseId && responseId !== previous.responseId;
    const modelChanged = actualUpstreamModel && actualUpstreamModel !== previous.actualUpstreamModel;
    const importantEvent = eventType === "response.created"
      || eventType === "response.completed"
      || eventType === "response.incomplete"
      || eventType === "response.failed"
      || eventType === "chat.completion"
      || eventType === "chat.completion.chunk"
      || eventType === "error";
    if (!usageChanged && !phaseChanged && !responseChanged && !modelChanged && !importantEvent) {
      return actualUpstreamModel || previous.actualUpstreamModel || "";
    }

    const observation = {
      usage: usage ?? previous.usage,
      phase: phase ?? previous.phase,
      responseId: responseId || previous.responseId,
      actualUpstreamModel: actualUpstreamModel || previous.actualUpstreamModel,
    };
    this.attemptObservations.set(attemptId, observation);
    const usageFields = usage ? usageFieldsForModel(this.db, upstreamModel, usage, phase === "completed") : {};
    this.updateAttempt(attemptId, {
      ...usageFields,
      stream_phase: phase || undefined,
      last_stream_event: eventType || undefined,
      upstream_response_id: responseId || undefined,
      actual_upstream_model: actualUpstreamModel || undefined,
      cost_status: usageFields.cost_status,
    });
    if (actualUpstreamModel) this.updateRequest(requestId, { actual_upstream_model: actualUpstreamModel });
    this.syncRequestUsage(requestId);
    return observation.actualUpstreamModel || "";
  }

  syncRequestUsage(requestId) {
    const aggregate = this.db.prepare(`
      SELECT
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cached_tokens) AS cached_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(reasoning_tokens) AS reasoning_tokens,
        SUM(input_cost_usd) AS input_cost_usd,
        SUM(cached_input_cost_usd) AS cached_input_cost_usd,
        SUM(cache_creation_cost_usd) AS cache_creation_cost_usd,
        SUM(output_cost_usd) AS output_cost_usd,
        SUM(total_cost_usd) AS total_cost_usd,
        MAX(pricing_model) AS pricing_model,
        MAX(pricing_source) AS pricing_source,
        MAX(CASE WHEN cost_status = 'confirmed' THEN 1 ELSE 0 END) AS has_confirmed,
        MAX(CASE WHEN cost_status = 'partial' THEN 1 ELSE 0 END) AS has_partial,
        MAX(CASE WHEN cost_status = 'unknown' AND status <> 'connecting' THEN 1 ELSE 0 END) AS has_unknown,
        COUNT(*) AS attempt_count
      FROM request_attempts WHERE request_id = ?
    `).get(requestId);
    const costStatus = aggregate.attempt_count === 0
      ? "not_applicable"
      : aggregate.has_unknown
      ? (aggregate.total_cost_usd == null ? "unknown" : "partial")
      : aggregate.has_partial
        ? "partial"
        : aggregate.has_confirmed
          ? "confirmed"
          : "unknown";
    this.updateRequest(requestId, {
      input_tokens: aggregate.input_tokens,
      output_tokens: aggregate.output_tokens,
      cached_tokens: aggregate.cached_tokens,
      cache_creation_tokens: aggregate.cache_creation_tokens,
      reasoning_tokens: aggregate.reasoning_tokens,
      input_cost_usd: aggregate.input_cost_usd,
      cached_input_cost_usd: aggregate.cached_input_cost_usd,
      cache_creation_cost_usd: aggregate.cache_creation_cost_usd,
      output_cost_usd: aggregate.output_cost_usd,
      total_cost_usd: aggregate.total_cost_usd,
      pricing_model: aggregate.pricing_model,
      pricing_source: aggregate.pricing_source,
      cost_status: costStatus,
    });
    return costStatus;
  }

  requestCostStatus(requestId) {
    return this.db.prepare("SELECT cost_status FROM requests WHERE id = ?").get(requestId)?.cost_status || "unknown";
  }

  nextStreamSequence(requestId) {
    const next = (this.streamSequenceNumbers.get(requestId) ?? -1) + 1;
    this.streamSequenceNumbers.set(requestId, next);
    return next;
  }

  startStreamSampling(requestId, observedAtMono = performance.now()) {
    let sample = this.streamSamples.get(requestId);
    if (!sample) {
      sample = {
        started: false,
        terminalAtMono: null,
        interruptedAtMono: null,
        lastMeaningfulOutputMono: null,
        maxStreamChunkIdleMs: 0,
        maxMeaningfulOutputIdleMs: 0,
        streamChunkCount: 0,
        meaningfulOutputEventCount: 0,
      };
      this.streamSamples.set(requestId, sample);
    }
    if (!sample.started) {
      sample.started = true;
      sample.lastMeaningfulOutputMono = observedAtMono;
      sample.streamChunkCount = 1;
      sample.meaningfulOutputEventCount = 1;
    }
    return sample;
  }

  noteMeaningfulStreamOutput(requestId, observedAtMono = performance.now()) {
    const existing = this.streamSamples.get(requestId);
    if (!existing?.started) {
      this.startStreamSampling(requestId, observedAtMono);
      return;
    }
    if (existing.terminalAtMono != null) return;
    const idleMs = Math.max(0, Math.round(observedAtMono - existing.lastMeaningfulOutputMono));
    existing.maxMeaningfulOutputIdleMs = Math.max(existing.maxMeaningfulOutputIdleMs, idleMs);
    existing.lastMeaningfulOutputMono = observedAtMono;
    existing.meaningfulOutputEventCount += 1;
  }

  noteStreamChunkWait(requestId, idleMs, outcome) {
    const sample = this.streamSamples.get(requestId);
    if (!sample?.started || sample.terminalAtMono != null) return;
    if (outcome === "chunk") {
      sample.maxStreamChunkIdleMs = Math.max(sample.maxStreamChunkIdleMs, Math.max(0, Math.round(idleMs)));
      sample.streamChunkCount += 1;
    } else if (outcome === "error") {
      sample.interruptedAtMono = performance.now();
    }
  }

  noteStreamTerminal(requestId, observedAtMono = performance.now()) {
    const sample = this.streamSamples.get(requestId);
    if (!sample?.started || sample.terminalAtMono != null) return;
    const idleMs = Math.max(0, Math.round(observedAtMono - sample.lastMeaningfulOutputMono));
    sample.maxMeaningfulOutputIdleMs = Math.max(sample.maxMeaningfulOutputIdleMs, idleMs);
    sample.terminalAtMono = observedAtMono;
  }

  finishRequest(id, startedMono, fields) {
    const endedAt = new Date().toISOString();
    const finishedMono = performance.now();
    const duration = Math.max(0, Math.round(finishedMono - startedMono));
    const sample = this.streamSamples.get(id);
    this.streamSamples.delete(id);
    this.streamSequenceNumbers.delete(id);
    const includeFinalIdle = sample?.started
      && !["completed", "cancelled", "client_disconnected"].includes(fields.status)
      && !["user_cancelled", "client_disconnected"].includes(fields.termination_reason);
    const finalIdleEndMono = sample?.terminalAtMono ?? sample?.interruptedAtMono ?? finishedMono;
    const sampleFields = sample?.started ? {
      max_stream_chunk_idle_ms: sample.maxStreamChunkIdleMs,
      max_meaningful_output_idle_ms: sample.maxMeaningfulOutputIdleMs,
      final_output_idle_ms: includeFinalIdle
        ? Math.max(0, Math.round(finalIdleEndMono - sample.lastMeaningfulOutputMono))
        : null,
      stream_chunk_count: sample.streamChunkCount,
      meaningful_output_event_count: sample.meaningfulOutputEventCount,
    } : {};
    this.updateRequest(id, {
      ended_at: endedAt,
      duration_ms: duration,
      ...sampleFields,
      ...fields,
    });
    const request = getRequest(this.db, id);
    this.invalidateFirstTokenTimeoutCache(request);
    this.publish("request.finished", { request });
  }

  emitRequest(id, event) {
    this.publish(event, { request: getRequest(this.db, id) });
  }

  forwardHeaders(res, upstream, requestId) {
    for (const [key, value] of upstream.headers.entries()) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    }
    res.setHeader("x-codex-router-request-id", requestId);
  }

  forwardTransformedHeaders(res, requestId, stream) {
    res.setHeader("content-type", stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    if (stream) {
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
    }
    res.setHeader("x-codex-router-request-id", requestId);
  }

  markChatSupport(providerId, status, error = null) {
    this.db.prepare(`
      UPDATE providers
         SET chat_support_status = ?, chat_support_checked_at = ?, chat_support_error = ?, updated_at = ?
       WHERE id = ?
    `).run(status, new Date().toISOString(), error, new Date().toISOString(), providerId);
    this.publish("provider.changed", { provider: getProvider(this.db, providerId) });
  }

  stickyProvider(previousResponseId) {
    if (!previousResponseId) return null;
    const entry = this.stickyResponses.get(previousResponseId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.stickyResponses.delete(previousResponseId);
      return null;
    }
    return entry.providerId;
  }

  rememberSticky(responseId, providerId, ttlSeconds = 3600) {
    if (ttlSeconds <= 0) return;
    this.stickyResponses.set(responseId, { providerId, expiresAt: Date.now() + ttlSeconds * 1000 });
    if (this.stickyResponses.size > 5000) {
      const first = this.stickyResponses.keys().next().value;
      this.stickyResponses.delete(first);
    }
  }
}

export async function testProvider(db, dataDir, engine, providerId) {
  const provider = getProvider(db, providerId);
  if (!provider) throw new Error("中转不存在");
  const secret = getSecret(dataDir, provider.id);
  const started = performance.now();
  let response;
  try {
    response = await fetch(responsesUrl(provider.base_url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...parseHeaders(provider.headers_json),
      },
      body: JSON.stringify({
        model: provider.test_model,
        input: "Reply with OK.",
        max_output_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(provider.connect_timeout_ms + 15000),
    });
  } catch (error) {
    engine.recordFailure(provider, error?.name === "TimeoutError" ? "timeout" : "network");
    return { ok: false, latency_ms: Math.round(performance.now() - started), error: safeMessage(error) };
  }
  if (response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const streamBody = await response.text().catch(() => "");
    const latency = Math.round(performance.now() - started);
    const inspection = inspectTestStream(streamBody);
    if (!contentType.toLowerCase().includes("text/event-stream") || !inspection.completed) {
      engine.recordFailure(provider, "stream_protocol");
      return {
        ok: false,
        latency_ms: latency,
        status: response.status,
        model: provider.test_model,
        stream: true,
        error: !contentType.toLowerCase().includes("text/event-stream")
          ? "测试接口未返回 text/event-stream"
          : "SSE 流缺少 response.completed 结束事件",
      };
    }
    engine.recordSuccess(provider);
    return {
      ok: true,
      latency_ms: latency,
      status: response.status,
      model: provider.test_model,
      stream: true,
      event_count: inspection.eventCount,
    };
  }
  const text = await response.text().catch(() => "");
  const latency = Math.round(performance.now() - started);
  const classification = classifyStatus(response.status);
  if (classification.retryable || classification.auth) engine.recordFailure(provider, classification.category);
  return {
    ok: false,
    latency_ms: latency,
    status: response.status,
    model: provider.test_model,
    stream: true,
    error: extractUpstreamError(text, response.status),
  };
}

function inspectTestStream(value) {
  let eventCount = 0;
  let completed = false;
  for (const frame of value.split(/\r?\n\r?\n/)) {
    const eventName = frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!eventName && !data) continue;
    eventCount += 1;
    if (eventName === "response.completed") completed = true;
    if (data && data !== "[DONE]") {
      try {
        if (JSON.parse(data)?.type === "response.completed") completed = true;
      } catch {
        // Invalid data makes this frame unsuitable as a completion signal.
      }
    }
  }
  return { completed, eventCount };
}

function ruleMatches(rule, model) {
  if (rule.match_type === "default") return true;
  if (rule.match_type === "exact") return model === rule.model_pattern;
  if (rule.match_type === "prefix") return model.startsWith(rule.model_pattern);
  return false;
}

function weightedChoice(items) {
  const total = items.reduce((sum, item) => sum + Math.max(item.member.weight, 1), 0);
  let cursor = Math.random() * total;
  for (const item of items) {
    cursor -= Math.max(item.member.weight, 1);
    if (cursor <= 0) return item;
  }
  return items[items.length - 1];
}

function responsesUrl(baseUrl) {
  return responseEndpointUrl(baseUrl, "responses");
}

function responseEndpointUrl(baseUrl, endpoint) {
  return upstreamEndpointUrl(baseUrl, endpoint);
}

function upstreamHeaders(incoming, provider, secret, acceptOverride = null) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (
      !HOP_BY_HOP_HEADERS.has(key.toLowerCase()) &&
      key.toLowerCase() !== "authorization" &&
      key.toLowerCase() !== "accept-encoding" &&
      value != null
    ) {
      headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  headers["content-type"] = "application/json";
  headers.accept = acceptOverride || incoming.accept || "text/event-stream, application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  Object.assign(headers, parseHeaders(provider.headers_json));
  return headers;
}

function parseHeaders(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return { auth: true, retryable: false, category: "auth" };
  if (status === 429) return { auth: false, retryable: true, category: "rate_limit" };
  if (SAME_PROVIDER_RETRY_HTTP_STATUSES.has(status)) {
    return { auth: false, retryable: true, category: "server_error" };
  }
  if (status >= 500) return { auth: false, retryable: true, category: "upstream_5xx" };
  return { auth: false, retryable: false, category: "request_error" };
}

function retryAfterMs(headers) {
  const value = headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function extractUpstreamError(text, status) {
  try {
    const payload = JSON.parse(text);
    return String(payload.error?.message || payload.message || `上游返回 ${status}`).slice(0, 500);
  } catch {
    return text.trim().slice(0, 500) || `上游返回 ${status}`;
  }
}

function semanticFailureFromPayload(payload, status) {
  const type = String(payload?.type || "");
  const response = payload?.response ?? payload;
  const error = payload?.error ?? response?.error;
  const errorType = String(error?.type || payload?.error_type || response?.error_type || "");
  const code = String(error?.code || payload?.code || response?.code || (type === "openai_error" ? type : ""));
  const failedStatus = ["failed", "cancelled"].includes(String(response?.status || ""));
  if (!failedStatus && !["response.failed", "error", "openai_error"].includes(type) && !error) return null;
  const message = String(
    error?.message
      || (typeof error === "string" ? error : "")
      || payload?.message
      || response?.message
      || (failedStatus ? `Responses upstream ${response.status}` : "Responses upstream emitted an error before output"),
  );
  const category = sameProviderRetryCategory(status, message, code, errorType) || "upstream_semantic_failure";
  const errorStatus = status >= 400 ? status : category === "rate_limit" ? 429 : category === "capacity" ? 503 : 502;
  return new UpstreamSemanticFailureError(errorStatus, message, category, code);
}

function incompleteFailureFromPayload(payload) {
  const type = String(payload?.type || "");
  const response = payload?.response ?? payload;
  if (type !== "response.incomplete" && response?.status !== "incomplete") return null;
  const reason = String(response?.incomplete_details?.reason || "");
  if (reason === "max_output_tokens") {
    return {
      category: "incomplete_max_output_tokens",
      message: "输出达到最大 Token 限制，响应未完整结束",
      streamPhase: "incomplete",
      lastStreamEvent: "response.incomplete",
    };
  }
  if (reason === "content_filter") {
    return {
      category: "incomplete_content_filter",
      message: "内容被安全策略截断，响应未完整结束",
      streamPhase: "incomplete",
      lastStreamEvent: "response.incomplete",
    };
  }
  return {
    category: "response_incomplete",
    message: reason ? `上游响应未完整结束：${reason}` : "上游响应未完整结束",
    streamPhase: "incomplete",
    lastStreamEvent: "response.incomplete",
  };
}

function isCapacityError(message) {
  return /(?:at\s+capacity|capacity|try\s+a\s+different\s+model|overloaded)/i.test(String(message || ""));
}

function isRateLimitError(message) {
  return /(?:\b429\b|too\s+many\s+requests|rate[\s_-]*limit(?:ed)?|exceeded\s+(?:the\s+)?retry\s+limit)/i.test(String(message || ""));
}

function isTransientGatewayError(message) {
  return /(?:\b(?:408|425|502|503|504|52[0-7])\b|bad\s+gateway|service\s+unavailable|gateway\s+time(?:d?\s*out|out)|a\s+timeout\s+occurred|connection\s+timed\s+out|web\s+server\s+is\s+down|origin\s+is\s+unreachable|ssl\s+handshake\s+failed)/i.test(String(message || ""));
}

function isTransientSemanticTransportError(message) {
  return /(?:^upstream\s+request\s+failed$|websocket:\s*close\s+1006\b|unexpected\s+eof)/i.test(String(message || "").trim());
}

function isTransientHtmlGatewayResponse(response, body) {
  if (response.status !== 400) return false;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) return false;
  const gatewayEvidence = `${response.headers.get("server") || ""}\n${body}`;
  return /(?:cloudflare|cdn-cgi|cf-error-details|nginx|openresty)/i.test(gatewayEvidence);
}

function sameProviderRetryCategory(status, message, code = "", errorType = "") {
  const normalizedCode = String(code).toLowerCase();
  const normalizedErrorType = String(errorType).toLowerCase();
  if (status === 429 || normalizedCode === "rate_limit_exceeded" || isRateLimitError(message)) return "rate_limit";
  if (["server_error", "openai_error"].includes(normalizedCode)
    || ["server_error", "openai_error"].includes(normalizedErrorType)) return "server_error";
  if (normalizedCode === "vector_store_timeout") return "vector_store_timeout";
  if (isCapacityError(message)) return "capacity";
  if (SAME_PROVIDER_RETRY_HTTP_STATUSES.has(status) || isTransientGatewayError(message)
    || isTransientSemanticTransportError(message)) return "server_error";
  return null;
}

function extractUsage(payload) {
  const usage = payload?.response?.usage ?? payload?.usage ?? null;
  if (!usage) return null;
  if (usage.input_tokens != null || usage.output_tokens != null) return usage;
  if (usage.prompt_tokens != null || usage.completion_tokens != null) return chatUsageToResponseUsage(usage);
  return null;
}

function extractResponseModel(payload) {
  const model = payload?.response?.model ?? payload?.model;
  return typeof model === "string" ? model.trim() : "";
}

function extractReasoningEffort(body) {
  const effort = body?.reasoning?.effort ?? body?.reasoning_effort ?? body?.model_reasoning_effort;
  return typeof effort === "string" ? effort.trim() : "";
}

function usageFieldsForModel(db, model, usage, complete = false) {
  const cacheCreationTokens = usage?.input_tokens_details?.cache_creation_tokens
    ?? usage?.input_tokens_details?.cache_write_tokens
    ?? null;
  const hasTokens = usage?.input_tokens != null || usage?.output_tokens != null;
  const calculated = hasTokens
    ? calculateOfficialCost({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedTokens: usage.input_tokens_details?.cached_tokens,
      cacheCreationTokens,
      pricing: resolveModelPricing(db, model),
    })
    : null;
  return {
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cached_tokens: usage?.input_tokens_details?.cached_tokens ?? null,
    cache_creation_tokens: cacheCreationTokens,
    reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    ...(calculated ?? {}),
    cost_status: calculated ? (complete ? "confirmed" : "partial") : "unknown",
  };
}

function extractResponseId(payload) {
  return payload?.response?.id ?? payload?.id ?? "";
}

function isMeaningfulStreamOutput(payload) {
  const type = String(payload?.type || payload?.object || "");
  if (type === "chat.completion.chunk") {
    return (payload?.choices || []).some((choice) => {
      if (choice?.finish_reason != null) return true;
      const delta = choice?.delta || {};
      return Boolean(delta.content || delta.refusal || delta.tool_calls?.length || delta.function_call);
    });
  }
  if (["response.completed", "response.incomplete"].includes(type)) return true;
  if (!type.endsWith(".delta")) return false;
  const delta = payload?.delta ?? payload?.arguments_delta ?? payload?.text;
  return delta == null || (typeof delta === "string" ? delta.length > 0 : true);
}

function isStreamProgressPayload(payload) {
  const type = String(payload?.type || payload?.object || "");
  if (type === "chat.completion.chunk") {
    return (payload?.choices || []).some((choice) => {
      if (choice?.finish_reason != null) return true;
      const delta = choice?.delta || {};
      return Boolean(delta.content || delta.refusal || delta.tool_calls?.length || delta.function_call);
    });
  }
  if (type === "response.output_item.added") {
    return [
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
    ].includes(String(payload?.item?.type || ""));
  }
  if (/(?:\.in_progress|\.searching|\.generating|\.interpreting)$/.test(type)) {
    return /(?:web_search|file_search|computer|code_interpreter|image_generation|mcp|tool)/.test(type);
  }
  if (type === "response.image_generation_call.partial_image") return true;
  if (/\.completed$/.test(type)) {
    return /(?:web_search|file_search|computer|code_interpreter|image_generation|mcp|tool)/.test(type);
  }
  if (!type.endsWith(".delta")) return false;
  const delta = payload?.delta ?? payload?.arguments_delta ?? payload?.text;
  return typeof delta === "string" ? delta.length > 0 : delta != null;
}

function isTerminalStreamPayload(payload) {
  const type = typeof payload === "string"
    ? payload
    : String(payload?.type || payload?.object || "");
  if (["response.completed", "response.incomplete", "response.failed", "error"].includes(type)) return true;
  if (["chat.completion", "chat.completion.done"].includes(type)) return true;
  return type === "chat.completion.chunk"
    && (payload?.choices || []).some((choice) => choice?.finish_reason != null);
}

function isRaceSafeRequest(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return true;
  return body.tools.every((tool) => ["function", "custom"].includes(String(tool?.type || "")));
}

function createSseInspector(onPayload, onDone) {
  const decoder = new TextDecoder();
  let pending = "";
  const process = () => {
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      if (raw === "[DONE]") {
        onDone?.();
        continue;
      }
      try {
        onPayload(JSON.parse(raw));
      } catch {
        // Preserve unrecognized events without inspecting them.
      }
    }
  };
  return {
    push(buffer) {
      pending += decoder.decode(buffer, { stream: true });
      process();
    },
    finish() {
      pending += decoder.decode();
      pending += "\n";
      process();
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error("请求正文超过 20 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

function createRaceCandidate({
  requestId,
  attemptId,
  attemptMono,
  attemptController,
  requestTimer,
  provider,
  probe,
  upstream,
  onPayload,
  onMeaningfulOutput,
  onTerminal,
}) {
  const reader = upstream.body?.getReader();
  const candidate = {
    requestId,
    attemptId,
    attemptMono,
    attemptController,
    requestTimer,
    provider,
    probe,
    upstream,
    reader,
    buffered: [],
    parser: null,
    usage: {},
    responseId: "",
    actualUpstreamModel: "",
    lastStreamEvent: "",
    streamPhase: "connecting",
    semanticFailure: null,
    incompleteFailure: null,
    firstOutputRecorded: false,
    firstOutputCommitted: false,
    terminalReached: false,
    progressTracker: null,
    samplingEnabled: false,
    finished: false,
    firstEvent: null,
  };
  candidate.parser = createSseInspector((payload) => {
    candidate.usage = extractUsage(payload) ?? candidate.usage;
    candidate.responseId = extractResponseId(payload) || candidate.responseId;
    candidate.actualUpstreamModel = extractResponseModel(payload) || candidate.actualUpstreamModel;
    candidate.lastStreamEvent = String(payload?.type || candidate.lastStreamEvent || "");
    candidate.streamPhase = streamPhaseForPayload(payload) || candidate.streamPhase;
    onPayload?.(payload);
    candidate.semanticFailure ??= semanticFailureFromPayload(payload, upstream.status);
    candidate.incompleteFailure ??= incompleteFailureFromPayload(payload);
    if (candidate.samplingEnabled && !candidate.semanticFailure && isStreamProgressPayload(payload)) {
      candidate.progressTracker?.note();
      onMeaningfulOutput?.();
    }
    if (isTerminalStreamPayload(payload)) {
      candidate.terminalReached = true;
      candidate.progressTracker?.stop();
      if (candidate.samplingEnabled) onTerminal?.();
    }
    if (!candidate.semanticFailure && isMeaningfulStreamOutput(payload)) {
      candidate.firstOutputRecorded = true;
    }
  });
  candidate.firstEvent = Promise.resolve({ kind: "error", error: new Error("竞速流未启动") });
  return candidate;
}

function startRaceCandidatePump(candidate) {
  if (!candidate.reader) {
    candidate.firstEvent = Promise.resolve({ kind: "error", error: new Error("上游响应正文为空") });
    return candidate.firstEvent;
  }
  candidate.firstEvent = (async () => {
    try {
      while (!candidate.firstOutputRecorded && !candidate.semanticFailure) {
        const result = await candidate.reader.read();
        if (result.done) return { kind: "ended" };
        const buffer = Buffer.from(result.value);
        candidate.buffered.push(buffer);
        candidate.parser.push(buffer);
      }
      if (candidate.semanticFailure) return { kind: "semantic_failure", error: candidate.semanticFailure };
      return { kind: "output" };
    } catch (error) {
      return { kind: "error", error };
    }
  })();
  return candidate.firstEvent;
}

async function raceWithTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRaceWinner(candidates) {
  const pending = new Set(candidates);
  while (pending.size > 0) {
    const results = [...pending].map((candidate) => candidate.firstEvent.then((result) => ({ candidate, result })));
    const { candidate, result } = await Promise.race(results);
    pending.delete(candidate);
    if (result.kind === "output") return candidate;
  }
  return null;
}

async function readUntilFirstOutput({
  reader,
  parser,
  buffered,
  firstOutputSeen,
  attemptStartedMono,
  timeoutMs,
}) {
  const deadline = timeoutMs > 0 ? attemptStartedMono + timeoutMs : null;
  try {
    while (!firstOutputSeen()) {
      let result;
      if (deadline == null) {
        result = await reader.read();
      } else {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new FirstTokenTimeoutError(timeoutMs);
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new FirstTokenTimeoutError(timeoutMs)), remaining);
        });
        try {
          result = await Promise.race([reader.read(), timeout]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (result.done) return;
      const buffer = Buffer.from(result.value);
      buffered.push(buffer);
      parser.push(buffer);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  }
}

async function readUntilFirstConvertedOutput({
  reader,
  bridge,
  buffered,
  attemptStartedMono,
  timeoutMs,
}) {
  const deadline = timeoutMs > 0 ? attemptStartedMono + timeoutMs : null;
  try {
    while (!bridge.meaningfulOutput && !bridge.failure) {
      let result;
      if (deadline == null) {
        result = await reader.read();
      } else {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new FirstTokenTimeoutError(timeoutMs);
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new FirstTokenTimeoutError(timeoutMs)), remaining);
        });
        try {
          result = await Promise.race([reader.read(), timeout]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (result.done) {
        buffered.push(...bridge.finish());
        return;
      }
      buffered.push(...bridge.push(Buffer.from(result.value)));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  }
}

async function* streamReaderWithIdleTimeout(reader, timeoutMs, progressTracker = null, onIdle = null) {
  let readerDone = false;
  try {
    while (true) {
      const idleStartedMono = performance.now();
      const timers = [];
      const waits = [reader.read()];
      if (timeoutMs > 0) {
        waits.push(new Promise((_, reject) => {
          timers.push(setTimeout(() => reject(new RouterTimeoutError(
            "stream_idle_timeout",
            timeoutMs,
            `首字后连续 ${Math.round(timeoutMs / 1000)} 秒未收到上游数据`,
          )), timeoutMs));
        }));
      }
      const progressRemainingMs = progressTracker?.remaining() ?? Infinity;
      if (Number.isFinite(progressRemainingMs)) {
        waits.push(new Promise((_, reject) => {
          timers.push(setTimeout(() => reject(new RouterTimeoutError(
            "stream_progress_timeout",
            progressTracker.timeoutMs,
            `首字后连续 ${Math.round(progressTracker.timeoutMs / 1000)} 秒无有效进展`,
          )), progressRemainingMs));
        }));
      }
      let result;
      try {
        result = await Promise.race(waits);
      } catch (error) {
        onIdle?.(performance.now() - idleStartedMono, "error");
        throw error;
      } finally {
        for (const timer of timers) clearTimeout(timer);
      }
      if (result.done) {
        readerDone = true;
        onIdle?.(performance.now() - idleStartedMono, "end");
        return;
      }
      onIdle?.(performance.now() - idleStartedMono, "chunk");
      yield result.value;
    }
  } catch (error) {
    throw error;
  } finally {
    if (!readerDone) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* streamWithIdleTimeout(stream, timeoutMs, onIdle = null) {
  if (!stream) throw new Error("上游响应正文为空");
  yield* streamReaderWithIdleTimeout(stream.getReader(), timeoutMs, null, onIdle);
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

function errorBody(message, requestId) {
  return {
    error: {
      message,
      type: "codex_router_error",
      request_id: requestId,
    },
  };
}

function writeProtocolStreamError(res, protocol, error, requestId, sequenceNumber = 0) {
  if (res.writableEnded || res.destroyed) return;
  const category = streamFailureCategory(error);
  const message = safeMessage(error);
  const payload = {
    error: {
      message,
      type: "server_error",
      param: null,
      code: category,
    },
    request_id: requestId,
  };
  if (protocol === "chat") {
    res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    return;
  }
  res.end(`event: error\ndata: ${JSON.stringify({
    type: "error",
    code: category,
    message,
    param: null,
    sequence_number: Number.isInteger(sequenceNumber) ? sequenceNumber : 0,
  })}\n\n`);
}

function chatCompatibilityErrorBody(error, requestId) {
  return {
    error: {
      message: error.message,
      type: "invalid_request_error",
      param: error.param,
      code: error.code,
      request_id: requestId,
    },
  };
}

function bridgeFailureError(failure, status) {
  const message = String(failure?.message || "Responses upstream failed");
  const code = String(failure?.code || "");
  const errorType = String(failure?.type || "");
  const category = sameProviderRetryCategory(status, message, code, errorType) || "upstream_semantic_failure";
  const errorStatus = status >= 400 ? status : category === "rate_limit" ? 429 : category === "capacity" ? 503 : 502;
  const error = new UpstreamSemanticFailureError(errorStatus, message, category, code);
  error.streamPhase = "failed";
  error.lastStreamEvent = "response.failed";
  return error;
}

function safeMessage(error) {
  return String(error?.message || error || "未知错误").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
}

export function isActiveRequest(request) {
  return ACTIVE_STATUSES.has(request?.status);
}
