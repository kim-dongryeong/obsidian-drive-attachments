import { requestUrl, type RequestUrlResponse } from "obsidian";
import { DriveAuthService } from "./driveAuthService";
import { assertValidDrivePickerItem, DRIVE_FOLDER_MIME_TYPE, DrivePickerItem } from "./driveTypes";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_CHANGES_URL = "https://www.googleapis.com/drive/v3/changes";
const DRIVE_INDEX_PAGE_SIZE = 1000;
const DRIVE_INDEX_MAX_PAGES = 50;

// Clamp the user's configured page limit. 0 = unlimited (crawl until Drive returns no more pages —
// always terminates since Drive is finite). Otherwise [10, 2000]; bad input falls back to the default.
function resolveMaxPages(value: number): number {
  if (value === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number.isFinite(value) && value >= 10 ? Math.min(2000, Math.floor(value)) : DRIVE_INDEX_MAX_PAGES;
}
// Folders are a small fraction of a Drive, but they're the ancestor chain `computeItemPaths` walks to
// build each item's `path`. The main file index is page-capped (modifiedTime desc), so a long-untouched
// ancestor folder can fall past the cap and break the chain — D11 limit #2 (the `… wise` miss). A
// dedicated folders-only crawl backfills EVERY folder into the path map so deep paths resolve fully,
// still with zero network per keystroke (paths stay precomputed). One crawl per refresh, not per query.
const DRIVE_FOLDER_INDEX_MAX_PAGES = 50;
// Changes sync exists for small deltas between modal opens. A delta past this cap (pages × 1000
// changes) is cheaper to resolve with a full rebuild, so the sync throws and the caller falls back.
const DRIVE_CHANGES_MAX_PAGES = 20;
// Degraded-mode staleness TTL, used only when there is no changes token (minting failed): a clean
// cached index is served as-is for this long, after which the next `ensureLoaded()` rebuilds — the
// pre-changes-sync behavior. With a token this TTL plays no part: every load runs the cheap delta
// sync, so a Drive rename/add/delete shows up on the very next modal open, not after a TTL.
const DRIVE_INDEX_NO_TOKEN_TTL_MS = 5 * 60 * 1000;
// Periodic full rebuild safety net: changes tokens are minted after a full crawl, so a Drive change
// landing mid-crawl in an already-fetched region can be missed by deltas. Once the last FULL crawl
// is this old, the next load rebuilds instead of delta-syncing. The clock deliberately ignores
// delta syncs — they cannot heal that gap, so a steady stream of successful syncs must not keep
// pushing the rebuild out. Manual "Refresh Drive index" bypasses both TTLs and rebuilds immediately.
const DRIVE_INDEX_FULL_REBUILD_TTL_MS = 60 * 60 * 1000;

// `path` is the item's Drive folder path ("ancestor/names", own name excluded — same shape as the
// rendered location path), precomputed by `computeItemPaths` so path search never walks per keystroke.
export type DriveIndexItem = DrivePickerItem & { parents?: string[]; md5Checksum?: string; size?: string; path?: string };

// On-disk index snapshot (T-010). Restart hydrates from this and delta-syncs via the Changes API
// instead of re-crawling the whole Drive, so the first search after an Obsidian restart is instant.
// `startPageToken` is the Changes cursor; without it the snapshot can't be caught up, so it's not kept.
export const DRIVE_INDEX_SNAPSHOT_SCHEMA = 1;

export interface PersistedDriveIndexSnapshot {
  schemaVersion: number;
  fetchedAt: string;
  startPageToken: string | null;
  files: DriveIndexItem[];
  folders: DriveIndexItem[];
}

export interface DriveIndexPersistence {
  load(): Promise<PersistedDriveIndexSnapshot | null>;
  save(snapshot: PersistedDriveIndexSnapshot): Promise<void>;
}

export interface DriveIndexState {
  items: DriveIndexItem[];
  isLoading: boolean;
  loadedPages: number;
  capped: boolean;
  lastLoadedAt: number | null;
  lastError: string | null;
  changePageToken: string | null;
}

export interface DriveIndexProgress {
  isLoading: boolean;
  itemCount: number;
  loadedPages: number;
  capped: boolean;
  lastLoadedAt: number | null;
  lastError: string | null;
}

interface GoogleDriveErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{
      reason?: string;
      message?: string;
    }>;
  };
}

