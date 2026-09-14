import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

const timingStorage = new AsyncLocalStorage();
const requestTimings = new WeakMap();
const errorTimings = new WeakMap();

function currentTiming(request) {
  return (request && requestTimings.get(request)) || timingStorage.getStore() || null;
}

function elapsed(start, end = performance.now()) {
  if (start == null) return null;
  return Math.max(0, Math.round(end - start));
}

channel("undici:request:create").subscribe(({ request }) => {
  const timing = timingStorage.getStore();
  if (!timing || !request) return;
  timing.requestCreatedMono = performance.now();
  requestTimings.set(request, timing);
});

channel("undici:client:beforeConnect").subscribe(() => {
  const timing = timingStorage.getStore();
  if (!timing) return;
  timing.connectionReused = 0;
  timing.connectStartedMono = performance.now();
});

channel("undici:client:connected").subscribe(() => {
  const timing = timingStorage.getStore();
  if (!timing) return;
  timing.connectedMono = performance.now();
  timing.networkConnectMs = elapsed(timing.connectStartedMono, timing.connectedMono);
  timing.onConnected?.();
});

channel("undici:client:sendHeaders").subscribe(({ request }) => {
  const timing = currentTiming(request);
  if (!timing) return;
  if (timing.connectionReused == null) timing.connectionReused = 1;
  timing.onRequestSent?.();
});

channel("undici:client:connectError").subscribe(() => {
  const timing = timingStorage.getStore();
  if (!timing) return;
  timing.connectionReused = 0;
  timing.networkConnectMs = elapsed(timing.connectStartedMono);
});

channel("undici:request:bodySent").subscribe(({ request }) => {
  const timing = currentTiming(request);
  if (!timing) return;
  const sentMono = performance.now();
  if (timing.connectionReused == null) timing.connectionReused = 1;
  timing.bodySentMono = sentMono;
  timing.requestUploadMs = elapsed(
    timing.connectedMono ?? timing.requestCreatedMono ?? timing.fetchStartedMono,
    sentMono,
  );
  timing.onBodySent?.();
});

channel("undici:request:headers").subscribe(({ request }) => {
  const timing = currentTiming(request);
  if (!timing) return;
  timing.responseHeadersMono = performance.now();
  timing.upstreamWaitMs = elapsed(timing.bodySentMono, timing.responseHeadersMono);
});

function snapshot(timing) {
  return {
    connection_reused: timing.connectionReused ?? null,
    network_connect_ms: timing.networkConnectMs ?? null,
    request_upload_ms: timing.requestUploadMs ?? null,
    upstream_wait_ms: timing.upstreamWaitMs ?? null,
  };
}

export async function fetchWithNetworkTiming(url, init, hooks = {}) {
  const timing = {
    fetchStartedMono: performance.now(),
    connectionReused: null,
    connectStartedMono: null,
    connectedMono: null,
    requestCreatedMono: null,
    bodySentMono: null,
    responseHeadersMono: null,
    networkConnectMs: null,
    requestUploadMs: null,
    upstreamWaitMs: null,
    onConnected: hooks.onConnected,
    onRequestSent: hooks.onRequestSent,
    onBodySent: hooks.onBodySent,
  };
  try {
    const response = await timingStorage.run(timing, () => fetch(url, init));
    return { response, timing: snapshot(timing) };
  } catch (error) {
    if (error && typeof error === "object") errorTimings.set(error, snapshot(timing));
    throw error;
  }
}

export function networkTimingForError(error) {
  return error && typeof error === "object" ? errorTimings.get(error) ?? null : null;
}
