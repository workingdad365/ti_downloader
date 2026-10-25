const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { source, tick, ports, content } = require("./helpers.cjs");

const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 255, 128, 0]);
const instagramVideo = { kind: "video", url: "https://video.cdninstagram.com/one.mp4", verified: true };
const tiktokVideo = { kind: "video", url: "https://v.tiktokcdn.com/one.mp4" };

function response(body, { url = instagramVideo.url, status = 200, type = "video/mp4", length } = {}) {
  const result = new Response(body, { status, headers: { "content-type": type, ...(length ? { "content-length": length } : {}) } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function reader({ page = content({ hostname: "www.instagram.com" }), fetch = async () => response(mp4) } = {}) {
  let bridge;
  const context = vm.createContext({ URL, Uint8Array, ReadableStream, TransformStream, DOMException, atob, fetch,
    chrome: {
      runtime: {},
      tabs: {
        sendMessage: (_id, message) => page.message(message),
        connect() { bridge = ports(); page.connect(bridge.pair[1]); return bridge.pair[0]; }
      }
    }
  });
  vm.runInContext(source("media-reader.js"), context);
  return { open: context.MediaReader.open, bridge: () => bridge };
}

test("Instagram 영상은 쿠키 없이 가져오고 분할된 MP4 헤더와 바이너리를 보존", async () => {
  const fixture = reader({ fetch: async (url, options) => {
    assert.equal(url, instagramVideo.url);
    assert.equal(options.credentials, "omit");
    return response(new ReadableStream({ start(controller) {
      controller.enqueue(mp4.slice(0, 5));
      controller.enqueue(mp4.slice(5, 10));
      controller.enqueue(mp4.slice(10));
      controller.close();
    } }));
  } });
  const stream = await fixture.open(7, instagramVideo);
  assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()), mp4);
});

test("이미지는 선택한 URL의 응답을 스트림으로 반환", async () => {
  const image = { kind: "image", url: "https://image.cdninstagram.com/photo.jpg" };
  const bytes = Uint8Array.of(255, 216, 0, 127);
  const fixture = reader({ fetch: async (url, options) => {
    assert.equal(url, image.url);
    assert.equal(options.credentials, "include");
    return response(bytes, { url, type: "image/jpeg" });
  } });
  assert.deepEqual(new Uint8Array(await new Response(await fixture.open(7, image)).arrayBuffer()), bytes);
});

test("페이지 준비 응답이 없어도 중지와 시간 초과는 즉시 미디어 취득 종료", async () => {
  for (const reason of [new DOMException("Stopped", "AbortError"), new Error("The media request timed out.")]) {
    let respond;
    let fetches = 0;
    const fixture = reader({
      page: { message: () => new Promise((resolve) => { respond = resolve; }) },
      fetch: async () => { fetches += 1; return response(mp4); }
    });
    const controller = new AbortController();
    const opening = fixture.open(7, instagramVideo, { signal: controller.signal });
    const rejected = assert.rejects(opening, (error) => error === reason);
    controller.abort(reason);
    await rejected;
    respond({ ok: true, source: "instagram-video", url: instagramVideo.url });
    await tick();
    assert.equal(fetches, 0);
  }
});

test("Instagram HTTP 오류, 잘못된 형식, 호스트, 빈 응답과 용량 초과 거절", async () => {
  const cases = [
    [() => response(mp4, { status: 403 }), /403/],
    [() => response(mp4, { type: "text/html" }), /not an MP4/],
    [() => response(mp4, { url: "https://example.com/file.mp4" }), /not allowed/],
    [() => response(new Uint8Array(12)), /signature/],
    [() => response(mp4.slice(0, 5)), /signature/],
    [() => response(new Uint8Array()), /signature/],
    [() => response(mp4, { length: 256 * 1024 * 1024 + 1 }), /256 MB/]
  ];
  for (const [fetch, pattern] of cases) {
    const fixture = reader({ fetch });
    await assert.rejects(async () => new Response(await fixture.open(7, instagramVideo)).arrayBuffer(), pattern);
  }
});

test("Content-Length가 없어도 Instagram 스트림의 256 MB 제한 적용", async () => {
  const chunk = new Uint8Array(8 * 1024 * 1024);
  chunk.set(mp4);
  let cancelled = false;
  const fixture = reader({ fetch: async () => response(new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; }
  })) });
  const stream = await fixture.open(7, instagramVideo);
  await assert.rejects(stream.pipeTo(new WritableStream({ write() {} })), /256 MB/);
  await tick();
  assert.equal(cancelled, true);
});

