import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatCompatibilityError,
  chatRequestToResponses,
  createResponsesToChatBridge,
  isChatEndpointUnsupported,
  upstreamEndpointUrl,
} from "../server/chat-protocol.mjs";

test("maps Chat messages, tools, reasoning, and structured output to Responses", () => {
  const converted = chatRequestToResponses({
    model: "gpt-5.6-terra",
    messages: [
      { role: "developer", content: "Be concise" },
      { role: "user", content: [{ type: "text", text: "Weather?" }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"BJ\"}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
    tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters: { type: "object" }, strict: true } }],
    tool_choice: { type: "function", function: { name: "weather" } },
    response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: { type: "object" } } },
    reasoning_effort: "high",
    max_completion_tokens: 200,
    stream: false,
  });

  assert.equal(converted.stream, true);
  assert.equal(converted.max_output_tokens, 200);
  assert.deepEqual(converted.reasoning, { effort: "high" });
  assert.deepEqual(converted.tool_choice, { type: "function", name: "weather" });
  assert.equal(converted.tools[0].name, "weather");
  assert.deepEqual(converted.text.format, { type: "json_schema", name: "result", schema: { type: "object" }, strict: true });
  assert.equal(converted.input[2].type, "function_call");
  assert.equal(converted.input[3].type, "function_call_output");
});

test("rejects Chat parameters that cannot be represented by Responses", () => {
  assert.throws(
    () => chatRequestToResponses({ model: "gpt-5.6-terra", messages: [], n: 2 }),
    (error) => error instanceof ChatCompatibilityError && error.param === "n",
  );
  assert.throws(
    () => chatRequestToResponses({ model: "gpt-5.6-terra", messages: [], stop: ["END"] }),
    (error) => error instanceof ChatCompatibilityError && error.param === "stop",
  );
});

test("converts Responses text stream to Chat chunks and usage", () => {
  const bridge = createResponsesToChatBridge({
    stream: true,
    includeUsage: true,
    requestedModel: "gpt-5.6-terra",
  });
  const output = [];
  output.push(...bridge.push(frame({ type: "response.created", response: { id: "resp_123", created_at: 1786880000, model: "gpt-5.6-terra-actual" } })));
  output.push(...bridge.push(frame({ type: "response.output_text.delta", delta: "hello" })));
  output.push(...bridge.push(frame({
    type: "response.completed",
    response: {
      id: "resp_123",
      model: "gpt-5.6-terra-actual",
      output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4 } },
    },
  })));
  output.push(...bridge.finish());

  const text = Buffer.concat(output).toString("utf8");
  assert.match(text, /"object":"chat\.completion\.chunk"/);
  assert.match(text, /"content":"hello"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /"prompt_tokens":10/);
  assert.match(text, /data: \[DONE\]/);
});

test("aggregates Responses function calls into a non-stream Chat completion", () => {
  const bridge = createResponsesToChatBridge({ stream: false, includeUsage: false, requestedModel: "gpt-5.6-terra" });
  bridge.push(frame({ type: "response.created", response: { id: "resp_tools", model: "gpt-5.6-terra" } }));
  bridge.push(frame({
    type: "response.output_item.added",
    output_index: 1,
    item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "weather", arguments: "" },
  }));
  bridge.push(frame({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: "{\"city\":\"BJ\"}" }));
  bridge.push(frame({
    type: "response.completed",
    response: {
      id: "resp_tools",
      model: "gpt-5.6-terra",
      output: [{ id: "fc_1", call_id: "call_1", type: "function_call", name: "weather", arguments: "{\"city\":\"BJ\"}" }],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    },
  }));
  bridge.finish();

  const completion = bridge.completion();
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(completion.choices[0].message.tool_calls[0], {
    id: "call_1",
    type: "function",
    function: { name: "weather", arguments: "{\"city\":\"BJ\"}" },
  });
});

test("only treats endpoint capability failures as unsupported Chat", () => {
  assert.equal(isChatEndpointUnsupported(405, ""), true);
  assert.equal(isChatEndpointUnsupported(404, JSON.stringify({ error: { code: "endpoint_not_found" } })), true);
  assert.equal(isChatEndpointUnsupported(404, JSON.stringify({ error: { code: "model_not_found", message: "model not found" } })), false);
  assert.equal(isChatEndpointUnsupported(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } })), false);
  assert.equal(upstreamEndpointUrl("https://example.com/v1/responses", "chat/completions"), "https://example.com/v1/chat/completions");
});

function frame(payload) {
  return Buffer.from(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
