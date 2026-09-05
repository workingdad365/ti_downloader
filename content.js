const mediaByUrl = new Map();
let cachedPageUrl = location.href;
let overlayRefreshTimer;
let overlayHost;
let overlayButton;
let instagramResolveCache;
let lastInstagramResolveError = "";

const OVERLAY_ICONS = {
  download: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708z"/></svg>',
  loading: '<svg class="ti-spin" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"/></svg>',
  success: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.485 1.929a.75.75 0 0 1 .086 1.057l-7 8.25a.75.75 0 0 1-1.08.065l-3.5-3.25a.75.75 0 1 1 1.018-1.102l2.926 2.717 6.493-7.651a.75.75 0 0 1 1.057-.086"/></svg>',
  error: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.938 2.016a.13.13 0 0 1 .125 0l6.857 11.667c.036.06.042.101.038.125a.13.13 0 0 1-.063.093.13.13 0 0 1-.07.016H1.175a.13.13 0 0 1-.117-.066c-.01-.018-.013-.05.005-.082zM8.5 5.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 1 0zm0 5.5a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0"/></svg>'
};

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.source !== "ti_downloader_page" || event.data?.type !== "MEDIA_FOUND") return;
  mergeMedia(event.data.media, event.data.pageUrl);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DOWNLOAD_PAGE_MEDIA") {
    downloadMedia(message.item, message.filename)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== "GET_MEDIA") return;

  refreshMedia().then(() => {
    sendResponse({
      ok: true,
      platform: location.hostname.endsWith("instagram.com") ? "instagram" : "tiktok",
      instagramVideoDisabled: false,
      resolveError: lastInstagramResolveError,
      pageUrl: location.href,
      media: mediaForUi()
    });
  });
  return true;
});

restoreCachedMedia();
refreshDownloadOverlays();
new MutationObserver(scheduleOverlayRefresh).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "poster"]
});
window.addEventListener("scroll", scheduleOverlayRefresh, true);
window.addEventListener("resize", scheduleOverlayRefresh);
setTimeout(() => {
  refreshMedia().finally(refreshDownloadOverlays);
}, 500);

async function refreshMedia() {
  const runtimeMedia = await requestRuntimeMedia();
  if (location.hostname.endsWith("tiktok.com")) {
    replaceTikTokMedia(runtimeMedia);
  } else {
    const requestedUrl = getCurrentInstagramPermalink();
    const resolved = await resolveInstagramProgressiveVideoCached(requestedUrl).catch((error) => {
      lastInstagramResolveError = error.message;
      return null;
    });
    if (normalizePostUrl(requestedUrl) !== normalizePostUrl(getCurrentInstagramPermalink())) return;
    if (resolved?.url) {
      lastInstagramResolveError = "";
      replaceInstagramVideo({
        url: resolved.url,
        kind: "video",
        score: Number.MAX_SAFE_INTEGER,
        verified: true
      });
    }
  }
  collectFromDom();
}

function mediaForUi() {
  const media = rankedMedia();
  if (!location.hostname.endsWith("instagram.com")) return media;
  if (media.some((item) => item.kind === "video") || !hasVisibleInstagramVideo()) return media;
  return [{
    url: getCurrentInstagramPermalink(),
    kind: "video",
    score: Number.MAX_SAFE_INTEGER,
    pendingResolution: true,
    permalink: getCurrentInstagramPermalink()
  }, ...media];
}

function hasVisibleInstagramVideo() {
  const scope = findActivePost() || document;
  return [...scope.querySelectorAll("video")].some(isLargeVisibleMedia);
}

function replaceInstagramVideo(video) {
  for (const [url, item] of mediaByUrl) {
    if (item.kind === "video") mediaByUrl.delete(url);
  }
  if (video) mergeMedia([video], location.href);
}

function replaceTikTokMedia(media) {
  for (const [url, item] of mediaByUrl) {
    if (item.kind === "video" || isTikTokPageUrl(item.url)) mediaByUrl.delete(url);
  }
  mergeMedia(media, location.href);
}

