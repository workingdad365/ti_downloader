const assert = require("node:assert/strict");
const { test } = require("node:test");
const { background, directory, tick } = require("./helpers.cjs");

const item = { kind: "video", url: "https://v.tiktokcdn.com/one.mp4" };
const items = [{ item, filename: "video.mp4" }];
const start = (fixture, downloads = items) => fixture.message({ type: "START_DOWNLOAD", tabId: 7, items: downloads });

test("폴더 미지정 때만 최초 안내 창을 열고 미디어는 취득하지 않음", async () => {
  const fixture = background();
  const result = await start(fixture);
  assert.equal(result.state, "needs-folder");
  assert.equal(fixture.windows.length, 1);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.intervals.size, 0);
  const key = new URL(fixture.windows[0].url).searchParams.get("job");
  assert.equal(fixture.stored[key].tabId, 7);
  assert.equal(fixture.stored[key].items, items);
});

test("기억한 폴더에 백그라운드로 저장하며 재실행 후에도 팝업 없이 기존 파일 보존", async () => {
  const handle = directory();
  const storage = { directory: handle };
  for (let index = 0; index < 2; index += 1) {
    const fixture = background({ storage });
    const result = await start(fixture);
    assert.equal(result.state, "started");
    await tick();
    assert.equal(fixture.windows.length, 0);
    assert.equal(fixture.requests[0].tabId, 7);
    assert.equal(fixture.status().state, "complete");
    assert.equal(fixture.status().saved, 1);
    assert.equal(fixture.intervals.size, 0);
    assert.equal(fixture.timeouts.size, 0);
    assert.equal(fixture.badge(), "");
  }
  assert.equal(handle.requested(), 0);
  assert.deepEqual([...handle.files.keys()], ["video.mp4", "video (1).mp4"]);
  assert.deepEqual(handle.files.get("video.mp4"), Buffer.from([0, 255, 128]));
  assert.deepEqual(handle.files.get("video (1).mp4"), Buffer.from([0, 255, 128]));
});

test("권한 만료나 삭제된 폴더도 팝업을 열지 않고 기본 UI에서 변경하도록 안내", async () => {
  for (const options of [{ permission: "prompt" }, { permission: "denied" }, { missing: true }]) {
    const handle = directory(options);
    const fixture = background({ storage: { directory: handle } });
    const result = await start(fixture);
    assert.equal(result.ok, false);
    assert.match(result.error, /Change download folder/);
    assert.equal(fixture.windows.length, 0);
    assert.equal(fixture.requests.length, 0);
    assert.equal(handle.requested(), 0);
    assert.equal(fixture.storage.directory, handle);
    assert.equal(fixture.badge(), "!");
  }
  const broken = background({ loadError: true });
  assert.equal((await start(broken)).ok, false);
  assert.equal(broken.windows.length, 0);
});

test("기본 UI에서 바꾼 폴더를 다음 다운로드부터 사용", async () => {
  const first = directory({ name: "First" });
  const second = directory({ name: "Second" });
  const storage = { directory: first };
  const fixture = background({ storage });
  await start(fixture);
  await tick();
  storage.directory = second;
  await start(fixture);
  await tick();
  assert.equal(first.files.size, 1);
  assert.equal(second.files.size, 1);
  assert.equal(fixture.windows.length, 0);
  assert.match(fixture.status().message, /Second/);
});

test("파일 쓰기가 끝날 때까지 작업을 유지하고 전체 배치 완료 후에만 성공 표시", async () => {
  let finish;
  const handle = directory({ closeGate: new Promise((resolve) => { finish = resolve; }) });
  const fixture = background({ storage: { directory: handle } });
  await start(fixture, [...items, { item, filename: "second.mp4" }]);
  await tick();
  assert.equal(fixture.status().state, "saving");
  assert.equal(fixture.status().saved, 0);
  assert.equal(fixture.intervals.size, 1);
  const timer = [...fixture.intervals.values()][0];
  assert.ok(timer.delay < 30000);
  await timer.fn();
  assert.equal(fixture.keepAliveCalls(), 1);
  finish();
  await tick();
  assert.equal(fixture.status().state, "complete");
  assert.equal(fixture.status().saved, 2);
  assert.equal(fixture.intervals.size, 0);
  assert.equal(handle.files.size, 2);
  assert.equal(fixture.windows.length, 0);
});

