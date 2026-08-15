import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT || 19091);
let sameRaceCalls = 0;

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
    if (req.url?.includes("/fail/")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock primary failed" } }));
      return;
    }
    if (req.url?.includes("/hang/")) return;
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (compact) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_compact_mock",
        object: "response.compaction",
        output: [{ type: "compaction", id: "cmp_mock", encrypted_content: "mock" }],
        usage: { input_tokens: 18, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } },
      }));
      return;
    }
    if (req.url?.includes("/partial/") && body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_partial" } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "PARTIAL" })}\n\n`);
      res.write(`event: response.incomplete\ndata: ${JSON.stringify({
        type: "response.incomplete",
        response: {
          id: "resp_partial",
          usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
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
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_mock" } })}\n\n`);
        setTimeout(() => {
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: "OK",
          })}\n\n`);
          setTimeout(() => res.end(`event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_mock",
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
        res.end(JSON.stringify({ id: "resp_mock", output: [], usage: { input_tokens: 12, output_tokens: 5 } }));
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
