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

  if (message?.type !== "OPEN_DOWNLOAD_WINDOW") return;
  openDownloadWindow(sender.tab?.id ?? message.tabId, message.items)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function openDownloadWindow(tabId, items) {
  if (!Array.isArray(items) || items.length > 40) throw new Error("Invalid download list.");
  if (items.length && (!Number.isInteger(tabId) || tabId < 0)) throw new Error("The source tab is unavailable.");
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