export class DriveIndexService {
  private items: DriveIndexItem[] = [];
  // Every folder in Drive (a folders-only crawl), used SOLELY to give `computeItemPaths` a complete
  // ancestor map — so a deep item's path resolves even when its folder fell past the file page cap.
  // Not a search corpus: these never enter `items`/`getItems()`, only the offline path walk reads them.
  private folderIndex: DriveIndexItem[] = [];
  private isLoading = false;
  private loadedPages = 0;
  private capped = false;
  private lastLoadedAt: number | null = null;
  // When the last successful FULL crawl finished — unlike `lastLoadedAt`, never re-stamped by a
  // delta sync, so the full-rebuild safety net actually fires for an actively-syncing index.
  private lastFullLoadAt: number | null = null;
  private lastError: string | null = null;
  private changePageToken: string | null = null;
  private loadPromise: Promise<DriveIndexItem[]> | null = null;
  private syncPromise: Promise<DriveIndexItem[]> | null = null;
  // Bumped at the start of every full refresh so an in-flight changes sync can tell its snapshot
  // is obsolete and abandon, instead of clobbering the rebuild (two writers on `items`).
  private refreshGeneration = 0;
  // One-shot disk hydration (T-010): load the persisted snapshot before the first crawl decision.
  private hydrated = false;

  constructor(
    private readonly auth: DriveAuthService,
    private readonly getMaxPages: () => number = () => DRIVE_INDEX_MAX_PAGES,
    private readonly persistence?: DriveIndexPersistence,
  ) {}

  getState(): DriveIndexState {
    return {
      items: [...this.items],
      isLoading: this.isLoading,
      loadedPages: this.loadedPages,
      capped: this.capped,
      lastLoadedAt: this.lastLoadedAt,
      lastError: this.lastError,
      changePageToken: this.changePageToken,
    };
  }

  getProgress(): DriveIndexProgress {
    return {
      isLoading: this.isLoading,
      itemCount: this.items.length,
      loadedPages: this.loadedPages,
      capped: this.capped,
      lastLoadedAt: this.lastLoadedAt,
      lastError: this.lastError,
    };
  }

  getItems(): DriveIndexItem[] {
    return [...this.items];
  }

  // Filter arbitrary index/server hits to descendants of `folderId`. Drive's files.list parent
  // predicate only covers direct children; this walks parent ids through the complete folders-only
  // index, so a panel Location scope includes every depth without relying on mutable folder names or
  // slash-delimited paths. Candidate folders are overlaid too, which lets a fresh server-only folder
  // hit participate before the next index refresh.
  filterToFolderSubtree<T extends { id: string; mimeType: string; parents?: string[] }>(
    candidates: T[],
    folderId: string,
  ): T[] {
    const parentsByFolderId = new Map<string, string[]>();
    const collectFolder = (item: { id: string; mimeType: string; parents?: string[] }): void => {
      if (item.mimeType === DRIVE_FOLDER_MIME_TYPE) {
        parentsByFolderId.set(item.id, item.parents ?? []);
      }
    };
    this.folderIndex.forEach(collectFolder);
    this.items.forEach(collectFolder);
    candidates.forEach(collectFolder);

    const memo = new Map<string, boolean>();
    const reachesFolder = (id: string, visiting: Set<string>, depth: number): boolean => {
      if (id === folderId) {
        return true;
      }
      const cached = memo.get(id);
      if (cached !== undefined) {
        return cached;
      }
      if (depth >= 50 || visiting.has(id)) {
        return false;
      }

      visiting.add(id);
      const matches = (parentsByFolderId.get(id) ?? []).some((parentId) =>
        reachesFolder(parentId, visiting, depth + 1),
      );
      visiting.delete(id);
      memo.set(id, matches);
      return matches;
    };

    return candidates.filter((item) =>
      (item.parents ?? []).some((parentId) => reachesFolder(parentId, new Set<string>(), 0)),
    );
  }

