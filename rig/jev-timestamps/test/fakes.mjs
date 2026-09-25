// Shared EventEmitter-based test doubles for lib/client.mjs. No test ever
// touches the network: these fakes stand in for `https.request`'s req/res
// objects, driven purely by emitting events on a schedule the test controls.
import { EventEmitter } from "node:events";

// Internal to this module: only makeRequestFn() constructs these directly;
// tests interact with them through the requestFn it returns.
function createFakeReq({ reusedSocket = false } = {}) {
  const req = new EventEmitter();
  req.writes = [];
  req.destroyed = false;
  req.reusedSocket = reusedSocket;
  req.write = (chunk) => {
    req.writes.push(chunk);
    return true;
  };
  req.end = () => {};
  req.destroy = () => {
    req.destroyed = true;
  };
  return req;
}

/** A fake IncomingMessage: a readable of Buffers with statusCode/headers. */
export function createFakeRes({ statusCode = 200, headers = {} } = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  return res;
}

/** A fake TLS/TCP socket that only ever emits connect/secureConnect. */
function createFakeSocket() {
  return new EventEmitter();
}

/**
 * Builds a `requestFn` compatible with createClient's `requestFn` dependency,
 * plus handles to drive it deterministically from a test.
 *
 * By default it does nothing on its own — the test drives `req`, `res`, and
 * `socket` explicitly by emitting events in whatever order/timing it wants to
 * exercise. `options` from the call site are captured on `.calls`.
 */
export function makeRequestFn({ reusedSocket = false } = {}) {
  const req = createFakeReq({ reusedSocket });
  const socket = createFakeSocket();
  const calls = [];
  let capturedCallback;

  const requestFn = (options, callback) => {
    calls.push(options);
    capturedCallback = callback;
    return req;
  };

  requestFn.calls = calls;
  requestFn.req = req;
  requestFn.socket = socket;
  requestFn.emitResponse = (res) => {
    req.emit("socket", socket);
    capturedCallback(res);
  };

  return requestFn;
}