async function restoreCachedMedia() {
  const cached = await chrome.runtime.sendMessage({ type: "GET_CACHED_MEDIA" }).catch(() => null);
  if (cached?.pageUrl === location.href) mergeMedia(cached.media, cached.pageUrl, false);
}

function mergeMedia(media, pageUrl, persist = true) {
  if (pageUrl && normalizePostUrl(pageUrl) !== normalizePostUrl(location.href)) return;
  if (cachedPageUrl !== location.href) {
    mediaByUrl.clear();
    cachedPageUrl = location.href;
  }

  const incoming = Array.isArray(media) ? media : [];
  if (location.hostname.endsWith("tiktok.com") && incoming.some((item) => item?.kind === "video")) {
    for (const [url, item] of mediaByUrl) {
      if (item.kind === "image" || isTikTokPageUrl(item.url)) mediaByUrl.delete(url);
    }
  }

  for (const item of incoming) {
    if (location.hostname.endsWith("instagram.com") && item.kind === "video" && item.verified !== true) {
      continue;
    }
    if (!isSafeMedia(item)) continue;
    const current = mediaByUrl.get(item.url);
    if (!current || Number(item.score || 0) > Number(current.score || 0)) {
      mediaByUrl.set(item.url, item);
    }
  }

  if (persist) {
    chrome.runtime.sendMessage({
      type: "CACHE_MEDIA",
      payload: { pageUrl: location.href, media: rankedMedia().slice(0, 60) }
    }).catch(() => {});
  }
}

function collectFromDom() {
  const found = [];
  const scope = findActivePost() || document;

  if (!location.hostname.endsWith("tiktok.com") || !scope.querySelector("video")) {
    scope.querySelectorAll("img").forEach((image) => {
      const rect = image.getBoundingClientRect();
      if (image.naturalWidth < 300 || image.naturalHeight < 300) return;
      if (rect.width < 180 || rect.height < 180) return;
      const src = bestSrcsetUrl(image.srcset) || image.currentSrc || image.src;
      if (src?.startsWith("https://")) {
        found.push({ url: src, kind: "image", score: image.naturalWidth * image.naturalHeight });
      }
    });
  }

  if (!location.hostname.endsWith("tiktok.com") || !document.querySelector("video")) {
    document.querySelectorAll('meta[property="og:image"]').forEach((meta) => {
      found.push({ url: meta.content, kind: "image", score: 1000 });
    });
  }

  mergeMedia(found, location.href);
}

function findActivePost() {
  if (location.hostname.endsWith("instagram.com")) {
    const articles = [...document.querySelectorAll("article")];
    return articles
      .map((element) => ({ element, distance: distanceFromViewportCenter(element) }))
      .sort((a, b) => a.distance - b.distance)[0]?.element || document.querySelector('main[role="main"]');
  }

  const videos = [...document.querySelectorAll('section[data-e2e="feed-video"], [data-e2e="browse-video"], video')];
  return videos
    .map((element) => ({ element, distance: distanceFromViewportCenter(element) }))
    .sort((a, b) => a.distance - b.distance)[0]?.element.closest("section, article, div[data-e2e]") || null;
}

function distanceFromViewportCenter(element) {
  const rect = element.getBoundingClientRect();
  return Math.abs(rect.top + rect.height / 2 - innerHeight / 2);
}

function bestSrcsetUrl(srcset) {
  if (!srcset) return "";
  return srcset
    .split(",")
    .map((part) => {
      const [url, descriptor = "0"] = part.trim().split(/\s+/);
      return { url, size: Number.parseFloat(descriptor) || 0 };
    })
    .sort((a, b) => b.size - a.size)[0]?.url || "";
}

