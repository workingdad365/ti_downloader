(() => {
  const INSTAGRAM = /(^|\.)(instagram\.com)$/;
  const TIKTOK = /(^|\.)(tiktok\.com)$/;
  const CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|byteoversea\.com|ibytedtos\.com|muscdn\.com|akamaized\.net)$/;
  const RESERVED = new Set(["accounts", "about", "direct", "explore", "p", "reel", "reels", "tv", "stories", "legal", "developer", "web", "challenge"]);

  function profile(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (TIKTOK.test(url.hostname)) {
        const match = url.pathname.match(/^\/@([\w.-]+)\/?$/);
        return match ? { platform: "tiktok", username: match[1] } : null;
      }
      if (INSTAGRAM.test(url.hostname)) {
        const match = url.pathname.match(/^\/([\w.]+)\/(?:reels\/?)?$/) || url.pathname.match(/^\/([\w.]+)$/);
        return match && !RESERVED.has(match[1].toLowerCase()) ? { platform: "instagram", username: match[1] } : null;
      }
    } catch {}
    return null;
  }

  function post(rawUrl, baseUrl) {
    try {
      const url = new URL(rawUrl, baseUrl);
      const base = new URL(baseUrl || rawUrl);
      if (url.protocol !== "https:") return null;
      if (INSTAGRAM.test(url.hostname) && INSTAGRAM.test(base.hostname)) {
        const match = url.pathname.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)\/?$/);
        if (!match) return null;
        const type = match[1] === "reels" ? "reel" : match[1];
        return { platform: "instagram", postId: match[2], kind: type === "p" ? "post" : "video",
          permalink: `https://www.instagram.com/${type}/${match[2]}/` };
      }
      if (TIKTOK.test(url.hostname) && TIKTOK.test(base.hostname)) {
        const match = url.pathname.match(/^\/@([\w.-]+)\/(video|photo)\/(\d+)\/?$/);
        if (!match) return null;
        return { platform: "tiktok", username: match[1], postId: match[3], kind: match[2] === "video" ? "video" : "post",
          permalink: `https://www.tiktok.com/@${match[1]}/${match[2]}/${match[3]}` };
      }
    } catch {}
    return null;
  }

  function cards(document, pageUrl, media = []) {
    const context = profile(pageUrl);
    if (!context) return [];
    const selector = context.platform === "tiktok"
      ? 'a[href*="/video/"], a[href*="/photo/"]'
      : 'a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]';
    const found = new Map();
    for (const element of document.querySelectorAll(selector)) {
      const info = post(element.href, pageUrl);
      if (!info || (info.username && info.username.toLowerCase() !== context.username.toLowerCase())) continue;
      const image = element.querySelector("img, video");
      if (!image || element.closest('[role="dialog"]')) continue;
      if (!found.has(info.postId)) found.set(info.postId, { element, item: {
        ...info, url: info.permalink, pendingResolution: true, mediaIndex: 0,
        ownerUsername: context.username,
        title: (image.alt || element.getAttribute("aria-label") || "").slice(0, 160)
      } });
    }
    if (context.platform === "tiktok") {
      for (const element of document.querySelectorAll('[data-e2e="user-post-item"], [class*="DivItemContainer"], div[id^="column-item-video-container-"]')) {
        if (element.closest('[role="dialog"]')) continue;
        const image = element.querySelector("img, video");
        if (!image) continue;
        const id = element.id?.match(/^column-item-video-container-(\d+)$/)?.[1];
        const thumbnail = image.currentSrc || image.src || image.poster;
        const item = media.find((candidate) => candidate.postId === id ||
          (thumbnail && candidate.thumbnail === thumbnail));
        if (item && !found.has(item.postId)) found.set(item.postId, { element, item });
      }
    }
    return [...found.values()];
  }

  function allowed(rawUrl, platform) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === "https:" && (platform === "instagram"
        ? /(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname) : CDN.test(url.hostname));
    } catch { return false; }
  }

  function urls(value) {
    if (typeof value === "string") return [value.replace(/\\u002F/g, "/").replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&")];
    if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? urls(item) : []);
    return urls(value?.urlList || value?.UrlList || value?.url_list || []);
  }

  function tiktokVideo(video) {
    const candidates = [];
    const add = (value, score) => urls(value).forEach((url) => {
      if (allowed(url, "tiktok")) candidates.push({ url, score });
    });
    add(video?.playAddr, 500);
    add(video?.PlayAddrStruct, 450);
    add(video?.play_addr, 400);
    const bitrates = video?.bitrateInfo || video?.bit_rate;
    for (const bitrate of Array.isArray(bitrates) ? bitrates : []) {
      add(bitrate.PlayAddr || bitrate.play_addr, Number(bitrate.Bitrate || bitrate.bit_rate || 0) + 300);
    }
    add(video?.downloadAddr || video?.download_addr, 200);
    return candidates.sort((a, b) => b.score - a.score)[0] || null;
  }

  function instagramItems(value, info) {
    const children = value.carousel_media || value.edge_sidecar_to_children?.edges?.map((edge) => edge.node);
    info = { ...info, postMediaId: String(value.pk || value.id || ""), mediaCount: children?.length || value.carousel_media_count || 1 };
    if (Array.isArray(children) && children.length) {
      return children.flatMap((child, mediaIndex) => instagramItem(child, { ...info, mediaIndex }));
    }
    return instagramItem(value, { ...info, mediaIndex: 0 });
  }

  function instagramItem(value, info) {
    const video = value.media_type === 2 || value.is_video === true || value.__typename === "GraphVideo" ||
      Array.isArray(value.video_versions) || typeof value.video_url === "string";
    const carousel = value.media_type === 8 || value.__typename === "GraphSidecar";
    const image = !carousel && (value.media_type === 1 || value.is_video === false || value.__typename === "GraphImage");
    const kind = video ? "video" : image ? "image" : "post";
    const candidates = video
      ? [...(Array.isArray(value.video_versions) ? value.video_versions : []), ...(value.video_url ? [{ url: value.video_url }] : [])]
      : image ? [...(value.image_versions2?.candidates || value.display_resources || []), ...(value.display_url ? [{ url: value.display_url }] : [])] : [];
    const best = candidates.filter(Boolean).map((entry) => ({ url: urls(entry.url || entry.src)[0],
      score: Number(entry.width || entry.config_width || 0) * Number(entry.height || entry.config_height || 0) }))
      .filter((entry) => allowed(entry.url, "instagram")).sort((a, b) => b.score - a.score)[0];
    return [{ ...info, kind, mediaId: String(value.pk || value.id || ""),
      url: best?.url || info.permalink, score: best?.score || 0,
      verified: video && Boolean(best), pendingResolution: !best }];
  }

  function collect(root, pageUrl) {
    const context = profile(pageUrl);
    const current = post(pageUrl, pageUrl);
    if (!context && !current) return [];
    const platform = (context || current).platform;
    const stack = [root];
    const seen = new WeakSet();
    const found = new Map();
    let inspected = 0;
    while (stack.length && inspected < 50000) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      inspected += 1;
      let items = [];
      if (platform === "instagram") {
        const code = value.code || value.shortcode;
        const owner = value.user?.username || value.owner?.username;
        if (typeof code === "string" && /^[\w-]+$/.test(code) &&
            (value.media_type || value.is_video !== undefined || value.video_versions || value.image_versions2 || value.__typename?.startsWith("Graph")) &&
            (!current || current.postId === code) &&
            (!context || !owner || owner.toLowerCase() === context.username.toLowerCase())) {
          const info = { platform, postId: code, permalink: `https://www.instagram.com/p/${code}/`, ownerUsername: owner || "",
            title: String(value.caption?.text || value.accessibility_caption || "").slice(0, 160) };
          items = instagramItems(value, info);
        }
      } else {
        const id = String(value.id || value.aweme_id || value.itemId || "");
        const owner = value.author?.uniqueId || value.author?.unique_id || value.author?.uniqueid;
        if (/^\d+$/.test(id) && (value.video || value.imagePost || value.image_post_info) &&
            (!current || current.postId === id) && (!context || !owner || owner.toLowerCase() === context.username.toLowerCase())) {
          const username = owner || context?.username || current?.username;
          const images = value.imagePost?.images || value.image_post_info?.images;
          const permalink = `https://www.tiktok.com/@${username}/${images?.length ? "photo" : "video"}/${id}`;
          const info = { platform, postId: id, permalink, ownerUsername: owner || "", title: String(value.desc || "").slice(0, 160),
            thumbnail: urls(value.video?.cover || value.video?.originCover)[0] || "", mediaCount: images?.length || 1 };
          if (Array.isArray(images) && images.length) {
            items = images.map((image, mediaIndex) => {
              const url = urls(image.imageURL || image.display_image || image.owner_watermark_image).find((candidate) => allowed(candidate, platform));
              return { ...info, kind: "image", url: url || permalink, mediaIndex, pendingResolution: !url };
            });
          } else {
            const candidate = tiktokVideo(value.video);
            items = [{ ...info, kind: "video", url: candidate?.url || permalink,
              score: candidate?.score || 0, mediaIndex: 0, pendingResolution: !candidate }];
          }
        }
      }
      if (items.length) {
        for (const item of items) {
          const previous = found.get(key(item));
          if (prefer(item, previous)) found.set(key(item), item);
        }
        continue;
      }
      const children = Object.values(value);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        if (children[index] && typeof children[index] === "object") stack.push(children[index]);
      }
    }
    return [...found.values()];
  }

  function fromHtml(html, pageUrl) {
    const found = new Map();
    for (const match of html.matchAll(/<script\b(?=[^>]*(?:type=["']application\/json["']|id=["'](?:SIGI_STATE|__NEXT_DATA__|__UNIVERSAL_DATA_FOR_REHYDRATION__)["']))[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1].length > 20000000) continue;
      try {
        for (const item of collect(JSON.parse(match[1]), pageUrl)) {
          if (prefer(item, found.get(key(item)))) found.set(key(item), item);
        }
      } catch {}
    }
    return [...found.values()];
  }

  function key(item) {
    return `${item.postId}:${item.mediaIndex || 0}`;
  }

  function prefer(item, previous) {
    if (!previous) return true;
    if (Boolean(previous.pendingResolution) !== Boolean(item.pendingResolution)) return !item.pendingResolution;
    if (previous.mediaId && !item.mediaId) return false;
    return (previous.kind === "post" && item.kind !== "post") ||
      (!previous.mediaId && Boolean(item.mediaId)) ||
      Number(item.mediaCount || 1) > Number(previous.mediaCount || 1) ||
      Number(item.score || 0) > Number(previous.score || 0);
  }

  function posts(media) {
    const groups = new Map();
    for (const item of media) {
      if (!groups.has(item.postId)) groups.set(item.postId, []);
      groups.get(item.postId).push(item);
    }
    return [...groups.values()].map((items) => {
      const first = items.find((item) => !item.mediaIndex) || items[0];
      const mediaCount = Math.max(items.length, ...items.map((item) => Number(item.mediaCount || 1)));
      return mediaCount > 1 ? { ...first, kind: "post", url: first.permalink, pendingResolution: true, mediaCount } : first;
    });
  }

  globalThis.ProfileMedia = { profile, post, cards, collect, fromHtml, key, prefer, posts, tiktokVideo, instagramItems };
  if (typeof module !== "undefined") module.exports = globalThis.ProfileMedia;
})();
