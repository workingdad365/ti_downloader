const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { source, tick, directory, element } = require("./helpers.cjs");

const items = [{ item: { kind: "video", url: "https://v.tiktokcdn.com/one.mp4" }, filename: "video.mp4" }];

function setupWindow({ storage = {}, selected = directory(), cancel = false, saveError = false,
  loadGate, pickerGate, job = { tabId: 7, items }, response = { ok: true, state: "started" } } = {}) {
  const elements = new Map([...source("download.html").matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]));
  elements.get("choose-folder").disabled = true;
  const listeners = new Map();
  const requests = [];
  let picked = 0;
  let removed = 0;
  let closeCalls = 0;
  const context = vm.createContext({ URLSearchParams,
    location: { search: "?job=download:test" },
    document: { querySelector: (selector) => elements.get(selector.slice(1)) },
    window: {
      addEventListener(name, fn) { listeners.set(name, fn); },
      close() { closeCalls += 1; listeners.get("pagehide")?.(); },
      async showDirectoryPicker(options) {
        picked += 1;
        assert.equal(options.mode, "readwrite");
        await pickerGate;
        if (cancel) throw new DOMException("Cancelled", "AbortError");
        return selected;
      }
    },
    chrome: {
      runtime: { getManifest: () => ({ version: "1.0.6" }),
        async sendMessage(message) { requests.push(message); return response; } },
      storage: { session: {
        get: async () => ({ "download:test": job }),
        async remove(key) { assert.equal(key, "download:test"); removed += 1; }
      } }
    },
    FolderStore: {
      async load() { await loadGate; return storage.directory || null; },
      async save(handle) { if (saveError) throw new Error("Settings write failed"); storage.directory = handle; }
    }
  });
  vm.runInContext(source("download.js"), context);
  return { elements, requests, storage, selected, removed: () => removed, picked: () => picked,
    closeCalls: () => closeCalls, click: (name) => elements.get(name).click(),
    close: () => listeners.get("pagehide")(), status: () => elements.get("status").textContent };
}

test("최초 폴더 지정 후 백그라운드에 저장을 맡기고 안내 창을 즉시 닫음", async () => {
  const fixture = setupWindow();
  await tick();
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.picked(), 0);
  assert.match(fixture.status(), /without opening this window/);
  await fixture.click("choose-folder");
  assert.equal(fixture.storage.directory, fixture.selected);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].type, "START_DOWNLOAD");
  assert.equal(fixture.requests[0].tabId, 7);
  assert.equal(fixture.requests[0].items, items);
  assert.equal(fixture.closeCalls(), 1);
  assert.ok(fixture.removed() > 0);
  assert.equal(fixture.selected.files.size, 0);
});

test("이미 폴더가 지정되었으면 안내 창에서 폴더 선택을 다시 요구하지 않음", async () => {
  const fixture = setupWindow({ storage: { directory: directory() } });
  await tick();
  assert.equal(fixture.picked(), 0);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.closeCalls(), 1);
});

test("폴더 선택 취소와 설정 저장 실패는 다운로드를 시작하지 않음", async () => {
  for (const options of [{ cancel: true }, { saveError: true }]) {
    const fixture = setupWindow(options);
    await tick();
    await fixture.click("choose-folder");
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.storage.directory, undefined);
    assert.equal(fixture.closeCalls(), 0);
    assert.equal(fixture.elements.get("choose-folder").disabled, false);
  }
});

test("첫 폴더 지정이 끝나면 백그라운드 시작 오류도 안내 창을 다시 사용하지 않음", async () => {
  const fixture = setupWindow({ response: { ok: false, error: "Folder access required" } });
  await tick();
  await fixture.click("choose-folder");
  assert.equal(fixture.storage.directory, fixture.selected);
  assert.equal(fixture.closeCalls(), 1);
});

test("폴더 선택 중 중복 클릭은 하나의 다운로드만 시작", async () => {
  let finish;
  const fixture = setupWindow({ pickerGate: new Promise((resolve) => { finish = resolve; }) });
  await tick();
  const first = fixture.click("choose-folder");
  await fixture.click("choose-folder");
  assert.equal(fixture.picked(), 1);
  finish();
  await first;
  assert.equal(fixture.requests.length, 1);
});

test("설정 복원 전에 닫힌 창이나 만료된 요청은 다운로드하지 않음", async () => {
  let restore;
  const fixture = setupWindow({ storage: { directory: directory() }, loadGate: new Promise((resolve) => { restore = resolve; }) });
  await tick();
  await fixture.click("choose-folder");
  fixture.close();
  restore();
  await tick();
  assert.equal(fixture.picked(), 0);
  assert.equal(fixture.requests.length, 0);
  const expired = setupWindow({ job: null });
  await tick();
  assert.match(expired.status(), /expired/);
  assert.equal(expired.elements.get("choose-folder").disabled, true);
});
