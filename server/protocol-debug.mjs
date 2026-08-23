import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const DEBUG_ENABLED = process.env.CODEX_ROUTER_PROTOCOL_DEBUG === "1";

export function createProtocolDebugger(dataDir) {
  if (!DEBUG_ENABLED) return () => {};
  const file = process.env.CODEX_ROUTER_PROTOCOL_DEBUG_FILE || join(dataDir, "protocol-debug.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  let sequence = 0;
  let writeFailed = false;
  return (event, payload = {}) => {
    try {
      appendFileSync(file, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        sequence: ++sequence,
        event,
        ...payload,
      })}\n`, "utf8");
    } catch (error) {
      if (!writeFailed) {
        writeFailed = true;
        console.error("[router] protocol debug log failed", error);
      }
    }
  };
}

export function summarizeChatRequest(body, headers) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return {
    top_level_keys: objectKeys(body),
    model: typeof body?.model === "string" ? body.model : null,
    stream: body?.stream === true,
    message_count: messages.length,
    messages: messages.map((message, index) => ({
      index,
      role: String(message?.role || ""),
      content: summarizeValue(message?.content),
      tool_call_count: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
      has_function_call: message?.function_call != null,
    })),
    tools: Array.isArray(body?.tools) ? body.tools.map((tool) => ({ type: tool?.type || null, has_function: Boolean(tool?.function) })) : [],
    metadata_keys: objectKeys(body?.metadata),
    client_metadata_keys: objectKeys(body?.client_metadata),
    cache: {
      prompt_cache_key: summarizeSecretLike(body?.prompt_cache_key),
      prompt_cache_options_keys: objectKeys(body?.prompt_cache_options),
      prompt_cache_retention: body?.prompt_cache_retention ?? null,
      previous_response_id: summarizeSecretLike(body?.previous_response_id),
    },
    headers: summarizeHeaders(headers),
  };
}

export function summarizeResponsesRequest(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return {
    top_level_keys: objectKeys(body),
    model: typeof body?.model === "string" ? body.model : null,
    stream: body?.stream === true,
    input_count: input.length,
    input_types: input.map((item) => item?.type || "message"),
    input_roles: input.map((item) => item?.role || null),
    input_content: input.map((item) => summarizeValue(item?.content)),
    tools: Array.isArray(body?.tools) ? body.tools.map((tool) => ({ type: tool?.type || null, name: tool?.name || null })) : [],
    instructions: summarizeValue(body?.instructions),
    metadata_keys: objectKeys(body?.metadata),
    cache: {
      prompt_cache_key: summarizeSecretLike(body?.prompt_cache_key),
      prompt_cache_options_keys: objectKeys(body?.prompt_cache_options),
      prompt_cache_retention: body?.prompt_cache_retention ?? null,
      previous_response_id: summarizeSecretLike(body?.previous_response_id),
    },
  };
}

export function summarizeHeaders(headers) {
  const names = [
    "thread-id",
    "session-id",
    "x-thread-id",
    "x-session-id",
    "x-conversation-id",
    "x-codex-turn-metadata",
    "x-client-request-id",
    "user-agent",
    "accept",
    "content-type",
  ];
  return Object.fromEntries(names.map((name) => {
    const value = Array.isArray(headers?.[name]) ? headers[name].join(", ") : headers?.[name];
    return [name, summarizeSecretLike(value)];
  }));
}

export function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    keys: objectKeys(usage),
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? null,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? null,
    cached_tokens: usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? null,
    input_details_keys: objectKeys(usage.input_tokens_details || usage.prompt_tokens_details),
    output_details_keys: objectKeys(usage.output_tokens_details || usage.completion_tokens_details),
  };
}

function objectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

function summarizeValue(value) {
  if (value == null) return { kind: "null", chars: 0, hash: null };
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return {
    kind: Array.isArray(value) ? "array" : typeof value,
    chars: serialized.length,
    hash: hash(serialized),
  };
}

function summarizeSecretLike(value) {
  if (value == null || value === "") return { present: false, chars: 0, hash: null };
  const serialized = Array.isArray(value) ? value.join(", ") : String(value);
  return { present: true, chars: serialized.length, hash: hash(serialized) };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
