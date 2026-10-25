# Privacy Policy — Tiktok Instagram Downloader

Publisher: workingdad365

Contact: workingdad365@gmail.com

## Purpose and information processed

Tiktok Instagram Downloader identifies videos and images in the Instagram or TikTok post you are viewing and lets you save detected media directly to a folder you select.

To provide this feature, the extension processes the current post URL, media URLs, media identifiers and types, page elements, and relevant network JSON responses within your browser. Media URLs can contain identifiers and signed access parameters. The extension observes supported pages while they are open; downloading a file requires your action.

## Requests to the original platforms

The extension requests post details and media from Instagram, TikTok, and their media delivery hosts. Requests made in the page may use your existing platform session. For Instagram media information requests, the extension reads the page's CSRF token and includes it in a request to Instagram. It does not ask you to provide your password or an API key.

Instagram MP4 downloads are fetched in the extension's save window without cookies. The extension verifies the allowed media host, response format, MP4 signature, and size limit while streaming the file. TikTok videos are fetched in the original page context and transferred in bounded chunks to the save window.

The original platforms and their delivery providers receive normal request information, such as your IP address and the requested resource. Their own privacy policies apply to those requests. The extension does not send this information to a separate developer-operated server.

## Local storage and downloaded files

Detected media information, post URLs, and pending download requests are cached in `chrome.storage.session` for the browser session. Media buffers are held temporarily in browser memory. The selected folder's `FileSystemDirectoryHandle` is stored in the extension's IndexedDB to reuse that folder after reopening the window or restarting Chrome. Folder access is checked before saving, and you can change the folder in the extension.

Downloaded files remain in your chosen folder until you delete them and are not added to Chrome's download history. Removing the extension clears its remembered folder setting but does not delete downloaded files. Restarting the browser clears the extension's session storage.

## Permissions

- **activeTab:** identify the active supported tab when you open the popup and communicate with its content script.
- **storage:** cache detected media and download state in browser session storage.
- **Folder access:** the File System Access API requests permission to write to the folder you select.
- **Site access:** inspect Instagram and TikTok posts and retrieve media from the platform and CDN hosts declared in the extension manifest.

## Data use and sharing

Data is used only to detect, display, and download media and manage the related temporary state. The extension includes no advertising or analytics SDK and does not sell user data. It does not use or transfer data for unrelated purposes, creditworthiness decisions, or lending. It does not send browsing history, media lists, or authentication information to the developer.

## Contact and support

For privacy questions, contact **workingdad365@gmail.com**. For product support, use [GitHub Issues](https://github.com/workingdad365/ti_downloader/issues).

Do not post private media URLs, session tokens, passwords, or other sensitive information in a public issue.
