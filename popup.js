const statusElement = document.querySelector("#status");
const platformElement = document.querySelector("#platform");
const listElement = document.querySelector("#media-list");
const refreshButton = document.querySelector("#refresh");
const downloadAllButton = document.querySelector("#download-all");
const versionElement = document.querySelector("#version");

versionElement.textContent = `v${chrome.runtime.getManifest().version}`;

let activeTab;
let media = [];
let instagramVideoDisabled = false;
let resolveError = "";

refreshButton.addEventListener("click", loadMedia);
downloadAllButton.addEventListener("click", () => downloadItems(media));
loadMedia();

async function loadMedia() {
  setStatus("Looking for media in the current post...");
  listElement.replaceChildren();
  downloadAllButton.disabled = true;

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !isSupportedUrl(activeTab.url)) {
    platformElement.textContent = "unsupported";
    setStatus("Open an Instagram or TikTok post to use this extension.");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: "GET_MEDIA" });
    media = deduplicate(response?.media || []).slice(0, 40);
    instagramVideoDisabled = response?.instagramVideoDisabled === true;
    resolveError = response?.resolveError || "";
    platformElement.textContent = response?.platform || "unknown";
    renderMedia();
  } catch (error) {
    setStatus("Reload the page, then try again.");
  }
}

function renderMedia() {
  if (!media.length) {
    setStatus(instagramVideoDisabled
      ? "Instagram video downloads are disabled for safety. You can still download images."
      : resolveError || "No media found. Play the post or browse its slides, then click Refresh.");
    return;
  }

  const videoCount = media.filter((item) => item.kind === "video").length;
  const imageCount = media.length - videoCount;
  setStatus(instagramVideoDisabled
    ? `Found ${imageCount} image(s). Instagram video downloads are disabled.`
    : `Found ${videoCount} video(s) and ${imageCount} image(s).`);
  downloadAllButton.disabled = false;

  media.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "media-row";

    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = item.kind === "video" ? "VIDEO" : "IMAGE";

    const copy = document.createElement("div");
    copy.className = "media-copy";
    const title = document.createElement("strong");
    title.textContent = `${item.kind === "video" ? "Video" : "Image"} ${index + 1}`;
    const host = document.createElement("small");
    host.textContent = item.pendingResolution ? "Resolve source URL on download" : safeHostname(item.url);
    copy.append(title, host);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Download";
    button.addEventListener("click", () => downloadItems([item]));

    row.append(kind, copy, button);
    listElement.append(row);
  });
}

async function downloadItems(items) {
  if (!items.length) return;
  const slug = postSlug(activeTab.url);
  const batchTimestamp = timestampSlug();
  setStatus(`Starting ${items.length} download(s)...`);

  let failures = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const extension = extensionFor(item);
    const filename = `ti_downloader-${slug}-${batchTimestamp}-${String(index + 1).padStart(2, "0")}.${extension}`;
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "DOWNLOAD_PAGE_MEDIA",
      item,
      filename
    });
    if (!response?.ok) {
      failures += 1;
      if (response?.error) resolveError = response.error;
    }
  }

  setStatus(failures
    ? resolveError || `Started ${items.length - failures} download(s); ${failures} failed.`
    : "Downloads started.");
}

function deduplicate(items) {
  const byUrl = new Map();
  for (const item of items) {
    if (!item?.url || !["video", "image"].includes(item.kind)) continue;
    const current = byUrl.get(item.url);
    if (!current || Number(item.score || 0) > Number(current.score || 0)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

function extensionFor(item) {
  if (item.kind === "video") return "mp4";
  try {
    const extension = new URL(item.url).pathname.match(/\.(jpe?g|png|webp)(?:$|\/)/i)?.[1];
    return extension ? extension.toLowerCase().replace("jpeg", "jpg") : "jpg";
  } catch {
    return "jpg";
  }
}

function postSlug(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => ["p", "reel", "tv", "video"].includes(part));
    const id = marker >= 0 ? parts[marker + 1] : parts.at(-1);
    return `${url.hostname.includes("instagram") ? "instagram" : "tiktok"}-${id || Date.now()}`;
  } catch {
    return `post-${Date.now()}`;
  }
}

function isSupportedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith("instagram.com") || host.endsWith("tiktok.com");
  } catch {
    return false;
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "media";
  }
}

function setStatus(message) {
  statusElement.textContent = message;
}

function timestampSlug() {
  const date = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}
