const assert = require("node:assert/strict");
const { test } = require("node:test");
const { content, element, tick } = require("./helpers.cjs");

function profile(platform = "tiktok") {
  const pageUrl = platform === "tiktok" ? "https://www.tiktok.com/@fixture" : "https://www.instagram.com/fixture/";
  let scans = 0;
  const cards = [100, 1000].map((top, index) => {
    const position = { top, left: 100, width: 240, height: 300 };
    const image = { alt: "Post" };
    return { position, isConnected: true,
      href: platform === "tiktok" ? `${pageUrl}/video/${index + 1}` : `${pageUrl}reel/POST${index + 1}/`,
      querySelector: () => image, getAttribute: () => "", closest: () => null,
      getBoundingClientRect: () => ({ ...position, right: position.left + position.width, bottom: position.top + position.height }) };
  });
  const document = { documentElement: element("html"), cookie: "", createElement: element,
    querySelector: () => null, querySelectorAll(selector) {
      if (!selector.startsWith("a[href")) return [];
      scans += 1;
      return cards;
    } };
  const page = content({ pageUrl, document });
  return { ...page, cards, document, scans: () => scans };
}

test("두 프로필의 아이콘은 연속 스크롤 중 다음 프레임에 이동하며 게시물을 다시 탐색하지 않음", async () => {
  for (const platform of ["tiktok", "instagram"]) {
    const page = profile(platform);
    await tick();
    const host = page.document.documentElement.children[0];
    const scans = page.scans();
    assert.equal(host.style.top, "108px");
    for (const top of [70, 40, -20]) {
      page.cards[0].position.top = top;
      page.dispatch("scroll");
      page.dispatch("scroll");
      page.dispatch("scroll");
      assert.equal(page.frames.size, 1);
      page.frame();
      assert.equal(host.style.top, `${top + 8}px`);
      assert.equal(page.document.documentElement.children[0], host);
      assert.equal(page.scans(), scans);
    }
    page.cards[0].position.left = 50;
    page.cards[0].position.width = 300;
    page.dispatch("resize");
    page.frame();
    assert.equal(host.style.left, "312px");
    assert.equal(page.scans(), scans);
  }
});

test("스크롤로 새로 보이는 카드와 화면 밖 또는 제거된 카드의 버튼을 같은 프레임에 갱신", async () => {
  const page = profile();
  await tick();
  const old = page.document.documentElement.children[0];
  page.cards[0].position.top = -400;
  page.cards[1].position.top = 800;
  page.dispatch("scroll", { target: {} });
  page.frame();
  assert.equal(page.document.documentElement.children.length, 1);
  const current = page.document.documentElement.children[0];
  assert.notEqual(current, old);
  assert.equal(current.style.top, "808px");
  page.cards[1].isConnected = false;
  page.dispatch("scroll");
  page.frame();
  assert.equal(page.document.documentElement.children.length, 0);
});

test("위치 갱신을 기다리던 중 프로필이 바뀌면 이전 카드의 아이콘을 다시 표시하지 않음", async () => {
  const page = profile();
  await tick();
  page.dispatch("scroll");
  page.context.location = new URL("https://www.tiktok.com/@another");
  page.frame();
  assert.equal(page.document.documentElement.children.length, 0);
  page.dispatch("resize");
  page.frame();
  assert.equal(page.document.documentElement.children.length, 0);
});

test("개별 동영상의 아이콘도 다음 프레임에 따라 움직이고 화면 상단에 고정되지 않음", () => {
  const position = { top: 100, left: 100, width: 400, height: 500 };
  const video = { tagName: "VIDEO", currentSrc: "https://v.tiktokcdn.com/video.mp4",
    getBoundingClientRect: () => ({ ...position, right: position.left + position.width, bottom: position.top + position.height }),
    closest: () => document };
  const document = { documentElement: element("html"), createElement: element,
    querySelectorAll: (selector) => selector.includes("video") ? [video] : [], querySelector: () => video };
  const page = content({ document });
  const host = document.documentElement.children[0];
  assert.equal(host.style.top, "144px");
  for (const top of [80, 30, -60]) {
    position.top = top;
    page.dispatch("scroll");
    page.frame();
    assert.equal(host.style.top, `${top + 44}px`);
    assert.equal(document.documentElement.children.length, 1);
  }
  position.top = -600;
  page.dispatch("scroll");
  page.frame();
  assert.equal(host.style.display, "none");
});
