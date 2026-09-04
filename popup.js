const statusElement = document.querySelector("#status");
const platformElement = document.querySelector("#platform");
const listElement = document.querySelector("#media-list");
const refreshButton = document.querySelector("#refresh");
const downloadAllButton = document.querySelector("#download-all");

let activeTab;
let media = [];
let instagramVideoDisabled = false;
let resolveError = "";

refreshButton.addEventListener("click", loadMedia);
downloadAllButton.addEventListener("click", () => downloadItems(media));
loadMedia();

async function loadMedia() {
  setStatus("현재 게시물의 미디어를 찾는 중입니다.");
  listElement.replaceChildren();
  downloadAllButton.disabled = true;

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !isSupportedUrl(activeTab.url)) {
    platformElement.textContent = "unsupported";
    setStatus("Instagram 또는 TikTok 게시물 페이지에서 실행해 주세요.");
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
    setStatus("페이지를 새로고침한 뒤 다시 시도해 주세요.");
  }
}

function renderMedia() {
  if (!media.length) {
    setStatus(instagramVideoDisabled
      ? "안전을 위해 Instagram 영상 다운로드를 비활성화했습니다. 이미지만 다운로드할 수 있습니다."
      : resolveError || "미디어를 찾지 못했습니다. 게시물을 재생하거나 넘긴 뒤 다시 검색해 주세요.");
    return;
  }

  const videoCount = media.filter((item) => item.kind === "video").length;
  const imageCount = media.length - videoCount;
  setStatus(instagramVideoDisabled
    ? `이미지 ${imageCount}개를 찾았습니다. Instagram 영상 다운로드는 비활성화되어 있습니다.`
    : `영상 ${videoCount}개, 이미지 ${imageCount}개를 찾았습니다.`);
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
    title.textContent = `${item.kind === "video" ? "영상" : "이미지"} ${index + 1}`;
    const host = document.createElement("small");
    host.textContent = item.pendingResolution ? "클릭 시 원본 URL 확인" : safeHostname(item.url);
    copy.append(title, host);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "다운로드";
    button.addEventListener("click", () => downloadItems([item]));

    row.append(kind, copy, button);
    listElement.append(row);
  });
}

async function downloadItems(items) {
  if (!items.length) return;
  const slug = postSlug(activeTab.url);
  const batchTimestamp = timestampSlug();
  setStatus(`${items.length}개 다운로드를 시작합니다.`);

  let failures = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const extension = extensionFor(item);
    const filename = `ti_downloader/${slug}-${batchTimestamp}-${String(index + 1).padStart(2, "0")}.${extension}`;
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
    ? resolveError || `${items.length - failures}개를 시작했고 ${failures}개는 실패했습니다.`
    : "다운로드를 시작했습니다.");
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