  ensureLoaded(): Promise<DriveIndexItem[]> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    // First call: hydrate the persisted snapshot, then re-enter with a (possibly) warm index.
    if (!this.hydrated) {
      return this.hydrateOnce().then(() => this.ensureLoaded());
    }

    // Re-use the cached index only after a clean load that ran to completion (full or page-capped).
    // A load that errored mid-flight leaves `lastLoadedAt` null and possibly a partial `items`; that
    // case rebuilds instead of serving a silently-truncated list.
    if (this.lastLoadedAt !== null && this.lastError === null) {
      // With a token, EVERY load delta-syncs (concurrent calls share one in-flight sync). Callers
      // render the cached items synchronously and repaint when the delta lands, so this is what
      // makes a Drive rename/add/delete appear on the very next modal open with no TTL wait.
      if (this.hasChangePageToken() && !this.needsFullRebuild()) {
        return this.syncChanges().catch((error: unknown) => {
          console.warn(
            "[Drive Attachments] Drive changes sync failed; rebuilding the full index.",
            error,
          );
          return this.refresh();
        });
      }

      // No token (minting failed): degrade to the pre-changes-sync behavior — serve the cache for
      // a short TTL, then rebuild — rather than re-crawling Drive on every load.
      if (!this.hasChangePageToken() && !this.isStaleWithoutToken()) {
        return Promise.resolve(this.getItems());
      }
    }

