export class ChatCompatibilityError extends Error {
  constructor(message, param = null) {
    super(message);
    this.name = "ChatCompatibilityError";
    this.status = 400;
    this.param = param;
    this.code = "unsupported_chat_parameter";
  }
}

export function upstreamEndpointUrl(baseUrl, endpoint) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  const root = normalized
    .replace(/\/responses\/compact$/, "")
    .replace(/\/responses$/, "")
    .replace(/\/chat\/completions$/, "");
  return `${root}/${endpoint}`;
}

export function isChatEndpointUnsupported(status, responseText) {
  const parsed = safeJson(responseText, {});
  const code = String(parsed?.error?.code || parsed?.code || "").toLowerCase();
  const message = String(parsed?.error?.message || parsed?.message || responseText || "");
  if (code === "model_not_found" || /model[^\n]*(?:not found|does not exist)/i.test(message)) return false;
  if ([405, 501].includes(status)) return true;
  if (status === 404) return true;
  return ["unsupported_endpoint", "endpoint_not_supported", "not_implemented"].includes(code);
}

export function chatRequestToResponses(body) {
  if (!Array.isArray(body?.messages)) {
    throw new ChatCompatibilityError("Chat Completions 请求缺少 messages 数组", "messages");
  }
  rejectUnsupportedChatFields(body);

  const input = [];
  for (const message of body.messages) input.push(...chatMessageToResponseItems(message));
  const result = {
    model: body.model,
    input,
    stream: true,
  };

  copyDefined(body, result, [
    "metadata",
    "moderation",
    "parallel_tool_calls",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "safety_identifier",
    "service_tier",
    "store",
    "temperature",
    "top_p",
    "user",
  ]);
  if (body.max_completion_tokens != null) result.max_output_tokens = body.max_completion_tokens;
  else if (body.max_tokens != null) result.max_output_tokens = body.max_tokens;
  if (body.reasoning_effort != null) result.reasoning = { effort: body.reasoning_effort };
  if (body.tools != null) result.tools = body.tools.map(chatToolToResponseTool);
  if (body.tool_choice != null) result.tool_choice = chatToolChoiceToResponseToolChoice(body.tool_choice);

  const text = {};
  if (body.response_format != null) text.format = chatResponseFormatToResponseFormat(body.response_format);
  if (body.verbosity != null) text.verbosity = body.verbosity;
  if (Object.keys(text).length > 0) result.text = text;
  return result;
}

