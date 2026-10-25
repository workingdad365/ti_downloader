const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const ProfileMedia = require("../profile-media.js");
const { content, source, element, background, directory, tick } = require("./helpers.cjs");

const instagram = "https://www.instagram.com/aoii_417/";
const tiktok = "https://www.tiktok.com/@imhayun_";
const reel = { __typename: "XDTMediaDict", __isXIGPolarisMedia: "XDTMediaDict", pk: "4009347740802126028",
  code: "DekEIcfhpDM", media_type: 2, display_uri: "https://image.cdninstagram.com/cover.jpg",
  user: { username: "aoii_417" }, accessibility_caption: "Profile reel" };
const video = (id, username = "imhayun_") => ({ id, author: { uniqueId: username },
  video: { cover: `https://p.tiktokcdn.com/${id}.jpg`, playAddr: { urlList: [`https://v.tiktokcdn.com/${id}.mp4`] } } });
const album = { code: "ALBUM", pk: "12345", media_type: 8, user: { username: "aoii_417" }, carousel_media: [
  { pk: "12346", media_type: 1, image_versions2: { candidates: [{ url: "https://image.cdninstagram.com/one.jpg", width: 1080, height: 1440 }] } },
  { pk: "12347", media_type: 2, video_versions: [{ url: "https://video.cdninstagram.com/two.mp4", width: 720, height: 1280 }] }
] };
const html = (data, id = "") => `<script type="application/json" id="${id}">${JSON.stringify(data)}</script>`;
const plain = (value) => JSON.parse(JSON.stringify(value));

function documentWithCards(cards) {
  return { documentElement: element("html"), cookie: "", createElement: element,
    querySelector: () => null,
    querySelectorAll: (selector) => selector.startsWith("a[href") ? cards.filter((card) => card.href)
      : selector.includes("DivItemContainer") ? cards.filter((card) => !card.href) : [] };
}

function card(href, { dialog = false, top = 100, id = "", thumbnail = "" } = {}) {
  const image = { alt: "Post", currentSrc: thumbnail };
  return { href, id, querySelector: () => image, getAttribute: () => "",
    closest: () => dialog ? {} : null,
    getBoundingClientRect: () => ({ top, bottom: top + 250, left: 100, right: 300, width: 200, height: 250 }) };
}

test("프로필과 작성자 경로가 있는 게시물을 구분하고 비지원 경로 제외", () => {
  assert.equal(ProfileMedia.profile(instagram).username, "aoii_417");
  assert.equal(ProfileMedia.profile(`${instagram}reels/`).platform, "instagram");
  assert.equal(ProfileMedia.profile(tiktok).username, "imhayun_");
  assert.equal(ProfileMedia.post(`${instagram}reel/DekEIcfhpDM/`, instagram).postId, reel.code);
  assert.equal(ProfileMedia.post(`${tiktok}/photo/123`, tiktok).kind, "post");
  for (const url of ["https://www.instagram.com/explore/", "https://www.instagram.com/accounts/", `${tiktok}/video/123`]) {
    assert.equal(ProfileMedia.profile(url), null);
  }
  assert.equal(ProfileMedia.post("https://www.instagram.com.evil.test/p/POST/", instagram), null);
  assert.equal(ProfileMedia.post(`${tiktok}/video/123`, instagram), null);
});

test("Instagram 실제 프로필 형태의 메타데이터는 썸네일 대신 미확정 영상으로 감지", () => {
  const items = ProfileMedia.fromHtml(html({ require: [["ScheduledServerJS", { __bbox: { result: { data: { edges: [{ node: reel }] } } } }]] }), instagram);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "video");
  assert.equal(items[0].pendingResolution, true);
  assert.equal(items[0].mediaId, reel.pk);
  assert.equal(items[0].url, `https://www.instagram.com/p/${reel.code}/`);
});

test("TikTok 목록은 여러 영상과 사진을 유지하고 다른 작성자 및 상세 게시물 혼입 방지", () => {
  const photo = { id: "222", author: { uniqueId: "imhayun_" }, imagePost: { images: [
    { imageURL: { urlList: ["https://p.tiktokcdn.com/one.jpg"] } },
    { imageURL: { urlList: ["https://p.tiktokcdn.com/two.jpg"] } }
  ] } };
  const root = { itemList: [video("111"), photo, video("333"), video("444", "other")] };
  const items = ProfileMedia.collect(root, tiktok);
  assert.deepEqual(items.map((item) => `${item.postId}:${item.mediaIndex}`), ["111:0", "222:0", "222:1", "333:0"]);
  assert.equal(items[1].permalink, `${tiktok}/photo/222`);
  assert.deepEqual(ProfileMedia.collect(root, `${tiktok}/video/333`).map((item) => item.postId), ["333"]);
  const photoPage = ProfileMedia.collect(root, `${tiktok}/photo/222`);
  assert.deepEqual(photoPage.map((item) => item.kind), ["image", "image"]);
});

