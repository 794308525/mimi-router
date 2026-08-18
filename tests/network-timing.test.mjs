import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fetchWithNetworkTiming } from "../server/network-timing.mjs";

let server;
let url;

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.once("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 20);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/v1/responses`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("records connect, upload and upstream wait phases without an extra probe", async () => {
  let connected = 0;
  let bodySent = 0;
  const { response, timing } = await fetchWithNetworkTiming(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test" }),
    },
    {
      onConnected: () => connected += 1,
      onBodySent: () => bodySent += 1,
    },
  );
  await response.arrayBuffer();

  assert.equal(response.status, 200);
  assert.equal(connected, 1);
  assert.equal(bodySent, 1);
  assert.equal(timing.connection_reused, 0);
  assert.ok(Number.isInteger(timing.network_connect_ms));
  assert.ok(Number.isInteger(timing.request_upload_ms));
  assert.ok(timing.upstream_wait_ms >= 15);
});

test("notifies when a reused connection starts sending before a slow upload finishes", async () => {
  await fetchWithNetworkTiming(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warmup" }),
  }).then(({ response }) => response.arrayBuffer());

  let requestSentAt = null;
  let bodySentAt = null;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first chunk"));
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("second chunk"));
        controller.close();
      }, 120);
    },
  });
  const { response, timing } = await fetchWithNetworkTiming(
    url,
    {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
      duplex: "half",
    },
    {
      onRequestSent: () => { requestSentAt = performance.now(); },
      onBodySent: () => { bodySentAt = performance.now(); },
    },
  );
  await response.arrayBuffer();

  assert.equal(timing.connection_reused, 1);
  assert.ok(requestSentAt != null);
  assert.ok(bodySentAt != null);
  assert.ok(requestSentAt < bodySentAt);
});