    return this.refresh();
  }

  // Load the on-disk snapshot into memory once, so the first ensureLoaded() delta-syncs instead of
  // full-crawling. Marks the index "warm" (lastLoadedAt = now) with the snapshot's Changes cursor, so
  // the very next load catches up all changes since the snapshot (or falls back to a full rebuild if
  // the token is invalid / there are too many changes). A completed/in-flight load takes precedence.
  private async hydrateOnce(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;
    if (!this.persistence) {
      return;
    }
    try {
      const snapshot = await this.persistence.load();
      if (
        !snapshot ||
        snapshot.schemaVersion !== DRIVE_INDEX_SNAPSHOT_SCHEMA ||
        !snapshot.startPageToken ||
        this.lastLoadedAt !== null ||
        this.isLoading
      ) {
        return;
      }
      this.items = Array.isArray(snapshot.files) ? snapshot.files.filter(isUsableDriveIndexItem) : [];
      this.folderIndex = Array.isArray(snapshot.folders) ? snapshot.folders : [];
      this.changePageToken = snapshot.startPageToken;
      this.computeItemPaths();
      const now = Date.now();
      // Timers reset from restart: the Changes cursor (not the age) decides what to catch up, and the
      // 1h full-rebuild net now applies to this session so a long-lived snapshot still self-refreshes.
      this.lastLoadedAt = now;
      this.lastFullLoadAt = now;
    } catch (error: unknown) {
      console.warn("[Drive Attachments] Could not load the persisted Drive index; will rebuild.", error);
    }
  }

  // Write the current index to disk (best-effort). Skipped without a Changes cursor — a snapshot that
  // can't be caught up is useless to hydrate.
  private async persist(): Promise<void> {
    if (!this.persistence || !this.changePageToken) {
      return;
    }
    const snapshot: PersistedDriveIndexSnapshot = {
      schemaVersion: DRIVE_INDEX_SNAPSHOT_SCHEMA,
      fetchedAt: new Date().toISOString(),
      startPageToken: this.changePageToken,
      files: this.items,
      folders: this.folderIndex,
    };
    try {
      await this.persistence.save(snapshot);
    } catch (error: unknown) {
      console.warn("[Drive Attachments] Could not persist the Drive index snapshot.", error);
    }
  }

  hasChangePageToken(): boolean {
    return this.changePageToken !== null;
  }

  private isStaleWithoutToken(): boolean {
    return this.lastLoadedAt === null || Date.now() - this.lastLoadedAt > DRIVE_INDEX_NO_TOKEN_TTL_MS;
  }

  private needsFullRebuild(): boolean {
    return this.lastFullLoadAt === null || Date.now() - this.lastFullLoadAt > DRIVE_INDEX_FULL_REBUILD_TTL_MS;
  }

  async refresh(): Promise<DriveIndexItem[]> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    // A full rebuild supersedes any persisted snapshot, so hydration must never run afterwards.
    this.hydrated = true;
    this.refreshGeneration += 1;
    this.items = [];
    this.folderIndex = [];
    this.loadedPages = 0;
    this.capped = false;
    this.lastLoadedAt = null;
    this.lastError = null;
    this.changePageToken = null;
    this.isLoading = true;

    this.loadPromise = this.buildIndex()
      .then(async () => {
        // Best-effort: a folder-crawl failure must not fail the index build. On failure we keep
        // today's tail-only paths (D11 limit #2) rather than no index at all.
        try {
          await this.buildFolderIndex();
        } catch (error: unknown) {
          console.warn(
            "[Drive Attachments] Folder index crawl failed; deep paths may stay incomplete.",
            error,
          );
        }
        this.computeItemPaths();
        try {
          await this.fetchStartPageToken();
        } catch (error: unknown) {
          console.warn("[Drive Attachments] Could not mint Drive changes start token.", error);
        }
        // Stamp the success time only when the build actually ran to completion. Doing this in
        // `finally` would mark a failed/partial load as "freshly loaded", so `ensureLoaded` would
        // serve the partial list forever and a consumer could never tell a real load from a failure.
        this.lastLoadedAt = Date.now();
        this.lastFullLoadAt = this.lastLoadedAt;
        void this.persist();
        return this.getItems();
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.isLoading = false;
        this.loadPromise = null;
      });

    return this.loadPromise;
  }

  async syncChanges(): Promise<DriveIndexItem[]> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    if (this.syncPromise) {
      return this.syncPromise;
    }

    // Capture the token before any await: a refresh() starting mid-flight nulls it, and that race
    // belongs to the generation check in runChangesSync, not to a confusing "no token" failure.
    const startToken = this.changePageToken;
    if (!startToken) {
      throw new Error("Drive changes sync needs a start token. Refresh the Drive index first.");
    }

    this.syncPromise = this.runChangesSync(startToken).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async runChangesSync(startToken: string): Promise<DriveIndexItem[]> {
    const generation = this.refreshGeneration;
    const accessToken = await this.auth.getAccessToken();
    const changes: DriveChange[] = [];
    let pageToken: string | null = startToken;
    let newStartPageToken: string | null = null;

    for (let page = 0; pageToken; page += 1) {
      if (page >= DRIVE_CHANGES_MAX_PAGES) {
        throw new Error("Google Drive reported too many changes to sync. Refresh the Drive index.");
      }

      const response = await requestUrl({
        url: buildDriveChangesUrl(pageToken),
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(getDriveIndexErrorMessage(response));
      }

      const parsed = parseDriveChangesBody(response);
      changes.push(...parsed.changes);
      newStartPageToken = parsed.newStartPageToken ?? newStartPageToken;
      pageToken = parsed.nextPageToken;
    }

    if (!newStartPageToken) {
      throw new Error("Google Drive changes response did not include a new start token. Refresh the Drive index.");
    }

    // A full refresh started while this sync was paging. Its rebuild supersedes everything fetched
    // here; applying anyway would interleave two writers on `items` and stamp sync state over it.
    if (this.loadPromise !== null || generation !== this.refreshGeneration) {
      return this.loadPromise ?? this.getItems();
    }

    this.applyChanges(changes);
    this.computeItemPaths();
    this.changePageToken = newStartPageToken;
    this.lastLoadedAt = Date.now();
    this.lastError = null;
    // Re-persist only when something actually changed (the common no-op sync writes nothing); keeps
    // the on-disk Changes cursor current so the next restart catches up from here, not from the last
    // full crawl.
    if (changes.length > 0) {
      void this.persist();
    }
    return this.getItems();
  }

  private async buildIndex(): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const maxPages = resolveMaxPages(this.getMaxPages());
    let pageToken: string | null = null;

    for (let page = 0; page < maxPages; page += 1) {
      const response = await requestUrl({
        url: buildDriveIndexUrl(pageToken),
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(getDriveIndexErrorMessage(response));
      }

      const parsed = parseDriveIndexBody(response);
      this.items.push(...parsed.files.filter(isUsableDriveIndexItem));
      this.loadedPages += 1;

      if (!parsed.nextPageToken) {
        return;
      }

      pageToken = parsed.nextPageToken;
    }

    if (pageToken) {
      this.capped = true;
      console.warn(
        `[Drive Attachments] Drive index stopped after ${maxPages} pages (${this.items.length} items). Raise the index page limit in settings to include older files.`,
      );
    }
  }

  // Crawl every folder (folders-only `files.list`, all corpora) into `folderIndex`, so the path
  // precompute has the full ancestor tree regardless of the file index's modifiedTime page cap.
  // Replaces `folderIndex` atomically at the end so a mid-crawl read never sees a half-built tree.
  private async buildFolderIndex(): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const maxPages = Math.max(DRIVE_FOLDER_INDEX_MAX_PAGES, resolveMaxPages(this.getMaxPages()));
    const folders: DriveIndexItem[] = [];
    let pageToken: string | null = null;

    for (let page = 0; page < maxPages; page += 1) {
      const response = await requestUrl({
        url: buildDriveFolderIndexUrl(pageToken),
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(getDriveIndexErrorMessage(response));
      }

      const parsed = parseDriveIndexBody(response);
      folders.push(...parsed.files.filter(isUsableDriveIndexItem));

      if (!parsed.nextPageToken) {
        this.folderIndex = folders;
        return;
      }
      pageToken = parsed.nextPageToken;
    }

    // Cap hit (more than 50k folders): keep what we have — some deep paths may stay incomplete.
    console.warn(
      `[Drive Attachments] Folder index stopped after ${DRIVE_FOLDER_INDEX_MAX_PAGES} pages (${folders.length} folders). Some deep paths may stay incomplete.`,
    );
    this.folderIndex = folders;
  }

  private async fetchStartPageToken(): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const response = await requestUrl({
      url: buildDriveStartPageTokenUrl(),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(getDriveIndexErrorMessage(response));
    }

    this.changePageToken = parseStartPageTokenBody(response);
  }

  private applyChanges(changes: DriveChange[]): void {
    const byId = new Map(this.items.map((item) => [item.id, item]));
    const foldersById = new Map(this.folderIndex.map((folder) => [folder.id, folder]));

    for (const change of changes) {
      const id = change.fileId ?? change.file?.id;
      if (!id) {
        continue;
      }

      if (change.removed || change.file?.trashed) {
        byId.delete(id);
        foldersById.delete(id);
        continue;
      }

      if (change.file && isUsableDriveIndexItem(change.file)) {
        // Store a clean DriveIndexItem — `trashed` is changes-feed plumbing, not index data.
        const { trashed, ...item } = change.file;
        byId.set(item.id, item);
        if (item.mimeType === DRIVE_FOLDER_MIME_TYPE) {
          foldersById.set(item.id, item);
        } else {
          foldersById.delete(item.id);
        }
      }
    }

    this.items = [...byId.values()];
    this.folderIndex = [...foldersById.values()];
  }

  // Precompute every item's `path` by walking `parents` through the in-memory ancestor map (the
  // complete folders-only crawl, overlaid with the file index) — so the chain resolves with ZERO
  // network calls per keystroke, unlike the per-folder `files.get` walker in DriveMetadataService.
  // Cost: one id→item Map plus a memoized walk, O(items) total (~tens of ms at the 50k-item cap),
  // re-run after each completed crawl/delta sync. Items streamed mid-crawl have no path until the
  // crawl settles (they match name-only meanwhile). The folder crawl closes the old page-cap gap;
  // a chain still loses its head at the My Drive root or an unreadable (drive.file 403) ancestor,
  // keeping the readable tail. Shared-drive items get folder segments but not the drive's display
  // name (that needs drives.get) — so for those the matched path is a tail of the displayed path.
  private computeItemPaths(): void {
    // Seed the ancestor map with the complete folders-only crawl, then overlay `items` so any
    // folder that ALSO appears in the (possibly delta-synced) file index keeps its freshest
    // name/parents — a folder rename that landed via `applyChanges` wins over the crawl snapshot.
    const byId = new Map<string, DriveIndexItem>();
    for (const folder of this.folderIndex) {
      byId.set(folder.id, folder);
    }
    for (const item of this.items) {
      byId.set(item.id, item);
    }
    // folder id → that folder's own slash-joined path (ancestors + own name); null = unresolvable.
    const folderPaths = new Map<string, string | null>();

    const resolveFolderPath = (folderId: string): string | null => {
      // Walk up collecting unmemoized ancestors, then assign paths root→leaf on the way back down.
      const chain: string[] = [];
      let basePath: string | null = null;
      let currentId: string | undefined = folderId;
      for (let depth = 0; depth < 50 && currentId; depth += 1) {
        const memoized = folderPaths.get(currentId);
        if (memoized !== undefined) {
          basePath = memoized;
          break;
        }
        if (chain.includes(currentId)) {
          break;
        }
        const folder = byId.get(currentId);
        if (!folder || folder.mimeType !== DRIVE_FOLDER_MIME_TYPE) {
          break;
        }
        chain.push(currentId);
        currentId = folder.parents?.[0];
      }
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const folder = byId.get(chain[i]);
        if (!folder) {
          continue;
        }
        basePath = basePath ? `${basePath}/${folder.name}` : folder.name;
        folderPaths.set(chain[i], basePath);
      }
      return chain.length > 0 ? folderPaths.get(folderId) ?? null : basePath;
    };

    for (const item of this.items) {
      const parentId = item.parents?.[0];
      item.path = parentId ? resolveFolderPath(parentId) ?? undefined : undefined;
    }
  }
}

