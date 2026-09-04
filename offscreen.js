const blobRegistry = new Map();
const UNUSED_TTL_MS = 10 * 60 * 1000;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
let fetchJob = Promise.resolve();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  if (message.type === "REVOKE_REMOTE_BLOB") {
    revokeBlob(message.blobUrl);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "MARK_REMOTE_BLOB_IN_USE") {
    const entry = blobRegistry.get(message.blobUrl);
    if (entry) {
      entry.claimedAt = Date.now();
      entry.downloadId = message.downloadId;
    }
    sendResponse({ ok: true });
    return;
  }
  if (message.type !== "FETCH_REMOTE_VIDEO") return;

  const job = fetchJob.then(() => fetchRemoteVideo(message.url));
  fetchJob = job.catch(() => {});
  job
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function fetchRemoteVideo(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) {
    throw new Error("검증되지 않은 Instagram CDN 주소입니다.");
  }
  const response = await fetch(url.href, { credentials: "omit" });
  if (!response.ok) throw new Error(`Instagram CDN 요청 실패 (${response.status})`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(finalUrl.hostname)) {
    throw new Error("Instagram CDN redirect가 허용된 호스트를 벗어났습니다.");
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("video/mp4") && !contentType.includes("application/octet-stream")) {
    throw new Error(`MP4 응답이 아닙니다 (${contentType || "unknown"})`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_VIDEO_BYTES) throw new Error("Instagram 영상이 256MB 제한을 초과합니다.");
  const bytes = await readResponseWithLimit(response, MAX_VIDEO_BYTES);
  if (!bytes.byteLength) throw new Error("Instagram 영상이 비어 있습니다.");
  if (!hasMp4Signature(bytes)) throw new Error("Instagram 응답에 MP4 시그니처가 없습니다.");
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
  blobRegistry.set(blobUrl, { createdAt: Date.now(), claimedAt: null, downloadId: null });
  return { blobUrl, size: bytes.byteLength, mimeType: "video/mp4" };
}

async function readResponseWithLimit(response, maxBytes) {
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw new Error("Instagram 영상이 256MB 제한을 초과합니다.");
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Instagram 영상이 256MB 제한을 초과합니다.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

function revokeBlob(blobUrl) {
  if (!blobRegistry.has(blobUrl)) return;
  blobRegistry.delete(blobUrl);
  URL.revokeObjectURL(blobUrl);
}

function hasMp4Signature(bytes) {
  if (bytes.byteLength < 12) return false;
  const view = new Uint8Array(bytes, 4, 4);
  return view[0] === 0x66 && view[1] === 0x74 && view[2] === 0x79 && view[3] === 0x70;
}

setInterval(() => {
  const cutoff = Date.now() - UNUSED_TTL_MS;
  for (const [blobUrl, entry] of blobRegistry) {
    if (!entry.claimedAt && entry.createdAt < cutoff) revokeBlob(blobUrl);
  }
}, 30000);
