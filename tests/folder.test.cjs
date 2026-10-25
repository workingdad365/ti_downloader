const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const FolderStore = require("../folder-store.js");
const { source, tick, directory, element } = require("./helpers.cjs");

function settings({ storage = {}, selected = directory(), cancel = false, saveError = false } = {}) {
  const elements = new Map([...source("folder.html").matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]));
  elements.get("choose-folder").disabled = true;
  let picked = 0;
  let closed = false;
  const context = vm.createContext({
    document: { querySelector: (selector) => elements.get(selector.slice(1)) },
    window: { close() { closed = true; }, async showDirectoryPicker(options) {
      picked += 1;
      assert.equal(options.mode, "readwrite");
      if (cancel) throw new DOMException("Cancelled", "AbortError");
      return selected;
    } },
    chrome: { runtime: { getManifest: () => ({ version: "1.0.6" }) } },
    FolderStore: { ...FolderStore, load: async () => storage.directory || null,
      async save(handle) { if (saveError) throw new Error("Settings write failed"); storage.directory = handle; } }
  });
  vm.runInContext(source("folder.js"), context);
  return { elements, storage, selected, picked: () => picked, closed: () => closed,
    click: (name) => elements.get(name).click() };
}

test("폴더 설정은 최초 지정과 변경을 기억하고 재실행 시 복원", async () => {
  const storage = {};
  const first = settings({ storage });
  await tick();
  assert.equal(first.picked(), 0);
  await first.click("choose-folder");
  assert.equal(storage.directory, first.selected);
  assert.match(first.elements.get("status").textContent, /Download folder saved/);
  const second = settings({ storage, selected: directory({ name: "Changed" }) });
  await tick();
  assert.equal(second.elements.get("choose-folder").textContent, "Change download folder");
  await second.click("choose-folder");
  assert.equal(storage.directory.name, "Changed");
  await second.click("close");
  assert.equal(second.closed(), true);
});

test("폴더 변경 취소나 설정 저장 실패는 이전 폴더 보존", async () => {
  for (const options of [{ cancel: true }, { saveError: true }]) {
    const original = directory({ name: "Original" });
    const fixture = settings({ storage: { directory: original }, ...options });
    await tick();
    await fixture.click("choose-folder");
    assert.equal(fixture.storage.directory, original);
    assert.equal(fixture.elements.get("folder-name").textContent, "Download folder: Original");
    assert.equal(fixture.elements.get("choose-folder").disabled, false);
  }
});

test("폴더 접근 권한 만료 시 자동 권한 요청 없이 재선택 안내", async () => {
  const handle = directory({ permission: "prompt" });
  const fixture = settings({ storage: { directory: handle } });
  await tick();
  assert.equal(handle.requested(), 0);
  assert.match(fixture.elements.get("status").textContent, /Folder access is required/);
});
