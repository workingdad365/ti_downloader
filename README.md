# Tiktok Instagram Downloader

A Manifest V3 Chrome extension for downloading videos and images detected in the Instagram or TikTok post or profile you are viewing.

## Install from source

1. Open `chrome://extensions` in Chrome 116 or later.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Reload any Instagram or TikTok tabs that were already open.

## Usage

1. Open an Instagram or TikTok profile, or an individual post, Reel, video, or photo post.
2. On a profile, scroll to load more posts. On an individual post, play the video or browse its slides to help the extension detect available media.
3. Click the extension icon and use **Set download folder** to open the folder settings tab. Click **Choose download folder** there to select a location. The folder is remembered across browser restarts. Use **Change download folder** in the extension popup to change it later.
4. Click **Download** for an individual item or profile post, **Download all** for the detected list, or the download button over a profile card or the media. Profile carousels and photo posts are saved as separate files in their original order.
5. If no folder has ever been selected, a one-time setup window opens. Click **Choose folder and download**; the window closes after the folder is remembered and the download starts in the background.
6. Once a folder is set, downloads run in the background without opening a save window. Keep the source tab open until saving finishes. The extension popup shows progress, results, and a **Stop downloads** button.
7. If folder access expires or the folder is deleted, use **Change download folder** in the extension popup to select it again or choose another location. This does not open the initial setup window.
8. Click **Refresh** to search the current page again, including newly loaded profile posts.

Files are written directly to the chosen folder using the File System Access API. Other extensions cannot rename these downloads, and the files do not appear in Chrome's download list. Existing files are preserved by adding a numeric suffix. Downloads continue after the extension popup is closed. A `!` badge on the extension icon indicates an error; open the popup to see the result.

The extension does not require a separate account or API key. Some posts require you to be signed in to the original platform.

## Supported media

- Instagram progressive MP4 videos, images, and carousel media candidates.
- TikTok playable MP4 videos and photo-post images.
- Profile post discovery from card links, embedded JSON, runtime data, and network JSON responses, even without an active video player.
- Missing profile media URLs are resolved from the original post when downloading. File names include each post's ID.
- Individual downloads and batch downloads of the detected items.

## Limitations

- Instagram DASH video/audio merging, HLS streams, and ZIP archives are not supported.
- Instagram video downloads fetched through the extension are limited to 256 MB.
- Profile detection covers posts loaded in the page, up to 500 posts at a time. It does not automatically scroll or crawl an entire account. A profile post can expand into up to 40 files.
- Detection depends on the page layout, available media URLs, and your access to the original post. Not every post or stream can be downloaded.
- The extension does not bypass login requirements or access restrictions.

Download only content you own or have permission to save. This extension is not affiliated with or endorsed by TikTok, Instagram, Meta, or ByteDance.

## Privacy

See [Privacy Policy](PRIVACY.md) for information about local media processing, network requests, and temporary storage.

## Tests

After editing `profile-media.js` or `interceptor.js`, run `npm run build` to regenerate `interceptor-main.js`. The page-world bundle has a separate path because Chrome does not inject the same content-script resource twice across isolated and MAIN worlds. The generated bundle is included for loading the extension from source.

Run `npm test` with Node.js 18 or later to check profile detection, post resolution, carousel expansion, page navigation, folder reuse, media transfer, cancellation, and file preservation using local test fixtures.
