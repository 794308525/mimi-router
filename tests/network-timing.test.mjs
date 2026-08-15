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
  const { response, timing } = await fetchWithNetworkTiming(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test" }),
  });
  await response.arrayBuffer();

  assert.equal(response.status, 200);
  assert.equal(timing.connection_reused, 0);
  assert.ok(Number.isInteger(timing.network_connect_ms));
  assert.ok(Number.isInteger(timing.request_upload_ms));
  assert.ok(timing.upstream_wait_ms >= 15);
});