test("Instagram carousel의 순서와 원본 종류를 유지하고 표지 이미지를 별도 파일로 오인하지 않음", () => {
  const items = ProfileMedia.collect({ items: [album] }, instagram);
  assert.deepEqual(items.map((item) => item.kind), ["image", "video"]);
  assert.deepEqual(items.map((item) => item.mediaIndex), [0, 1]);
  assert.ok(items.every((item) => item.postMediaId === album.pk && item.mediaCount === 2));
  const posts = ProfileMedia.posts(items);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].kind, "post");
  const metadata = ProfileMedia.collect({ ...album, carousel_media: undefined, carousel_media_count: 2,
    display_url: "https://image.cdninstagram.com/cover.jpg", is_video: false }, instagram)[0];
  assert.equal(metadata.kind, "post");
  assert.equal(metadata.pendingResolution, true);
});

test("동일 게시물은 ID로 병합하고 DOM 재검색이 원본 주소와 메타데이터를 덮어쓰지 않음", async () => {
  const page = content({ pageUrl: instagram });
  await tick();
  const link = ProfileMedia.cards(documentWithCards([card(`${instagram}reel/${reel.code}/`)]), instagram)[0].item;
  page.context.mergeMedia([link], instagram);
  page.context.mergeMedia(ProfileMedia.collect(reel, instagram), instagram);
  page.context.mergeMedia([link], instagram);
  assert.equal(page.context.mediaForUi()[0].mediaId, reel.pk);
  const resolved = { ...reel, video_versions: [{ url: "https://video.cdninstagram.com/source.mp4", width: 1080, height: 1920 }] };
  page.context.mergeMedia(ProfileMedia.collect(resolved, instagram), instagram);
  page.context.mergeMedia([link], instagram);
  assert.equal(page.context.mediaForUi().length, 1);
  assert.equal(page.context.mediaForUi()[0].url, resolved.video_versions[0].url);
});

test("DOM 카드에서는 다른 계정과 대화상자를 제외하고 링크 없는 TikTok 카드는 ID나 썸네일로 연결", () => {
  const document = documentWithCards([card(`${tiktok}/video/111`), card("https://www.tiktok.com/@other/video/222"),
    card(`${tiktok}/video/333`, { dialog: true }), card("", { id: "column-item-video-container-444" }),
    card("", { thumbnail: "https://p.tiktokcdn.com/555.jpg" })]);
  const known = ProfileMedia.collect([video("444"), video("555")], tiktok);
  assert.deepEqual(ProfileMedia.cards(document, tiktok, known).map(({ item }) => item.postId), ["111", "444", "555"]);
});

test("프로필 카드별 오버레이 다운로드는 해당 게시물만 전달하고 SPA 이동 시 이전 항목 제거", async () => {
  const requests = [];
  const cards = [card(`${tiktok}/video/111`), card(`${tiktok}/video/222`, { top: 1500 })];
  const document = documentWithCards(cards);
  const page = content({ pageUrl: tiktok, document,
    sendMessage: async (message) => { requests.push(message); return { ok: true, state: "started" }; } });
  await tick();
  assert.equal(document.documentElement.children.length, 1);
  const button = document.documentElement.children[0].shadow.children[1];
  await button.click();
  const request = requests.find((message) => message.type === "START_DOWNLOAD");
  assert.equal(request.items.length, 1);
  assert.equal(request.items[0].item.postId, "111");
  assert.match(request.items[0].filename, /tiktok-111-/);
  page.context.location = new URL("https://www.tiktok.com/@other");
  cards.splice(0, cards.length);
  page.context.refreshDownloadOverlays();
  await tick();
  page.context.mergeMedia(ProfileMedia.collect(video("111"), tiktok), tiktok);
  assert.equal(page.context.mediaForUi().length, 0);
  assert.equal(document.documentElement.children.length, 0);
});

