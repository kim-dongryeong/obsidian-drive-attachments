import { Notice } from "obsidian";
import {
  DriveBrowserItem,
  DriveBrowserPage,
  DriveMetadataService,
  SharedDriveRoot,
} from "./driveMetadataService";
import { sortFolderFirst } from "./drivePanelFormat";
import { RECENT_ROOT, SHARED_WITH_ME_ROOT, STARRED_ROOT, TRASH_ROOT } from "./drivePanelLocation";

// The view-side hooks the controller calls back into. The controller owns DATA + GENERATION only
// (T-011 P6 design constraint); selection, focus restore, and rendering stay in the view and are
// reached exclusively through these callbacks.
export interface DrivePanelDataHost {
  canBrowse(): boolean;
  // The folder the panel is currently showing — loads always target this id.
  currentFolderId(): string;
  render(): void;
  // canBrowse() said no: the view drops its selection before the empty-state render.
  onCannotBrowse(): void;
  // A folder listing was applied to the cache (fresh page or Load more merge): the view prunes its
  // selection against the new item set.
  onFolderItemsApplied(folderId: string): void;
  // A loadCurrentFolder pass is about to render its final state: the view applies its pending
  // active item (⌘↑ focus restore) so the cursor lands before the paint.
  onFolderLoadSettled(): void;
  // force=true refresh — the view's explicit retry path for previously failed thumbnails.
  onForceRefresh(): void;
  // A Load more kicked off: the view unparks the keyboard cursor from the Load more button.
  onLoadMoreStarted(): void;
}

// Folder/collection listing state for the Drive panel: the per-folder item cache, pagination
// tokens, shared-drive roots, and the generation guards that make slow responses land safely
// after navigation. Extracted from drivePanelView.ts (T-011 P6) — method bodies moved verbatim,
// with the view's selection/render side effects routed through DrivePanelDataHost.
export class DrivePanelDataController {
  private readonly folderCache = new Map<string, DriveBrowserItem[]>();
  private readonly folderNextPageToken = new Map<string, string>();
  private loadGeneration = 0;
  private rootGeneration = 0;

  loadingFolderId: string | null = null;
  loadingMoreFolderId: string | null = null;
  errorMessage: string | null = null;
  sharedDriveRoots: SharedDriveRoot[] = [];
  rootsLoaded = false;
  rootsLoading = false;

  constructor(
    private readonly metadata: DriveMetadataService,
    private readonly host: DrivePanelDataHost,
  ) {}

  // ---- cache access (the view's read/invalidate surface) ----

  getCached(folderId: string): DriveBrowserItem[] | undefined {
    return this.folderCache.get(folderId);
  }

  setCached(folderId: string, items: DriveBrowserItem[]): void {
    this.folderCache.set(folderId, items);
  }

  // Every cached listing, for cross-folder item patches (starred flags, folder colors).
  cachedLists(): IterableIterator<DriveBrowserItem[]> {
    return this.folderCache.values();
  }

  invalidate(folderId: string): void {
    this.folderCache.delete(folderId);
  }

  // Root switch / panel close: drop every listing and its pagination cursor together.
  invalidateAll(): void {
    this.folderCache.clear();
    this.folderNextPageToken.clear();
  }

  hasMorePages(folderId: string): boolean {
    return this.folderNextPageToken.has(folderId);
  }

  // Abandon any in-flight folder/root load so its late .then can't paint a torn-down view.
  cancelInFlight(): void {
    this.loadGeneration++;
    this.rootGeneration++;
  }

  // ---- loading ----

