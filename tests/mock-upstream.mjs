import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT || 19091);
let sameRaceCalls = 0;
let recoverEarlyCalls = 0;
let recoverLateCalls = 0;

const server = createServer((req, res) => {
  const compact = req.url?.endsWith("/responses/compact");
  if (req.method !== "POST" || (!req.url?.endsWith("/responses") && !compact)) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (compact && req.url?.includes("/unsupported/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "compact is not supported" } }));
      return;
    }
    if (req.url?.includes("/capacity/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_capacity" } })}\n\n`);
      res.end(`event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: { message: "Selected model is at capacity. Please try a different model." },
        },
      })}\n\n`);
      return;
    }
    if (req.url?.includes("/rate-limit/")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } }));
      return;
    }
    if (req.url?.includes("/semantic-rate-limit/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_rate_limit" } })}\n\n`);
      res.end(`event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: { message: "exceeded retry limit, last status: 429 Too Many Requests" },
        },
      })}\n\n`);
      return;
    }
    if (req.url?.includes("/top-level-rate-limit/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: error\ndata: ${JSON.stringify({
        type: "error",
        code: "rate_limit_exceeded",
        message: "Rate limit exceeded",
        param: null,
      })}\n\n`);
      return;
    }
    if (req.url?.includes("/semantic-server-error/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "server_error", message: "The server encountered an error" },
        },
      })}\n\n`);
      return;
    }
    if (req.url?.includes("/late-server-error/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "PARTIAL" })}\n\n`);
      setTimeout(() => res.end(`event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "server_error", message: "Late server failure" },
        },
      })}\n\n`), 50);
      return;
    }
    if (req.url?.includes("/top-level-vector-timeout/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: error\ndata: ${JSON.stringify({
        type: "error",
        code: "vector_store_timeout",
        message: "Vector store search timed out",
        param: null,
      })}\n\n`);
      return;
    }
    if (req.url?.includes("/incomplete-max-output/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "PARTIAL" })}\n\n`);
      res.end(`event: response.incomplete\ndata: ${JSON.stringify({
        type: "response.incomplete",
        response: {
          id: "resp_incomplete_max_output",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 30, output_tokens: 8, input_tokens_details: { cached_tokens: 5 } },
        },
      })}\n\n`);
      return;
    }
    if (req.url?.includes("/incomplete-content-filter/")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: response.incomplete\ndata: ${JSON.stringify({
        type: "response.incomplete",
        response: {
          id: "resp_incomplete_content_filter",
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
          usage: { input_tokens: 14, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
        },
      })}\n\n`);
      return;
    }
    if (req.url?.includes("/recover-early/") && recoverEarlyCalls++ === 0) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "early recovery initial failure" } }));
      return;
    }
    if (req.url?.includes("/recover-late/") && recoverLateCalls++ === 0) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "late recovery initial failure" } }));
      return;
    }
    if (req.url?.includes("/fail/")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock primary failed" } }));
      return;
    }
    if (req.url?.includes("/hang/")) return;
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const actualModel = `${body.model || "mock-model"}-actual`;
    if (compact) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_compact_mock",
        object: "response.compaction",
        model: actualModel,
        output: [{ type: "compaction", id: "cmp_mock", encrypted_content: "mock" }],
        usage: { input_tokens: 18, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } },
      }));
      return;
    }
    if (req.url?.includes("/partial/") && body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_partial", model: actualModel } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "PARTIAL" })}\n\n`);
      res.write(`event: response.incomplete\ndata: ${JSON.stringify({
        type: "response.incomplete",
        response: {
          id: "resp_partial",
          model: actualModel,
          usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
        },
      })}\n\n`);
      setTimeout(() => res.end(), 1000);
      return;
    }
    if (req.url?.includes("/terminal-open/") && body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_terminal_open", model: actualModel } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`);
      res.write(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_terminal_open",
          model: actualModel,
          usage: {
            input_tokens: 24,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 4 },
          },
        },
      })}\n\n`);
      setTimeout(() => res.end(), 1000);
      return;
    }
    const sameRaceCall = req.url?.includes("/same-race/") ? ++sameRaceCalls : 0;
    const headerDelay = req.url?.includes("/fast/") || sameRaceCall ? 10 : 220;
    const firstOutputDelay = sameRaceCall
      ? (sameRaceCall === 1 ? 220 : 20)
      : req.url?.includes("/slow/") ? 220 : req.url?.includes("/fast/") ? 20 : 40;
    setTimeout(() => {
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_mock", model: actualModel } })}\n\n`);
        setTimeout(() => {
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: "OK",
          })}\n\n`);
          setTimeout(() => res.end(`event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_mock",
              model: actualModel,
              usage: {
                input_tokens: 12,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 2 },
                output_tokens_details: { reasoning_tokens: 1 },
              },
            },
          })}\n\n`), 20);
        }, firstOutputDelay);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "resp_mock", model: actualModel, output: [], usage: { input_tokens: 12, output_tokens: 5 } }));
      }
    }, headerDelay);
  });
});

server.listen(port, "127.0.0.1", () => console.log(`mock upstream listening on ${port}`));

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