export function createResponsesToChatBridge({ stream, includeUsage, requestedModel, onPayload }) {
  const state = {
    id: `chatcmpl_router_${Date.now().toString(36)}`,
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || "",
    serviceTier: null,
    text: "",
    refusal: "",
    annotations: [],
    tools: [],
    toolsByItem: new Map(),
    usage: null,
    roleSent: false,
    finishSent: false,
    doneSent: false,
    meaningfulOutput: false,
    completed: false,
    finishReason: null,
    failure: null,
    output: [],
  };
  const decoder = createSseDecoder(handlePayload);

  function emit(value) {
    if (!stream) return;
    state.output.push(Buffer.from(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`));
  }

  function chunk(choices, usage) {
    return {
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices,
      ...(state.serviceTier ? { service_tier: state.serviceTier } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  function ensureRole() {
    if (state.roleSent || !stream) return;
    state.roleSent = true;
    emit(chunk([{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }]));
  }

  function ensureTool(item, outputIndex, emitHeader = true) {
    const itemId = String(item?.id || item?.item_id || `output_${outputIndex}`);
    let tool = state.toolsByItem.get(itemId);
    if (!tool) {
      tool = {
        index: state.tools.length,
        id: String(item?.call_id || item?.id || `call_${outputIndex}`),
        name: String(item?.name || ""),
        arguments: "",
        headerSent: false,
      };
      state.tools.push(tool);
      state.toolsByItem.set(itemId, tool);
    } else {
      tool.id = String(item?.call_id || tool.id);
      tool.name = String(item?.name || tool.name);
    }
    if (stream && emitHeader && !tool.headerSent) {
      ensureRole();
      tool.headerSent = true;
      emit(chunk([{
        index: 0,
        delta: {
          tool_calls: [{
            index: tool.index,
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: "" },
          }],
        },
        logprobs: null,
        finish_reason: null,
      }]));
    }
    return tool;
  }

  function updateResponseMetadata(response) {
    if (!response || typeof response !== "object") return;
    if (response.id) state.id = chatCompletionId(response.id);
    if (Number.isFinite(response.created_at)) state.created = Math.floor(response.created_at);
    if (response.model) state.model = String(response.model);
    if (response.service_tier) state.serviceTier = String(response.service_tier);
    if (response.usage) state.usage = responseUsageToChatUsage(response.usage);
  }

  function hydrateOutput(response) {
    for (const [outputIndex, item] of (response?.output || []).entries()) {
      if (item?.type === "message") {
        const text = (item.content || []).filter((part) => part?.type === "output_text").map((part) => part.text || "").join("");
        const refusal = (item.content || []).filter((part) => part?.type === "refusal").map((part) => part.refusal || "").join("");
        const annotations = (item.content || []).flatMap((part) => part?.annotations || []);
        if (!state.text && text) {
          state.text = text;
          state.meaningfulOutput = true;
          if (stream) {
            ensureRole();
            emit(chunk([{ index: 0, delta: { content: text }, logprobs: null, finish_reason: null }]));
          }
        }
        if (!state.refusal && refusal) {
          state.refusal = refusal;
          state.meaningfulOutput = true;
          if (stream) {
            ensureRole();
            emit(chunk([{ index: 0, delta: { refusal }, logprobs: null, finish_reason: null }]));
          }
        }
        if (state.annotations.length === 0 && annotations.length > 0) state.annotations = annotations;
      }
      if (item?.type === "function_call") {
        const tool = ensureTool(item, outputIndex);
        if (!tool.arguments && item.arguments) {
          tool.arguments = String(item.arguments);
          state.meaningfulOutput = true;
          if (stream) {
            emit(chunk([{
              index: 0,
              delta: { tool_calls: [{ index: tool.index, function: { arguments: tool.arguments } }] },
              logprobs: null,
              finish_reason: null,
            }]));
          }
        }
      }
    }
  }

  function finish(reason) {
    if (state.finishSent) return;
    state.finishReason = reason;
    state.completed = true;
    state.meaningfulOutput = true;
    if (!stream) return;
    ensureRole();
    state.finishSent = true;
    emit(chunk([{ index: 0, delta: {}, logprobs: null, finish_reason: reason }]));
    if (includeUsage && state.usage) emit(chunk([], state.usage));
    emitDone();
  }

  function emitDone() {
    if (state.doneSent || !stream) return;
    state.doneSent = true;
    emit("[DONE]");
  }

  function fail(payload) {
    const response = payload?.response ?? payload;
    const error = response?.error ?? payload?.error ?? payload;
    state.failure = {
      message: String(error?.message || payload?.message || "Responses upstream failed"),
      type: String(error?.type || "server_error"),
      param: error?.param ?? null,
      code: error?.code ?? null,
    };
    if (stream) {
      emit({ error: state.failure });
      emitDone();
    }
  }

  function handlePayload(payload) {
    onPayload?.(payload);
    const type = String(payload?.type || "");
    const response = payload?.response ?? null;
    updateResponseMetadata(response);
    if (type === "response.created" || type === "response.in_progress") {
      if (stream) ensureRole();
      return;
    }
    if (type === "response.output_text.delta") {
      const delta = String(payload.delta || "");
      if (!delta) return;
      state.text += delta;
      state.meaningfulOutput = true;
      if (stream) {
        ensureRole();
        emit(chunk([{ index: 0, delta: { content: delta }, logprobs: null, finish_reason: null }]));
      }
      return;
    }
    if (type === "response.refusal.delta") {
      const delta = String(payload.delta || "");
      if (!delta) return;
      state.refusal += delta;
      state.meaningfulOutput = true;
      if (stream) {
        ensureRole();
        emit(chunk([{ index: 0, delta: { refusal: delta }, logprobs: null, finish_reason: null }]));
      }
      return;
    }
    if (type === "response.output_text.annotation.added" && payload.annotation) {
      state.annotations.push(payload.annotation);
      return;
    }
    if (type === "response.output_item.added" && payload.item?.type === "function_call") {
      ensureTool(payload.item, payload.output_index ?? 0);
      state.meaningfulOutput = true;
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const tool = ensureTool({ id: payload.item_id }, payload.output_index ?? 0, false);
      const delta = String(payload.delta || "");
      if (!delta) return;
      if (!tool.headerSent) ensureTool({ id: payload.item_id, call_id: tool.id, name: tool.name }, payload.output_index ?? 0);
      tool.arguments += delta;
      state.meaningfulOutput = true;
      if (stream) {
        emit(chunk([{
          index: 0,
          delta: { tool_calls: [{ index: tool.index, function: { arguments: delta } }] },
          logprobs: null,
          finish_reason: null,
        }]));
      }
      return;
    }
    if (type === "response.completed") {
      hydrateOutput(response);
      finish(state.tools.length > 0 ? "tool_calls" : "stop");
      return;
    }
    if (type === "response.incomplete") {
      hydrateOutput(response);
      const reason = String(response?.incomplete_details?.reason || "");
      finish(reason === "content_filter" ? "content_filter" : "length");
      return;
    }
    if (type === "response.failed" || type === "error") fail(payload);
  }

  return {
    push(buffer) {
      state.output = [];
      decoder.push(buffer);
      return state.output;
    },
    finish() {
      state.output = [];
      decoder.finish();
      return state.output;
    },
    get meaningfulOutput() {
      return state.meaningfulOutput;
    },
    get completed() {
      return state.completed;
    },
    get failure() {
      return state.failure;
    },
    get usage() {
      return state.usage;
    },
    get responseId() {
      return state.id;
    },
    get actualModel() {
      return state.model;
    },
    completion() {
      if (state.failure) return { error: state.failure };
      const message = {
        role: "assistant",
        content: state.text || null,
        refusal: state.refusal || null,
        annotations: state.annotations,
      };
      if (state.tools.length > 0) {
        message.tool_calls = state.tools.map((tool) => ({
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: tool.arguments },
        }));
      }
      return {
        id: state.id,
        object: "chat.completion",
        created: state.created,
        model: state.model,
        choices: [{ index: 0, message, logprobs: null, finish_reason: state.finishReason || "stop" }],
        ...(state.usage ? { usage: state.usage } : {}),
        ...(state.serviceTier ? { service_tier: state.serviceTier } : {}),
      };
    },
  };
}

export function chatUsageToResponseUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    input_tokens: usage.prompt_tokens ?? null,
    output_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? null,
      cache_write_tokens: usage.prompt_tokens_details?.cache_write_tokens ?? null,
    },
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    },
  };
}

function responseUsageToChatUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptDetails = {};
  const completionDetails = {};
  if (usage.input_tokens_details?.cached_tokens != null) {
    promptDetails.cached_tokens = usage.input_tokens_details.cached_tokens;
  }
  if (usage.output_tokens_details?.reasoning_tokens != null) {
    completionDetails.reasoning_tokens = usage.output_tokens_details.reasoning_tokens;
  }
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
    ...(Object.keys(promptDetails).length > 0 ? { prompt_tokens_details: promptDetails } : {}),
    ...(Object.keys(completionDetails).length > 0 ? { completion_tokens_details: completionDetails } : {}),
  };
}

function chatMessageToResponseItems(message) {
  const role = String(message?.role || "");
  if (!["system", "developer", "user", "assistant", "tool"].includes(role)) {
    throw new ChatCompatibilityError(`无法转换 Chat 消息角色: ${role || "<empty>"}`, "messages");
  }
  if (role === "tool") {
    if (!message.tool_call_id) throw new ChatCompatibilityError("tool 消息缺少 tool_call_id", "messages");
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: toolOutput(message.content),
    }];
  }
  if (message.function_call != null) {
    throw new ChatCompatibilityError("降级路径暂不支持已废弃的 function_call 消息，请使用 tool_calls", "messages");
  }

  const items = [];
  if (message.content != null) {
    items.push({ role, content: responseMessageContent(message.content) });
  }
  if (role === "assistant" && Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call?.type !== "function" || !call.id || !call.function?.name) {
        throw new ChatCompatibilityError("降级路径仅支持带 id 的 function tool_calls", "messages");
      }
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: String(call.function.arguments || ""),
      });
    }
  }
  return items;
}

function responseMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new ChatCompatibilityError("消息 content 必须是字符串或数组", "messages");
  return content.map((part) => {
    if (part?.type === "text") return { type: "input_text", text: String(part.text || "") };
    if (part?.type === "image_url") {
      const image = typeof part.image_url === "string" ? { url: part.image_url } : part.image_url;
      return {
        type: "input_image",
        image_url: image?.url,
        ...(image?.detail ? { detail: image.detail } : {}),
      };
    }
    if (part?.type === "file") {
      const file = part.file || {};
      return {
        type: "input_file",
        ...(file.file_id ? { file_id: file.file_id } : {}),
        ...(file.file_data ? { file_data: file.file_data } : {}),
        ...(file.filename ? { filename: file.filename } : {}),
      };
    }
    throw new ChatCompatibilityError(`降级路径暂不支持消息内容类型: ${part?.type || "<empty>"}`, "messages");
  });
}

function toolOutput(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content.map((part) => part?.text ?? JSON.stringify(part)).join("");
}

function chatToolToResponseTool(tool) {
  if (tool?.type !== "function" || !tool.function?.name) {
    throw new ChatCompatibilityError("降级路径暂仅支持 function tools", "tools");
  }
  return {
    type: "function",
    name: tool.function.name,
    ...(tool.function.description != null ? { description: tool.function.description } : {}),
    ...(tool.function.parameters != null ? { parameters: tool.function.parameters } : {}),
    ...(tool.function.strict != null ? { strict: tool.function.strict } : {}),
  };
}

function chatToolChoiceToResponseToolChoice(choice) {
  if (typeof choice === "string") return choice;
  if (choice?.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name };
  }
  throw new ChatCompatibilityError("无法转换 tool_choice", "tool_choice");
}

function chatResponseFormatToResponseFormat(format) {
  if (format?.type === "text" || format?.type === "json_object") return { type: format.type };
  if (format?.type === "json_schema" && format.json_schema?.name && format.json_schema?.schema) {
    return {
      type: "json_schema",
      name: format.json_schema.name,
      schema: format.json_schema.schema,
      ...(format.json_schema.description != null ? { description: format.json_schema.description } : {}),
      ...(format.json_schema.strict != null ? { strict: format.json_schema.strict } : {}),
    };
  }
  throw new ChatCompatibilityError("无法转换 response_format", "response_format");
}

function rejectUnsupportedChatFields(body) {
  if (body.n != null && Number(body.n) !== 1) {
    throw new ChatCompatibilityError("Responses 降级路径不支持 n > 1", "n");
  }
  const unsupported = [
    ["audio", body.audio],
    ["frequency_penalty", body.frequency_penalty],
    ["function_call", body.function_call],
    ["functions", body.functions],
    ["logit_bias", body.logit_bias],
    ["prediction", body.prediction],
    ["presence_penalty", body.presence_penalty],
    ["seed", body.seed],
    ["stop", body.stop],
    ["web_search_options", body.web_search_options],
  ];
  if (body.logprobs === true || Number(body.top_logprobs || 0) > 0) unsupported.push(["logprobs", true]);
  if (Array.isArray(body.modalities) && body.modalities.some((item) => item !== "text")) {
    unsupported.push(["modalities", body.modalities]);
  }
  const entry = unsupported.find(([, value]) => value != null && value !== false);
  if (entry) throw new ChatCompatibilityError(`Responses 降级路径暂不支持参数 ${entry[0]}`, entry[0]);
}

function createSseDecoder(onPayload) {
  const decoder = new TextDecoder();
  let pending = "";
  const process = (flush = false) => {
    const frames = pending.split(/\r?\n\r?\n/);
    pending = flush ? "" : (frames.pop() ?? "");
    for (const frame of frames) {
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        onPayload(JSON.parse(data));
      } catch {
        // Unrecognized upstream frames are ignored by the compatibility adapter.
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
      if (pending) pending += "\n\n";
      process(true);
    },
  };
}

function chatCompletionId(responseId) {
  const suffix = String(responseId).replace(/^resp_/, "");
  return suffix.startsWith("chatcmpl-") ? suffix : `chatcmpl-${suffix}`;
}

function copyDefined(source, target, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
