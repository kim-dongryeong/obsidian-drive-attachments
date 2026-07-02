# Decisions & open spikes (ADR)

The crystallized memory of the design conversation. Each decision = **what / why / status**.
When a decision changes, edit it here and note the date.

## Resolved decisions

### D1 — Scope: `drive.file` + Google Picker (not `drive.readonly`/`drive`)
- **Why:** Search and least-privilege upload pull in opposite directions. `drive.file` only
  sees files the app created or the user handed it via **Google Picker** — it cannot crawl
  arbitrary roots. Picker does the searching with the user's own session and grants per-file
  access, collapsing the conflict and dropping the folder cache + broad scope at once.
- **Also:** `drive.file` is a **non-sensitive** scope and should have a much simpler verification
  path than restricted Drive scopes. Still test the real OAuth consent screen before promising
  "no warning screen" in user-facing docs. `drive.readonly` is **restricted**.
- **Nuance (Codex correction, verified):** the restricted-scope CASA *security assessment* is
  triggered by storing/transmitting restricted data **on servers**; a local-only plugin (and
  personal use) may not incur it. So "drive.readonly is impossible to ship" was overstated —
  it's still the wrong choice, but for least-privilege/optionality reasons, not a hard wall.
- **Status:** Agreed, **pending Spike 1** (does Picker even load in Obsidian's Electron renderer?).

### D2 — Publish the OAuth consent screen to "In production"
- **Why:** In "Testing" status, an External app's **refresh token is revoked after 7 days** —
  presents as "the plugin randomly broke weekly." Production (one-time unverified-app click-through;
  simpler consent path with non-sensitive `drive.file`) removes the 7-day expiry.
- **Status:** Agreed. Must be a **README setup step**.

### D3 — `editor-drop`: synchronous `preventDefault`
- **Why:** The drop event is synchronous; Obsidian's default insert fires the instant the
  handler returns. You cannot await a modal then prevent. Correct shape: (1) `preventDefault()`
  synchronously for any local-file drop + capture `Array.from(evt.dataTransfer.files)` sync;
  (2) then show modal; (3) if "Save locally," re-implement the vault save yourself
  (`vault.createBinary` + `app.fileManager`), because the default is already eaten.
- **Status:** Agreed.

### D4 — All HTTP via Obsidian `requestUrl()`, not `fetch()`
- **Why:** `fetch` from `app://obsidian.md` is CORS-blocked; `requestUrl` bypasses it. The
  existing plugin already proves this pattern (see baseline). Caveat: `requestUrl` buffers the
  whole body (no streaming) → build resumable upload as an explicit `Content-Range` PUT loop.
- **Status:** Agreed (verified; reuse from `reference/`).

### D5 — Dedup by content hash (`md5Checksum`), not filename
- **Why:** Drive allows duplicate names in a folder. `md5Checksum` (binary files only) is the
  real identity. Hash local file → query target folder → skip if matched. Store `drive_md5` in
  the asset note. **Caveat:** no md5 for Google-native Docs/Sheets/Slides or folders; the
  canonical identity after upload is still `drive_id`. Treat checksum as an optimization.
- **Status:** Agreed.

### D6 — Asset-note pattern is the canonical representation
- **Why:** Wrapping each Drive file in a small Markdown note (`drive_id`, `drive_size`,
  `drive_mime_type`, link) makes the external file a first-class Obsidian object: backlinks,
  aliases, graph, and a **Dataview** inventory of every external binary (footprint, biggest,
  orphans). Mobile consumes it as plain Markdown (so `isDesktopOnly: true` only gates
  upload/search). Default name `Drive - {name}`, collision fallback `Drive - {name} ({short_id})`.
- **Status:** Agreed (strongest idea; originated in the spec).

### D7 — Secret storage
- **Why:** The desktop-app OAuth **client secret is not truly confidential** (installed-app flow);
  still keep it out of Git as hygiene. The **refresh token** is the real risk — prefer OS keychain
  / Electron `safeStorage` over plaintext `data.json` (the baseline stores it in plaintext).
- **Status:** Agreed.

### D8 — In-Obsidian search needs a read scope; keep it gated, Picker stays default
- **Why:** kdr wants the baseline plugin's **in-Obsidian search modal** (type a name, pick, insert)
  — no leaving Obsidian. That lists the user's Drive via Drive API `files.list`, which `drive.file`
  **cannot** do (it only sees app-created/Picker-granted files). So search needs a **read scope**.
- **Choice:** add **`drive.metadata.readonly`** (names + `webViewLink`, *not* file content — least
  privilege for search-and-link). This **amends D1**: `drive.file` + system-browser Picker stays the
  least-privilege default; the read scope is added **only when the user enables in-Obsidian search**
  (a setting → re-consent). `drive.metadata.readonly` is a *restricted* scope → unverified-app
  warning on consent (fine for personal use; flag for any future publishing/verification).
- **Status:** Shipped in M2 with `drive.metadata.readonly`. **Amended 2026-06-11:** upgraded the gated
  scope to **`drive.readonly`** — kdr's call after a live test proved `drives.get` (the only API that
  returns a shared drive's real name, needed for `Shared drives/<name>/…` paths, M3.6) returns 403
  `ACCESS_TOKEN_SCOPE_INSUFFICIENT` under metadata.readonly, and `files.get` on the drive root only
  returns the literal name "Drive". drive.readonly is restricted (full read incl. content), accepted
  for personal use. A legacy metadata.readonly grant still satisfies search until the user reconnects;
  the settings tab shows "Reconnect required" until the full read scope is granted.
- **Amendment 2 (kdr, 2026-06-12):** Connect now always requests **`drive.file` + `drive.readonly`**
  in one consent screen. kdr chose the one-shot personal-use UX over incremental scopes, so
  "Enable in-Obsidian Drive search" is only a feature switch for commands/UI. The "Grant access" row
  remains only for legacy connections whose saved grant lacks `drive.readonly`.

### D9 — Byte-size display: IEC binary (MiB); `drive_size` stays numeric
- **Why:** `drive_size_human` must be standards-correct. `MB` = 10⁶ = 1,000,000 B (SI decimal);
  `MiB` = 2²⁰ = 1,048,576 B (IEC binary, IEC 80000-13). **Windows *and* Google Drive divide by 1024
  but label it "MB"** — so their "MB" is really a `MiB`. Verified: Drive shows a 19,016,553-byte file
  as "18.1 MB" (= 18.1 MiB); the true SI value is 19.0 MB.
- **Decision:** `drive_size_human` uses **IEC binary** — ÷1024 with labels `B/KiB/MiB/GiB/TiB`, one
  decimal for KiB and up → "18.1 MiB". Same *number* kdr sees in Drive, with the correct unit.
  `drive_size` stays a **plain numeric byte count** (no commas — for Dataview); an optional comma view
  is a separate `drive_size_display` *string*. Overrides if kdr prefers: literal-Drive ÷1024 "MB", or
  SI ÷1000 "MB" (matches macOS Finder).
- **Status:** Decided 2026-06-11; implement in M3.5 (replace `formatBytes` in `assetNoteMetadata.ts`).

### D10 — Upload dedup by content hash (md5), cheapest check first
- **Why:** a dropped file may already be in Drive; avoid duplicate uploads. Extends **D5**.
- **Key fact (CORRECTED 2026-06-11, verified live):** Drive stores `md5Checksum` for **binary** files
  and returns it as a **response field** — but it is **NOT a queryable search term**:
  `files.list?q=md5Checksum='…'` → **HTTP 400 Invalid Value** (tested with kdr's token). The original
  design assumed direct querying — wrong. Still no download/re-hash needed: fetch md5 as a *field* and
  compare locally. (`md5Checksum` is binary-only — fine for uploads.)
- **Workflow (cheapest first, v2):** ① local — search vault asset notes for `drive_md5 == hash` (free);
  ② **in-memory Drive index** — add `md5Checksum` to the index fields and scan it locally (instant,
  covers the ~50k most-recent files under the read scope); ③ **name query** —
  `files.list?q=name = '<filename>' and trashed=false&fields=files(…,md5Checksum)`, compare md5
  locally (catches same-named files beyond the index cap); ④ else upload. On a hit, modal
  "Use existing link / Upload anyway" showing **both filenames and the matched md5**.
- A Drive link is keyed to the **file id** → it survives moves, so any found copy's link is reusable.
- **Open policy (kdr):** default on a hit (reuse / ask / upload); search depth (local / app's own files /
  whole Drive). Full analysis in the brain note "Google Drive Attachments — upload dedup design".
- **Status:** Designed 2026-06-11; implement in **M5.5** (roadmap).

### D11 — Path search (Everything-style): separator-agnostic token-AND substring over name + index path
- **Why:** kdr wanted an Everything-style search (order-independent, matches across folder names **and**
  file name) under the "path search" toggle, distinct from the default in-order name-only fuzzy match.
- **Match rule (toggle ON):** the haystack is `name + " " + item.path`, then **NFC-normalized,
  lowercased, and stripped of every non-letter/number char** (`/[^\p{L}\p{N}]+/gu`) — so `/  -  _  .
  (  )  space` and any other separator are all equivalent, ignorable boundaries. The query is split on
  whitespace into tokens (each NFC + stripped the same way); **EACH token must be a contiguous
  substring** of the haystack. Matching is therefore token-AND and order-independent, and a token may
  land in the name, a folder segment, or span both. Toggle OFF = the base in-order name-only fuzzy
  subsequence (NFC-normalized on both sides so Korean NFC/NFD still hits — see the Korean-search fix).
- **Substring, not subsequence:** tokens match contiguously on purpose. Subsequence-AND over a long
  name+path haystack was rejected as far too loose. Consequence: `kch` does **not** match `Wise(KC) EUR`
  (stripped → `wisekceur`, which has no `kch`); `kc` does.
- **Path source:** `item.path` is precomputed by `computeItemPaths` walking `parents[0]` through an
  in-memory ancestor map — **zero network calls per keystroke**. **M16 (T167):** that map is now seeded
  by a dedicated **folders-only crawl** (`q = mimeType = folder and trashed = false`, all-drives) that
  runs once per index refresh and is overlaid by the file index (so a delta-synced folder rename still
  wins). **M16 (T168):** the changes-feed delta sync now mutates `folderIndex` too (create/rename/move
  set it, remove/trash delete it), so a folder **past the file page cap** — present only in the crawl,
  not in `items` — heals on the next modal open (delta sync) instead of waiting for the hourly
  full-rebuild TTL. This closes the old page-cap gap: a deep file whose ancestor folder had fallen past the
  50-page (modifiedTime desc) file cap — kdr's `…/Wise(KC) EUR/statement…csv`, where `… wise` missed —
  now resolves its full folder path, so the **matched path equals the displayed path** for My-Drive
  items. The crawl is best-effort (a failure logs + keeps the old tail-only paths, never blocks the
  build). Remaining coverage limits (what path search still can't see, by design):
  1. an item streamed **mid-crawl** has no path until the crawl settles (it matches name-only meanwhile);
  2. a chain that **leaves the index** still keeps only the readable **tail**, but now only at the
     **My Drive root** or an **unreadable (drive.file 403) ancestor** — the page-cap gap is closed
     (unless a Drive somehow exceeds 50k folders, which warns);
  3. **shared-drive** items get their folder segments but **not the drive's display name** (that needs
     `drives.get`, deliberately avoided to keep precompute network-free) — so for those the matched path
     is a tail of the displayed `Shared drives/<name>/…` path;
  4. the **My Drive root is not prefixed** — "My Drive" is display-only; `item.path` is `undefined` for a
     root-level item.
- **Status:** Matcher + tokenizer + path-precompute shipped and red-teamed in **M13** (T157 widened the
  separator class to `/[^\p{L}\p{N}]+/gu`; T158 audited coverage and confirmed the deep-path Korean cases
  resolve when their ancestors are in the index). **M16 (T167)** added the folders-only crawl that closes
  the page-cap gap (limit #2); **M16 (T168)** wired folder changes into the delta sync so past-cap folder
  renames/moves/deletes heal without the full-rebuild wait (red-teamed SAFE, T169). Closing the
  network-cost gaps (shared-drive display name, My-Drive prefix) is **deferred** pending kdr's call — not
  worth the per-folder fetch unattended.

## Open spikes (run BEFORE building the architecture around them)

1. **Google Picker inside Obsidian/Electron** — does the Picker JS load from `app://obsidian.md`?
   Do API key / app ID / origin work? Can it return both files **and** folders? Are returned items
   usable with `drive.file`? **This gates D1.** If it fails: fall back to a system-browser picker,
   not happily back to `drive.readonly` root-crawl.
   - **RESULT (2026-06-10, run in Obsidian via test vault):** Picker JS **loads and renders**
     in Obsidian's renderer — `api.js` is **not** CSP-blocked, the iframe appears. BUT the Picker
     iframe returns **401 from `docs.google.com/picker`** and shows "You must sign in to access this
     content." Root cause: the Picker browses Drive using the **user's Google session cookies** (see
     D1: "Picker does the searching with the user's own session"), and Obsidian's Electron renderer
     (`app://obsidian.md`, isolated partition) has **no Google session**; a `drive.file` token alone
     cannot list files, and `app://obsidian.md` is not a registerable JS origin. `setOAuthToken` is
     insufficient here. **Verdict: in-renderer Picker is a dead end → use the system-browser picker
     fallback** (serve the Picker from the loopback `127.0.0.1` server in the user's logged-in
     browser; post the pick back to Obsidian — same loopback pattern proven by the OAuth flow).
     **Loading PASSES; session/origin FAILS.**
   - **FALLBACK VERIFIED (2026-06-10, end-to-end in Obsidian):** the system-browser Picker works.
     `DrivePickerService` runs a `127.0.0.1` loopback server that serves the Picker page to the
     user's logged-in browser; the browser POSTs the picked item back. Confirmed live: real browser
     opened, Drive files listed (no sign-in wall), file picked → `[name](<webViewLink>)` inserted at
     the cursor. **Spike 1 RESOLVED:** in-renderer Picker is dead; system-browser-over-loopback is
     the adopted design. Also validated in the same run: OAuth loopback, token refresh, `safeStorage`
     storage, and the `drive.file` + Picker scope combo (D1).
1b. **Picker → upload-into-picked-folder write grant under `drive.file`** — the riskiest combo:
   does picking a *folder* grant write access to upload into it? (Not just read on picked files.)
   - **RESOLVED (2026-06-11, M5 live test):** YES — uploading a new file into a Picker-selected folder
     **works under `drive.file`**. kdr confirmed the uploaded file lands in the chosen folder (a
     root-fallback path exists if a folder ever 403s). Multipart (≤5 MB) and resumable (>5 MB) uploads
     both verified live. (Also fixed live: manual `Content-Length` → `net::ERR_INVALID_ARGUMENT`.)
2. **Large-upload transport** — is `requestUrl` acceptable for 100–200 MB? If it buffers too much
   memory, implement resumable as explicit `Content-Range` chunks (or a desktop-only Node transport).
3. **Dedup edge cases** — `md5Checksum` only for binary files; compute local MD5 with Node `crypto`.
4. **Secure token storage** — wire `safeStorage`; keep plaintext `data.json` only as a warned fallback.

## Phased build order

Phase 1 link-only → Phase 2 metadata/asset notes → Phase 3 upload (scope change + drop) →
Phase 4 preview experiments → Phase 5 hardening. Detail in [spec.md](spec.md).


### D12 — Publishing model: ship with bring-your-own-OAuth, no CASA (kdr 2026-06-16)
- **Why:** the search feature needs `drive.readonly` (a restricted scope), whose public verification
  requires an annual paid CASA security assessment (~$1k-5k/yr). **kdr has rejected CASA (cost).**
- **Decision:** ship **BYO-OAuth** — each user creates their own Google Cloud project + OAuth client
  and pastes the credentials into settings (exactly what kdr does today; same model as
  GoogleDriveFolderLink and modern Total Commander). The unverified-app warning + 100-user cap apply
  *per the user's own app*, so the cap is moot. The **upload** half (`drive.file`, non-sensitive) needs
  no audit. → M6 = polish + a clear Google-Cloud setup guide in the README, NOT app verification.
- **Status:** Decided 2026-06-16. Supersedes the "consider CASA" option in the competitive survey.

