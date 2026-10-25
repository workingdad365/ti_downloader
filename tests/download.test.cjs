const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const FolderStore = require("../folder-store.js");
const FolderWriter = require("../folder-writer.js");
const { source, tick, directory, element } = require("./helpers.cjs");

const media = { kind: "video", url: "https://v.tiktokcdn.com/one.mp4" };
const defaultItems = [{ item: media, filename: "video.mp4" }];

function saveWindow({ storage = {}, selected = directory(), cancel = false, saveError = false, loadGate,
  items = defaultItems, open = async () => new Response(Uint8Array.of(0, 255, 128)).body } = {}) {
  const elements = new Map([...source("download.html").matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]));
  elements.get("start").disabled = true;
  elements.get("choose-folder").disabled = true;
  const listeners = new Map();
  const requests = [];
  let picked = 0;
  let consumed = false;
  const context = vm.createContext({ URLSearchParams, AbortController,
    location: { search: "?job=download:test" },
    document: { querySelector: (selector) => elements.get(selector.slice(1)) },
    window: {
      addEventListener(name, fn) { listeners.set(name, fn); },
      async showDirectoryPicker() {
        picked += 1;
        if (cancel) throw new DOMException("Cancelled", "AbortError");
        return selected;
      }
    },
    chrome: {
      runtime: { getManifest: () => ({ version: "1.0.6" }) },
      storage: { session: {
        get: async () => ({ "download:test": { tabId: 7, items } }),
        async remove(key) { assert.equal(key, "download:test"); consumed = true; }
      } }
    },
    FolderStore: { ...FolderStore,
      async load() { await loadGate; return storage.directory || null; },
      async save(handle) { if (saveError) throw new Error("Settings write failed"); storage.directory = handle; }
    },
    FolderWriter,
    MediaReader: { async open(tabId, item, options) {
      assert.equal(tabId, 7);
      requests.push({ item, ...options });
      return open(item, options, requests.length);
    } }
  });
  vm.runInContext(source("download.js"), context);
  return { elements, requests, storage, selected, consumed: () => consumed, picked: () => picked,
    click: (name) => elements.get(name).click(), close: () => listeners.get("pagehide")(),
    status: () => elements.get("status").textContent };
}

test("최초 폴더 선택 후 저장하며 다시 연 창은 선택 없이 자동 저장", async () => {
  const first = saveWindow();
  await tick();
  assert.equal(first.picked(), 0);
  assert.equal(first.requests.length, 0);
  assert.equal(first.consumed(), true);
  await first.click("start");
  assert.equal(first.picked(), 1);
  assert.deepEqual(first.selected.files.get("video.mp4"), Buffer.from([0, 255, 128]));
  assert.match(first.status(), /^Saved 1 file/);
  first.close();
  const reopened = saveWindow({ storage: first.storage });
  await tick();
  assert.equal(reopened.picked(), 0);
  assert.equal(reopened.requests.length, 1);
  assert.equal(first.selected.requested(), 0);
  assert.deepEqual(first.selected.files.get("video (1).mp4"), Buffer.from([0, 255, 128]));
  assert.equal(reopened.elements.get("choose-folder").textContent, "Change folder");
});

test("기억한 폴더 권한이 없으면 자동 요청하지 않고 클릭 후 재허용", async () => {
  const handle = directory({ permission: "prompt", granted: "denied" });
  const fixture = saveWindow({ storage: { directory: handle } });
  await tick();
  assert.equal(handle.requested(), 0);
  assert.equal(fixture.requests.length, 0);
  await fixture.click("start");
  assert.equal(handle.requested(), 1);
  assert.equal(fixture.requests.length, 0);
  assert.match(fixture.status(), /Write access/);
  handle.granted = "granted";
  await fixture.click("start");
  assert.equal(fixture.picked(), 0);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.storage.directory, handle);
});

test("폴더 선택 취소나 설정 저장 실패 시 미디어를 요청하지 않음", async () => {
  for (const options of [{ cancel: true }, { saveError: true }]) {
    const fixture = saveWindow(options);
    await tick();
    await fixture.click("start");
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.storage.directory, undefined);
    assert.equal(fixture.selected.files.size, 0);
    assert.equal(fixture.elements.get("start").disabled, false);
  }
});

