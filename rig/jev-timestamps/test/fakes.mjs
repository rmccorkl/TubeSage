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

/**
 * A fake child_process.spawn standing in for `op`. Each call records
 * (command, args, options, child) on `.calls`, then plays the given outcome:
 * stdout/stderr data and a close with `exitCode`, a spawn error, or nothing
 * at all (`hang`).
 */
export function fakeSpawn({ exitCode = 0, stdout = "", stderr = "", errorCode, hang = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ command, args, options, child });
    if (!hang) {
      setImmediate(() => {
        if (errorCode) return child.emit("error", Object.assign(new Error(`spawn op ${errorCode}`), { code: errorCode }));
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", exitCode);
      });
    }
    return child;
  };
  spawn.calls = calls;
  return spawn;
}
