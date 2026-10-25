const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { source, tick, event, content, element } = require("./helpers.cjs");

function background({ failWindow = false } = {}) {
  const onMessage = event();
  const stored = {};
  const windows = [];
  const context = vm.createContext({ crypto: require("node:crypto").webcrypto,
    chrome: {
      runtime: { onMessage, getURL: (url) => `chrome-extension://test/${url}` },
      storage: { session: {
        async set(values) { Object.assign(stored, values); },
        async get(key) { return { [key]: stored[key] }; },
        async remove(key) { delete stored[key]; }
      } },
      windows: { async create(options) { if (failWindow) throw new Error("Window failed"); windows.push(options); } }
    }
  });
  vm.runInContext(source("background.js"), context);
  return { stored, windows, message: (message, sender = {}) => new Promise((resolve) => onMessage.emit(message, sender, resolve)) };
}

test("팝업과 오버레이 요청을 저장 창에 전달하고 원본 탭을 유지", async () => {
  for (const sender of [{}, { tab: { id: 9 } }]) {
    const fixture = background();
    const items = [{ item: { url: "https://v.tiktokcdn.com/one.mp4", kind: "video" }, filename: "one.mp4" }];
    const response = await fixture.message({ type: "OPEN_DOWNLOAD_WINDOW", tabId: 7, items }, sender);
    assert.equal(response.ok, true);
    assert.equal(fixture.windows.length, 1);
    const key = new URL(fixture.windows[0].url).searchParams.get("job");
    assert.equal(fixture.stored[key].tabId, sender.tab?.id || 7);
    assert.equal(fixture.stored[key].items, items);
  }
});

test("창 생성 실패 시 대기 요청을 정리하고 잘못된 목록은 저장하지 않음", async () => {
  const fixture = background({ failWindow: true });
  const response = await fixture.message({ type: "OPEN_DOWNLOAD_WINDOW", items: [] });
  assert.equal(response.ok, false);
  assert.equal(Object.keys(fixture.stored).length, 0);
  for (const items of [undefined, Array(41).fill({})]) {
    const result = await fixture.message({ type: "OPEN_DOWNLOAD_WINDOW", tabId: 7, items });
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

function popup() {
  const elements = new Map([...source("popup.html").matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]));
  const created = [];
  const requests = [];
  let closed = false;
  const items = [
    { kind: "video", url: "https://v.tiktokcdn.com/one.mp4" },
    { kind: "image", url: "https://v.tiktokcdn.com/two.jpg" }
  ];
  const context = vm.createContext({ URL, window: { close() { closed = true; } },
    document: {
      querySelector: (selector) => elements.get(selector.slice(1)),
      querySelectorAll: () => [...elements.values(), ...created],
      createElement() { const node = element(); created.push(node); return node; }
    },
    chrome: {
      runtime: { getManifest: () => ({ version: "1.0.6" }), async sendMessage(message) { requests.push(message); return { ok: true }; } },
      tabs: { query: async () => [{ id: 7, url: "https://www.tiktok.com/@user/video/123" }], sendMessage: async () => ({ media: items, platform: "tiktok" }) }
    }
  });
  vm.runInContext(source("popup.js"), context);
  return { elements, requests, closed: () => closed };
}

test("팝업 일괄 다운로드는 파일명과 순서를 유지한 하나의 작업으로 전달", async () => {
  const fixture = popup();
  await tick();
  await fixture.elements.get("download-all").click();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].type, "OPEN_DOWNLOAD_WINDOW");
  assert.equal(fixture.requests[0].items.length, 2);
  assert.match(fixture.requests[0].items[0].filename, /^ti_downloader-tiktok-123-\d{8}-\d{6}-\d{3}-01\.mp4$/);
  assert.match(fixture.requests[0].items[1].filename, /-02\.jpg$/);
  assert.equal(fixture.closed(), true);
});

test("팝업 개별 다운로드와 폴더 설정 버튼을 각각 연결", async () => {
  const single = popup();
  await tick();
  await single.elements.get("media-list").children[1].children[2].click();
  assert.equal(single.requests[0].items.length, 1);
  assert.equal(single.requests[0].items[0].item.kind, "image");
  const settings = popup();
  await tick();
  await settings.elements.get("choose-folder").click();
  assert.equal(settings.requests[0].items.length, 0);
});

test("영상 위 다운로드 버튼도 저장 창을 열고 실제 저장 완료로 오인하지 않음", async () => {
  const requests = [];
  const fixture = content({ sendMessage: async (message) => {
    if (message.type === "OPEN_DOWNLOAD_WINDOW") requests.push(message);
    return { ok: true };
  } });
  vm.runInContext('refreshMedia = async () => {}; refreshDownloadOverlays = () => {}; mediaForUi = () => [{ kind: "video", url: "https://v.tiktokcdn.com/one.mp4" }];', fixture.context);
  const button = element();
  await fixture.context.downloadFromOverlay({ preventDefault() {}, stopPropagation() {} }, button);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].items[0].item.kind, "video");
  assert.match(requests[0].items[0].filename, /^ti_downloader-tiktok-123-/);
  assert.equal(button.title, "Save window opened");
});