test("Instagram 미확정 게시물은 저장 시 media ID로 원본 전체를 해석하고 요청 중복을 합침", async () => {
  let requests = 0;
  const item = ProfileMedia.collect({ ...album, carousel_media: undefined, carousel_media_count: 2 }, instagram)[0];
  const page = content({ pageUrl: instagram, fetch: async (url, options) => {
    requests += 1;
    assert.equal(url, `https://www.instagram.com/api/v1/media/${album.pk}/info/`);
    assert.equal(options.credentials, "include");
    return Response.json({ items: [album] });
  } });
  await tick();
  page.context.mergeMedia([item], instagram);
  const results = await Promise.all([0, 1].map(() => page.message({ type: "RESOLVE_PROFILE_POST", item })));
  assert.equal(requests, 1);
  for (const result of results) {
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(plain(result.items.map((entry) => entry.kind)), ["image", "video"]);
  }
  assert.equal(page.context.mediaForUi().length, 1);
});

test("TikTok 링크만 감지한 게시물은 정확한 ID의 초기 JSON으로 해석하고 다른 게시물 및 CAPTCHA 응답 거절", async () => {
  for (const body of [html({ ItemModule: { 111: video("111"), 222: video("222") } }, "SIGI_STATE"),
    html({ itemList: [video("222")] }), "<title>Verify you are human</title>"]) {
    let requests = 0;
    const item = ProfileMedia.cards(documentWithCards([card(`${tiktok}/video/111`)]), tiktok)[0].item;
    const page = content({ pageUrl: tiktok, fetch: async (url) => {
      requests += 1;
      assert.equal(url, `${tiktok}/video/111`);
      return new Response(body);
    } });
    await tick();
    const response = await page.message({ type: "RESOLVE_PROFILE_POST", item });
    assert.equal(response.ok, body.includes('"111"'), response.error);
    if (response.ok) assert.equal(response.items[0].url, "https://v.tiktokcdn.com/111.mp4");
    else {
      assert.match(response.error, /Open it, sign in/);
      await page.message({ type: "RESOLVE_PROFILE_POST", item });
      assert.equal(requests, 2);
    }
  }
});

test("게시물 해석 중 프로필 이동 시 이전 결과가 새 목록에 들어가지 않음", async () => {
  let finish;
  const page = content({ pageUrl: tiktok, fetch: () => new Promise((resolve) => { finish = resolve; }) });
  await tick();
  const item = ProfileMedia.cards(documentWithCards([card(`${tiktok}/video/111`)]), tiktok)[0].item;
  const pending = page.message({ type: "RESOLVE_PROFILE_POST", item });
  page.context.location = new URL("https://www.tiktok.com/@other");
  page.context.syncMediaPage();
  finish(new Response(html(video("111"))));
  assert.equal((await pending).ok, true);
  assert.equal(page.context.mediaForUi().length, 0);
});

test("프로필 500개 제한은 게시물 전체에 적용하고 원본 없는 추천 게시물은 표시하지 않음", async () => {
  const page = content({ pageUrl: tiktok });
  await tick();
  page.context.mergeMedia(ProfileMedia.collect(Array.from({ length: 501 }, (_, index) => video(String(index + 1))), tiktok), tiktok);
  assert.equal(page.context.mediaForUi().length, 500);
  assert.equal((await page.message({ type: "GET_MEDIA" })).limitReached, true);
  const unknown = ProfileMedia.collect({ ...video("999"), author: undefined }, tiktok);
  page.context.mergeMedia(unknown, tiktok);
  assert.ok(!page.context.mediaForUi().some((item) => item.postId === "999"));
});

test("백그라운드는 게시물을 순서대로 확장하여 이미지와 영상을 저장하고 진행 총수 갱신", async () => {
  const handle = directory();
  const resolved = ProfileMedia.collect(album, instagram);
  const item = ProfileMedia.posts(resolved)[0];
  let resolutions = 0;
  const worker = background({ storage: { directory: handle }, resolve: async (_item, tabId) => {
    resolutions += 1;
    assert.equal(tabId, 7);
    return resolved;
  } });
  const response = await worker.message({ type: "START_DOWNLOAD", tabId: 7, items: [{ item, filename: "instagram-ALBUM.post" }] });
  assert.equal(response.state, "started");
  await tick();
  assert.equal(resolutions, 1);
  assert.deepEqual([...handle.files.keys()], ["instagram-ALBUM-01.jpg", "instagram-ALBUM-02.mp4"]);
  assert.equal(worker.status().saved, 2);
  assert.equal(worker.status().total, 2);
  assert.equal(worker.status().state, "complete");
  assert.equal(worker.windows.length, 0);
});