test("미디어 취득 실패는 다음 파일로 진행하고 오류를 기본 UI에 남김", async () => {
  const fixture = background({ storage: { directory: directory() },
    open: async (_item, _options, count) => {
      if (count === 1) throw new Error("HTTP 403");
      return new Response(Uint8Array.of(1, 2, 3)).body;
    }
  });
  await start(fixture, [...items, { item, filename: "second.mp4" }]);
  await tick();
  assert.equal(fixture.status().state, "error");
  assert.match(fixture.status().message, /Saved 1 file.*1 failed: HTTP 403/);
  assert.equal(fixture.windows.length, 0);
  assert.equal(fixture.badge(), "!");
  assert.equal(fixture.intervals.size, 0);
});

test("디스크 쓰기 실패는 후속 파일 저장을 중단하고 기존 파일과 원본 이름 보존", async () => {
  const handle = directory({ failWrite: true });
  handle.files.set("video.mp4", Buffer.from("original"));
  const fixture = background({ storage: { directory: handle } });
  await start(fixture, [...items, { item, filename: "second.mp4" }]);
  await tick();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.status().state, "error");
  assert.match(fixture.status().message, /Disk full/);
  assert.deepEqual([...handle.files.keys()], ["video.mp4"]);
  assert.equal(handle.files.get("video.mp4").toString(), "original");
  assert.equal(fixture.windows.length, 0);
  assert.equal(fixture.intervals.size, 0);
});

test("기본 UI의 중지 요청은 스트림과 후속 파일을 취소하고 불완전한 파일 정리", async () => {
  const handle = directory();
  let cancelled = false;
  const fixture = background({ storage: { directory: handle },
    open: async () => new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); },
      cancel() { cancelled = true; }
    })
  });
  await start(fixture, [...items, ...items]);
  await tick();
  await fixture.message({ type: "STOP_DOWNLOADS" });
  await tick();
  assert.equal(fixture.requests[0].signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(fixture.requests.length, 1);
  assert.equal(handle.files.size, 0);
  assert.equal(fixture.status().state, "stopped");
  assert.equal(fixture.intervals.size, 0);
  assert.equal(fixture.windows.length, 0);
});

test("응답 지연은 워커 종료 전에 취소하고 오류 표시 및 타이머 정리", async () => {
  const fixture = background({ storage: { directory: directory() },
    open: async (_item, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
  await start(fixture);
  await tick();
  const timeout = [...fixture.timeouts.values()][0];
  assert.ok(timeout.delay < 30000);
  timeout.fn();
  await tick();
  assert.equal(fixture.status().state, "error");
  assert.match(fixture.status().message, /timed out/);
  assert.equal(fixture.intervals.size, 0);
  assert.equal(fixture.timeouts.size, 0);
  assert.equal(fixture.windows.length, 0);
});

test("예기치 않은 워커 재시작 후 진행 중 상태를 성공으로 표시하지 않음", async () => {
  const fixture = background({ storage: { directory: directory() },
    session: { "download-status": { id: "previous-worker", state: "saving", message: "Saving..." } }
  });
  const response = await fixture.message({ type: "GET_DOWNLOAD_STATUS" });
  assert.equal(response.status.state, "error");
  assert.match(response.status.message, /interrupted/);
  assert.equal(fixture.windows.length, 0);
});

test("동시 다운로드 중 하나가 끝나도 남은 작업을 표시하고 중지 가능", async () => {
  const handle = directory();
  const fixture = background({ storage: { directory: handle },
    open: async (_item, { signal }, count) => count === 1
      ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
      : new Response(Uint8Array.of(1, 2, 3)).body
  });
  await start(fixture);
  await start(fixture);
  await tick();
  assert.equal(fixture.status().state, "complete");
  assert.equal(fixture.status().active, 1);
  assert.equal((await fixture.message({ type: "GET_DOWNLOAD_STATUS" })).active, 1);
  assert.equal(fixture.badge(), "...");
  assert.equal(handle.files.size, 1);
  await fixture.message({ type: "STOP_DOWNLOADS" });
  await tick();
  assert.equal(fixture.status().state, "stopped");
  assert.equal(fixture.status().active, 0);
  assert.equal(fixture.intervals.size, 0);
  assert.equal(fixture.timeouts.size, 0);
  assert.equal(fixture.windows.length, 0);
});

test("동시 작업 일부 완료 후 워커가 종료되면 남은 작업을 중단으로 표시", async () => {
  const fixture = background({ session: { "download-status": {
    id: "finished", state: "complete", active: 1, message: "Saved 1 file."
  } } });
  const response = await fixture.message({ type: "GET_DOWNLOAD_STATUS" });
  assert.equal(response.status.state, "error");
  assert.equal(response.status.active, 0);
  assert.match(response.status.message, /interrupted/);
});
