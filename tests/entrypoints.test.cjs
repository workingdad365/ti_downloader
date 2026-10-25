const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const FolderStore = require("../folder-store.js");
const { source, tick, event, content, element, directory, background } = require("./helpers.cjs");

test("팝업과 오버레이의 최초 다운로드 요청에서 원본 탭을 유지", async () => {
  for (const [sender, tabId] of [[{}, 7], [{ tab: { id: 9 }, url: "https://www.tiktok.com/" }, 9],
    [{ tab: { id: 11 }, url: "chrome-extension://test/download.html?job=download:test" }, 7]]) {
    const fixture = background();
    const items = [{ item: { url: "https://v.tiktokcdn.com/one.mp4", kind: "video" }, filename: "one.mp4" }];
    const response = await fixture.message({ type: "START_DOWNLOAD", tabId: 7, items }, sender);
    assert.equal(response.ok, true);
    assert.equal(fixture.windows.length, 1);
    const key = new URL(fixture.windows[0].url).searchParams.get("job");
    assert.equal(fixture.stored[key].tabId, tabId);
    assert.equal(fixture.stored[key].items, items);
  }
});

test("최초 폴더 안내 창에서 시작해도 미디어 취득에는 원본 탭 사용", async () => {
  const fixture = background({ storage: { directory: directory() } });
  const items = [{ item: { kind: "video", url: "https://v.tiktokcdn.com/one.mp4" }, filename: "one.mp4" }];
  const response = await fixture.message({ type: "START_DOWNLOAD", tabId: 7, items },
    { tab: { id: 11 }, url: "chrome-extension://test/download.html?job=download:test" });
  assert.equal(response.state, "started");
  await tick();
  assert.equal(fixture.requests[0].tabId, 7);
  assert.equal(fixture.status().state, "complete");
  assert.equal(fixture.windows.length, 0);
});

test("창 생성 실패 시 대기 요청을 정리하고 잘못된 목록은 저장하지 않음", async () => {
  const fixture = background({ failWindow: true });
  const response = await fixture.message({ type: "START_DOWNLOAD", tabId: 7, items: [{ item: { kind: "video" } }] });
  assert.equal(response.ok, false);
  assert.equal(Object.keys(fixture.stored).length, 0);
  for (const items of [undefined, [], Array(41).fill({}), [null]]) {
    const result = await fixture.message({ type: "START_DOWNLOAD", tabId: 7, items });
    assert.equal(result.ok, false);
  }
});

test("기존 미디어 세션 캐시를 계속 읽고 갱신", async () => {
  const fixture = background();
  const payload = { pageUrl: "https://www.instagram.com/p/POST/", media: [] };
  const sender = { tab: { id: 7 } };
  assert.equal((await fixture.message({ type: "CACHE_MEDIA", payload }, sender)).ok, true);
  assert.equal(await fixture.message({ type: "GET_CACHED_MEDIA" }, sender), payload);
});

function popup({ storage = {}, state = "started", unsupported = false, optionsError = false,
  profile = false, limitReached = false, items = [
    { kind: "video", url: "https://v.tiktokcdn.com/one.mp4" },
    { kind: "image", url: "https://v.tiktokcdn.com/two.jpg" }
  ] } = {}) {
  const elements = new Map([...source("popup.html").matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]));
  const created = [];
  const requests = [];
  const messages = [];
  const onChanged = event();
  let closed = false;
  let settingsOpened = 0;
  elements.get("choose-folder").disabled = true;
  const context = vm.createContext({ URL, window: { close() { closed = true; } },
    FolderStore: { ...FolderStore, load: async () => storage.directory || null },
    document: {
      querySelector: (selector) => elements.get(selector.slice(1)),
      querySelectorAll: () => [...elements.values(), ...created],
      createElement(tagName) { const node = element(tagName); created.push(node); return node; }
    },
    chrome: {
      runtime: { getManifest: () => ({ version: "1.0.6" }),
        async openOptionsPage() { if (optionsError) throw new Error("Could not open folder settings"); settingsOpened += 1; },
        async sendMessage(message) {
        messages.push(message);
        if (message.type === "START_DOWNLOAD") requests.push(message);
        return { ok: true, state };
      } },
      storage: { onChanged },
      tabs: { query: async () => [{ id: 7, url: unsupported ? "https://example.com" : "https://www.tiktok.com/@user/video/123" }],
        sendMessage: async () => ({ media: items, platform: "tiktok", profile, limitReached }) }
    }
  });
  vm.runInContext(source("popup.js"), context);
  return { elements, requests, messages, storage, onChanged, settingsOpened: () => settingsOpened, closed: () => closed };
}

test("팝업 일괄 다운로드는 파일명과 순서를 유지한 하나의 작업으로 전달", async () => {
  const fixture = popup();
  await tick();
  await fixture.elements.get("download-all").click();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].type, "START_DOWNLOAD");
  assert.equal(fixture.requests[0].items.length, 2);
  assert.match(fixture.requests[0].items[0].filename, /^ti_downloader-tiktok-123-\d{8}-\d{6}-\d{3}-01\.mp4$/);
  assert.match(fixture.requests[0].items[1].filename, /-02\.jpg$/);
  assert.equal(fixture.closed(), false);
});

