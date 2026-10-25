importScripts("folder-store.js", "folder-writer.js", "media-reader.js");

const activeDownloads = new Map();
const STATUS_KEY = "download-status";
const FOLDER_ACCESS_ERROR = "Open TI Downloader and use Change download folder to select an accessible folder.";

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

  if (message?.type === "GET_DOWNLOAD_STATUS") {
    getDownloadStatus()
      .then((status) => sendResponse({ ok: true, status, active: activeDownloads.size }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_DOWNLOADS") {
    for (const controller of activeDownloads.values()) controller.abort();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type !== "START_DOWNLOAD") return;
  const tabId = sender.url?.startsWith(chrome.runtime.getURL(""))
    ? message.tabId : sender.tab?.id ?? message.tabId;
  startDownload(tabId, message.items)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function startDownload(tabId, items) {
  if (!Array.isArray(items) || !items.length || items.length > 40 ||
      items.some((entry) => !entry?.item || !["video", "image"].includes(entry.item.kind))) {
    throw new Error("Invalid download list.");
  }
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("The source tab is unavailable.");
  const directory = await FolderStore.load();
  if (!directory) {
    await openInitialFolderWindow(tabId, items);
    return { state: "needs-folder" };
  }
  if (!await FolderStore.canReuse(directory, { interactive: false })) {
    await publishStatus({ state: "error", message: FOLDER_ACCESS_ERROR });
    throw new Error(FOLDER_ACCESS_ERROR);
  }

  const id = crypto.randomUUID();
  const controller = new AbortController();
  activeDownloads.set(id, controller);
  // Keep the worker alive only while a download is active, including slow disk writes.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  runDownload(id, { tabId, items }, directory, controller)
    .catch(async (error) => {
      await publishStatus({ id, state: "error", message: error.message }).catch(() => {});
    })
    .finally(() => {
      clearInterval(keepAlive);
      activeDownloads.delete(id);
    });
  return { state: "started", id, folder: directory.name };
}

async function openInitialFolderWindow(tabId, items) {
  const key = `download:${crypto.randomUUID()}`;
  await chrome.storage.session.set({ [key]: { tabId, items } });
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL(`download.html?job=${encodeURIComponent(key)}`),
      type: "popup", width: 460, height: 420
    });
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
}

function sanitizeFilename(filename) {
  return String(filename || "media").replace(/[<>:"|?*\\/\x00-\x1f]/g, "_")
    .replace(/\.{2,}/g, ".").replace(/^[._]+/, "").slice(0, 180) || "media";
}

async function runDownload(id, job, directory, controller) {
  const { signal } = controller;
  let saved = 0;
  let failed = 0;
  let lastFailure = "";
  try {
    for (let index = 0; index < job.items.length; index += 1) {
      signal.throwIfAborted();
      await publishStatus({ id, state: "saving", saved, total: job.items.length,
        message: `Saving ${index + 1} of ${job.items.length} to ${directory.name}...` });
      const { item, filename } = job.items[index];
      let source;
      let writing = false;
      const responseTimeout = setTimeout(() => {
        controller.abort(new Error("The media request timed out. Try again from the source page."));
      }, 25000);
      try {
        source = await MediaReader.open(job.tabId, item, { signal });
        clearTimeout(responseTimeout);
        signal.throwIfAborted();
        writing = true;
        await FolderWriter.write(directory, sanitizeFilename(filename), source, { signal });
        saved += 1;
      } catch (error) {
        if (signal.aborted || writing) throw error;
        failed += 1;
        lastFailure = error.message;
      } finally {
        clearTimeout(responseTimeout);
        await source?.cancel().catch(() => {});
      }
    }
    await publishStatus({ id, state: failed ? "error" : "complete", saved, total: job.items.length,
      message: `Saved ${saved} file(s) to ${directory.name}.${failed ? ` ${failed} failed: ${lastFailure}` : ""}` });
  } catch (error) {
    const stopped = signal.aborted && signal.reason?.name === "AbortError";
    await publishStatus({ id, state: stopped ? "stopped" : "error", saved, total: job.items.length,
      message: stopped ? `Download stopped. Saved ${saved} file(s) to ${directory.name}.` : (signal.aborted ? signal.reason.message : error.message) });
  }
}

async function publishStatus(status) {
  if (status.state !== "saving") activeDownloads.delete(status.id);
  status = { ...status, active: activeDownloads.size };
  await chrome.storage.session.set({ [STATUS_KEY]: status });
  await Promise.allSettled([
    chrome.action.setBadgeText({ text: status.state === "error" ? "!" : status.active ? "..." : "" }),
    chrome.action.setBadgeBackgroundColor({ color: status.state === "error" ? "#c53929" : "#555555" }),
    chrome.action.setTitle({ title: `TI Downloader - ${status.message}` })
  ]);
}

async function getDownloadStatus() {
  const stored = await chrome.storage.session.get(STATUS_KEY);
  let status = stored[STATUS_KEY] || null;
  if ((status?.state === "saving" && !activeDownloads.has(status.id)) ||
      (status?.active > 0 && !activeDownloads.size)) {
    status = { ...status, state: "error", active: activeDownloads.size,
      message: "The download was interrupted. Try again from the source page." };
    await publishStatus(status);
  }
  return status;
}
