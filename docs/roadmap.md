# Roadmap — Drive Attachments

North star for the turn-by-turn build loop and for kdr. Keep it updated as milestones land.
Read alongside [spec.md](spec.md) (phased plan) and [decisions.md](decisions.md) (ADRs).

## Vision

An excellent Obsidian ↔ Google Drive bridge: keep large binaries **out of the Git-synced
vault**, reference them **durably**, and make finding/inserting them **fast — ideally without
leaving Obsidian**. The successor to `google-drive-folder-link`, done right.

Durable build order (from the spec): **link → metadata → upload → preview.**

## Done — Phase 1 core (verified live in Obsidian, 2026-06-10)

- OAuth via `127.0.0.1` loopback with **state + PKCE**; token refresh; refresh token in `safeStorage`.
- **System-browser Picker** (Spike 1 fallback): pick a file or folder in the logged-in browser,
  result posted back over loopback. Folders-only mode for folder attach.
- Insert **inline link** or **asset-note wikilink** at cursor; link-format setting.
- Folder → `googleDriveFolderUrl` frontmatter attach + "open attached folder".
- Asset-note **dedup by `drive_id`**; picker URL copied to clipboard (multi-profile safety).

## Milestones

### M2 — In-Obsidian search modal  ← NEXT (this loop)
A native Obsidian modal (extend `SuggestModal`) that searches Drive **by name** via the Drive API
(`files.list`) and inserts a link **without leaving Obsidian** — the baseline plugin's best UX.
- **Needs a read scope** — see [decisions.md](decisions.md) **D8**. Gate behind a setting; the Picker
  stays as the least-privilege path.
- **DONE-WHEN:** a command opens a modal; typing debounces a `files.list` name query (via
  `requestUrl`, fields `id,name,mimeType,webViewLink`); results are pickable; selecting inserts a
  link / asset note (reusing `InsertService`); handles empty query, no results, and API errors; if
  the read scope/consent is missing, the modal explains how to enable it. Build stays green.

### M3 — Metadata & asset-note polish (spec Phase 2)  ✅ done (2026-06-11)
Richer asset-note frontmatter (human-readable size, mime, `modifiedTime`, `md5Checksum`), a
"refresh metadata" command, a Dataview-friendly inventory of external binaries. **Also store the
several Drive link forms as distinct properties** — open (`webViewLink`), download
(`webContentLink`, binary), preview (`/preview`), export links (Google-native) — so kdr can click
the right one. **kdr reviews which link form is the inline/default**; do not silently change the
current `webViewLink` default — only ADD the others.

### M3.5 — Asset-note v2: path log + richer hints (kdr feedback 2026-06-11, deferred)
- **Body = a path log.** Replace the body `[Open in Google Drive]` link (redundant — links live in
  properties now) with a log section: one line per check, `YYYY-MM-DD HH:MM · <Drive path>`. On
  re-inserting the same file (dedup), **append a new log line** with the current path instead of
  duplicating the note. Policy for now: always log (later we may collapse unchanged paths). Lets a
  human see where the file lived over time even if the path later changes.
- **Two new properties:** `drive_path` (most recent Drive folder path) + `drive_path_checked` (its timestamp).
- **Search modal:** show the **granular type** (Google Sheet / Doc / Form / Slides / PDF / Folder /
  File — map from `mimeType`, not just "Google Drive file") **and the Drive path** of each result.
- Needs path resolution: `files.get` `parents` → walk up resolving folder names.
- **Known issue:** `drive_export_links` is empty for Google-native files — likely because
  `drive.metadata.readonly` does not return export links (would need `drive.readonly`). Decide whether
  broadening the scope is worth it before implementing.
- **`drive_owner` property** — record the file's owner; kdr may switch the connected Google account or
  add multi-account support later, and owner makes a note self-explanatory.
- **Path-log line records the filename too** (`timestamp · filename · path`), since Drive names change.
- **Rename-on-filename-change:** re-inserting the same `drive_id` whose name changed renames the asset
  note via `app.fileManager.renameFile` (updates backlinks), reusing the short-id collision fallback.
- **Same-name collision is already handled (M3) — keep it:** dedup keys on `drive_id` not name, so two
  different files with the same name get `Drive - name.md` + `Drive - name (shortid).md`.
- **Byte-size formatting → see decision D9** (IEC `MiB`, `drive_size` stays numeric).

### M3.6 — Shared Drive support + dedup hardening (kdr feedback 2026-06-11) [deferred]
- **Shared Drive path:** format as `Shared drives/<drive name>/…` (currently the top resolves to a
  generic name). Request `driveId` in metadata; resolve the shared-drive name via `drives.get`
  (cached); stop the parents walk at the shared-drive root and prefix it explicitly. My Drive keeps
  `My Drive/…`.
