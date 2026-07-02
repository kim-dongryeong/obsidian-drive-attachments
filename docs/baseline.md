# Baseline: how `google-drive-folder-link` works

Reverse-read from the installed bundle (v1.0.4, Andrew Marconi), copied under
`reference/google-drive-folder-link/`. Full writeup with analysis lives in the vault:
`~/notes/brain/Google Drive Folder Link.md`. This is the read-only plugin we extend.

## Core mental model

> Log in once → pre-crawl your Drive folders into memory → fuzzy-search them → write the chosen
> folder's URL into the note's frontmatter as `googleDriveFolderUrl`.

It does **not** upload, handles **folders only** (no files), and does **not** intercept drops.

## Four stages (with bundle symbols)

| Stage | Symbols | Endpoint |
|---|---|---|
| Authorize (loopback OAuth) | `W` (local 127.0.0.1 server), `Q` (code→token) | `…/o/oauth2/v2/auth`, `oauth2.googleapis.com/token` |
| Keep token valid | `R` (guard, refresh if <60 s left), `Y` (refresh), `K` (email) | `/token`, `drive/v3/about` |
| Crawl/search folders | `y` (FolderCache BFS), `_` (list children), `G` (name search), `I` (shared drives) | `drive/v3/files`, `drive/v3/drives` |
| Attach to note | `attachFolderToFile`, `E` (build URL) | writes frontmatter |

- **Loopback OAuth:** spins up a throwaway HTTP server on `127.0.0.1:<random port>`, opens the
  browser to Google with that as `redirect_uri`, catches the `?code=`, shuts down. 120 s timeout.
  Key params: `access_type=offline` (grants refresh token) + `prompt=consent`.
- **Crawl:** BFS over enabled roots, query `mimeType='…folder' and '<parent>' in parents and
  trashed=false`, cached in a `Map` by ID; **5 per batch, 100 ms pause**, abortable.
- **Attach:** `app.fileManager.processFrontMatter` sets `googleDriveFolderUrl: https://drive.google.com/drive/folders/<id>`. "Open" = `window.open(url)`.

## What to reuse (already good)

- **`requestUrl` for every Google call** (CORS-safe) — copy verbatim into `DriveAuthService`.
- Loopback-OAuth + auto-refresh spine.
- Drive ID regex validation (`Z`); single-quote escaping in name search (`G`) — anti-injection.
- Batched + throttled + abortable crawl.

## What to change for this project

| Baseline | Bridge |
|---|---|
| Folders only | Files too (search + link) |
| Scope hard-coded `drive.readonly` | `drive.file` + Picker (upload-capable) |
| No drop handling | `editor-drop` (sync `preventDefault`) |
| URL in frontmatter | Asset-note wrapper |

## ⚠️ Security note carried forward

The baseline's `data.json` stores `clientSecret` + `accessToken` + `refreshToken` **in plaintext**
(NOT copied into this repo). Protect the **refresh token** — prefer keychain / `safeStorage`. See D7.