interface ParsedDriveIndexBody {
  files: DriveIndexItem[];
  nextPageToken: string | null;
}

interface DriveChangeFile extends DriveIndexItem {
  trashed?: boolean;
}

interface DriveChange {
  fileId?: string;
  removed?: boolean;
  file?: DriveChangeFile;
}

interface ParsedDriveChangesBody {
  changes: DriveChange[];
  nextPageToken: string | null;
  newStartPageToken: string | null;
}

function buildDriveIndexUrl(pageToken: string | null): string {
  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set("q", "trashed = false");
  url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,webViewLink,parents,md5Checksum,size)");
  url.searchParams.set("pageSize", String(DRIVE_INDEX_PAGE_SIZE));
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("corpora", "allDrives");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  return url.toString();
}

// Folders-only crawl: same corpora/all-drives flags as the file index, but filtered to folders and
// without orderBy (we want EVERY folder, order is irrelevant to path resolution). `webViewLink` is
// requested so each row passes `isUsableDriveIndexItem` (folders do have one); md5/size are file-only.
function buildDriveFolderIndexUrl(pageToken: string | null): string {
  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set("q", "mimeType = 'application/vnd.google-apps.folder' and trashed = false");
  url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,webViewLink,parents)");
  url.searchParams.set("pageSize", String(DRIVE_INDEX_PAGE_SIZE));
  url.searchParams.set("corpora", "allDrives");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  return url.toString();
}