  async loadCurrentFolder(force: boolean): Promise<void> {
    // Bump the generation up front so any in-flight load is invalidated the moment navigation
    // (back/breadcrumb/refresh) changes what we're showing — including when we return early via
    // the cache or scope guards below. Otherwise a slow load that errors after the user has
    // already navigated away would paint its error onto the now-current folder.
    const generation = ++this.loadGeneration;
    if (force) {
      // A refresh is the explicit retry path for thumbnails that previously failed (offline, stale
      // link, expired grant). Successful cached thumbnails remain and self-invalidate if their URL changes.
      this.host.onForceRefresh();
    }

    if (!this.host.canBrowse()) {
      this.loadingFolderId = null;
      this.errorMessage = null;
      this.host.onCannotBrowse();
      this.host.render();
      return;
    }

    const folderId = this.host.currentFolderId();
    if (!force && this.folderCache.has(folderId)) {
      this.loadingFolderId = null;
      this.errorMessage = null;
      this.host.onFolderItemsApplied(folderId);
      this.host.onFolderLoadSettled();
      this.host.render();
      return;
    }

    this.loadingFolderId = folderId;
    this.errorMessage = null;
    this.host.render();

    try {
      const page = await this.listLocationItemsPage(folderId);
      if (generation !== this.loadGeneration) {
        return;
      }
      this.folderCache.set(folderId, sortFolderFirst(page.items));
      this.setNextPageToken(folderId, page.nextPageToken);
      this.host.onFolderItemsApplied(folderId);
      this.errorMessage = null;
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.loadGeneration) {
        this.loadingFolderId = null;
        this.host.onFolderLoadSettled();
        this.host.render();
      }
    }
  }

  private setNextPageToken(folderId: string, token: string | undefined): void {
    // Every listing (Recent included) pages the same way drive.google.com does — its Recent view
    // is an infinite recency scroll, not a fixed top-N — so a pending token always offers Load more.
    if (token) {
      this.folderNextPageToken.set(folderId, token);
    } else {
      this.folderNextPageToken.delete(folderId);
    }
  }

  // "Load more" — fetch the current listing's next Drive page and append it. Guarded by the same
  // loadGeneration as loadCurrentFolder, so navigating away (or refreshing) while a page is in
  // flight discards the stale append instead of splicing it into another folder's list.
  async loadMoreCurrentFolder(): Promise<void> {
    const folderId = this.host.currentFolderId();
    const pageToken = this.folderNextPageToken.get(folderId);
    if (!pageToken || this.loadingMoreFolderId !== null) {
      return;
    }

    const generation = this.loadGeneration;
    this.loadingMoreFolderId = folderId;
    this.host.onLoadMoreStarted();
    this.host.render();

    try {
      const page = await this.listLocationItemsPage(folderId, pageToken);
      if (generation !== this.loadGeneration) {
        return;
      }
      const existing = this.folderCache.get(folderId) ?? [];
      // Dedup by id: the listing can shift between page fetches (uploads, renames), and Drive may
      // then re-serve an item the first page already had. Last-write wins keeps the fresher copy.
      const merged = new Map(existing.map((item) => [item.id, item] as const));
      for (const item of page.items) {
        merged.set(item.id, item);
      }
      this.folderCache.set(folderId, sortFolderFirst([...merged.values()]));
      this.setNextPageToken(folderId, page.nextPageToken);
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      new Notice(`Load more failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (generation === this.loadGeneration) {
        this.loadingMoreFolderId = null;
        this.host.render();
      } else {
        this.loadingMoreFolderId = null;
      }
    }
  }

  async loadRoots(force: boolean): Promise<void> {
    const generation = ++this.rootGeneration;

    if (!this.host.canBrowse()) {
      this.sharedDriveRoots = [];
      this.rootsLoaded = false;
      this.rootsLoading = false;
      this.host.render();
      return;
    }

    if (!force && this.rootsLoaded) {
      return;
    }

    this.rootsLoading = true;
    this.host.render();

    try {
      const roots = await this.metadata.listSharedDriveRoots();
      if (generation !== this.rootGeneration) {
        return;
      }
      this.sharedDriveRoots = roots;
      this.rootsLoaded = true;
    } catch {
      if (generation !== this.rootGeneration) {
        return;
      }
      this.sharedDriveRoots = [];
      this.rootsLoaded = true;
    } finally {
      if (generation === this.rootGeneration) {
        this.rootsLoading = false;
        this.host.render();
      }
    }
  }

  // Route a location id to its Drive listing: the four virtual collection roots use their dedicated
  // queries; everything else is a real folder id.
  listLocationItemsPage(folderId: string, pageToken?: string): Promise<DriveBrowserPage> {
    if (folderId === SHARED_WITH_ME_ROOT.id) {
      return this.metadata.listSharedWithMePage(pageToken);
    }
    if (folderId === RECENT_ROOT.id) {
      return this.metadata.listRecentPage(pageToken);
    }
    if (folderId === STARRED_ROOT.id) {
      return this.metadata.listStarredPage(pageToken);
    }
    if (folderId === TRASH_ROOT.id) {
      return this.metadata.listTrashedPage(pageToken);
    }
    return this.metadata.listFolderPage(folderId, pageToken);
  }

  // A breadcrumb sibling menu needs a folder's children without navigating there: cached listing
  // if present, otherwise fetch the first page and cache it (with its pagination cursor).
  async getBreadcrumbFolderItems(folderId: string): Promise<DriveBrowserItem[]> {
    const cached = this.folderCache.get(folderId);
    if (cached !== undefined) {
      return cached;
    }

    const page = await this.listLocationItemsPage(folderId);
    const items = sortFolderFirst(page.items);
    this.folderCache.set(folderId, items);
    this.setNextPageToken(folderId, page.nextPageToken);
    return items;
  }
}