test("게시물 해석 실패는 다음 게시물로 진행하며 중지된 해석의 늦은 응답은 파일을 만들지 않음", async () => {
  const resolved = ProfileMedia.collect(album, instagram);
  const item = ProfileMedia.posts(resolved)[0];
  const handle = directory();
  const worker = background({ storage: { directory: handle }, resolve: async () => { throw new Error("Post unavailable"); } });
  await worker.message({ type: "START_DOWNLOAD", tabId: 7, items: [{ item, filename: "album.post" },
    { item: resolved[0], filename: "next.jpg" }] });
  await tick();
  assert.deepEqual([...handle.files.keys()], ["next.jpg"]);
  assert.match(worker.status().message, /1 failed: Post unavailable/);
  let finish;
  const stopped = background({ storage: { directory: directory() }, resolve: () => new Promise((resolve) => { finish = resolve; }) });
  await stopped.message({ type: "START_DOWNLOAD", tabId: 7, items: [{ item, filename: "album.post" }] });
  await tick();
  await stopped.message({ type: "STOP_DOWNLOADS" });
  await tick();
  finish(resolved);
  await tick();
  assert.equal(stopped.status().state, "stopped");
  assert.equal(stopped.requests.length, 0);
  assert.equal(stopped.intervals.size, 0);
});

test("게시물 확장 응답의 다른 ID, 미확정 URL과 과도한 파일 목록을 거절", async () => {
  const resolved = ProfileMedia.collect(album, instagram);
  const item = ProfileMedia.posts(resolved)[0];
  for (const items of [[{ ...resolved[0], postId: "OTHER" }], [{ ...resolved[0], pendingResolution: true }],
    [{ ...resolved[0], url: "https://example.com/file.jpg" }], Array(41).fill(resolved[0])]) {
    const worker = background({ storage: { directory: directory() }, resolve: async () => items });
    await worker.message({ type: "START_DOWNLOAD", tabId: 7, items: [{ item, filename: "album.post" }] });
    await tick();
    assert.equal(worker.status().state, "error");
    assert.equal(worker.requests.length, 0);
  }
});

function interceptor(pageUrl, document, globals = {}) {
  const messages = [];
  let onMessage;
  const context = vm.createContext({ URL, location: new URL(pageUrl), document,
    XMLHttpRequest: class { open() {} send() {} },
    window: { ...globals, fetch: async () => Response.json({ itemList: [video("111"), video("222")] }),
      addEventListener(_type, listener) { onMessage = listener; }, postMessage(message) { messages.push(message); } } });
  vm.runInContext(source("profile-media.js"), context);
  vm.runInContext(source("interceptor.js"), context);
  return { context, messages, runtime() { onMessage({ source: context.window, origin: context.location.origin,
    data: { source: "ti_downloader", type: "GET_RUNTIME_MEDIA", requestId: "test" } }); return messages.at(-1).media; } };
}

test("MAIN 컨텍스트는 초기 JSON, 전역 데이터와 순환 React 목록에서 여러 게시물을 감지", () => {
  const fiber = { memoizedProps: { items: [video("222"), video("333")] } };
  fiber.return = fiber;
  const node = { __reactFiber$fixture: fiber };
  const document = { querySelectorAll: (selector) => selector.startsWith("script") ? [{ textContent: JSON.stringify({ itemList: [video("111")] }) }]
    : selector.startsWith('[data-e2e="user-post-item-list"]') ? [node] : [] };
  const fixture = interceptor(tiktok, document, { SIGI_STATE: { ItemModule: { 444: video("444") } } });
  assert.deepEqual(plain(fixture.runtime().map((item) => item.postId).sort()), ["111", "222", "333", "444"]);
});

test("프로필 네트워크 JSON을 감지하며 요청 도중 SPA 이동하면 응답을 무시", async () => {
  const fixture = interceptor(tiktok, { querySelectorAll: () => [] });
  await fixture.context.window.fetch("https://www.tiktok.com/api/post/item_list/");
  await tick();
  assert.equal(fixture.messages[0].type, "MEDIA_FOUND");
  assert.equal(fixture.messages[0].media.length, 2);
  fixture.messages.length = 0;
  const pending = fixture.context.window.fetch("https://www.tiktok.com/api/post/item_list/");
  fixture.context.location = new URL("https://www.tiktok.com/@other");
  await pending;
  await tick();
  assert.equal(fixture.messages.length, 0);
});