function buildDriveStartPageTokenUrl(): string {
  const url = new URL(`${DRIVE_CHANGES_URL}/startPageToken`);
  url.searchParams.set("supportsAllDrives", "true");
  return url.toString();
}

function buildDriveChangesUrl(pageToken: string): string {
  const url = new URL(DRIVE_CHANGES_URL);
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("pageSize", String(DRIVE_INDEX_PAGE_SIZE));
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("restrictToMyDrive", "false");
  url.searchParams.set(
    "fields",
    "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,webViewLink,parents,md5Checksum,size,trashed))",
  );
  return url.toString();
}

function parseDriveIndexBody(response: RequestUrlResponse): ParsedDriveIndexBody {
  if (!response.text) {
    return { files: [], nextPageToken: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error(
      "Google Drive returned an unreadable index response. Retry in a moment; reconnect if it keeps failing.",
    );
  }

  const body = parsed as { files?: unknown; nextPageToken?: unknown } | null;
  return {
    files: Array.isArray(body?.files) ? (body.files as DriveIndexItem[]) : [],
    nextPageToken: typeof body?.nextPageToken === "string" && body.nextPageToken.length > 0
      ? body.nextPageToken
      : null,
  };
}

function parseStartPageTokenBody(response: RequestUrlResponse): string {
  const body = parseJsonResponseBody(response, "Google Drive returned an unreadable changes start-token response.");
  const startPageToken = (body as { startPageToken?: unknown } | null)?.startPageToken;
  if (typeof startPageToken !== "string" || startPageToken.length === 0) {
    throw new Error("Google Drive did not return a changes start token.");
  }
  return startPageToken;
}

function parseDriveChangesBody(response: RequestUrlResponse): ParsedDriveChangesBody {
  if (!response.text) {
    return { changes: [], nextPageToken: null, newStartPageToken: null };
  }

  const body = parseJsonResponseBody(response, "Google Drive returned an unreadable changes response.");
  const parsed = body as { changes?: unknown; nextPageToken?: unknown; newStartPageToken?: unknown } | null;
  return {
    changes: Array.isArray(parsed?.changes) ? (parsed.changes as DriveChange[]) : [],
    nextPageToken: typeof parsed?.nextPageToken === "string" && parsed.nextPageToken.length > 0
      ? parsed.nextPageToken
      : null,
    newStartPageToken: typeof parsed?.newStartPageToken === "string" && parsed.newStartPageToken.length > 0
      ? parsed.newStartPageToken
      : null,
  };
}

function parseJsonResponseBody(response: RequestUrlResponse, errorMessage: string): unknown {
  if (!response.text) {
    return null;
  }

  try {
    return JSON.parse(response.text);
  } catch {
    throw new Error(errorMessage);
  }
}

function isUsableDriveIndexItem(item: DriveIndexItem): boolean {
  try {
    assertValidDrivePickerItem(item);
    return true;
  } catch {
    return false;
  }
}

function getDriveIndexErrorMessage(response: RequestUrlResponse): string {
  const details = parseGoogleDriveError(response);
  const reason = details.reason.toLowerCase();
  const message = details.message.toLowerCase();

  if (response.status === 401) {
    return "Google Drive index needs reconnecting. Connect to Google Drive again, then retry.";
  }

  if (response.status === 403 && (reason.includes("insufficient") || message.includes("insufficient permission"))) {
    return "Google Drive index is missing Drive read permission. Grant Drive read access in settings, then retry.";
  }

  if (response.status === 429 || (response.status === 403 && isQuotaOrRateLimitError(reason, message))) {
    return "Google Drive index is temporarily rate-limited or over quota. Wait a bit, then retry.";
  }

  if (response.status === 403) {
    return "Google Drive denied the index request. Check Drive access, reconnect if needed, then retry.";
  }

  return `Google Drive index failed with HTTP ${response.status}. Retry in a moment; reconnect if it keeps failing.`;
}

function parseGoogleDriveError(response: RequestUrlResponse): { reason: string; message: string } {
  const body = parseErrorBody(response);
  const firstError = body?.error?.errors?.[0];
  return {
    reason: firstError?.reason ?? "",
    message: firstError?.message ?? body?.error?.message ?? "",
  };
}

function parseErrorBody(response: RequestUrlResponse): GoogleDriveErrorBody | null {
  if (!response.text) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(response.text);
    return isGoogleDriveErrorBody(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isGoogleDriveErrorBody(value: unknown): value is GoogleDriveErrorBody {
  if (!value || typeof value !== "object" || !("error" in value)) {
    return false;
  }

  const error = (value as GoogleDriveErrorBody).error;
  return !error || typeof error === "object";
}

function isQuotaOrRateLimitError(reason: string, message: string): boolean {
  return (
    reason.includes("ratelimit") ||
    reason.includes("quota") ||
    reason.includes("dailylimit") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("daily limit")
  );
}
