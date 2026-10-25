const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const folderButton = document.querySelector("#choose-folder");
const folderElement = document.querySelector("#folder");
const statusElement = document.querySelector("#status");
document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;

let directory = null;
let job = null;
let running = false;
let controller = null;
let nextItem = 0;
let saved = 0;
let failed = 0;
let closed = false;
let lastFailure = "";

function renderFolder() {
  folderElement.textContent = directory ? `Save folder: ${directory.name}` : "Choose a folder once. Future downloads will reuse it.";
  folderButton.textContent = directory ? "Change folder" : "Choose folder";
  startButton.textContent = directory ? "Save" : "Choose folder and save";
}

function setBusy(busy) {
  running = busy;
  folderButton.disabled = busy;
  startButton.disabled = busy || !job?.items.length || nextItem >= job.items.length;
  stopButton.hidden = !busy;
  stopButton.disabled = false;
}

async function chooseDirectory() {
  if (!window.showDirectoryPicker) throw new Error("Chrome with direct folder saving support is required.");
  const selected = await window.showDirectoryPicker({ id: "ti-downloader", mode: "readwrite", startIn: "downloads" });
  await FolderStore.save(selected);
  directory = selected;
  renderFolder();
}

function showError(error) {
  statusElement.textContent = error.name === "AbortError" ? "Cancelled. No further files were saved." : error.message;
}

function sanitizeFilename(filename) {
  return String(filename || "media").replace(/[<>:"|?*\\/\x00-\x1f]/g, "_")
    .replace(/\.{2,}/g, ".").replace(/^[._]+/, "").slice(0, 180) || "media";
}

async function saveItems(interactive = true) {
  if (closed || running || !job?.items.length || nextItem >= job.items.length) return;
  setBusy(true);
  controller = new AbortController();
  const signal = controller.signal;
  try {
    const reusable = await FolderStore.canReuse(directory, { interactive });
    signal.throwIfAborted();
    if (!reusable) {
      if (!interactive) {
        statusElement.textContent = directory ? "Click Save to confirm folder access or choose a new folder." : "Choose a save folder to start. It will be remembered.";
        return;
      }
      await chooseDirectory();
    }
    for (; nextItem < job.items.length; nextItem += 1) {
      signal.throwIfAborted();
      const { item, filename } = job.items[nextItem];
      statusElement.textContent = `Saving ${nextItem + 1} of ${job.items.length}...`;
      let source;
      let writing = false;
      try {
        source = await MediaReader.open(job.tabId, item, { signal });
        signal.throwIfAborted();
        writing = true;
        await FolderWriter.write(directory, sanitizeFilename(filename), source, { signal });
        saved += 1;
      } catch (error) {
        if (signal.aborted || writing) throw error;
        failed += 1;
        lastFailure = error.message;
        statusElement.textContent = error.message;
      } finally {
        await source?.cancel().catch(() => {});
      }
    }
    statusElement.textContent = `Saved ${saved} file(s) to ${directory.name}.${failed ? ` ${failed} failed: ${lastFailure}` : ""}`;
  } catch (error) {
    showError(error);
  } finally {
    controller = null;
    setBusy(false);
  }
}

startButton.addEventListener("click", () => saveItems());
stopButton.addEventListener("click", () => {
  controller?.abort();
  stopButton.disabled = true;
});
folderButton.addEventListener("click", async () => {
  if (running) return;
  setBusy(true);
  stopButton.hidden = true;
  try {
    await chooseDirectory();
    statusElement.textContent = "Save folder remembered.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});
window.addEventListener("pagehide", () => {
  closed = true;
  controller?.abort();
});

async function init() {
  const key = new URLSearchParams(location.search).get("job");
  if (!key?.startsWith("download:")) throw new Error("Open the save window from TI Downloader.");
  const stored = await chrome.storage.session.get(key);
  job = stored[key];
  if (!job || !Array.isArray(job.items)) throw new Error("The download request has expired. Start again from the source page.");
  await chrome.storage.session.remove(key);
  directory = await FolderStore.load();
  renderFolder();
  startButton.hidden = !job.items.length;
  setBusy(false);
  if (job.items.length) await saveItems(false);
  else statusElement.textContent = "Choose the folder to use for future downloads.";
}

init().catch((error) => {
  showError(error);
  folderButton.disabled = false;
});
