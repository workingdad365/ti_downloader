(() => {
  const CHUNK_BYTES = 64 * 1024;

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "ti-page-media") return;
    const controller = new AbortController();
    let reader;
    let pending = new Uint8Array();
    let total = 0;
    let opened = false;
    let busy = false;
    let connected = true;

    function cancel() {
      controller.abort();
      reader?.cancel().catch(() => {});
      pending = new Uint8Array();
    }

    async function handle(message) {
      if (busy) throw new Error("A media read is already in progress.");
      busy = true;
      try {
        if (message.type === "OPEN") {
          if (opened || !/(^|\.)tiktok\.com$/.test(location.hostname) || !isSafeMedia({ kind: "video", url: message.url })) {
            throw new Error("This page video URL is not allowed.");
          }
          opened = true;
          const response = await fetch(message.url, {
            credentials: "include", cache: "no-store", signal: controller.signal,
            headers: { Accept: "video/mp4,video/*;q=0.9,*/*;q=0.1" }
          });
          reader = response.body?.getReader();
          if (!response.ok) throw new Error(`Video request failed (${response.status}).`);
          const contentType = (response.headers.get("content-type") || "").toLowerCase();
          if (!contentType.includes("video") && !contentType.includes("octet-stream")) {
            throw new Error(`The response is not a video (${contentType || "unknown"}).`);
          }
          if (!reader) throw new Error("The video response is empty.");
          if (connected) port.postMessage({ type: "READY" });
          return;
        }
        if (message.type !== "READ" || !reader) throw new Error("The video stream is not open.");
        while (!pending.byteLength) {
          const result = await reader.read();
          if (result.done) {
            if (!total) throw new Error("The video file is empty.");
            reader.releaseLock();
            reader = null;
            if (connected) port.postMessage({ type: "CHUNK", done: true });
            return;
          }
          pending = result.value;
        }
        const chunk = pending.subarray(0, CHUNK_BYTES);
        pending = pending.subarray(CHUNK_BYTES);
        total += chunk.byteLength;
        const data = btoa(Array.from(chunk, (byte) => String.fromCharCode(byte)).join(""));
        if (connected) port.postMessage({ type: "CHUNK", data, done: false });
      } finally {
        busy = false;
      }
    }

    port.onMessage.addListener((message) => {
      handle(message).catch((error) => {
        if (connected) port.postMessage({ type: "ERROR", error: error.message });
        cancel();
      });
    });
    port.onDisconnect.addListener(() => {
      connected = false;
      cancel();
    });
  });
})();
