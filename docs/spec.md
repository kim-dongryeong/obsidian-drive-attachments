# Spec snapshot — Drive Attachments

Condensed snapshot of the agreed design. The **living** version (with full review threads) lives
in the maintainer's private notes. For the *decisions* distilled from it, see
[decisions.md](decisions.md).

## Problem

- `Attachments/` grows with binaries; 100+ MB spreadsheets are unsafe for Git history.
- The vault syncs across 2 MacBooks, Windows, iPhone — phones shouldn't store every large file.
- Sometimes the right destination for a dropped file is a Drive folder, not the local vault.

## Goals

1. Insert Drive links at the **cursor**, not only as note properties.
2. Support both Drive **folders and files**.
3. Upload dropped local files to a configured Drive folder + insert a link.
4. Record metadata for search: Drive ID, name, MIME, size, web view link, parent, times.
5. Keep auth secrets out of Git.
6. Multi-device safe: MacBooks use the plugin; iPhone only consumes links/notes.
7. First version useful even without embedded previews.

## Non-goals

- Don't replace Google Drive sync clients.
- Don't put large binaries back into Git.
- Don't promise authenticated iframe previews inside Obsidian (Electron webview login fails).
- Don't publish a community plugin until license/attribution/OAuth/privacy are clean.

## Feature priorities

| Feature | Priority |
|---|---|
| Insert Drive folder/file link at cursor | P0 |
| Search existing Drive files (not only folders) | P0 |
| Keep frontmatter-attach (compat with baseline) | P0 |
| Sync-safe local secrets (git-ignored) | P0 |
| Upload dropped file to Drive (+ placeholder→link) | P1 |
| Dedicated Drive asset note + human-readable size | P1 |
| Preview block (iframe/open) | P2 |

## Key workflows

- **Insert existing file:** command → search under Picker → insert `[name](webViewLink)` or
  `[[Drive - name]]` asset-note wikilink.
- **Drop local file:** intercept `editor-drop` (sync `preventDefault` — see D3) → modal "Save
  locally / Upload to Drive" → on upload, insert placeholder, replace with link on success.
- **Asset note:** one Markdown note per Drive file with metadata frontmatter; other notes link
  to it (`[[Drive - large.xlsx]]`) so the external file joins the graph. See D6.

## Technical design (modules)

`DriveAuthService` (OAuth + refresh) · `DrivePickerService` (Google Picker) · `DriveUploadService`
(multipart ≤5 MB / resumable >5 MB) · `DriveMetadataService` (`id,name,mimeType,size,webViewLink,
webContentLink,thumbnailLink,modifiedTime,md5Checksum`) · `InsertService` · `DropController` ·
`AssetNoteService` · `SettingsTab`. Keep `webViewLink` (open) / `webContentLink` (download) /
`/preview` (iframe) distinct.

## Phased plan

- **Phase 1 — link-only MVP:** file+folder search, insert-at-cursor, link-format setting, keep
  frontmatter attach. No upload. (Reuse auth + `requestUrl` from `reference/`.)
- **Phase 2 — metadata notes:** asset-note generation, metadata frontmatter, refresh command, size.
- **Phase 3 — upload:** `drive.file` scope, default upload folder, multipart + resumable, drop modal, placeholder→link.
- **Phase 4 — preview experiments:** explicit iframe command; test PDF/image/sheet/Docs/ZIP; keep "open in browser" primary.
- **Phase 5 — hardening:** upload error recovery, duplicate policy, shared-drive tests, token migration, privacy README.

## Durable rule

Build **link-first, metadata-second, upload-third, preview-last.** The real value is keeping
large binaries out of Git while preserving durable Markdown references.
