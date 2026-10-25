const chooseButton = document.querySelector("#choose-folder");
const closeButton = document.querySelector("#close");
const statusElement = document.querySelector("#status");
document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;

let job;
let key;
let choosing = false;
let closed = false;

async function startDownload() {
  const response = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", tabId: job.tabId, items: job.items });
  if (!response?.ok) throw new Error(response?.error || "Could not start the download. Open TI Downloader to try again.");
  await chrome.storage.session.remove(key);
}

chooseButton.addEventListener("click", async () => {
  if (choosing || closed || !job) return;
  choosing = true;
  chooseButton.disabled = true;
  let remembered = false;
  try {
    const directory = await window.showDirectoryPicker({ id: "ti-downloader", mode: "readwrite", startIn: "downloads" });
    await FolderStore.save(directory);
    remembered = true;
    if (!closed) await startDownload();
  } catch (error) {
    statusElement.textContent = error.name === "AbortError"
      ? "No folder selected. Choose a download folder to continue."
      : error.message;
  } finally {
    choosing = false;
    chooseButton.disabled = !job;
    if (remembered && !closed) window.close();
  }
});
closeButton.addEventListener("click", () => window.close());
window.addEventListener("pagehide", () => {
  closed = true;
  if (key && !choosing) chrome.storage.session.remove(key).catch(() => {});
});

async function init() {
  key = new URLSearchParams(location.search).get("job");
  if (!key?.startsWith("download:")) throw new Error("Start a download from TI Downloader.");
  const stored = await chrome.storage.session.get(key);
  job = stored[key];
  if (!job || !Array.isArray(job.items) || !job.items.length) {
    job = null;
    throw new Error("The download request has expired. Start again from the source page.");
  }
  const directory = await FolderStore.load();
  if (closed) return;
  if (directory) {
    try { await startDownload(); } finally { window.close(); }
    return;
  }
  statusElement.textContent = "Choose a download folder once. Future downloads will save there without opening this window.";
  chooseButton.disabled = false;
}

init().catch((error) => { statusElement.textContent = error.message; });
