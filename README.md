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
2. Create an **OAuth client ID** (Desktop app) → gives you a *Client ID* and *Client Secret*.
3. Create an **API key** for the Picker, and note your **App ID** (project number).
4. In the plugin settings, paste the *Client ID*, *Client Secret*, *Picker API key*, and
   *App ID*, then authorize your Google account.

Your credentials and tokens are stored locally in
`<vault>/.obsidian/plugins/drive-attachments/data.json`. The client secret and access token sit
there in **plaintext** (the refresh token is encrypted via Electron `safeStorage` when available),
so treat the file like a password: exclude it from vault sync/backups you share and from any Git
repo tracking your vault.

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
