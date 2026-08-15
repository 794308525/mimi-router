import { randomUUID } from "node:crypto";
import { getAdaptiveFirstTokenTimeout, getProvider, getRequest, getRouterSettings, listRoutes, publicProvider, resolveModelPricing } from "./db.mjs";
import { getSecret } from "./secrets.mjs";
import { DEFAULT_MODEL } from "./constants.mjs";
import { calculateOfficialCost } from "./pricing.mjs";
import { fetchWithNetworkTiming, networkTimingForError } from "./network-timing.mjs";

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
  "vector_store_timeout",
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

function streamPhaseForPayload(payload) {
  const type = String(payload?.type || "");
  if (type === "response.created") return "headers";
  if (type === "response.completed") return "completed";
  if (type === "response.incomplete") return "incomplete";
  if (type === "response.failed" || type === "error") return "failed";
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
  }

  async handle(req, res, { upstreamEndpoint = "responses" } = {}) {
    const requestId = randomUUID();
    const startedAt = new Date();
    const startedMono = performance.now();
    this.createRequest(requestId, startedAt);
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
    const isStream = upstreamEndpoint === "responses" && body.stream === true;
    this.updateRequest(requestId, {
      status: "routing",
      requested_model: requestedModel,
      is_stream: isStream ? 1 : 0,
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
      const upstreamBody = { ...body, model: upstreamModel };

      this.beginAttempt(requestId, attemptId, sequence, provider, attemptStarted, upstreamModel);
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
      const requestTimer = setTimeout(
        () => attemptController.abort(new DOMException("上游请求超时", "TimeoutError")),
        provider.request_timeout_ms,
      );
      try {
        const secret = getSecret(this.dataDir, provider.id);
        const signal = AbortSignal.any([clientController.signal, attemptController.signal]);
        const timedFetch = await fetchWithNetworkTiming(responseEndpointUrl(provider.base_url, upstreamEndpoint), {
          method: "POST",
          headers: upstreamHeaders(req.headers, provider, secret),
          body: JSON.stringify(upstreamBody),
          signal,
        });
        upstream = timedFetch.response;
        clearTimeout(connectTimer);
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
        clearTimeout(connectTimer);
        clearTimeout(requestTimer);
        this.updateAttempt(attemptId, networkTimingForError(error) ?? {});
        this.releaseProvider(provider.id, probe);
        const terminationReason = clientTerminationReason(clientController);
        const category = terminationReason || (error?.name === "TimeoutError" ? "timeout" : "network");
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

      const classification = classifyStatus(upstream.status);
      if (classification.retryable || classification.auth) {
        const responseText = await upstream.text().catch(() => "");
        clearTimeout(requestTimer);
        this.releaseProvider(provider.id, probe);
        const message = extractUpstreamError(responseText, upstream.status);
        const retryCategory = sameProviderRetryCategory(upstream.status, message);
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
        const responseBuffer = Buffer.from(await upstream.arrayBuffer());
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
          stickyTtlSeconds: route.group.sticky_enabled ? route.group.sticky_ttl_seconds : 0,
          streamIdleTimeoutMs: provider.stream_idle_timeout_ms,
          firstTokenTimeoutMs: isStream
            ? this.resolveFirstTokenTimeoutMs(routerSettings, provider.id, requestedModel)
            : 0,
          attemptController,
          requestTimer,
        };
        if (isStream && firstTokenTimeoutMode.startsWith("race_") && forwardContext.firstTokenTimeoutMs > 0) {
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
        const category = terminationReason || "stream_interrupted";
        const message = terminationReason ? terminationMessage(terminationReason) : safeMessage(error);
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
        if (!res.headersSent) sendJson(res, 502, errorBody("上游流式响应中断", requestId));
        else res.destroy(error);
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
    const requestTimer = setTimeout(
      () => attemptController.abort(new DOMException("上游请求超时", "TimeoutError")),
      provider.request_timeout_ms,
    );
    try {
      const secret = getSecret(this.dataDir, provider.id);
      const signal = AbortSignal.any([clientController.signal, attemptController.signal]);
      const timedFetch = await fetchWithNetworkTiming(responsesUrl(provider.base_url), {
        method: "POST",
        headers: upstreamHeaders(req.headers, provider, secret),
        body: JSON.stringify(upstreamBody),
        signal,
      });
      const upstream = timedFetch.response;
      clearTimeout(connectTimer);
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
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      this.updateAttempt(attemptId, networkTimingForError(error) ?? {});
      this.releaseProvider(provider.id, probe);
      const terminationReason = clientTerminationReason(clientController);
      const category = terminationReason || (error?.name === "TimeoutError" ? "timeout" : "network");
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
      });
      startRaceCandidatePump(fallbackCandidate);
    } else if (fallback?.ok) {
      await this.finishRaceNonStreamAttempt(fallback);
    }

    if (!fallbackCandidate) {
      const late = await original.firstEvent;
      if (late.kind === "output") {
        await this.forwardRaceCandidate({
          candidate: original,
          requestId,
          requestStartedMono,
          upstreamModel,
          res,
          stickyTtlSeconds,
          streamIdleTimeoutMs,
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
    await this.cancelRaceCandidate(loser, "cancelled", "race_lost");
    await this.forwardRaceCandidate({
      candidate: winner,
      requestId,
      requestStartedMono,
      upstreamModel,
      res,
      stickyTtlSeconds,
      streamIdleTimeoutMs,
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
    clientController,
  }) {
    const { upstream, reader, parser, buffered, provider, probe, attemptId, attemptMono, requestTimer } = candidate;
    this.markRaceFirstOutput(candidate, requestId, requestStartedMono);
    try {
      this.forwardHeaders(res, upstream, requestId);
      res.statusCode = upstream.status;
      res.flushHeaders();
      for (const buffer of buffered) {
        if (!res.write(buffer)) await onceDrain(res);
      }
      for await (const chunk of streamReaderWithIdleTimeout(reader, streamIdleTimeoutMs)) {
        const buffer = Buffer.from(chunk);
        parser.push(buffer);
        if (candidate.semanticFailure && !candidate.firstOutputRecorded) throw candidate.semanticFailure;
        if (!res.write(buffer)) await onceDrain(res);
      }
      parser.finish();
      if (candidate.semanticFailure && !candidate.firstOutputRecorded) throw candidate.semanticFailure;
      res.end();
    } catch (error) {
      clearTimeout(requestTimer);
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
      })) return;
      this.releaseProvider(provider.id, probe);
      const terminationReason = clientTerminationReason(clientController);
      const category = terminationReason || "stream_interrupted";
      const message = terminationReason ? terminationMessage(terminationReason) : safeMessage(error);
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
      if (!res.headersSent) sendJson(res, 502, errorBody("上游流式响应中断", requestId));
      else res.destroy(error);
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
    });
  }

  markRaceFirstOutput(candidate, requestId, requestStartedMono) {
    if (candidate.firstOutputCommitted) return;
    candidate.firstOutputCommitted = true;
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
      stickyTtlSeconds,
      streamIdleTimeoutMs,
      firstTokenTimeoutMs,
      requestTimer,
    } = context;

    let usage = {};
    let responseId = "";
    let firstOutputRecorded = false;
    let semanticFailure = null;
    let incompleteFailure = null;
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
      this.recordFirstTokenSuccess(provider);
      this.emitRequest(requestId, "request.status_changed");
    };

    try {
      if (isStream) {
        const parser = createSseInspector((payload) => {
          usage = extractUsage(payload) ?? usage;
          responseId = extractResponseId(payload) || responseId;
          this.observeAttemptPayload({ requestId, attemptId, upstreamModel, payload });
          semanticFailure ??= semanticFailureFromPayload(payload, upstream.status);
          incompleteFailure ??= incompleteFailureFromPayload(payload);
          if (!semanticFailure && isMeaningfulStreamOutput(payload)) markFirstOutput();
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
        if (!firstOutputRecorded) markFirstOutput();
        this.forwardHeaders(res, upstream, requestId);
        res.statusCode = upstream.status;
        res.flushHeaders();
        for (const buffer of buffered) {
          if (!res.write(buffer)) await onceDrain(res);
        }
        for await (const chunk of streamReaderWithIdleTimeout(reader, streamIdleTimeoutMs)) {
          const buffer = Buffer.from(chunk);
          parser.push(buffer);
          if (semanticFailure && !firstOutputRecorded) throw semanticFailure;
          if (!res.write(buffer)) await onceDrain(res);
        }
        parser.finish();
        if (semanticFailure && !firstOutputRecorded) throw semanticFailure;
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
          this.observeAttemptPayload({ requestId, attemptId, upstreamModel, payload });
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
        failure: semanticFailure,
        affectsProviderHealth: true,
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
        failure: incompleteFailure,
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
      usage,
      responseId,
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
  }) {
    if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
      this.updateAttempt(attemptId, {
        ...usageFieldsForModel(this.db, upstreamModel, usage, true),
        stream_phase: "completed",
        last_stream_event: "response.completed",
        upstream_response_id: responseId || undefined,
      });
    }
    this.syncRequestUsage(requestId);
    this.releaseProvider(provider.id, probe);
    this.recordSuccess(provider);
    this.finishAttempt(attemptId, attemptMono, "completed", upstream.status, null, null, {
      termination_reason: null,
      stream_phase: "completed",
      last_stream_event: "response.completed",
      upstream_response_id: responseId || undefined,
      cost_status: this.requestCostStatus(requestId),
    });
    this.publishAttempt(requestId, attemptId);
    if (responseId) this.rememberSticky(responseId, provider.id, stickyTtlSeconds);
    this.finishRequest(requestId, requestStartedMono, {
      status: "completed",
      http_status: upstream.status,
      final_provider_id: provider.id,
      upstream_model: upstreamModel,
      termination_reason: null,
      stream_phase: "completed",
      last_stream_event: "response.completed",
      upstream_response_id: responseId || undefined,
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
    failure,
    affectsProviderHealth,
  }) {
    const usageFields = usage && (usage.input_tokens != null || usage.output_tokens != null)
      ? usageFieldsForModel(this.db, upstreamModel, usage, true)
      : { cost_status: "unknown" };
    this.updateAttempt(attemptId, {
      ...usageFields,
      stream_phase: failure.streamPhase || "failed",
      last_stream_event: failure.lastStreamEvent || "response.failed",
      upstream_response_id: responseId || undefined,
    });
    this.releaseProvider(provider.id, probe);
    if (affectsProviderHealth) this.recordFailure(provider, failure.category);
    this.finishAttempt(attemptId, attemptMono, "failed", upstream.status, failure.category, failure.message, {
      termination_reason: failure.category,
      stream_phase: failure.streamPhase || "failed",
      last_stream_event: failure.lastStreamEvent || "response.failed",
      upstream_response_id: responseId || undefined,
      cost_status: usageFields.cost_status,
    });
    this.publishAttempt(requestId, attemptId);
    const costStatus = this.syncRequestUsage(requestId);
    this.finishRequest(requestId, requestStartedMono, {
      status: "failed",
      http_status: upstream.status,
      final_provider_id: provider.id,
      upstream_model: upstreamModel,
      error_category: failure.category,
      error_message: failure.message,
      termination_reason: failure.category,
      stream_phase: failure.streamPhase || "failed",
      last_stream_event: failure.lastStreamEvent || "response.failed",
      upstream_response_id: responseId || undefined,
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

  acquireProvider(providerId) {
    this.inFlight.set(providerId, (this.inFlight.get(providerId) ?? 0) + 1);
  }

  releaseProvider(providerId, probe) {
    this.inFlight.set(providerId, Math.max(0, (this.inFlight.get(providerId) ?? 1) - 1));
    if (probe) this.halfOpenProbes.delete(providerId);
  }

  recordSuccess(provider) {
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      UPDATE providers SET health_status = 'healthy', circuit_state = 'closed',
        circuit_open_until = NULL, consecutive_failures = 0,
        consecutive_slow_first_tokens = 0,
        last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
    `).run(timestamp, timestamp, provider.id);
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
    this.publish("circuit.state_changed", { provider_id: providerId, state: "closed" });
    return getProvider(this.db, providerId);
  }

  cancelRequest(requestId) {
    const controller = this.controllers.get(requestId);
    if (!controller) return false;
    if (!controller.signal.aborted) controller.abort(abortError("user_cancelled", "用户从管理界面取消请求"));
    return true;
  }

  createRequest(id, startedAt) {
    this.db.prepare(
      "INSERT INTO requests (id, started_at, status, requested_model) VALUES (?, ?, 'received', '')",
    ).run(id, startedAt.toISOString());
  }

  beginAttempt(requestId, attemptId, sequence, provider, startedAt, upstreamModel) {
    const current = this.db.prepare(
      "SELECT final_provider_id, is_failover FROM requests WHERE id = ?",
    ).get(requestId);
    const changedProvider = Boolean(current?.final_provider_id && current.final_provider_id !== provider.id);
    this.db.prepare(`
      INSERT INTO request_attempts (id, request_id, sequence, provider_id, started_at, status)
      VALUES (?, ?, ?, ?, ?, 'connecting')
    `).run(attemptId, requestId, sequence, provider.id, startedAt.toISOString());
    this.updateRequest(requestId, {
      status: "connecting",
      final_provider_id: provider.id,
      upstream_model: upstreamModel,
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
      "upstream_wait_ms", "first_byte_at", "ended_at", "duration_ms", "ttft_ms", "status",
      "requested_model", "upstream_model", "route_rule_id", "route_group_id",
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
      "upstream_response_id", "cost_status",
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
    const eventType = String(payload?.type || "");
    const phase = streamPhaseForPayload(payload);
    const usage = extractUsage(payload);
    const responseId = extractResponseId(payload);
    const previous = this.attemptObservations.get(attemptId) ?? {};
    const usageChanged = usage && JSON.stringify(usage) !== JSON.stringify(previous.usage);
    const phaseChanged = phase && phase !== previous.phase;
    const responseChanged = responseId && responseId !== previous.responseId;
    const importantEvent = eventType === "response.created"
      || eventType === "response.completed"
      || eventType === "response.incomplete"
      || eventType === "response.failed"
      || eventType === "error";
    if (!usageChanged && !phaseChanged && !responseChanged && !importantEvent) return;

    const observation = { usage: usage ?? previous.usage, phase: phase ?? previous.phase, responseId: responseId || previous.responseId };
    this.attemptObservations.set(attemptId, observation);
    const usageFields = usage ? usageFieldsForModel(this.db, upstreamModel, usage, phase === "completed") : {};
    this.updateAttempt(attemptId, {
      ...usageFields,
      stream_phase: phase || undefined,
      last_stream_event: eventType || undefined,
      upstream_response_id: responseId || undefined,
      cost_status: usageFields.cost_status,
    });
    this.syncRequestUsage(requestId);
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

  finishRequest(id, startedMono, fields) {
    const endedAt = new Date().toISOString();
    const duration = Math.max(0, Math.round(performance.now() - startedMono));
    this.updateRequest(id, { ended_at: endedAt, duration_ms: duration, ...fields });
    this.emitRequest(id, "request.finished");
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
  const normalized = baseUrl.replace(/\/+$/, "");
  if (endpoint === "responses/compact") {
    if (normalized.endsWith("/responses/compact")) return normalized;
    if (normalized.endsWith("/responses")) return `${normalized}/compact`;
    return `${normalized}/responses/compact`;
  }
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function upstreamHeaders(incoming, provider, secret) {
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
  headers.accept = incoming.accept || "text/event-stream, application/json";
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
  const code = String(error?.code || payload?.code || response?.code || "");
  const failedStatus = ["failed", "cancelled"].includes(String(response?.status || ""));
  if (!failedStatus && type !== "response.failed" && type !== "error" && !error) return null;
  const message = String(
    error?.message
      || (typeof error === "string" ? error : "")
      || payload?.message
      || response?.message
      || (failedStatus ? `Responses upstream ${response.status}` : "Responses upstream emitted an error before output"),
  );
  const category = sameProviderRetryCategory(status, message, code) || "upstream_semantic_failure";
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

function sameProviderRetryCategory(status, message, code = "") {
  if (status === 429 || code === "rate_limit_exceeded" || isRateLimitError(message)) return "rate_limit";
  if (code === "server_error") return "server_error";
  if (code === "vector_store_timeout") return "vector_store_timeout";
  if (isCapacityError(message)) return "capacity";
  return null;
}

function extractUsage(payload) {
  return payload?.response?.usage ?? payload?.usage ?? null;
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
  const type = String(payload?.type || "");
  if (["response.completed", "response.incomplete"].includes(type)) return true;
  if (!type.endsWith(".delta")) return false;
  const delta = payload?.delta ?? payload?.arguments_delta ?? payload?.text;
  return delta == null || (typeof delta === "string" ? delta.length > 0 : true);
}

function isRaceSafeRequest(body) {
  return !Array.isArray(body?.tools) || body.tools.length === 0;
}

function createSseInspector(onPayload) {
  const decoder = new TextDecoder();
  let pending = "";
  const process = () => {
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
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
    lastStreamEvent: "",
    streamPhase: "connecting",
    semanticFailure: null,
    incompleteFailure: null,
    firstOutputRecorded: false,
    firstOutputCommitted: false,
    finished: false,
    firstEvent: null,
  };
  candidate.parser = createSseInspector((payload) => {
    candidate.usage = extractUsage(payload) ?? candidate.usage;
    candidate.responseId = extractResponseId(payload) || candidate.responseId;
    candidate.lastStreamEvent = String(payload?.type || candidate.lastStreamEvent || "");
    candidate.streamPhase = streamPhaseForPayload(payload) || candidate.streamPhase;
    onPayload?.(payload);
    candidate.semanticFailure ??= semanticFailureFromPayload(payload, upstream.status);
    candidate.incompleteFailure ??= incompleteFailureFromPayload(payload);
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

async function* streamReaderWithIdleTimeout(reader, timeoutMs) {
  try {
    while (true) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DOMException("上游流式响应空闲超时", "TimeoutError")), timeoutMs);
      });
      let result;
      try {
        result = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) return;
      yield result.value;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function* streamWithIdleTimeout(stream, timeoutMs) {
  if (!stream) throw new Error("上游响应正文为空");
  yield* streamReaderWithIdleTimeout(stream.getReader(), timeoutMs);
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

function safeMessage(error) {
  return String(error?.message || error || "未知错误").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
}

export function isActiveRequest(request) {
  return ACTIVE_STATUSES.has(request?.status);
}