test("팝업 개별 다운로드와 별도의 폴더 지정 버튼을 각각 연결", async () => {
  const single = popup();
  await tick();
  await single.elements.get("media-list").children[1].children[2].click();
  assert.equal(single.requests[0].items.length, 1);
  assert.equal(single.requests[0].items[0].item.kind, "image");
  const settings = popup();
  await tick();
  await settings.elements.get("choose-folder").click();
  assert.equal(settings.requests.length, 0);
  assert.equal(settings.settingsOpened(), 1);
  assert.equal(settings.closed(), false);
});

test("미지원 페이지에서도 별도의 폴더 설정을 열고 열기 실패 시 재시도 가능", async () => {
  for (const optionsError of [false, true]) {
    const original = directory({ name: "Original" });
    const fixture = popup({ storage: { directory: original }, unsupported: true, optionsError });
    await tick();
    await fixture.elements.get("choose-folder").click();
    assert.equal(fixture.storage.directory, original);
    assert.equal(fixture.settingsOpened(), optionsError ? 0 : 1);
    assert.equal(fixture.elements.get("choose-folder").textContent, "Change download folder");
    assert.equal(fixture.elements.get("choose-folder").disabled, false);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.closed(), false);
  }
});

test("폴더 재승인 안내와 다운로드 진행 및 중지는 기본 UI에 표시", async () => {
  const handle = directory({ permission: "prompt" });
  const fixture = popup({ storage: { directory: handle } });
  await tick();
  assert.match(fixture.elements.get("folder-status").textContent, /Folder access is required/);
  assert.equal(handle.requested(), 0);
  fixture.onChanged.emit({ "download-status": { newValue: { state: "saving", message: "Saving 1 of 2..." } } }, "session");
  assert.equal(fixture.elements.get("download-progress").hidden, false);
  assert.equal(fixture.elements.get("stop-downloads").hidden, false);
  await fixture.elements.get("stop-downloads").click();
  assert.equal(fixture.messages.at(-1).type, "STOP_DOWNLOADS");
  fixture.onChanged.emit({ "download-status": { newValue: { state: "stopped", message: "Download stopped." } } }, "session");
  assert.equal(fixture.elements.get("stop-downloads").hidden, true);
  assert.equal(fixture.elements.get("download-status").textContent, "Download stopped.");
});

test("다른 다운로드가 남아 있으면 완료 결과와 함께 중지 버튼 유지", async () => {
  const fixture = popup();
  await tick();
  fixture.onChanged.emit({ "download-status": { newValue: { state: "complete", active: 1, message: "Saved 1 file." } } }, "session");
  assert.equal(fixture.elements.get("stop-downloads").hidden, false);
  assert.match(fixture.elements.get("download-status").textContent, /Saved 1 file.*1 download\(s\) still in progress/);
  await fixture.elements.get("stop-downloads").click();
  assert.equal(fixture.messages.at(-1).type, "STOP_DOWNLOADS");
  fixture.onChanged.emit({ "download-status": { newValue: { state: "stopped", active: 0, message: "Download stopped." } } }, "session");
  assert.equal(fixture.elements.get("stop-downloads").hidden, true);
});

test("영상 위 버튼은 백그라운드 다운로드를 요청", async () => {
  const requests = [];
  const fixture = content({ sendMessage: async (message) => {
    if (message.type === "START_DOWNLOAD") requests.push(message);
    return { ok: true, state: "started" };
  } });
  vm.runInContext('refreshMedia = async () => {}; refreshDownloadOverlays = () => {}; mediaForUi = () => [{ kind: "video", url: "https://v.tiktokcdn.com/one.mp4" }];', fixture.context);
  const button = element();
  await fixture.context.downloadFromOverlay({ preventDefault() {}, stopPropagation() {} }, button);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].items[0].item.kind, "video");
  assert.match(requests[0].items[0].filename, /^ti_downloader-tiktok-123-/);
  assert.equal(button.title, "Download started");
});

test("프로필 팝업은 40개를 넘는 게시물을 표시하고 게시물별 ID로 파일명을 생성", async () => {
  const items = Array.from({ length: 45 }, (_, index) => ({ kind: index === 0 ? "post" : "video",
    postId: String(index + 1), mediaIndex: 0, mediaCount: index === 0 ? 2 : 1, pendingResolution: true,
    url: `https://www.tiktok.com/@user/video/${index + 1}`, permalink: `https://www.tiktok.com/@user/video/${index + 1}` }));
  const fixture = popup({ profile: true, items });
  await tick();
  assert.equal(fixture.elements.get("media-list").children.length, 45);
  assert.equal(fixture.elements.get("platform").textContent, "tiktok profile");
  assert.match(fixture.elements.get("status").textContent, /45 post\(s\)/);
  assert.equal(fixture.elements.get("media-list").children[0].children[0].textContent, "POST");
  assert.match(fixture.elements.get("media-list").children[0].children[1].children[0].textContent, /2 files/);
  await fixture.elements.get("download-all").click();
  assert.equal(fixture.requests[0].items.length, 45);
  assert.match(fixture.requests[0].items[0].filename, /^ti_downloader-tiktok-1-.*\.post$/);
  assert.match(fixture.requests[0].items[44].filename, /^ti_downloader-tiktok-45-.*\.mp4$/);
});

test("프로필 팝업은 목록 제한과 빈 프로필 안내를 표시", async () => {
  const limited = popup({ profile: true, limitReached: true });
  const empty = popup({ profile: true, items: [] });
  await tick();
  assert.match(limited.elements.get("status").textContent, /500 posts/);
  assert.match(empty.elements.get("status").textContent, /Scroll the profile/);
  assert.equal(empty.elements.get("download-all").disabled, true);
});
