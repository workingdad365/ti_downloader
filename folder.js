const folderButton = document.querySelector("#choose-folder");
const folderElement = document.querySelector("#folder-name");
const statusElement = document.querySelector("#status");
document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;
document.querySelector("#close").addEventListener("click", () => window.close());

let directory = null;
let choosing = false;

function renderFolder() {
  folderElement.textContent = directory ? `Download folder: ${directory.name}` : "No download folder selected.";
  folderButton.textContent = directory ? "Change download folder" : "Choose download folder";
}

folderButton.addEventListener("click", async () => {
  if (choosing) return;
  choosing = true;
  folderButton.disabled = true;
  try {
    const selected = await window.showDirectoryPicker({ id: "ti-downloader", mode: "readwrite", startIn: "downloads" });
    await FolderStore.save(selected);
    directory = selected;
    renderFolder();
    statusElement.textContent = "Download folder saved. Future downloads will be saved here automatically.";
  } catch (error) {
    statusElement.textContent = error.name === "AbortError" ? "Folder selection cancelled. The previous folder is unchanged." : error.message;
  } finally {
    choosing = false;
    folderButton.disabled = false;
  }
});

async function init() {
  directory = await FolderStore.load();
  renderFolder();
  statusElement.textContent = !directory
    ? "Choose a folder to use for downloads."
    : await FolderStore.canReuse(directory, { interactive: false })
      ? "Downloads are saved here automatically."
      : "Folder access is required. Select this folder again or choose another folder.";
}

init().catch((error) => { statusElement.textContent = error.message; })
  .finally(() => { folderButton.disabled = false; });
