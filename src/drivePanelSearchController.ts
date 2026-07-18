import { prepareFuzzySearch } from "obsidian";
import { DriveBrowserItem } from "./driveMetadataService";
import { DriveIndexItem, DriveIndexService } from "./driveIndexService";
import { DriveSearchLocationQuery, DriveSearchResult, DriveSearchService } from "./driveSearchService";
import { DrivePanelLocation, RECENT_ROOT, SHARED_WITH_ME_ROOT, STARRED_ROOT, TRASH_ROOT } from "./drivePanelLocation";
import { matchesTypeCategory, PanelModifiedRange, PanelOwnerOption, PanelTypeCategory } from "./drivePanelFormat";

const DRIVE_PANEL_SEARCH_DEBOUNCE_MS = 300;
export const DRIVE_PANEL_SEARCH_RESULT_LIMIT = 200;

// The view-side hooks the search controller calls back into. It owns the panel's search + chip
// filter STATE (T-011 P7); rendering, selection, and the current path stay in the view.
export interface DrivePanelSearchHost {
  currentPath(): DrivePanelLocation[];
  currentLocationId(): string;
  render(): void;
  refreshListOnly(): void;
  clearSelection(): void;
}

// The Drive panel's hybrid search state machine: the live query, its origin path + location scope,
// index/server result sets and their merge, the Type/People/Modified chip filters, and the
// debounce/generation guards. Extracted from drivePanelView.ts (T-011 P7) — bodies verbatim, with
// the view's render/selection side effects routed through DrivePanelSearchHost.
export class DrivePanelSearchController {
  filterQuery = "";
  // Captured when an empty query becomes active. Location=current-folder must stay anchored to the
  // folder where the search began even while asynchronous index/server results stream in.
  searchOriginPath: DrivePanelLocation[] | null = null;
  searchLocation: PanelSearchLocation = "current-folder";
  searchIndexItems: DriveIndexItem[] = [];
  searchServerItems: DriveSearchResult[] = [];
  searchLoading = false;
  searchError: string | null = null;
  searchHasMore = false;
  // Drive-style "Type ▾" filter chip: restricts the loaded listing to a single file-type category
  // (folders / documents / images / …). In-memory + transient like `filterQuery` — it ANDs with the
  // name filter, is purely client-side over the already-loaded folder, and resets on panel reopen.
  typeFilter: PanelTypeCategory | null = null;
  // Drive-style "People ▾" filter chip. The stable key prefers an owner's email address while the
  // label remains human-friendly; owners absent from shared-drive items simply do not match.
  peopleFilter: PanelOwnerOption | null = null;
  // Drive-style "Modified ▾" filter chip: restricts the loaded listing to a recency window
  // (Today / Last 7 days / Last 30 days / This year). In-memory + transient like the other chips —
  // it ANDs with Type + People + name, is client-side over `modifiedTime`, and resets on reopen.
  // The cutoff is recomputed against `Date.now()` each filter pass; items without a parseable
  // `modifiedTime` simply do not match.
  modifiedFilter: PanelModifiedRange | null = null;
  private searchTimer: number | null = null;
  private searchGeneration = 0;
  private panelIndexPromise: Promise<DriveIndexItem[]> | null = null;

  constructor(
    private readonly index: DriveIndexService,
    private readonly search: DriveSearchService,
    private readonly host: DrivePanelSearchHost,
  ) {}

  isDriveSearchActive(): boolean {
    return this.filterQuery.trim().length > 0;
  }

  getDriveSearchItems(): DriveBrowserItem[] {
    return this.locationScopedDriveSearchItems().slice(0, DRIVE_PANEL_SEARCH_RESULT_LIMIT);
  }

  mergeDriveSearchItems(): DriveBrowserItem[] {
    // Overlay fresh server listing metadata (owners, modifiedTime, starred, shared, …) onto index hits
    // the server also returned, so the Type / People / Modified chips can refine search results. The
    // index crawl omits those fields; without this, the People/Modified chips would drop every index hit
    // — even a real match — for want of metadata, because the merge below keeps the index copy and
    // discards the metadata-bearing server copy of the same id. Server fields win (fresher); the index's
    // precomputed `path` survives because the server copy never carries that key. Index-only hits (beyond
    // the server's page, or fuzzy-only) still carry no owner/modified metadata, so those two chips treat
    // the server result set as authoritative. `getSearchMetadataFilterStatus` explicitly signals when
    // an active metadata chip hides one of those unevaluable index-only matches.
    const serverById = new Map(this.searchServerItems.map((item) => [item.id, item] as const));
    const indexIds = new Set(this.searchIndexItems.map((item) => item.id));
    const enrichedIndexItems = this.searchIndexItems.map((indexItem) => {
      const serverItem = serverById.get(indexItem.id);
      return serverItem ? { ...indexItem, ...serverItem } : indexItem;
    });
    return [
      ...enrichedIndexItems,
      ...this.searchServerItems.filter((item) => !indexIds.has(item.id)),
    ];
  }

