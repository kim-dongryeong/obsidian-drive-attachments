# Drive Attachments

**Keep your Obsidian vault light. Send attachments to *your* Google Drive instead.**

Drop a file into a note — it uploads to your own Google Drive and a durable link takes its place. Search your entire Drive without leaving Obsidian. Browse, organize, and upload from a full Drive file manager in the sidebar.

[![Release](https://img.shields.io/github/v/release/kim-dongryeong/obsidian-drive-attachments?label=release)](https://github.com/kim-dongryeong/obsidian-drive-attachments/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Desktop only](https://img.shields.io/badge/platform-desktop-lightgrey)

![Drop a file into a note — it uploads to Google Drive and becomes a durable link](docs/media/hero.gif)

## Why

Vaults get heavy. PDFs, images, videos, and design files bloat your (often Git-tracked, cloud-synced) vault until sync crawls and backups balloon. **Drive Attachments moves the bytes to Google Drive and keeps only links and metadata in your notes** — your vault stays small, fast, and fully syncable, while every attachment stays one click away.

- 🔒 **Your Drive, your credentials.** The plugin talks directly to Google with *your own* OAuth app. No third-party server, no account, no telemetry.
- 🔗 **Durable links.** Drive file IDs never change — links survive renames and moves on Drive.
- 🗂️ **A real file manager.** Not just uploads: browse, search, rename, move, color, and trash your Drive from the Obsidian sidebar.

## See it in action

| Search Drive → insert a link | Drop a file → auto-upload | Browse Drive in the sidebar |
|---|---|---|
| ![Search Google Drive and insert a link](docs/media/search-insert.gif) | ![Drop a local file into the editor to upload it](docs/media/drop-upload.gif) | ![Browse Google Drive in the sidebar panel](docs/media/panel-browse.gif) |

## Installation

> Pending review for the Obsidian Community Plugins directory.

**[BRAT](https://github.com/TfTHacker/obsidian42-brat)** (recommended until then) — add
`kim-dongryeong/obsidian-drive-attachments` as a beta plugin.

**Manual**

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/kim-dongryeong/obsidian-drive-attachments/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/drive-attachments/`.
3. Reload Obsidian and enable **Drive Attachments** in *Settings → Community plugins*.

Then follow [Setup](#setup) (~7 minutes, one time) to connect your own Google Cloud project.

---

# Feature manual

Everything the plugin does, in detail.

## 1. Upload on drop (editor)

Drag any local file into a note. Instead of copying it into the vault, the plugin uploads it to Google Drive (streaming in 5 MiB chunks — large files don't balloon memory) and inserts a Markdown link or an [asset note](#3-asset-notes) at the cursor. A `⏳ Uploading…` placeholder shows progress and is replaced in place.

![Editor drop: placeholder while uploading, then a durable Drive link](docs/media/editor-drop-flow.gif)

### Content-hash dedup

Re-drop a file that already exists on Drive (byte-identical, detected by MD5) and the plugin offers to **reuse the existing Drive file** instead of uploading a duplicate.

![Dedup modal: use existing file or upload anyway](docs/media/dedup-modal.png)

## 2. Search & insert

`Search Google Drive and insert link` searches your whole Drive — a locally cached instant index (persisted across restarts, delta-synced via the Drive Changes API) merged with live server results, so matches appear as you type even seconds after startup. Each result shows its type icon and full folder path.

![Search modal: instant fuzzy results with folder paths](docs/media/search-modal.gif)

## 3. Asset notes

Optionally, each uploaded or linked file gets its own **asset note** — a dedicated Markdown note with configurable frontmatter (Drive ID, size, MD5, timestamps), location, and naming template. Your attachments become first-class, linkable, taggable citizens of the vault.

![An asset note with Drive metadata frontmatter](docs/media/asset-note.png)

## 4. Inline previews

Drive-hosted images render as thumbnails in your notes, with hover previews and a full lightbox — all fetched with authenticated requests (your token never leaks into URLs).

![Inline thumbnail, hover preview, and lightbox for Drive images](docs/media/inline-preview.gif)

## 5. The Drive panel — a file manager in your sidebar

`Open Drive panel` gives you a full Drive browser: **My Drive, shared drives, Shared with me, Starred, Recent, and Trash**, in list / compact / grid views (grid shows lazy-loaded thumbnails).

![Drive panel: navigation, views, and thumbnails](docs/media/panel-tour.gif)

### Browse like a native file manager

- Breadcrumb path with sibling menus and an editable address bar
- Back / Forward / Up history, `⌘↑` up-a-level with focus restore
- Sort by name, dates, size, type (Trash sorts by date trashed) — folders first or mixed
- 200-per-page listings with **Load more** (keyboard reachable)

![Breadcrumbs, history, sorting](docs/media/panel-navigation.gif)

### Full keyboard control

Arrow keys, PageUp/Down, Home/End, type-ahead jump, `Enter` to open, `F2` to rename, `Shift+F10` / `Ctrl+Enter` / menu key for the context menu, Shift-select ranges, `⌘A`, `Delete` to trash.

![Keyboard-only navigation in the panel](docs/media/panel-keyboard.gif)

### Search with filters

Search from the panel and refine like on drive.google.com: **location scopes** (anywhere, current folder, My Drive, Shared with me, Starred, Trash) and **Type / People / Modified** filter chips. Results are relevance-ranked, show each hit's folder path, and every hit offers **Open location**. Opening a folder from results rebuilds its true breadcrumb ancestry.

![Panel search: scopes, filter chips, open location](docs/media/panel-search.gif)

### Organize your Drive

Everything in the row context menu: **rename, move (folder picker), copy, star, folder colors** (drive.google.com palette), new folder, download, share-link copy — plus multi-select bulk actions and a details bar with owner, size, and location.

![Context menu: rename, move, color, star](docs/media/panel-organize.gif)
![Folder colors matching drive.google.com](docs/media/folder-colors.png)

### Upload by drag & drop

Drop files **or entire folders** onto the panel (or onto a specific folder row). Folder trees are recreated faithfully — subfolders included. An in-panel progress card shows the target, per-file progress, and a **Cancel** button; drops made mid-upload queue up automatically; name collisions get ` (1)` suffixes like drive.google.com.

![Panel drop: progress card, queue, cancel](docs/media/panel-upload.gif)

### Trash management

Browse Drive's trash, **restore** or **delete forever** (with explicit confirmation), sorted by date trashed.

![Trash view with restore and delete forever](docs/media/panel-trash.png)

## 6. Google Picker

Prefer Google's own UI? The **Google Picker** opens Drive's native file/folder chooser for inserting links — handy for files outside the plugin's index.

![Google Picker integration](docs/media/picker.png)

## 7. Migrate existing attachments

Already have a vault full of attachments? The migration tool moves them to Drive in bulk and rewrites your notes' links — with a dry-run preview first.

![Vault-to-Drive migration with dry-run preview](docs/media/migrate.gif)

## 8. Icons & theming

- **File-type icons** for a wide range of formats, with multiple bundled icon themes
- **Custom icon packs** — drop your own icons into a folder and the plugin picks them up live
- **Panel themes** — restyle the Drive panel (default, Notion-like, Drive-like, macOS-like, and more)

![Icon themes and custom icon packs](docs/media/icons-themes.png)

### Building a custom icon pack

Point *Settings → Icons → Custom icon pack folder* at any vault folder and drop icon files in
(`svg`, `png`, `webp`, `gif`, or `ico` — svg wins when the same name exists twice). **The file
name is the mapping** — no configuration needed:

```
my-icons/
├─ mp3.svg      ← every .mp3 file uses this (extension-named = highest priority)
├─ audio.svg    ← every other audio file (category fallback)
├─ video.png
└─ map.json     ← optional aliases: { "map": { "aac": "mp3" } } = .aac also uses mp3.svg
```

Resolution order per file: an icon named after its **extension** → a `map.json` alias → the
**category** icon (`folder`, `audio`, `video`, `photo`, `docx`, `xlsx`, `pptx`, `pdf`, `zip`,
`archive`, `code`, `txt`, …), where the category comes from Google's own mimeType first and the
plugin's extension table as fallback. So a Google-Drive-style pack needs only a dozen category
icons, while a per-format pack can define exactly the extensions it cares about.

**Sharing packs**: *Export icon pack* writes the whole folder (any format, `map.json` included)
into a single portable `icons.json`; *Import* restores the folder from one. Binary formats travel
as data URIs inside the JSON.

---

## Setup

This plugin talks to Google Drive with **your own** Google Cloud credentials — nothing is
shared with a third-party server.

![Plugin settings after a successful connection](docs/media/settings-connected.png)

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and
   enable the **Google Drive API** and the **Google Picker API**.
2. Configure the OAuth consent screen (now **Google Auth Platform**): under **Audience**, set
   the user type — **Internal** if you have a Google Workspace organization, otherwise
   **External** — fill in the app name and your support email, and for an **External** app add
   your own Google account under **Test users**.
3. Create an **OAuth client ID** (**Desktop app**) → gives you a *Client ID* and *Client Secret*.
4. Create an **API key** for the Picker, and note your **App ID** (project number).
5. In the plugin settings, paste the *Client ID*, *Client Secret*, *Picker API key*, and
   *App ID*, then authorize your Google account.

Your credentials are stored locally in
`<vault>/.obsidian/plugins/drive-attachments/data.json`. The client secret sits there in
**plaintext**; the refresh token is encrypted via Electron `safeStorage` when available; the
short-lived access token is kept in memory only and never written to disk. Still treat the file
like a password: exclude it from vault sync/backups you share and from any Git repo tracking
your vault.

### What the plugin can touch

On connect the plugin requests two OAuth scopes:

- **`drive.file`** — create, read, modify, and **delete files the plugin itself uploaded** (or
  that you hand it through the Google Picker). This non-sensitive scope powers uploads, dedup,
  and deleting your own uploads.
- **`drive.readonly`** — read-only access, used for in-Obsidian search and shared-drive paths.

`drive.readonly` (and the full `drive` scope below) are **restricted** scopes. While your app's
publishing status is **Testing**, Google shows a "Google hasn't verified this app" screen that
you — a listed test user — can click through; no verification is required. The catch: in Testing
status your authorization **expires after 7 days**, so you must periodically reconnect
(*Disconnect → Connect*). For a long-lived connection, set the publishing status to **In
production** (**Google Auth Platform → Audience → Publish app**); you still click through the
unverified-app warning once, but the sign-in stops expiring weekly. Going through full Google
OAuth verification is only necessary if you distribute the app to other people.

### Enabling deletion of existing Drive files

Out of the box the plugin can delete (trash or permanently delete) **only the files it
uploaded** — that is all the `drive.file` scope permits. To also delete files you **picked or
searched from your existing Drive** (files the plugin never created), you must grant the full
**Drive** scope:

1. In the [Google Cloud Console](https://console.cloud.google.com/), open
   **Google Auth Platform → Data Access** and click **Add or remove scopes**.
2. Enable the full Drive scope — Google lists it under the **Google Drive API** as
   `https://www.googleapis.com/auth/drive`, described as *"See, edit, create, and delete all of
   your Google Drive files."* You can either **tick it directly in the scope table** or paste the
   URL below into the **Manually add scopes** box and click **Add to table**:
   ```
   https://www.googleapis.com/auth/drive
   ```
   It is one of Google's *restricted* scopes. Then click **Update** and **Save**.
3. In the plugin settings, turn on **Full Drive access (delete picked/searched files)**.
4. **Disconnect** and **Connect** again so the new scope is granted, and approve it on the Google
   consent screen.

Only enable this if you are comfortable granting the plugin read/write/delete over your
**entire** Drive — that breadth is the price Google charges for touching files the plugin did not
create. Deletions still default to Drive's **trash** (recoverable for ~30 days); a permanent,
unrecoverable delete always requires a second explicit confirmation.

## Privacy

- **Your files stay private.** Uploads go to *your* Google Drive with its default private
  permissions — the plugin never makes a file public or shares it with anyone.
- **No middle-man server.** The plugin talks **directly** to Google's APIs using *your own* OAuth
  client. There is no third-party backend, proxy, or account — nothing is sent anywhere but Google.
- **No telemetry.** No analytics, no phone-home, no usage tracking. Feedback is opt-in — open a
  GitHub issue if something's wrong.
- **Tokens stay local.** See the storage note under [Setup](#setup): the client secret sits in
  plaintext `data.json`, the refresh token is `safeStorage`-encrypted when available, and the
  short-lived access token lives in memory only (never written to disk).

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| **"Google hasn't verified this app"** on connect | Expected while your OAuth app is in *Testing* / unverified — you are its developer. Click **Advanced → Go to \<app name\> (unsafe)** and continue. |
| Connection **stops working after ~7 days** | Testing-status apps expire sensitive-scope grants weekly. **Disconnect → Connect** to renew, or publish the app (**Google Auth Platform → Audience → Publish app → In production**) to stop the weekly expiry for good. |
| **`invalid_grant`** / "Not authenticated. Please connect to Google Drive." | The refresh token was revoked or expired (7-day testing limit, a password change, or you removed the app under your Google account's *Third-party access*). **Disconnect → Connect** to re-authorize. |
| Consent screen shows the **wrong Google account** | You're signed into several Google accounts. Choose the one that owns the Cloud project **and** the Drive on the consent screen, or sign the others out first. |
| **"This API … is disabled"** or search returns nothing | The **Google Drive API** and/or **Google Picker API** aren't enabled on your Cloud project. Enable both under **Cloud Console → APIs & Services → Library**. |
| Search finds nothing right after connecting | Grant the read scope: the first connect on an older setup may lack it — the settings tab shows a **"Grant read access for search"** button, or just **Disconnect → Connect**. The index also needs a moment to build on first use (**Refresh Drive index** forces it). |
| Uploads land in **Drive root**, not the folder you chose | The chosen folder isn't writable under `drive.file` (e.g. a folder someone else shared with you). The plugin falls back to root and warns; pick a folder you own, or grant full Drive access. |
| The **Picker** won't open | Recheck the **Picker API key** and **App ID** (Cloud project number) in settings, and that the **Google Picker API** is enabled. |

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # type-check + production build → main.js
```

`main.js` is built output and is not committed; releases are produced by the GitHub Actions
workflow on a version tag.

## Credits

Inspired by and building on the ideas of
[Google Drive Folder Link](https://github.com/andrewmarconi/GoogleDriveFolderLink) by
Andrew Marconi.

## License

[AGPL-3.0](LICENSE) © Kim Dongryeong

Free to use, modify, and redistribute — but derivatives must stay open source under the same license, **including when the code is used to provide a network service** (AGPL §13 closes the SaaS loophole). Versions up to 0.72.0 were published under MIT.