- **Shared Drive owner:** shared-drive files have no `owners` → write the organization instead (e.g.
  the connected account's domain `@namouli.com`, or "Shared drive — <name>") in `drive_owner` rather
  than leaving it blank. (My Drive owner already works.)
- **Empty duplicate notes — RESOLVED (2026-06-11, kdr diagnosed):** root cause was **Unicode
  normalization** — macOS Drive names are NFD (decomposed Hangul), Obsidian registers notes in NFC, so
  the NFD `[[wikilink]]` didn't resolve to its NFC note and Obsidian created an empty `… 1.md`. Fixed by
  NFC-normalizing the asset-note basename (`sanitizeFileBasename`). Re-inserting an existing NFD-named
  note migrates it to NFC (rename-by-`drive_id`); empty orphans can be deleted.
- **Dedup hardening (still open, minor):** harden `findExistingAssetNote` against the async
  `metadataCache` — a just-created note's `drive_id` may be unindexed, so a rapid re-insert could still
  make a real (shortid-named, propertied) duplicate.

### M4 — Embeds & preview (spec Phase 4)
Inline preview for images/PDF where it works; `thumbnailLink` thumbnails; "open in browser" stays
primary. Experiment per file type.

### M5 — Upload (spec Phase 3)  ← NEXT (kdr prioritized over M4)
Drag/drop or paste a large file → upload to a configured Drive folder (multipart ≤5 MB, resumable
`Content-Range` >5 MB) → placeholder→link. `drive.file` write; resolve **Spike 1b** (does picking a
folder grant write to upload into it?).

### M5.5 — Upload dedup by content hash (deferred, kdr 2026-06-11)
Before uploading a dropped file, detect it's already in Drive by **md5** and offer to reuse the
existing link instead of duplicating. Layered: local asset-note `drive_md5` check → Drive
`md5Checksum` query (folder-scoped, then whole-Drive under `drive.metadata.readonly`) → upload. See
**D10** + the brain note "upload dedup design". Policy (default action, search depth) is a kdr call.

### M10 — Search keyword highlighting (kdr 2026-06-13)
Highlight the matched query tokens in the search-result name + path rows (like the dish-ingredients
web app). Pairs with the M9 token-AND matcher — wrap each matched token range in a styled span;
cheap (≤200 rows × query length). Optional toggle if it ever feels noisy.

### M11 — Vault slimming: migrate existing local attachments to Drive (kdr 2026-06-13)
A command that takes already-in-vault attachments → uploads each to Drive (with M5.x dedup) → creates
a Drive-link note → deletes the local file, shrinking the Git-tracked vault. Batch + dry-run preview;
update existing links/embeds that pointed at the local file. Mirrors CloudAttach's "upload + update
refs" but with our dedup + link-note model.

### M13 — Search fixes & UX (kdr 2026-06-14)
Real bugs first, then UX:
- **BUG: Korean search returns nothing** — e.g. `허용` matches a file that exists but shows zero
  results. Suspect NFC/NFD normalization on the query vs the indexed name, or the tokenizer dropping
  CJK. Normalize both sides (NFC) and verify CJK tokens survive the matcher.
- **BUG: path-search gaps** — with path search on, `fina st kch` finds
  `…/contract …/form test.docx` but NOT `…/finance/Wise(KC) EUR/statement_…csv` (which contains all
  three tokens across its path). Earlier misses: `굿모닝 624`, `받았음`, `받았음 monthly lease`,
  `받았음 pdf`, `받았음 .pdf`. The token-AND matcher must hit when every token appears anywhere in
  name+full-path, separator-agnostic — audit why some deep paths still miss (path resolved? all
  ancestors included? token split on `(`/`)`/`.`?).
- **Per-keyword highlight colors** — when the query has multiple tokens, highlight each token in a
  DISTINCT color (cycle a small palette), not all one color.
- **Search-modal row action menu** — give each result the same `⋮` action menu as the Drive panel
  (Open in browser / Insert link / Insert Drive-link note / Embed preview / Quick preview). Enter
  keeps its default (Drive-link note), but the other actions are reachable.

### M14 — Preview UX (kdr 2026-06-14)
- **Picasa-style lightbox quick-preview** — the panel's "Quick preview" modal should be a dark
  full-bleed backdrop with the image centered; click the backdrop to close; scroll to zoom in/out
  (and pan when zoomed). Replaces the plain modal.
- **BUG: hover border on embeds** — hovering an embedded image/video shows a full-width, slightly
  taller box border. Find the offending rule (likely the code-block container, not `.frame`) and
  scope the hover affordance to the media box only.
- **Instant embed on revisit** — switching away and back to a note re-loads the preview (flash of
  "Loading…"). When the bytes are already cached, render synchronously with no loading flash.
- **PDF resize: vertical too + no black gap** — shrinking a PDF leaves black empty space below
  (iframe `min-height` vs the smaller frame). Let the user resize height as well as width, and remove
  the gap (size the iframe to the frame).

### M15 — Streaming media proxy (long-term, kdr 2026-06-14)
Inline video currently whole-file-fetches (`requestUrl` can't stream), so it's capped at 50 MiB.
For large video with seeking, run a **loopback `127.0.0.1` Range proxy** (same pattern as the OAuth /
Picker servers) that forwards the client's `Range` header to Drive `alt=media` with the bearer token,
using Node `https` to stream (not `requestUrl`). `<video src="http://127.0.0.1:PORT/media/<id>?token=…">`
then streams + seeks with bounded memory. **Spike risk:** Obsidian's renderer CSP may block loading
`http://127.0.0.1` media in `app://obsidian.md` (Chromium treats localhost as trustworthy, so it may
be fine — verify live, like the Picker session-wall spike). Needs a per-session URL token + 127.0.0.1
bind for safety, and lifecycle (start lazily, close on unload).

### M6 — Hardening & publish (spec Phase 5)
Upload error recovery, duplicate policy, shared-drive tests, token-storage migration, privacy
README, community-plugin submission (license/attribution/OAuth review). **Publish gate is Google's
restricted-scope `drive.readonly` (search) → CASA audit vs bring-your-own-OAuth**; see brain note
"Drive Attachments — competitive landscape & publishing". Upload half (`drive.file`) is
publish-ready without audit.

## Search & dedup coverage — Shared with me / Computers (code-read 2026-06-13, M7.1)

Confirmed: **all three server-backed lookups see "Shared with me" and "Computers" files.** Every
read call runs under `drive.readonly` (always requested on connect alongside `drive.file`), so
scope does not narrow visibility to app-created files.

- **Index crawl** (`driveIndexService`): `files.list` with `corpora=allDrives` +
  `includeItemsFromAllDrives=true` + `supportsAllDrives=true`. `allDrives` = the `user` corpus
  (My Drive, files shared directly with the user, and user-created content — which includes
  Drive-for-desktop "Computers" items) plus every shared drive the user is a member of. The delta
  sync (`changes.list`) sets `restrictToMyDrive=false`, so changes to shared-with-me and Computers
  items keep flowing after the initial crawl.
- **Server search modal** (`driveSearchService`): same visibility — default `user` corpus plus
  `includeItemsFromAllDrives=true`/`supportsAllDrives=true`. (Harmless asymmetry: it relies on the
  default corpus where the index pins `corpora=allDrives` explicitly.)
- **Upload dedup** (`driveDedupService`): layer 1 is vault-local frontmatter; layer 2 scans the
  index (coverage above); layer 3's live name lookup uses `corpora=allDrives` + both all-drives
  flags — same coverage as the crawl. Confirmed live by kdr's M7 testing: a Computers duplicate
  surfaced in the dedup dialog (hence the M7.1 decision to keep Computers included, with the
  path line as the judgment aid).

Known limits (documented, not bugs): a file *inside* a folder shared with the user — never opened
by them and not directly shared — falls outside Google's `user` corpus definition ("created by,
opened by, or shared directly with the user") and may stay invisible to all three lookups until
first opened/picked; the index full crawl caps at 50 pages (~50k items, surfaced via `capped`);
and the folder **Picker** has no Computers view (Picker API gap, worklog turn 107), so a Computers
folder cannot be picked even though Computers files appear in search and dedup.

## Pre-publish decisions (decide before community submit)

- ✅ **Plugin name + id — DONE (2026-06-30).** Final: name **"Drive Attachments"**, id
  **`drive-attachments`**, repo `obsidian-drive-attachments`. Internal identifiers (the `gdab-`
  CSS prefix, the `drive-attachment-bridge-panel` view type) intentionally keep the legacy
  namespace — renaming them would break existing vaults' saved workspace layouts for zero
  user-visible gain.
- ✅ **Namespace the code-block languages — DONE (0.70.0, 2026-07-02).** New inserts emit
  `drive-attachments-preview` / `drive-attachments-actions`; the legacy generic `drive-preview` /
  `drive-actions` remain registered AND detected (read-compat) so pre-rename notes keep rendering,
  and re-inserting/normalizing an old block upgrades it. Languages centralized in
  `src/codeBlockLang.ts`.

- ✅ **Replace third-party filetype icons — DONE (0.71.1, 2026-07-08).** Default file icons now fall
  back to Obsidian/Lucide, and the old Google/Microsoft inline SVG assets were removed. The optional
  bundled themes use plugin-generated artwork.

## Operating notes for the loop

- `requestUrl()` only, never `fetch()`. Secrets git-ignored. Keep `npm run build` green every turn.
- The loop **writes code**; kdr re-auths and tests anything needing a live Google session
  (new scopes, the modal). Mark such steps clearly rather than claiming runtime verification.
- One focused increment per turn; Codex drafts, Claude red-teams (see AGENTS.md protocol).