  locationScopedDriveSearchItems(): DriveBrowserItem[] {
    if (this.searchLocation === "anywhere") {
      return this.mergeDriveSearchItems();
    }
    if (this.searchLocation === "current-folder") {
      const folderId = this.searchOriginPath?.[this.searchOriginPath.length - 1]?.id;
      return folderId ? this.index.filterToFolderSubtree(this.mergeDriveSearchItems(), folderId) : [];
    }
    // The index intentionally does not persist starred/shared/ownership/trash metadata. These
    // locations therefore use the server query as the authoritative result set instead of leaking
    // unscoped index hits into the list.
    return this.searchServerItems;
  }

  hasMoreDriveSearchItems(): boolean {
    return this.searchHasMore || this.locationScopedDriveSearchItems().length > DRIVE_PANEL_SEARCH_RESULT_LIMIT;
  }

  getSearchMetadataFilterStatus(items: DriveBrowserItem[]): string | null {
    const metadataFilters = [this.peopleFilter ? "People" : null, this.modifiedFilter ? "Modified" : null].filter(
      (label): label is string => label !== null,
    );
    if (metadataFilters.length === 0 || !this.searchLocationUsesIndex()) {
      return null;
    }

    const serverIds = new Set(this.searchServerItems.map((item) => item.id));
    const hasHiddenIndexMatch = items.some(
      (item) =>
        !serverIds.has(item.id) &&
        (!this.typeFilter || matchesTypeCategory(item.mimeType, this.typeFilter)),
    );
    if (!hasHiddenIndexMatch) {
      return null;
    }

    const filterLabel = metadataFilters.join(" and ");
    return `Some indexed matches lack ${filterLabel} metadata and are hidden by the active ${
      metadataFilters.length === 1 ? "filter" : "filters"
    }.`;
  }

  queueDriveSearch(immediate = false, refreshChrome = false): void {
    const generation = ++this.searchGeneration;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }

    const query = this.filterQuery.trim();
    let searchModeChanged = false;
    if (query && this.searchOriginPath === null) {
      this.searchOriginPath = this.host.currentPath().map((location) => ({ ...location }));
      this.searchLocation = defaultPanelSearchLocation(this.host.currentLocationId());
      searchModeChanged = true;
    } else if (!query && this.searchOriginPath !== null) {
      this.searchOriginPath = null;
      this.searchLocation = "current-folder";
      searchModeChanged = true;
    }
    this.searchServerItems = [];
    this.searchHasMore = false;
    this.searchError = null;
    this.host.clearSelection();
    if (!query) {
      this.searchIndexItems = [];
      this.searchLoading = false;
      if (searchModeChanged || refreshChrome) {
        this.host.render();
      } else {
        this.host.refreshListOnly();
      }
      return;
    }

