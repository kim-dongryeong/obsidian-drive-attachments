# Drive Attachments

An [Obsidian](https://obsidian.md) plugin that uses **Google Drive as your vault's
attachment layer**. Drop a file into a note and it is uploaded to Google Drive instead of
the vault, leaving behind a durable Markdown link (or a dedicated *asset note*). You can
also search your Drive and insert links to existing files and folders.

> Keep large binaries out of your (often Git-tracked, synced) vault, while your notes keep
> durable links and metadata.

**Desktop only.**

## Features

- **Upload on drop** — drag a file into the editor and it goes to Google Drive, not the
  vault. A Markdown link or asset note is inserted in its place.
- **Content-hash dedup** — re-dropping the same file reuses the existing Drive file instead
  of creating duplicates.
- **Search & insert** — fuzzy search across My Drive and Shared Drives (server search and
  path search) and insert durable Drive-link notes.
- **Asset notes** — optional dedicated notes per file, with configurable frontmatter,
  location, and naming template.
- **Inline preview** — thumbnails, hover previews, and a lightbox for Drive-hosted images.
- **Migrate existing attachments** — move attachments already in your vault out to Drive.
- **Trash management** and a dedup browser for cleaning up.
- **File-type icons** for a wide range of formats.

## Installation

> Pending submission to the Obsidian Community Plugins directory.

**Manual**

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/kim-dongryeong/obsidian-drive-attachments/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/drive-attachments/`.
3. Reload Obsidian and enable **Drive Attachments** in *Settings → Community plugins*.

**[BRAT](https://github.com/TfTHacker/obsidian42-brat)** — add
`kim-dongryeong/obsidian-drive-attachments` as a beta plugin.

## Setup

This plugin talks to Google Drive with **your own** Google Cloud credentials — nothing is
shared with a third-party server.

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

Your credentials and tokens are stored locally in
`<vault>/.obsidian/plugins/drive-attachments/data.json`. The client secret and access token sit
there in **plaintext** (the refresh token is encrypted via Electron `safeStorage` when available),
so treat the file like a password: exclude it from vault sync/backups you share and from any Git
repo tracking your vault.

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

[MIT](LICENSE) © Kim Dongryeong
