(() => {
  const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

  function allowedUrl(rawUrl, instagram = false) {
    const url = new URL(rawUrl);
    const hosts = instagram ? /(^|\.)(cdninstagram\.com|fbcdn\.net)$/
      : /(^|\.)(instagram\.com|cdninstagram\.com|fbcdn\.net|tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|byteoversea\.com|ibytedtos\.com|muscdn\.com|akamaized\.net)$/;
    if (url.protocol !== "https:" || !hosts.test(url.hostname)) throw new Error("This media URL is not allowed.");
    return url.href;
  }

  async function open(tabId, item, { signal } = {}) {
    signal?.throwIfAborted();
    const media = await prepareMedia(tabId, item, signal);
    signal?.throwIfAborted();
    if (!media?.ok) throw new Error(media?.error || "Could not prepare the media. Reload the source page.");
    if (!["instagram-video", "page-video", "image"].includes(media.source)) throw new Error("Unsupported media source.");
    const instagram = media.source === "instagram-video";
    const url = allowedUrl(media.url, instagram);
    if (media.source === "page-video") return openPageStream(tabId, url, signal);
    const response = await fetch(url, { credentials: instagram ? "omit" : "include", signal });
    try {
      if (!response.ok) throw new Error(`Media request failed (${response.status}).`);
      allowedUrl(response.url, instagram);
      if (!response.body) throw new Error("The media response is empty.");
      if (!instagram) return response.body;
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("video/mp4") && !contentType.includes("application/octet-stream")) {
        throw new Error(`The response is not an MP4 (${contentType || "unknown"}).`);
      }
      if (Number(response.headers.get("content-length") || 0) > MAX_VIDEO_BYTES) {
        throw new Error("The Instagram video exceeds the 256 MB limit.");
      }
      return verifiedMp4Stream(response.body);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
  }

  async function prepareMedia(tabId, item, signal) {
    return sendToPage(tabId, { type: "PREPARE_PAGE_MEDIA", item }, signal);
  }

  async function resolve(tabId, item, { signal } = {}) {
    const response = await sendToPage(tabId, { type: "RESOLVE_PROFILE_POST", item }, signal);
    signal?.throwIfAborted();
    if (!response?.ok) throw new Error(response?.error || "Could not resolve the profile post.");
    const items = response.items;
    if (!Array.isArray(items) || !items.length || items.length > 40 ||
        items.some((media) => !media || media.postId !== item.postId || media.pendingResolution ||
          !["video", "image"].includes(media.kind)) ||
        new Set(items.map((media) => media.mediaIndex)).size !== items.length) {
      throw new Error("The resolved post contains invalid media.");
    }
    for (const media of items) allowedUrl(media.url);
    return items;
  }

  function resolvedFilename(filename, item, multiple) {
    const extension = item.kind === "video" ? "mp4"
      : new URL(item.url).pathname.match(/\.(jpe?g|png|webp)(?:$|\/)/i)?.[1]?.toLowerCase().replace("jpeg", "jpg") || "jpg";
    const base = String(filename || "media").replace(/\.(post|mp4|jpe?g|png|webp)$/i, "");
    return `${base}${multiple ? `-${String((item.mediaIndex || 0) + 1).padStart(2, "0")}` : ""}.${extension}`;
  }

  async function sendToPage(tabId, message, signal) {
    signal?.throwIfAborted();
    const response = chrome.tabs.sendMessage(tabId, message);
    if (!signal) return response;
    let onAbort;
    try {
      return await Promise.race([response, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      })]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  function verifiedMp4Stream(body) {
    let total = 0;
    let verified = false;
    let prefix = new Uint8Array();
    return body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_VIDEO_BYTES) throw new Error("The Instagram video exceeds the 256 MB limit.");
        if (!verified) {
          const combined = new Uint8Array(prefix.byteLength + chunk.byteLength);
          combined.set(prefix);
          combined.set(chunk, prefix.byteLength);
          prefix = combined;
          if (prefix.byteLength < 12) return;
          if (prefix[4] !== 0x66 || prefix[5] !== 0x74 || prefix[6] !== 0x79 || prefix[7] !== 0x70) {
            throw new Error("The Instagram response does not contain an MP4 signature.");
          }
          verified = true;
          controller.enqueue(prefix);
          prefix = new Uint8Array();
          return;
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (!verified) throw new Error("The Instagram response does not contain an MP4 signature.");
      }
    }));
  }

  async function openPageStream(tabId, url, signal) {
    const port = chrome.tabs.connect(tabId, { name: "ti-page-media" });
    let pending;
    let controller;
    let closed = false;

    function close(error) {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        pending?.reject(error);
        controller?.error(error);
      }
      pending = null;
      port.disconnect();
    }

    function onAbort() {
      close(signal.reason || new DOMException("Download stopped", "AbortError"));
    }

    function request(message) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new Error("The source page disconnected."));
        pending = { resolve, reject };
        try { port.postMessage(message); } catch (error) { close(error); }
      });
    }

    port.onMessage.addListener((message) => {
      if (message.type === "ERROR") return close(new Error(message.error));
      const waiting = pending;
      pending = null;
      waiting?.resolve(message);
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      close(new Error(error?.message || "The source page disconnected."));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      const ready = await request({ type: "OPEN", url });
      if (ready.type !== "READY") throw new Error("Could not open the page video stream.");
      return new ReadableStream({
        start(value) { controller = value; },
        async pull(value) {
          try {
            const chunk = await request({ type: "READ" });
            if (chunk.type !== "CHUNK") throw new Error("Invalid video stream response.");
            if (chunk.done) {
              value.close();
              close();
            } else {
              const data = atob(chunk.data);
              value.enqueue(Uint8Array.from(data, (character) => character.charCodeAt(0)));
            }
          } catch (error) {
            close(error);
          }
        },
        cancel() { close(); }
      });
    } catch (error) {
      close(error);
      throw error;
    }
  }

  globalThis.MediaReader = { open, resolve, resolvedFilename };
})();
