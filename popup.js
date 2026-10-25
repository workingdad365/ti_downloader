const statusElement = document.querySelector("#status");
const platformElement = document.querySelector("#platform");
const listElement = document.querySelector("#media-list");
const refreshButton = document.querySelector("#refresh");
const downloadAllButton = document.querySelector("#download-all");
const versionElement = document.querySelector("#version");
const folderButton = document.querySelector("#choose-folder");
const folderNameElement = document.querySelector("#folder-name");
const folderStatusElement = document.querySelector("#folder-status");
const downloadProgressElement = document.querySelector("#download-progress");
const downloadStatusElement = document.querySelector("#download-status");
const stopDownloadsButton = document.querySelector("#stop-downloads");

versionElement.textContent = `v${chrome.runtime.getManifest().version}`;

let activeTab;
let media = [];
let instagramVideoDisabled = false;
let resolveError = "";
let directory = null;
let profilePage = false;
let limitReached = false;
let mediaLoadId = 0;

refreshButton.addEventListener("click", loadMedia);
downloadAllButton.addEventListener("click", () => downloadItems(media));
folderButton.addEventListener("click", chooseDownloadFolder);
stopDownloadsButton.addEventListener("click", async () => {
  stopDownloadsButton.disabled = true;
  await chrome.runtime.sendMessage({ type: "STOP_DOWNLOADS" }).catch((error) => {
    downloadStatusElement.textContent = error.message;
    stopDownloadsButton.disabled = false;
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes["download-status"]) renderDownloadStatus(changes["download-status"].newValue);
});
loadFolder();
chrome.runtime.sendMessage({ type: "GET_DOWNLOAD_STATUS" })
  .then((response) => { if (response?.ok) renderDownloadStatus(response.status); })
  .catch(() => {});
loadMedia();

function renderFolder() {
  folderNameElement.textContent = directory ? `Download folder: ${directory.name}` : "Download folder: not set";
  folderButton.textContent = directory ? "Change download folder" : "Set download folder";
}

async function loadFolder() {
  try {
    directory = await FolderStore.load();
    renderFolder();
    if (directory && !await FolderStore.canReuse(directory, { interactive: false })) {
      folderStatusElement.textContent = "Folder access is required. Select this folder again or choose another folder.";
    }
  } catch (error) {
    folderStatusElement.textContent = error.message;
  } finally {
    folderButton.disabled = false;
  }
}

async function chooseDownloadFolder() {
  folderButton.disabled = true;
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    folderStatusElement.textContent = error.message;
  } finally {
    folderButton.disabled = false;
  }
}

function renderDownloadStatus(status) {
  downloadProgressElement.hidden = !status;
  downloadStatusElement.textContent = status?.message || "";
  if (status?.active > 0 && status.state !== "saving") {
    downloadStatusElement.textContent += ` ${status.active} download(s) still in progress.`;
  }
  stopDownloadsButton.hidden = !(status?.active > 0 || status?.state === "saving");
  stopDownloadsButton.disabled = false;
}

async function loadMedia() {
  const requestId = ++mediaLoadId;
  setStatus("Looking for posts and media...");
  listElement.replaceChildren();
  media = [];
  downloadAllButton.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (requestId !== mediaLoadId) return;
  activeTab = tab;
  if (!activeTab?.id || !isSupportedUrl(activeTab.url)) {
    platformElement.textContent = "unsupported";
    setStatus("Open an Instagram or TikTok post or profile to use this extension.");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: "GET_MEDIA" });
    if (requestId !== mediaLoadId) return;
    if (response?.ok === false) throw new Error(response.error);
    const detected = deduplicate(response?.media || []);
    media = detected.slice(0, 500);
    profilePage = response?.profile === true;
    limitReached = response?.limitReached === true || detected.length > media.length;
    instagramVideoDisabled = response?.instagramVideoDisabled === true;
    resolveError = response?.resolveError || "";
    platformElement.textContent = `${response?.platform || "unknown"}${profilePage ? " profile" : ""}`;
    renderMedia();
  } catch (error) {
    if (requestId === mediaLoadId) setStatus("Reload the page, then try again.");
  }
}

function renderMedia() {
  if (!media.length) {
    setStatus(instagramVideoDisabled
      ? "Instagram video downloads are disabled for safety. You can still download images."
      : resolveError || (profilePage ? "No posts found. Scroll the profile to load posts, then click Refresh."
        : "No media found. Play the post or browse its slides, then click Refresh."));
    return;
  }

  const videoCount = media.filter((item) => item.kind === "video").length;
  const imageCount = media.filter((item) => item.kind === "image").length;
  setStatus(profilePage ? `Found ${media.length} post(s). Scroll to load more, then Refresh.${limitReached ? " Showing up to 500 posts." : ""}` : instagramVideoDisabled
    ? `Found ${imageCount} image(s). Instagram video downloads are disabled.`
    : `Found ${videoCount} video(s) and ${imageCount} image(s).`);
  downloadAllButton.disabled = false;

  media.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "media-row";

    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = item.kind.toUpperCase();

    const copy = document.createElement("div");
    copy.className = "media-copy";
    const title = document.createElement("strong");
    title.textContent = profilePage ? `Post ${item.postId}${item.mediaCount > 1 ? ` (${item.mediaCount} files)` : ""}`
      : `${item.kind === "video" ? "Video" : "Image"} ${index + 1}`;
    if (item.title) title.title = item.title;
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
  const batchTimestamp = timestampSlug();
  const downloads = items.map((item, index) => {
    const slug = postSlug(item.permalink || activeTab.url);
    const extension = extensionFor(item);
    const filename = `ti_downloader-${slug}-${batchTimestamp}-${String(index + 1).padStart(2, "0")}.${extension}`;
    return { item, filename };
  });
  await startDownload(downloads);
}

async function startDownload(items) {
  const buttons = [refreshButton, downloadAllButton, ...listElement.querySelectorAll("button")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_DOWNLOAD", tabId: activeTab?.id, items
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start the download.");
    if (response.state === "needs-folder") window.close();
  } catch (error) {
    setStatus(error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    downloadAllButton.disabled = !media.length;
  }
}

function deduplicate(items) {
  const byUrl = new Map();
  for (const item of items) {
    if (!item?.url || !["post", "video", "image"].includes(item.kind)) continue;
    const key = item.postId ? `${item.postId}:${item.mediaIndex || 0}` : item.url;
    const current = byUrl.get(key);
    if (!current || (current.pendingResolution && !item.pendingResolution) ||
        Number(item.score || 0) > Number(current.score || 0)) byUrl.set(key, item);
  }
  return [...byUrl.values()];
}

function extensionFor(item) {
  if (item.kind === "post") return "post";
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
    const marker = parts.findIndex((part) => ["p", "reel", "reels", "tv", "video", "photo"].includes(part));
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