function rankedMedia() {
  const ranked = [...mediaByUrl.values()]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "video" ? -1 : 1;
      return Number(b.score || 0) - Number(a.score || 0);
    });
  if (location.hostname.endsWith("instagram.com")) {
    const verifiedVideo = ranked.find((item) => item.kind === "video" && item.verified === true);
    return [...(verifiedVideo ? [verifiedVideo] : []), ...ranked.filter((item) => item.kind === "image")];
  }
  if (!location.hostname.endsWith("tiktok.com")) return ranked;

  const video = ranked.find((item) => item.kind === "video" && !isTikTokPageUrl(item.url));
  return video ? [video] : ranked.filter((item) => item.kind === "image");
}

function isSafeMedia(item) {
  if (!item || !["video", "image"].includes(item.kind)) return false;
  try {
    const url = new URL(item.url);
    return url.protocol === "https:" && /(^|\.)(instagram\.com|cdninstagram\.com|fbcdn\.net|tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|byteoversea\.com|ibytedtos\.com|muscdn\.com|akamaized\.net)$/.test(url.hostname);
  } catch {
    return false;
  }
}

function normalizePostUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/(p|reel|tv|video)\/[^/]+/);
    return match ? `${parsed.hostname}${match[0]}` : `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function requestRuntimeMedia() {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onResponse, true);
      resolve([]);
    }, 1200);

    function onResponse(event) {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.source !== "ti_downloader_page" || event.data?.type !== "RUNTIME_MEDIA") return;
      if (event.data.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener("message", onResponse, true);
      resolve(Array.isArray(event.data.media) ? event.data.media : []);
    }

    window.addEventListener("message", onResponse, true);
    window.postMessage({
      source: "ti_downloader",
      type: "GET_RUNTIME_MEDIA",
      requestId
    }, location.origin);
  });
}

function scheduleOverlayRefresh() {
  clearTimeout(overlayRefreshTimer);
  overlayRefreshTimer = setTimeout(refreshDownloadOverlays, 200);
}

function refreshDownloadOverlays() {
  const mediaElement = findVisibleMediaElement();

  if (!mediaElement) {
    if (overlayHost) overlayHost.style.display = "none";
    return;
  }

  ensureOverlay();
  overlayHost.dataset.mediaKind = mediaElement.tagName === "VIDEO" ? "video" : "image";
  overlayHost.dataset.mediaUrl = mediaElement.tagName === "IMG"
    ? bestSrcsetUrl(mediaElement.srcset) || mediaElement.currentSrc || mediaElement.src || ""
    : mediaElement.currentSrc || mediaElement.src || "";
  overlayHost.dataset.permalink = location.hostname.endsWith("instagram.com")
    ? getCurrentInstagramPermalink(mediaElement)
    : location.href;
  const rect = mediaElement.getBoundingClientRect();
  overlayHost.style.display = "block";
  overlayHost.style.top = `${Math.max(8, rect.top + 44)}px`;
  overlayHost.style.left = `${Math.max(8, rect.right - 40)}px`;
}

function findVisibleMediaElement() {
  const scope = findActivePost() || document;
  const videos = [...scope.querySelectorAll("video")].filter(isLargeVisibleMedia);
  if (videos.length) {
    return videos.sort((a, b) => distanceFromViewportCenter(a) - distanceFromViewportCenter(b))[0];
  }
  if (!location.hostname.endsWith("instagram.com")) return null;
  return [...scope.querySelectorAll("img")]
    .filter((image) => image.naturalWidth >= 300 && image.naturalHeight >= 300)
    .filter(isLargeVisibleMedia)
    .sort((a, b) => distanceFromViewportCenter(a) - distanceFromViewportCenter(b))[0] || null;
}

function isLargeVisibleMedia(element) {
  const rect = element.getBoundingClientRect();
  return rect.width >= 220 && rect.height >= 220 && rect.right > 0 &&
    rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
}

function ensureOverlay() {
  if (overlayHost?.isConnected) return;
  overlayHost = document.createElement("div");
  overlayHost.id = "ti-downloader-overlay-root";
  Object.assign(overlayHost.style, {
    all: "initial",
    position: "fixed",
    zIndex: "2147483647",
    width: "30px",
    height: "28px",
    pointerEvents: "auto"
  });

  const shadow = overlayHost.attachShadow({ mode: "closed" });
  overlayButton = document.createElement("button");
  overlayButton.type = "button";
  setOverlayButtonState(overlayButton, "download");
  Object.assign(overlayButton.style, {
    all: "initial",
    display: "grid",
    placeItems: "center",
    boxSizing: "border-box",
    width: "30px",
    height: "28px",
    border: "1px solid rgba(255,255,255,.3)",
    borderRadius: "6px",
    background: "rgba(15,15,18,.58)",
    boxShadow: "0 2px 10px rgba(0,0,0,.22)",
    color: "rgba(255,255,255,.92)",
    cursor: "pointer"
  });
  const style = document.createElement("style");
  style.textContent = `
    button svg { width: 15px; height: 15px; fill: currentColor; display: block; }
    .ti-spin { animation: ti-spin .8s linear infinite; }
    @keyframes ti-spin { to { transform: rotate(360deg); } }
  `;
  ["pointerdown", "mousedown", "mouseup"].forEach((type) => {
    overlayButton.addEventListener(type, stopOverlayEvent, true);
  });
  overlayButton.addEventListener("click", (event) => downloadFromOverlay(event, overlayButton), true);
  shadow.append(style, overlayButton);
  document.documentElement.append(overlayHost);
}

function stopOverlayEvent(event) {
  event.stopPropagation();
}

async function downloadFromOverlay(event, button) {
  event.preventDefault();
  event.stopPropagation();
  button.disabled = true;
  setOverlayButtonState(button, "loading");

  await refreshMedia();
  refreshDownloadOverlays();
  const kind = overlayHost?.dataset.mediaKind || "video";
  const visibleUrl = overlayHost?.dataset.mediaUrl || "";
  const visibleItem = {
    url: visibleUrl,
    kind,
    score: Number.MAX_SAFE_INTEGER,
    permalink: overlayHost?.dataset.permalink || location.href
  };
  const preferRuntimeVideo = kind === "video";
  const item = !preferRuntimeVideo && isSafeMedia(visibleItem)
    ? visibleItem
    : mediaForUi().find((candidate) => candidate.kind === kind);
  if (!item) {
    showButtonResult(button, false, "Media not found");
    return;
  }

  const extension = item.kind === "video" ? "mp4" : imageExtension(item.url);
  const filename = `ti_downloader-${downloadSlug()}-${timestampSlug()}.${extension}`;
  try {
    const response = await downloadMedia(item, filename);
    showButtonResult(button, response?.ok, response?.ok ? "Download started" : "Download failed");
  } catch (error) {
    showButtonResult(button, false, error.message);
  }
}

async function downloadMedia(item, filename) {
  if (location.hostname.endsWith("instagram.com") && item.kind === "video") {
    const permalink = item.permalink || getCurrentInstagramPermalink();
    const resolved = item.verified === true && isAllowedInstagramVideoUrl(item.url)
      ? { url: item.url, mediaId: item.mediaId }
      : await resolveInstagramProgressiveVideoCached(permalink);
    if (!resolved?.url) throw new Error("현재 Instagram 영상의 원본 URL을 확인하지 못했습니다.");
    return chrome.runtime.sendMessage({
      type: "DOWNLOAD_INSTAGRAM_PROGRESSIVE",
      url: resolved.url,
      filename
    });
  }
  if (!item?.url || !isSafeMedia(item)) throw new Error("유효한 미디어 주소가 없습니다.");
  if (item.kind !== "video") {
    return chrome.runtime.sendMessage({
      type: "DOWNLOAD_MEDIA",
      url: item.url,
      filename
    });
  }

  const response = await fetch(item.url, {
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "video/mp4,video/*;q=0.9,*/*;q=0.1" }
  });
  if (!response.ok) throw new Error(`영상 요청 실패 (${response.status})`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("video") && !contentType.toLowerCase().includes("octet-stream")) {
    throw new Error(`응답이 영상이 아닙니다 (${contentType || "unknown"})`);
  }

  const blob = await response.blob();
  if (blob.size === 0) throw new Error("빈 영상 파일입니다.");
  const blobUrl = URL.createObjectURL(blob);
  try {
    const result = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_BLOB",
      url: blobUrl,
      filename
    });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    return result;
  } catch (error) {
    URL.revokeObjectURL(blobUrl);
    throw error;
  }
}

async function resolveInstagramProgressiveVideoCached(permalink) {
  const key = normalizePostUrl(permalink);
  if (instagramResolveCache?.key === key && instagramResolveCache.expiresAt > Date.now()) {
    return instagramResolveCache.promise;
  }
  const promise = resolveInstagramProgressiveVideo(permalink).catch((error) => {
    if (instagramResolveCache?.promise === promise) instagramResolveCache = undefined;
    throw error;
  });
  instagramResolveCache = { key, promise, expiresAt: Date.now() + 30000 };
  return promise;
}

async function resolveInstagramProgressiveVideo(permalink) {
  const shortcode = new URL(permalink).pathname.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i)?.[1];
  if (!shortcode) throw new Error("Instagram 게시물 shortcode를 찾지 못했습니다.");

  const response = await fetch(permalink, {
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!response.ok) throw new Error(`Instagram 게시물 요청 실패 (${response.status})`);
  const html = await response.text();
  const parsed = extractInstagramMediaFromHtml(html, shortcode);
  if (parsed?.url) return parsed;
  if (!parsed?.mediaId) throw new Error("게시물 JSON에서 video_versions 또는 media ID를 찾지 못했습니다.");
  const apiResult = await fetchInstagramMediaInfo(parsed.mediaId, shortcode);
  if (!apiResult?.url) throw new Error("Instagram Media Info API에서 progressive MP4를 찾지 못했습니다.");
  return apiResult;
}

function getCurrentInstagramPermalink(mediaElement) {
  const direct = extractInstagramPermalink(location.href);
  if (direct) return direct;

  const scope = mediaElement?.closest("article") || findActivePost() || document;
  const links = [...scope.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]')];
  for (const link of links) {
    const permalink = extractInstagramPermalink(link.href);
    if (permalink) return permalink;
  }

  return location.href;
}

function extractInstagramPermalink(rawUrl) {
  try {
    const url = new URL(rawUrl, location.origin);
    const match = url.pathname.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
    if (!match) return "";
    const type = url.pathname.match(/\/(reel|reels|p|tv)\//i)?.[1].toLowerCase();
    return `${url.origin}/${type}/${match[1]}/`;
  } catch {
    return "";
  }
}

function extractInstagramMediaFromHtml(html, shortcode) {
  const scriptPattern = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let mediaId;
  while ((match = scriptPattern.exec(html))) {
    try {
      const media = findInstagramMedia(JSON.parse(match[1]), shortcode, 0);
      if (!media) continue;
      mediaId = String(media.pk || media.id || "") || mediaId;
      const url = pickBestInstagramProgressiveDeep(media);
      if (url) return { url, mediaId };
    } catch {
      // Ignore malformed embedded JSON.
    }
  }
  return mediaId ? { mediaId } : null;
}

function findInstagramMedia(value, shortcode, depth) {
  if (!value || typeof value !== "object" || depth > 20) return null;
  const code = value.code || value.shortcode;
  if (String(code || "") === shortcode) return value;

  const priorityKeys = ["__bbox", "result", "data", "require", "graphql", "edges", "node", "items", "extensions"];
  const visited = new Set();
  for (const key of priorityKeys) {
    if (!(key in value)) continue;
    visited.add(key);
    const found = findInstagramMedia(value[key], shortcode, depth + 1);
    if (found) return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (visited.has(key)) continue;
    const found = findInstagramMedia(child, shortcode, depth + 1);
    if (found) return found;
  }
  return null;
}

function pickBestInstagramProgressive(media) {
  const candidates = [];
  for (const version of Array.isArray(media.video_versions) ? media.video_versions : []) {
    if (typeof version?.url !== "string") continue;
    const width = numericValue(version.width);
    const height = numericValue(version.height);
    const bandwidth = numericValue(version.bandwidth);
    candidates.push({ url: decodeInstagramUrl(version.url), score: width * height * 10000 + bandwidth });
  }
  if (typeof media.video_url === "string") {
    candidates.push({ url: decodeInstagramUrl(media.video_url), score: 1 });
  }
  return candidates
    .filter((candidate) => isAllowedInstagramVideoUrl(candidate.url))
    .sort((a, b) => b.score - a.score)[0]?.url || null;
}

function pickBestInstagramProgressiveDeep(root) {
  const candidates = [];
  const stack = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) continue;
    seen.add(value);
    const url = pickBestInstagramProgressive(value);
    if (url) {
      const version = Array.isArray(value.video_versions)
        ? [...value.video_versions].sort((a, b) =>
            numericValue(b?.width) * numericValue(b?.height) -
            numericValue(a?.width) * numericValue(a?.height)
          )[0]
        : null;
      candidates.push({ url, score: version ? numericValue(version.width) * numericValue(version.height) : 1 });
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
    }
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.url || null;
}

async function fetchInstagramMediaInfo(mediaId, shortcode) {
  const pk = String(mediaId).split("_")[0];
  if (!/^\d+$/.test(pk)) return null;
  const headers = {
    accept: "*/*",
    "x-ig-app-id": "936619743392459",
    "x-requested-with": "XMLHttpRequest"
  };
  const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("csrftoken="));
  if (csrf) headers["x-csrftoken"] = csrf.slice("csrftoken=".length);

  const response = await fetch(`https://www.instagram.com/api/v1/media/${pk}/info/`, {
    method: "GET",
    mode: "cors",
    credentials: "include",
    headers
  });
  if (!response.ok) return null;
  const media = (await response.json())?.items?.[0];
  if (!media) return null;
  const responseCode = media.code || media.shortcode;
  if (responseCode && String(responseCode) !== shortcode) return null;
  const url = pickBestInstagramProgressiveDeep(media);
  return url ? { url, mediaId: pk } : null;
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function decodeInstagramUrl(url) {
  return String(url).replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&#x26;/gi, "&").trim();
}

function isAllowedInstagramVideoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && /(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname);
  } catch {
    return false;
  }
}

function setOverlayButtonState(button, state, label) {
  button.innerHTML = OVERLAY_ICONS[state];
  const accessibleLabel = label || {
    download: "Download",
    loading: "Finding media",
    success: "Download started",
    error: "Download failed"
  }[state];
  button.setAttribute("aria-label", accessibleLabel);
  button.title = accessibleLabel;
}

function showButtonResult(button, success, label) {
  setOverlayButtonState(button, success ? "success" : "error", label);
  setTimeout(() => {
    setOverlayButtonState(button, "download");
    button.disabled = false;
  }, 1800);
}

function downloadSlug() {
  const id = location.pathname.match(/\/(?:p|reel|tv|video)\/([^/]+)/)?.[1] || Date.now();
  const platform = location.hostname.endsWith("instagram.com") ? "instagram" : "tiktok";
  return `${platform}-${id}`;
}

function timestampSlug() {
  const date = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function isTikTokPageUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname;
    return ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com"].includes(host);
  } catch {
    return false;
  }
}

function imageExtension(rawUrl) {
  try {
    const extension = new URL(rawUrl).pathname.match(/\.(jpe?g|png|webp)(?:$|\/)/i)?.[1];
    return extension ? extension.toLowerCase().replace("jpeg", "jpg") : "jpg";
  } catch {
    return "jpg";
  }
}
