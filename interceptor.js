(function () {
  if (window.__tiDownloaderInterceptor) return;
  window.__tiDownloaderInterceptor = true;

  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  window.fetch = async function (...args) {
    const pageUrl = location.href;
    const response = await originalFetch.apply(this, args);
    if (pageUrl === location.href && (isDetailPage() || ProfileMedia.profile(pageUrl))) inspectResponse(response.clone(), pageUrl);
    return response;
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__tiDownloaderUrl = String(url || "");
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const pageUrl = location.href;
    this.addEventListener("load", function () {
      try {
        if (pageUrl !== location.href || (!isDetailPage() && !ProfileMedia.profile(pageUrl))) return;
        const contentType = this.getResponseHeader("content-type") || "";
        if (this.responseType === "json" && this.response) {
          publish(this.response, pageUrl);
          return;
        }
        if (this.responseType && this.responseType !== "text") return;
        if (!contentType.includes("json") && !String(this.responseText || "").trim().startsWith("{")) return;
        publish(JSON.parse(this.responseText), pageUrl);
      } catch {
        // Non-JSON network responses are irrelevant.
      }
    });
    return originalSend.apply(this, arguments);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source !== "ti_downloader" || event.data?.type !== "GET_RUNTIME_MEDIA") return;

    const media = ProfileMedia.profile(location.href) ? getProfileRuntimeMedia()
      : isTikTok() ? getTikTokRuntimeMedia() : getInstagramRuntimeMedia();
    window.postMessage(
      {
        source: "ti_downloader_page",
        type: "RUNTIME_MEDIA",
        requestId: event.data.requestId,
        pageUrl: location.href,
        media
      },
      location.origin
    );
  }, true);

  async function inspectResponse(response, pageUrl) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return;
    try {
      publish(await response.json(), pageUrl);
    } catch {
      // Ignore incomplete or non-JSON response bodies.
    }
  }

  function publish(data, pageUrl = location.href) {
    if (pageUrl !== location.href) return;
    const media = ProfileMedia.profile(pageUrl) ? ProfileMedia.collect(data, pageUrl) : collectMedia(data);
    if (!media.length) return;
    window.postMessage(
      {
        source: "ti_downloader_page",
        type: "MEDIA_FOUND",
        pageUrl,
        media
      },
      location.origin
    );
  }

  function collectMedia(root) {
    const found = new Map();
    const seen = new WeakSet();
    const stack = [{ value: root, inCurrentPost: false }];
    let inspected = 0;

    while (stack.length && inspected < 50000) {
      const entry = stack.pop();
      const value = entry.value;
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      inspected += 1;

      const inCurrentPost = isInstagram()
        ? entry.inCurrentPost || matchesCurrentInstagramPost(value)
        : false;
      if (isInstagram() && inCurrentPost) collectInstagramObject(value, found);
      if (isTikTok()) collectTikTokObject(value, found);

      for (const child of Object.values(value)) {
        if (child && typeof child === "object") stack.push({ value: child, inCurrentPost });
      }
    }
    return [...found.values()];
  }

  function collectInstagramObject(value, found) {
    const metadata = { verified: true, mediaId: String(value.pk || value.id || "") || undefined };
    addCandidate(found, value.video_url, "video", scoreSize(value), metadata);
    addCandidate(found, value.videoUrl, "video", scoreSize(value), metadata);

    if (Array.isArray(value.video_versions)) {
      addBestCandidate(found, value.video_versions, "url", "video", metadata);
    }

    addCandidate(found, value.display_url, "image", scoreSize(value));
    if (Array.isArray(value.display_resources)) {
      addBestCandidate(found, value.display_resources, "src", "image");
    }
    if (Array.isArray(value.image_versions2?.candidates)) {
      addBestCandidate(found, value.image_versions2.candidates, "url", "image");
    }
    if (Array.isArray(value.carousel_media)) {
      value.carousel_media.forEach((item) => collectInstagramMediaItem(item, found));
    }
    if (Array.isArray(value.edge_sidecar_to_children?.edges)) {
      value.edge_sidecar_to_children.edges.forEach((edge) =>
        collectInstagramMediaItem(edge?.node, found)
      );
    }
  }

  function collectInstagramMediaItem(value, found) {
    if (!value || typeof value !== "object") return;
    const metadata = { verified: true, mediaId: String(value.pk || value.id || "") || undefined };
    addCandidate(found, value.video_url, "video", scoreSize(value), metadata);
    if (Array.isArray(value.video_versions)) {
      addBestCandidate(found, value.video_versions, "url", "video", metadata);
    }
    addCandidate(found, value.display_url, "image", scoreSize(value));
    if (Array.isArray(value.image_versions2?.candidates)) {
      addBestCandidate(found, value.image_versions2.candidates, "url", "image");
    }
  }

  function collectTikTokObject(value, found) {
    if (!matchesCurrentTikTokPost(value)) return;
    const video = value.video || value.Video || value;
    const videoCandidate = selectTikTokVideo(video);
    addCandidate(found, videoCandidate?.url, "video", videoCandidate?.score || 0);

    const images = value.images || value.imagePost?.images || value.image_post_info?.images;
    if (Array.isArray(images)) {
      images.forEach((image) => {
        const urls = image?.imageURL?.urlList || image?.display_image?.url_list || image?.owner_watermark_image?.url_list;
        addCandidate(found, firstUrl(urls), "image", scoreSize(image));
      });
    }
  }

  function selectTikTokVideo(video) {
    return ProfileMedia.tiktokVideo(video);
  }

  function firstUrl(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.find((url) => typeof url === "string") || "";
    if (Array.isArray(value?.urlList)) return firstUrl(value.urlList);
    return "";
  }

  function addBestCandidate(found, items, urlKey, kind, metadata) {
    const best = [...items].sort((a, b) => scoreSize(b) - scoreSize(a))[0];
    addCandidate(found, best?.[urlKey], kind, scoreSize(best), metadata);
  }

  function addCandidate(found, rawUrl, kind, score, metadata = {}) {
    if (typeof rawUrl !== "string") return;
    const url = decodeUrl(rawUrl);
    if (!url.startsWith("https://") || !isMediaHost(url)) return;
    const current = found.get(url);
    if (!current || score > current.score) found.set(url, { url, kind, score, ...metadata });
  }

  function decodeUrl(url) {
    return url
      .replace(/\\u002F/g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
  }

  function isMediaHost(url) {
    try {
      const host = new URL(url).hostname;
      return /(^|\.)(instagram\.com|cdninstagram\.com|fbcdn\.net|tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|byteoversea\.com|ibytedtos\.com|muscdn\.com|akamaized\.net)$/.test(host);
    } catch {
      return false;
    }
  }

  function scoreSize(value) {
    return Number(value?.width || value?.original_width || 0) *
      Number(value?.height || value?.original_height || 0) +
      Number(value?.bitrate || value?.bit_rate || 0);
  }

  function matchesCurrentInstagramPost(value) {
    const shortcode = location.pathname.match(/^\/(?:p|reel|tv)\/([^/]+)/)?.[1];
    if (!shortcode) return false;
    const candidate = value.shortcode || value.code;
    if (candidate) return String(candidate) === shortcode;
    return typeof value.permalink === "string" && value.permalink.includes(`/${shortcode}/`);
  }

  function matchesCurrentTikTokPost(value) {
    const videoId = location.pathname.match(/\/video\/(\d+)/)?.[1];
    if (!videoId) return true;
    const candidate = value.id || value.aweme_id || value.itemId;
    return candidate ? String(candidate) === videoId : false;
  }

  function isInstagram() {
    return location.hostname.endsWith("instagram.com");
  }

  function isTikTok() {
    return location.hostname.endsWith("tiktok.com");
  }

  function isTikTokPageUrl(rawUrl) {
    try {
      return ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com"].includes(new URL(rawUrl).hostname);
    } catch {
      return true;
    }
  }

  function isDetailPage() {
    return isInstagram()
      ? /^\/(p|reel|tv)\/[^/]+/.test(location.pathname)
      : /\/video\/\d+/.test(location.pathname);
  }

  function getProfileRuntimeMedia() {
    const found = new Map();
    const add = (root) => {
      for (const item of ProfileMedia.collect(root, location.href)) {
        if (ProfileMedia.prefer(item, found.get(ProfileMedia.key(item)))) found.set(ProfileMedia.key(item), item);
      }
    };
    let bytes = 0;
    for (const script of document.querySelectorAll('script[type="application/json"], script#SIGI_STATE, script#__NEXT_DATA__')) {
      const text = script.textContent || "";
      bytes += text.length;
      if (bytes > 20000000) break;
      try { add(JSON.parse(text)); } catch {}
    }
    if (isTikTok()) {
      add(window.SIGI_STATE);
      add(window.__$UNIVERSAL_DATA$__);
    }

    const nodes = [...new Set([
      ...document.querySelectorAll('[data-e2e="user-post-item-list"], [class*="DivVideoListContainer"], [data-e2e="user-post-item"], [class*="DivItemContainer"], div[id^="column-item-video-container-"]'),
      ...ProfileMedia.cards(document, location.href).map((card) => card.element)
    ])].slice(0, 100);
    const queue = [];
    for (const node of nodes) {
      for (const key of Object.getOwnPropertyNames(node)) {
        if (key.startsWith("__reactFiber$") || key.startsWith("__reactProps$")) queue.push({ value: node[key], depth: 0 });
      }
    }
    const seen = new WeakSet();
    const keys = ["child", "sibling", "alternate", "return", "memoizedProps", "pendingProps", "memoizedState",
      "props", "children", "item", "items", "itemInfo", "itemStruct", "aweme", "awemeInfo", "videoData", "itemList", "list", "data", "edges", "node", "post", "media", "next"];
    let inspected = 0;
    while (queue.length && inspected < 6000) {
      const { value, depth } = queue.pop();
      if (!value || typeof value !== "object" || depth > 18 || seen.has(value)) continue;
      seen.add(value);
      inspected += 1;
      if ((value.code || value.shortcode) && (value.media_type || value.is_video !== undefined) ||
          (value.id || value.aweme_id || value.itemId) && (value.video || value.imagePost || value.image_post_info)) add(value);
      for (const child of Array.isArray(value) ? value : keys.map((key) => value[key])) {
        if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
      }
    }
    return [...found.values()];
  }

  function getTikTokRuntimeMedia() {
    const section = getActiveTikTokSection();
    if (!section) return [];
    const item = findReactItem(section);
    if (!item || typeof item !== "object") return [];

    const currentId = location.pathname.match(/\/video\/(\d+)/)?.[1];
    const itemId = String(item.id || item.aweme_id || "");
    if (currentId && itemId && itemId !== currentId) return [];

    const candidate = selectTikTokVideo(item.video);
    if (!candidate?.url) return [];
    const found = new Map();
    addCandidate(found, candidate.url, "video", candidate.score);
    return [...found.values()];
  }

  function getInstagramRuntimeMedia() {
    const found = new Map();
    document.querySelectorAll('script[type="application/json"]').forEach((script) => {
      const text = script.textContent?.trim();
      if (!text || text.length > 20000000) return;
      try {
        collectMedia(JSON.parse(text)).forEach((item) => {
          const current = found.get(item.url);
          if (!current || Number(item.score || 0) > Number(current.score || 0)) {
            found.set(item.url, item);
          }
        });
      } catch {
        // Ignore non-JSON hydration scripts.
      }
    });
    return [...found.values()];
  }

  function getActiveTikTokSection() {
    const selectors = [
      'section[data-e2e="feed-video"]',
      '[data-e2e="browse-video"]',
      '[data-e2e="video-player"]'
    ];
    const sections = [...document.querySelectorAll(selectors.join(","))]
      .filter((element) => isVisible(element));
    if (sections.length) {
      return sections.sort((a, b) => visibleScore(b) - visibleScore(a))[0];
    }

    const video = [...document.querySelectorAll("video")]
      .filter((element) => isVisible(element))
      .sort((a, b) => visibleScore(b) - visibleScore(a))[0];
    return video?.closest("section, article, main, div[data-e2e]") || video?.parentElement || null;
  }

  function findReactItem(section) {
    const nodes = [section, ...section.querySelectorAll("*")];
    for (const node of nodes) {
      let names;
      try {
        names = Object.getOwnPropertyNames(node);
      } catch {
        continue;
      }

      const fiberKey = names.find((key) => key.startsWith("__reactFiber$"));
      if (fiberKey) {
        let fiber = node[fiberKey];
        while (fiber) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          const item = props?.item || props?.itemInfo?.itemStruct || props?.awemeInfo;
          if (item?.video) return item;
          fiber = fiber.return || null;
        }
      }

      const propsKey = names.find((key) => key.startsWith("__reactProps$"));
      const props = propsKey ? node[propsKey] : null;
      const item = props?.item || props?.itemInfo?.itemStruct || props?.awemeInfo;
      if (item?.video) return item;
    }
    return null;
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function visibleScore(element) {
    const rect = element.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    const centerPenalty = Math.abs(rect.top + rect.height / 2 - innerHeight / 2);
    return visibleWidth * visibleHeight * 10 - centerPenalty;
  }
})();