test("TikTok 영상은 페이지 세션으로 취득하고 64 KB 이하 메시지로 원본 바이트 전송", async () => {
  const bytes = Uint8Array.from({ length: 170000 }, (_, index) => index % 256);
  const page = content({ fetch: async (url, options) => {
    assert.equal(url, tiktokVideo.url);
    assert.equal(options.credentials, "include");
    assert.equal(options.cache, "no-store");
    return response(bytes, { url });
  } });
  const fixture = reader({ page, fetch: async () => assert.fail("TikTok 영상을 확장 컨텍스트에서 요청함") });
  const stream = await fixture.open(7, tiktokVideo);
  assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()), bytes);
  const chunks = fixture.bridge().messages.filter((message) => message.type === "CHUNK" && !message.done);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => Buffer.from(chunk.data, "base64").length <= 64 * 1024));
  assert.equal(fixture.bridge().closed(), true);
});

test("TikTok 취득 실패와 HTML 또는 빈 영상 응답을 오류로 전달", async () => {
  for (const options of [{ status: 403 }, { type: "text/html" }, { empty: true }]) {
    const page = content({ fetch: async () => response(options.empty ? new Uint8Array() : mp4, options) });
    const fixture = reader({ page });
    await assert.rejects(async () => new Response(await fixture.open(7, tiktokVideo)).arrayBuffer(), /403|not a video|empty/);
    assert.equal(fixture.bridge().closed(), true);
  }
});

test("TikTok 저장 중지와 원본 탭 연결 종료는 대기 중인 읽기를 종료", async () => {
  for (const disconnect of [false, true]) {
    let pageSignal;
    let cancelled = false;
    const page = content({ fetch: async (_url, options) => {
      pageSignal = options.signal;
      return response(new ReadableStream({ cancel() { cancelled = true; } }));
    } });
    const fixture = reader({ page });
    const controller = new AbortController();
    const stream = await fixture.open(7, tiktokVideo, { signal: controller.signal });
    const reading = assert.rejects(stream.getReader().read(), disconnect ? /disconnected/ : { name: "AbortError" });
    await tick();
    if (disconnect) fixture.bridge().pair[1].disconnect();
    else controller.abort();
    await reading;
    await tick();
    assert.equal(pageSignal.aborted, true);
    assert.equal(cancelled, true);
  }
});

test("Instagram 미확정 영상은 게시물 URL 해석 후 검증된 CDN 주소를 반환", async () => {
  const page = content({ hostname: "www.instagram.com" });
  vm.runInContext('resolveInstagramProgressiveVideoCached = async (url) => { if (!url.endsWith("/POST/")) throw new Error("Wrong post"); return { url: "https://video.cdninstagram.com/resolved.mp4" }; }', page.context);
  const result = await page.message({ type: "PREPARE_PAGE_MEDIA", item: { kind: "video", url: "https://www.instagram.com/p/POST/", pendingResolution: true } });
  assert.equal(result.ok, true);
  assert.equal(result.source, "instagram-video");
  assert.match(result.url, /resolved\.mp4$/);
  const invalid = await page.message({ type: "PREPARE_PAGE_MEDIA", item: { kind: "image", url: "https://example.com/image.jpg" } });
  assert.equal(invalid.ok, false);
});