    // Mirror the search modal's hybrid path: show matching cached index entries immediately, then
    // debounce a full index ensure + fresh server `name contains` query and merge both by Drive id.
    this.searchIndexItems = this.searchLocationUsesIndex()
      ? this.matchDriveIndexItems(this.index.getItems(), query)
      : [];
    this.searchLoading = true;
    if (searchModeChanged || refreshChrome) {
      this.host.render();
    } else {
      this.host.refreshListOnly();
    }
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.runDriveSearch(query, generation);
    }, immediate ? 0 : DRIVE_PANEL_SEARCH_DEBOUNCE_MS);
  }

  async runDriveSearch(query: string, generation: number): Promise<void> {
    const requests: Promise<void>[] = [];
    if (this.searchLocationUsesIndex()) {
      requests.push(this.ensurePanelIndex().then((items) => {
        if (generation === this.searchGeneration) {
          this.searchIndexItems = this.matchDriveIndexItems(items, query);
          this.host.refreshListOnly();
        }
      }));
    }
    requests.push(this.search.searchByName(query, panelSearchServerLocation(this.searchLocation)).then((response) => {
      if (generation === this.searchGeneration) {
        this.searchServerItems = response.results;
        this.searchHasMore = response.hasMore;
        this.host.refreshListOnly();
      }
    }));

    const settled = await Promise.allSettled(requests);
    if (generation !== this.searchGeneration) {
      return;
    }

    this.searchLoading = false;
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length === settled.length) {
      const reason: unknown = failures[0]?.reason;
      this.searchError =
        reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Drive search failed.";
    }
    this.host.refreshListOnly();
  }

  searchLocationUsesIndex(): boolean {
    return this.searchLocation === "anywhere" || this.searchLocation === "current-folder";
  }

  matchDriveIndexItems(items: DriveIndexItem[], query: string): DriveIndexItem[] {
    // Relevance ordering (kdr QA): keep each hit's fuzzy score and sort best-first, the way
    // drive.google.com ranks search results, instead of leaving index insertion order.
    const fuzzySearch = prepareFuzzySearch(query.normalize("NFC"));
    const scored: Array<{ item: DriveIndexItem; score: number }> = [];
    for (const item of items) {
      const match = fuzzySearch(item.name.normalize("NFC"));
      if (match !== null) {
        scored.push({ item, score: match.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((entry) => entry.item);
  }

  ensurePanelIndex(): Promise<DriveIndexItem[]> {
    if (!this.panelIndexPromise) {
      this.panelIndexPromise = this.index.ensureLoaded().catch((error: unknown) => {
        this.panelIndexPromise = null;
        throw error;
      });
    }
    return this.panelIndexPromise;
  }

  // Drop the memoized index load (panel close / auth change) so the next search re-ensures it.
  resetIndexPromise(): void {
    this.panelIndexPromise = null;
  }

  cancelDriveSearch(): void {
    this.searchGeneration += 1;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.searchLoading = false;
  }

  // Leaving the current listing (any folder/root navigation) ends Drive-wide search mode: cancel the
  // in-flight query, drop the cached results, and clear the box so the destination folder's OWN
  // contents render. Without this, every navigation kept `filterQuery` set, so `isDriveSearchActive()`
  // stayed true and `renderBody` kept repainting the now-stale Drive-wide results — opening a folder
  // (including a folder hit in the results) appeared to do nothing. Returns whether a search was active
  // so the caller can branch (a search-result folder lives anywhere, not under the current path).
  exitDriveSearch(): boolean {
    const wasActive = this.isDriveSearchActive();
    this.cancelDriveSearch();
    this.filterQuery = "";
    this.searchIndexItems = [];
    this.searchServerItems = [];
    this.searchHasMore = false;
    this.searchError = null;
    this.searchOriginPath = null;
    this.searchLocation = "current-folder";
    return wasActive;
  }
}

export type PanelSearchLocation =
  | "anywhere"
  | "current-folder"
  | "my-drive"
  | "shared-with-me"
  | "starred"
  | "trashed";

export interface PanelSearchLocationOption {
  key: PanelSearchLocation;
  label: string;
  icon: string;
}

export function defaultPanelSearchLocation(locationId: string): PanelSearchLocation {
  switch (locationId) {
    case SHARED_WITH_ME_ROOT.id:
      return "shared-with-me";
    case STARRED_ROOT.id:
      return "starred";
    case TRASH_ROOT.id:
      return "trashed";
    case RECENT_ROOT.id:
      return "anywhere";
    default:
      // drive.google.com's search bar defaults to all of Drive, not the folder you're in.
      // Current-folder (recursive) stays one chip-click away. (kdr's confirmed preference.)
      return "anywhere";
  }
}

export function panelSearchServerLocation(location: PanelSearchLocation): DriveSearchLocationQuery {
  return location === "current-folder" ? "anywhere" : location;
}

export function panelSearchLocationOption(
  key: PanelSearchLocation,
  currentFolderName = "Current folder",
): PanelSearchLocationOption {
  switch (key) {
    case "current-folder":
      return { key, label: currentFolderName, icon: "folder" };
    case "my-drive":
      return { key, label: "My Drive", icon: "hard-drive" };
    case "shared-with-me":
      return { key, label: "Shared with me", icon: "users" };
    case "starred":
      return { key, label: "Starred", icon: "star" };
    case "trashed":
      return { key, label: "Trashed", icon: "trash-2" };
    case "anywhere":
    default:
      return { key, label: "Anywhere in Drive", icon: "globe-2" };
  }
}