test("폴더 설정 창은 다운로드 없이 변경하며 취소 시 기존 설정 보존", async () => {
  for (const cancel of [false, true]) {
    const original = directory({ name: "Original" });
    const selected = directory({ name: "Changed" });
    const fixture = saveWindow({ items: [], storage: { directory: original }, selected, cancel });
    await tick();
    assert.equal(fixture.elements.get("start").hidden, true);
    await fixture.click("choose-folder");
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.storage.directory, cancel ? original : selected);
    const reopened = saveWindow({ storage: fixture.storage });
    await tick();
    assert.match(reopened.status(), new RegExp(cancel ? "Original" : "Changed"));
  }
});

test("삭제된 폴더는 클릭 시 재선택하며 파일 취득 전에 새 폴더 저장", async () => {
  const fixture = saveWindow({ storage: { directory: directory({ missing: true }) } });
  await tick();
  assert.equal(fixture.picked(), 0);
  assert.equal(fixture.requests.length, 0);
  await fixture.click("start");
  assert.equal(fixture.picked(), 1);
  assert.equal(fixture.storage.directory, fixture.selected);
  assert.equal(fixture.selected.files.size, 1);
});

test("파일 close 전에는 성공 표시를 하지 않고 폴더 변경과 중복 실행 차단", async () => {
  let finish;
  const handle = directory({ closeGate: new Promise((resolve) => { finish = resolve; }) });
  const fixture = saveWindow({ storage: { directory: handle } });
  await tick();
  assert.match(fixture.status(), /^Saving/);
  assert.equal(fixture.elements.get("choose-folder").disabled, true);
  await fixture.click("start");
  await fixture.click("choose-folder");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.picked(), 0);
  finish();
  await tick();
  assert.match(fixture.status(), /^Saved 1 file/);
});

test("취득 실패는 다음 파일로 진행하지만 쓰기 실패는 중단하고 기존 파일 보존", async () => {
  const items = [...defaultItems, { item: media, filename: "second.mp4" }];
  const handle = directory();
  const fetchFailure = saveWindow({ storage: { directory: handle }, items,
    open: async (_item, _options, count) => {
      if (count === 1) throw new Error("HTTP 403");
      return new Response(mp4Bytes()).body;
    }
  });
  await tick();
  assert.equal(fetchFailure.requests.length, 2);
  assert.match(fetchFailure.status(), /Saved 1 file.*1 failed: HTTP 403/);
  const failedFolder = directory({ failWrite: true });
  failedFolder.files.set("video.mp4", Buffer.from("original"));
  const writeFailure = saveWindow({ storage: { directory: failedFolder }, items });
  await tick();
  assert.equal(writeFailure.requests.length, 1);
  assert.match(writeFailure.status(), /Disk full/);
  assert.deepEqual([...failedFolder.files.keys()], ["video.mp4"]);
  assert.equal(failedFolder.files.get("video.mp4").toString(), "original");
});

function mp4Bytes() { return Uint8Array.of(0, 255, 128); }

test("중지와 창 닫기는 진행 중인 스트림과 후속 파일 저장을 취소", async () => {
  for (const close of [false, true]) {
    const handle = directory();
    let cancelled = false;
    const fixture = saveWindow({ storage: { directory: handle }, items: [...defaultItems, ...defaultItems],
      open: async () => new ReadableStream({
        start(controller) { controller.enqueue(mp4Bytes()); },
        cancel() { cancelled = true; }
      })
    });
    await tick();
    if (close) fixture.close();
    else fixture.click("stop");
    await tick();
    assert.equal(fixture.requests[0].signal.aborted, true);
    assert.equal(cancelled, true);
    assert.equal(fixture.requests.length, 1);
    assert.equal(handle.files.size, 0);
    assert.match(fixture.status(), /Cancelled/);
  }
});

test("폴더 복원 전에 조작을 차단하고 먼저 닫힌 창에서는 저장하지 않음", async () => {
  let restore;
  const fixture = saveWindow({ storage: { directory: directory() }, loadGate: new Promise((resolve) => { restore = resolve; }) });
  await tick();
  await fixture.click("start");
  await fixture.click("choose-folder");
  assert.equal(fixture.picked(), 0);
  fixture.close();
  restore();
  await tick();
  assert.equal(fixture.requests.length, 0);
});
