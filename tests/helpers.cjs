const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = (file) => readFileSync(path.join(__dirname, "..", file), "utf8");
const tick = () => new Promise(setImmediate);

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { return listeners.map((fn) => fn(...args)); } };
}

function ports() {
  let closed = false;
  const messages = [];
  const pair = [0, 1].map((index) => ({
    name: "ti-page-media", onMessage: event(), onDisconnect: event(),
    postMessage(message) {
      if (closed) throw new Error("Port closed");
      const copy = JSON.parse(JSON.stringify(message));
      messages.push(copy);
      queueMicrotask(() => { if (!closed) pair[1 - index].onMessage.emit(copy); });
    },
    disconnect() {
      if (closed) return;
      closed = true;
      pair.forEach((port) => port.onDisconnect.emit());
    }
  }));
  return { pair, messages, closed: () => closed };
}

function content({ hostname = "www.tiktok.com", fetch = async () => { throw new Error("Unexpected page fetch"); }, sendMessage = async () => null } = {}) {
  const onConnect = event();
  const onMessage = event();
  const context = vm.createContext({
    URL, AbortController, Uint8Array, btoa, crypto: require("node:crypto").webcrypto, fetch,
    location: new URL(`https://${hostname}/${hostname.includes("instagram") ? "p/POST/" : "@user/video/123"}`),
    window: { addEventListener() {}, removeEventListener() {} },
    document: { documentElement: {}, querySelectorAll: () => [], querySelector: () => null },
    MutationObserver: class { observe() {} }, setTimeout() {}, clearTimeout() {},
    chrome: { runtime: { onConnect, onMessage, sendMessage } }
  });
  vm.runInContext(source("page-stream.js"), context);
  vm.runInContext(source("content.js"), context);
  return {
    context, connect: (port) => onConnect.emit(port),
    message: (message) => new Promise((resolve) => onMessage.emit(message, {}, resolve))
  };
}

function directory({ name = "Saved media", permission = "granted", granted = "granted", missing = false,
  failOpen = false, failWrite = false, closeGate } = {}) {
  const files = new Map();
  let requested = 0;
  let aborted = 0;
  const handle = {
    name, kind: "directory", files, permission, granted, missing,
    requested: () => requested, aborted: () => aborted,
    async queryPermission() { return handle.permission; },
    async requestPermission() { requested += 1; handle.permission = handle.granted; return handle.granted; },
    entries: () => ({ async next() {
      if (handle.missing) throw new DOMException("Missing folder", "NotFoundError");
      return { done: true };
    } }),
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("Missing file", "NotFoundError");
        files.set(name, Buffer.alloc(0));
      }
      return { async createWritable() {
        if (failOpen) throw new DOMException("Write permission denied", "NotAllowedError");
        const chunks = [];
        const sink = {
          write(chunk) {
            if (failWrite) throw new Error("Disk full");
            chunks.push(Buffer.from(chunk));
          },
          async close() { await closeGate; files.set(name, Buffer.concat(chunks)); },
          abort() { aborted += 1; }
        };
        const stream = new WritableStream(sink);
        stream.write = async (chunk) => sink.write(chunk);
        stream.close = () => sink.close();
        return stream;
      } };
    },
    async removeEntry(name) { files.delete(name); }
  };
  return handle;
}

function element() {
  const listeners = new Map();
  return {
    textContent: "", disabled: false, hidden: false, children: [],
    addEventListener(name, fn) { listeners.set(name, fn); },
    click() { if (!this.disabled) return listeners.get("click")?.(); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this[name] = value; }
  };
}

module.exports = { source, tick, event, ports, content, directory, element };
