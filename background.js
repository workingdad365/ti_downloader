const ALLOWED_MEDIA_HOSTS = [
  "instagram.com",
  "cdninstagram.com",
  "fbcdn.net",
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokv.com",
  "byteoversea.com",
  "ibytedtos.com",
  "muscdn.com",
  "akamaized.net"
];
const remoteDownloads = new Map();
let creatingOffscreenDocument;

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  releaseRemoteDownload(delta.id).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CACHE_MEDIA" && sender.tab?.id) {
    chrome.storage.session
      .set({ [`media:${sender.tab.id}`]: message.payload })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_CACHED_MEDIA" && sender.tab?.id) {
    chrome.storage.session.get(`media:${sender.tab.id}`).then((result) => {
      sendResponse(result[`media:${sender.tab.id}`] || null);
    });
    return true;
  }

  if (message?.type === "DOWNLOAD_BLOB" && sender.tab?.id) {
    downloadBlob(message.url, message.filename)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DOWNLOAD_INSTAGRAM_PROGRESSIVE" && sender.tab?.id) {
    downloadInstagramProgressive(message.url, message.filename)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== "DOWNLOAD_MEDIA") return;

  downloadMedia(message.url, message.filename)
    .then((downloadId) => sendResponse({ ok: true, downloadId }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function downloadMedia(rawUrl, rawFilename) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !isAllowedHost(url.hostname)) {
    throw new Error("허용되지 않은 미디어 주소입니다.");
  }

  const filename = sanitizeFilename(rawFilename || "media");

  return chrome.downloads.download({
    url: url.href,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
}

async function downloadBlob(rawUrl, rawFilename) {
  const url = new URL(rawUrl);
  if (url.protocol !== "blob:") throw new Error("올바르지 않은 Blob 주소입니다.");
  const filename = sanitizeFilename(rawFilename || "media");
  return chrome.downloads.download({
    url: url.href,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
}

async function downloadInstagramProgressive(rawUrl, rawFilename) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) {
    throw new Error("검증되지 않은 Instagram 영상 주소입니다.");
  }

  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "FETCH_REMOTE_VIDEO",
    url: url.href
  });
  if (!result?.ok || !result.blobUrl) throw new Error(result?.error || "영상 fetch 실패");

  const filename = sanitizeFilename(rawFilename || "instagram-video.mp4");
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: result.blobUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } catch (error) {
    await revokeOffscreenUrl(result.blobUrl);
    throw error;
  }

  remoteDownloads.set(downloadId, result.blobUrl);
  await Promise.allSettled([
    chrome.storage.session.set({ [`remote-download:${downloadId}`]: result.blobUrl }),
    chrome.runtime.sendMessage({
      target: "offscreen",
      type: "MARK_REMOTE_BLOB_IN_USE",
      blobUrl: result.blobUrl,
      downloadId
    })
  ]);
  const current = await chrome.downloads.search({ id: downloadId }).catch(() => []);
  if (current[0] && ["complete", "interrupted"].includes(current[0].state)) {
    await releaseRemoteDownload(downloadId);
  }
  return downloadId;
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (contexts.length) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Fetch verified Instagram progressive MP4 into an extension-owned Blob."
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }
  await creatingOffscreenDocument;
}

async function releaseRemoteDownload(downloadId) {
  const key = `remote-download:${downloadId}`;
  const stored = await chrome.storage.session.get(key);
  const blobUrl = remoteDownloads.get(downloadId) || stored[key];
  if (!blobUrl) return;
  remoteDownloads.delete(downloadId);
  await chrome.storage.session.remove(key);
  await revokeOffscreenUrl(blobUrl);
}

async function revokeOffscreenUrl(blobUrl) {
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "REVOKE_REMOTE_BLOB",
    blobUrl
  }).catch(() => {});
}

function isAllowedHost(hostname) {
  return ALLOWED_MEDIA_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`)
  );
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"|?*\\/]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._]+/, "")
    .slice(0, 180);
}
