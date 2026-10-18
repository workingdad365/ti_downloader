# Privacy Policy — Tiktok Instagram Downloader

Publisher: workingdad365

Contact: workingdad365@gmail.com

## Purpose and information processed

Tiktok Instagram Downloader identifies videos and images in the Instagram or TikTok post you are viewing and lets you save detected media through Chrome's download manager.

To provide this feature, the extension processes the current post URL, media URLs, media identifiers and types, page elements, and relevant network JSON responses within your browser. Media URLs can contain identifiers and signed access parameters. The extension observes supported pages while they are open; downloading a file requires your action.

## Requests to the original platforms

The extension requests post details and media from Instagram, TikTok, and their media delivery hosts. Requests made in the page may use your existing platform session. For Instagram media information requests, the extension reads the page's CSRF token and includes it in a request to Instagram. It does not ask you to provide your password or an API key.

Some Instagram MP4 downloads are fetched in an extension offscreen document without cookies. The extension verifies the allowed media host and response format before creating a temporary Blob for the download.

The original platforms and their delivery providers receive normal request information, such as your IP address and the requested resource. Their own privacy policies apply to those requests. The extension does not send this information to a separate developer-operated server.

## Local storage and downloaded files

Detected media information and post URLs are cached in `chrome.storage.session` for the browser session. Temporary download identifiers and Blob URLs may also be stored there to manage and release downloads. Media buffers and Blob URLs are held temporarily in browser memory.

Downloaded files remain in your chosen download location until you delete them. Chrome may retain download history according to its settings. Removing the extension does not delete files you have downloaded. Restarting the browser clears the extension's session storage.

## Permissions

- **activeTab:** identify the active supported tab when you open the popup and communicate with its content script.
- **downloads:** save requested media and track completion so temporary download resources can be released.
- **storage:** cache detected media and download state in browser session storage.
- **offscreen:** fetch and validate supported Instagram videos and create temporary Blob URLs for downloads.
- **Site access:** inspect Instagram and TikTok posts and retrieve media from the platform and CDN hosts declared in the extension manifest.

## Data use and sharing

Data is used only to detect, display, and download media and manage the related temporary state. The extension includes no advertising or analytics SDK and does not sell user data. It does not use or transfer data for unrelated purposes, creditworthiness decisions, or lending. It does not send browsing history, media lists, or authentication information to the developer.

## Contact and support

For privacy questions, contact **workingdad365@gmail.com**. For product support, use [GitHub Issues](https://github.com/workingdad365/ti_downloader/issues).

Do not post private media URLs, session tokens, passwords, or other sensitive information in a public issue.
