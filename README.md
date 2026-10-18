# Tiktok Instagram Downloader

A Manifest V3 Chrome extension for downloading videos and images detected in the Instagram or TikTok post you are viewing.

## Install from source

1. Open `chrome://extensions` in Chrome 116 or later.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Reload any Instagram or TikTok tabs that were already open.

## Usage

1. Open an Instagram post or Reel, or a TikTok video or photo post.
2. Play the video or browse the carousel slides to help the extension detect available media.
3. Click the extension icon to view the detected items.
4. Click **Download** for an individual item or **Download all** for the detected list.
5. Click **Refresh** to search the current post again.

Files are saved through Chrome's download manager. The extension does not require a separate account or API key. Some posts require you to be signed in to the original platform.

## Supported media

- Instagram progressive MP4 videos, images, and carousel media candidates.
- TikTok playable MP4 videos and photo-post images.
- Media discovery from the current page's DOM and network JSON responses.
- Individual downloads and batch downloads of the detected items.

## Limitations

- Instagram DASH video/audio merging, HLS streams, and ZIP archives are not supported.
- Instagram video downloads fetched through the extension are limited to 256 MB.
- Detection depends on the page layout, available media URLs, and your access to the original post. Not every post or stream can be downloaded.
- The extension does not bypass login requirements or access restrictions.

Download only content you own or have permission to save. This extension is not affiliated with or endorsed by TikTok, Instagram, Meta, or ByteDance.

## Privacy

See [Privacy Policy](PRIVACY.md) for information about local media processing, network requests, and temporary storage.
