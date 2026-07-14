import {
  Editor,
  ItemView,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  prepareFuzzySearch,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { formatBytes } from "./byteFormat";
import { computeMd5HexFromSource, DriveDedupHit, DriveDedupService } from "./driveDedupService";
import { DriveAuthService } from "./driveAuthService";
import { DriveIndexItem, DriveIndexService } from "./driveIndexService";
import {
  DriveBrowserItem,
  DriveBrowserPage,
  DriveMetadata,
  DriveMetadataService,
  DriveOwner,
  SharedDriveRoot,
} from "./driveMetadataService";
import { DrivePreviewService } from "./drivePreviewService";
import { CustomFileIconResolver, renderFileIcon } from "./driveFileIcon";
import {
  copyDriveItemLink,
  DriveRowActionContext,
  embedDriveItemPreview,
  insertDriveItemAssetNote,
  insertDriveItemLink,
  openDriveItemInBrowser,
  openDriveItemPreview,
  openDriveItemSharePage,
} from "./driveRowActions";
import { getDriveResultIcon, getDriveResultTypeClass, renderDriveResultHint, renderSearchHighlights } from "./driveSearchModal";
import {
  type DriveSearchLocationQuery,
  type DriveSearchResult,
  DriveSearchService,
} from "./driveSearchService";
import { DRIVE_FOLDER_MIME_TYPE, DRIVE_PANEL_DRAG_MIME, serializeDrivePanelDragItems } from "./driveTypes";
import { PanelDragModifierTracker } from "./panelDragModifierTracker";
import { InsertService } from "./insertService";
import {
  GoogleDriveAttachmentBridgeSettings,
  isPanelTheme,
  PANEL_THEME_OPTIONS,
  PanelSortDir,
  PanelSortKey,
  PanelTheme,
  PanelViewMode,
} from "./settings";
import { DriveUploadService, FileUploadSource } from "./driveUploadService";
import { DriveFileOpsService } from "./driveFileOpsService";
import { DriveThumbnailService } from "./driveThumbnailService";

// Legacy internal id from the pre-rename era ("Drive Attachment Bridge") — kept so existing vaults'
// saved workspace layouts still resolve this view. Same for the `gdab-` CSS/MIME prefixes: internal
// namespaces, not user-visible; renaming them buys nothing and breaks compatibility.
export const DRIVE_PANEL_VIEW_TYPE = "drive-attachment-bridge-panel";

interface DrivePanelLocation {
  id: string;
  name: string;
}

interface DrivePanelDetailRecord {
  metadata: DriveMetadata;
  thumbnailUrl: string | null;
}

interface PanelThumbnailTarget {
  fileId: string;
  sourceUrl: string;
}

const MY_DRIVE_ROOT: DrivePanelLocation = { id: "root", name: "My Drive" };
// Virtual collection ids deliberately cannot be mistaken for Drive file ids. They are panel-only
// locations and must never be passed as upload parents or move sources.
const SHARED_WITH_ME_ROOT: DrivePanelLocation = { id: "gdab:sharedwithme", name: "Shared with me" };
const STARRED_ROOT: DrivePanelLocation = { id: "gdab:starred", name: "Starred" };
const RECENT_ROOT: DrivePanelLocation = { id: "gdab:recent", name: "Recent" };
const TRASH_ROOT: DrivePanelLocation = { id: "gdab:trash", name: "Trash" };
const VIRTUAL_ROOT_IDS: ReadonlySet<string> = new Set([
  SHARED_WITH_ME_ROOT.id,
  STARRED_ROOT.id,
  RECENT_ROOT.id,
  TRASH_ROOT.id,
]);

// True for the panel-only collection roots (Shared with me / Starred / Recent / Trash), which are
// query-backed rather than real Drive folders and must never be passed as a parent id or move source.
function isVirtualRootId(id: string | undefined): boolean {
  return id !== undefined && VIRTUAL_ROOT_IDS.has(id);
}

// Display name for a virtual collection id, used in read-only Notices and state copy.
function virtualRootName(id: string | undefined): string {
  if (id === SHARED_WITH_ME_ROOT.id) {
    return "Shared with me";
  }
  if (id === RECENT_ROOT.id) {
    return "Recent";
  }
  if (id === STARRED_ROOT.id) {
    return "Starred";
  }
  if (id === TRASH_ROOT.id) {
    return "Trash";
  }
  return "This collection";
}

// drive.google.com-style glyph for each entry in the ROOT breadcrumb menu, shown as a TITLE PREFIX.
// MenuItem.setIcon() renders nothing in this menu (kdr saw no icons even after removing setChecked), so
// an emoji in the title is used instead — it always renders. My Drive / a shared drive / the virtual
// collections / Trash.
function rootBreadcrumbGlyph(id: string): string {
  if (id === SHARED_WITH_ME_ROOT.id) {
    return "🤝";
  }
  if (id === RECENT_ROOT.id) {
    return "🕘";
  }
  if (id === STARRED_ROOT.id) {
    return "⭐";
  }
  if (id === TRASH_ROOT.id) {
    return "🗑️";
  }
  if (id === MY_DRIVE_ROOT.id) {
    return "🗂️";
  }
  return "👥"; // a shared (team) drive — a real Drive id, not a virtual collection
}

const TYPE_AHEAD_RESET_MS = 900;
const DRIVE_PANEL_SEARCH_DEBOUNCE_MS = 300;
const DRIVE_PANEL_SEARCH_RESULT_LIMIT = 200;

// DataTransfer marker stamped on a Drive-internal row drag. Detection actually keys off the in-memory
// `internalDrag` field; this payload only ensures Electron registers the drag and keeps the move/copy
// path cleanly distinct from an OS-file drop (which uploads).
const DRIVE_INTERNAL_DRAG_MIME = "application/x-gdab-drive-items";

export class DrivePanelView extends ItemView {
  private readonly path: DrivePanelLocation[] = [{ ...MY_DRIVE_ROOT }];
  private readonly folderCache = new Map<string, DriveBrowserItem[]>();
  // Drive nextPageToken per location id — present only while that listing has more pages to fetch
  // ("Load more" row shows). Lives beside folderCache and is cleared/invalidated with it.
  private readonly folderNextPageToken = new Map<string, string>();
  private loadingMoreFolderId: string | null = null;
  private sharedDriveRoots: SharedDriveRoot[] = [];
  private rootsLoaded = false;
  private rootsLoading = false;
  private loadingFolderId: string | null = null;
  private errorMessage: string | null = null;
  private loadGeneration = 0;
  private rootGeneration = 0;
  private panelDropEventsRegistered = false;
  private panelDropInFlight = false;
  // One in-flight guard for panel Drive-write ops (rename/trash), separate from upload drops, so a
  // mutation and its follow-up reload can't overlap a second mutation fired in quick succession.
  private panelWriteInFlight = false;
  // One in-flight guard for an address-bar path resolution (a chain of `listFolder` reads) so a
  // second Enter can't start a competing walk while the first is mid-flight.
  private addressBarBusy = false;
  private addressBarEditing = false;
  private dropHintEl: HTMLElement | null = null;
  private filterQuery = "";
  // Captured when an empty query becomes active. Location=current-folder must stay anchored to the
  // folder where the search began even while asynchronous index/server results stream in.
  private searchOriginPath: DrivePanelLocation[] | null = null;
  private searchLocation: PanelSearchLocation = "current-folder";
  private searchIndexItems: DriveIndexItem[] = [];
  private searchServerItems: DriveSearchResult[] = [];
  private searchLoading = false;
  private searchError: string | null = null;
  private searchHasMore = false;
  private searchTimer: number | null = null;
  private searchGeneration = 0;
  private panelIndexPromise: Promise<DriveIndexItem[]> | null = null;
  // Drive-style "Type ▾" filter chip: restricts the loaded listing to a single file-type category
  // (folders / documents / images / …). In-memory + transient like `filterQuery` — it ANDs with the
  // name filter, is purely client-side over the already-loaded folder, and resets on panel reopen.
  private typeFilter: PanelTypeCategory | null = null;
  // Drive-style "People ▾" filter chip. The stable key prefers an owner's email address while the
  // label remains human-friendly; owners absent from shared-drive items simply do not match.
  private peopleFilter: PanelOwnerOption | null = null;
  // Drive-style "Modified ▾" filter chip: restricts the loaded listing to a recency window
  // (Today / Last 7 days / Last 30 days / This year). In-memory + transient like the other chips —
  // it ANDs with Type + People + name, is client-side over `modifiedTime`, and resets on reopen.
  // The cutoff is recomputed against `Date.now()` each filter pass; items without a parseable
  // `modifiedTime` simply do not match.
  private modifiedFilter: PanelModifiedRange | null = null;
  // The Drive items being dragged within the panel (a row, or the whole selection). Non-null only
  // during a Drive-internal drag; lets the folder-row handlers route to MOVE/COPY instead of upload.
  private internalDrag: DriveBrowserItem[] | null = null;
  private readonly selectedItemIds = new Set<string>();
  private selectionAnchorId: string | null = null;
  // Roving keyboard cursor: the row ↑/↓ move from and Enter acts on. Kept in sync with mouse
  // selection so a click then arrows feels continuous. `selectionAnchorId` stays the fixed end for
  // Shift-range extension; `activeItemId` is the moving end.
  private activeItemId: string | null = null;
  private listEl: HTMLElement | null = null;
  private listFolderId: string | null = null;
  private activeRowEl: HTMLElement | null = null;
  private scrollActiveIntoView = false;
  private typeAheadBuffer = "";
  private typeAheadResetTimer: number | null = null;
  // Browser-style folder history: snapshots of `path` the user has visited, plus a cursor into them.
  // Back/Forward move the cursor without recording; any forward navigation truncates entries past it.
  private navHistory: DrivePanelLocation[][] = [];
  private navHistoryIndex = -1;
  private readonly detailMetadataCache = new Map<string, DrivePanelDetailRecord>();
  private readonly detailMetadataLoadingIds = new Set<string>();
  private readonly detailMetadataErrors = new Map<string, string>();
  private detailBarEl: HTMLElement | null = null;
  // The Details row-menu action may reveal the bar for the current selection without changing the
  // user's persistent panelDetailBar setting. It stays open while the selection is active and has
  // its own close button; clearing/navigating the selection dismisses it.
  private transientDetailBar = false;
  private focusDetailBarOnRender = false;
  private readonly fileOps: DriveFileOpsService;
  private readonly thumbnails: DriveThumbnailService;
  private thumbnailObserver: IntersectionObserver | null = null;
  private readonly thumbnailTargets = new WeakMap<Element, PanelThumbnailTarget>();
  private readonly thumbnailFailures = new Set<string>();
  private thumbnailGeneration = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly auth: DriveAuthService,
    private readonly metadata: DriveMetadataService,
    private readonly index: DriveIndexService,
    private readonly search: DriveSearchService,
    private readonly upload: DriveUploadService,
    private readonly dedup: DriveDedupService,
    private readonly insert: InsertService,
    private readonly preview: DrivePreviewService,
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
    private readonly saveSettings: () => Promise<void>,
    private readonly connect: () => Promise<void>,
    private readonly openSettings: () => void,
    private readonly panelDragModifiers: PanelDragModifierTracker,
    private readonly customIconSrc?: CustomFileIconResolver,
  ) {
    super(leaf);
    this.fileOps = new DriveFileOpsService(auth);
    this.thumbnails = new DriveThumbnailService(auth);
  }

  getViewType(): string {
    return DRIVE_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Google Drive";
  }

  getIcon(): string {
    return "hard-drive";
  }

  async onOpen(): Promise<void> {
    this.registerPanelDropEvents();
    this.resetHistory();
    this.render();
    void this.loadRoots(false);
    void this.ensurePanelIndex().catch(() => undefined);
    await this.loadCurrentFolder(false);
  }

  async onClose(): Promise<void> {
    // Abandon any in-flight folder/root load so its late .then can't paint a torn-down view.
    this.loadGeneration++;
    this.rootGeneration++;
    this.cancelDriveSearch();
    this.panelIndexPromise = null;
    this.folderCache.clear();
    this.folderNextPageToken.clear();
    this.clearSelection(false);
    this.resetTypeAheadBuffer();
    this.setPanelDropHighlight(false);
    this.contentEl.removeClass("is-uploading");
    this.panelWriteInFlight = false;
    this.internalDrag = null;
    this.thumbnailObserver?.disconnect();
    this.thumbnailObserver = null;
    this.thumbnailGeneration += 1;
    this.thumbnailFailures.clear();
    this.thumbnails.clear();
  }

  // Re-paint the panel using cached folder data (no Drive refetch) — e.g. after the custom icon pack
  // reloads, so swapped row icons show immediately without re-navigating. If nothing's loaded yet
  // there are no icons to refresh and this just re-paints the current (loading/empty) state.
  refreshIcons(): void {
    this.render();
  }

  // Search enablement and OAuth grants can change while this leaf stays open. Re-run the same
  // availability gates as onOpen so disabling/disconnecting immediately replaces the live browser
  // with its CTA, while enabling/reconnecting reloads Drive instead of leaving a stale empty panel.
  refreshAvailability(): void {
    this.exitDriveSearch();
    this.panelIndexPromise = null;
    void this.loadRoots(true);
    if (this.canBrowse()) {
      void this.ensurePanelIndex().catch(() => undefined);
    }
    void this.loadCurrentFolder(true);
  }

  // Theme changes are CSS-only, so settings can repaint an open panel without rebuilding its DOM.
  refreshTheme(): void {
    this.applyThemeClass();
  }

  private registerPanelDropEvents(): void {
    if (this.panelDropEventsRegistered) {
      return;
    }
    this.panelDropEventsRegistered = true;

    this.registerDomEvent(this.contentEl, "dragenter", (evt) => {
      this.handlePanelDrag(evt);
    });
    this.registerDomEvent(this.contentEl, "dragover", (evt) => {
      this.handlePanelDrag(evt);
    });
    this.registerDomEvent(this.contentEl, "dragleave", (evt) => {
      const nextTarget = evt.relatedTarget;
      if (nextTarget instanceof Node && this.contentEl.contains(nextTarget)) {
        return;
      }
      this.setPanelDropHighlight(false);
      this.setDropHint(null);
    });
    this.registerDomEvent(this.contentEl, "drop", (evt) => {
      this.handlePanelDrop(evt);
    });
  }

  private handlePanelDrag(evt: DragEvent): void {
    if (!hasLocalFileDrag(evt.dataTransfer)) {
      return;
    }

    evt.preventDefault();
    evt.stopPropagation();

    const mode = this.getSettings().panelDropUpload;
    const canDrop = this.canAcceptPanelDrop();
    if (evt.dataTransfer) {
      evt.dataTransfer.dropEffect = mode === "off" || !canDrop ? "none" : "copy";
    }
    const active = mode !== "off" && canDrop;
    this.setPanelDropHighlight(active);
    this.setDropHint(active ? `Upload to "${this.currentLocation.name}"` : null);
  }

  private handlePanelDrop(evt: DragEvent): void {
    // A drop on empty space or a file row targets the folder currently shown in the panel.
    this.processPanelDrop(evt, this.currentLocation, this.currentBreadcrumb);
  }

  // A drop ONTO a folder row uploads INTO that folder (the one under the pointer), not the current
  // path. stopPropagation() so the panel-wide contentEl drop handler doesn't ALSO fire for this drop.
  private handleFolderRowDrop(evt: DragEvent, item: DriveBrowserItem, row: HTMLElement): void {
    // A Drive-internal drag (a row/selection dragged within the panel) → MOVE/COPY into this folder,
    // never the upload path. Detected by the in-memory marker, so it can't be confused with an OS drop.
    if (this.internalDrag) {
      evt.preventDefault();
      evt.stopPropagation();
      row.removeClass("is-drop-target");
      this.setDropHint(null);
      this.handleInternalFolderRowDrop(evt, item);
      return;
    }
    evt.stopPropagation();
    row.removeClass("is-drop-target");
    const breadcrumb = this.currentBreadcrumb ? `${this.currentBreadcrumb} / ${item.name}` : item.name;
    this.processPanelDrop(evt, { id: item.id, name: item.name }, breadcrumb);
  }

  private processPanelDrop(evt: DragEvent, targetLocation: DrivePanelLocation, targetBreadcrumb: string): void {
    this.setDropHint(null);
    const mode = this.getSettings().panelDropUpload;
    if (mode === "off") {
      if (hasLocalFileDrag(evt.dataTransfer)) {
        evt.preventDefault();
        evt.stopPropagation();
        this.setPanelDropHighlight(false);
        this.clearFolderRowDropHighlight();
        new Notice("Drive panel uploads are off in settings.");
      }
      return;
    }

    if (isVirtualRootId(targetLocation.id) && hasLocalFileDrag(evt.dataTransfer)) {
      evt.preventDefault();
      evt.stopPropagation();
      this.setPanelDropHighlight(false);
      new Notice(`Open a Drive folder before uploading files. ${virtualRootName(targetLocation.id)} is a collection.`);
      return;
    }

    // Capture BOTH the flat file list and the directory entries synchronously (the D3 rule): the
    // DataTransfer and its items go stale the moment this handler returns, so webkitGetAsEntry() must
    // be called now — before any await in the upload path below — to walk dropped folders later.
    const entries = captureDropEntries(evt.dataTransfer);
    const files = extractPanelDropFiles(evt.dataTransfer);
    if (!hasLocalFileDrag(evt.dataTransfer) && files.length === 0 && entries.length === 0) {
      return;
    }

    evt.preventDefault();
    evt.stopPropagation();
    this.setPanelDropHighlight(false);
    this.clearFolderRowDropHighlight();

    const target = { ...targetLocation };
    if (mode === "confirm") {
      if (!this.canStartPanelDropUpload()) {
        return;
      }
      this.openPanelDropConfirmModal(entries, files, target, targetBreadcrumb);
      return;
    }

    this.startPanelDropUpload(entries, files, target);
  }

  private startPanelDropUpload(entries: FileSystemEntry[], files: File[], target: DrivePanelLocation): void {
    if (!this.canStartPanelDropUpload()) {
      return;
    }

    // A drop that includes any directory goes through the recursive tree path (which also carries the
    // loose files dropped alongside it). A files-only drop keeps the flat Phase A path (md5 dedup).
    if (entries.some(isDirectoryEntry)) {
      void this.uploadPanelDroppedTree(entries, target);
      return;
    }

    if (files.length === 0) {
      new Notice("Drop local files or folders onto the Drive panel.");
      return;
    }

    const uploadableFiles = files.filter((file) => !isJunkFileName(file.name));
    const skippedJunk = files.length - uploadableFiles.length;
    if (uploadableFiles.length === 0) {
      new Notice(`Skipped ${formatCount(skippedJunk, "junk file")} from the Drive panel drop.`);
      return;
    }

    void this.uploadPanelDroppedFiles(uploadableFiles, target, skippedJunk);
  }

  private canStartPanelDropUpload(): boolean {
    if (this.getSettings().panelDropUpload === "off") {
      new Notice("Drive panel uploads are off in settings.");
      return false;
    }

    if (this.panelDropInFlight) {
      new Notice("Wait for the current Drive upload to finish before dropping more files.");
      return false;
    }

    if (!this.canBrowse()) {
      new Notice("Connect Google Drive with browsing access before dropping files onto the Drive panel.");
      return false;
    }

    return true;
  }

  private canAcceptPanelDrop(target: DrivePanelLocation = this.currentLocation): boolean {
    return !isVirtualRootId(target.id)
      && this.getSettings().panelDropUpload !== "off"
      && this.canBrowse()
      && !this.panelDropInFlight;
  }

  private setPanelDropHighlight(active: boolean): void {
    if (active) {
      this.contentEl.addClass("is-drop-target");
      return;
    }
    this.contentEl.removeClass("is-drop-target");
  }

  // Folder-row drop target: while a drag hovers a folder row, the drop goes INTO that folder. Light up
  // just that row, clear the whole-panel (current-folder) highlight, and name the target in the chip.
  private handleFolderRowDrag(evt: DragEvent, item: DriveBrowserItem, row: HTMLElement): void {
    if (this.internalDrag) {
      this.handleInternalFolderRowDrag(evt, item, row);
      return;
    }
    if (!hasLocalFileDrag(evt.dataTransfer)) {
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    const mode = this.getSettings().panelDropUpload;
    const canDrop = this.canAcceptPanelDrop({ id: item.id, name: item.name });
    if (evt.dataTransfer) {
      evt.dataTransfer.dropEffect = mode === "off" || !canDrop ? "none" : "copy";
    }
    const active = mode !== "off" && canDrop;
    this.setPanelDropHighlight(false);
    row.toggleClass("is-drop-target", active);
    this.setDropHint(active ? `Upload into "${item.name}"` : null);
  }

  private handleFolderRowDragLeave(evt: DragEvent, row: HTMLElement): void {
    // dragleave also fires moving between the row's own children — only clear on a true leave.
    if (evt.relatedTarget instanceof Node && row.contains(evt.relatedTarget)) {
      return;
    }
    row.removeClass("is-drop-target");
    this.setDropHint(null);
  }

  private clearFolderRowDropHighlight(): void {
    this.contentEl
      .querySelectorAll(".gdab-drive-panel-row.is-drop-target")
      .forEach((el) => el.classList.remove("is-drop-target"));
  }

  // A Drive row (or the current multi-selection) starts being dragged within the panel. Record the
  // dragged items in memory so the folder-row handlers route to MOVE/COPY (not upload), mark the
  // DataTransfer so Electron starts the drag, and dim the source rows.
  private handleRowDragStart(evt: DragEvent, item: DriveBrowserItem): void {
    const dragged = this.menuTargets(item);
    if (dragged.length === 0) {
      return;
    }
    this.internalDrag = dragged;
    // Track the modifiers for THIS drag so the capture-phase dragover (main.ts) and editor-drop can read
    // a ⌘/⌃/⌥/⇧ held while the pointer is stationary, not just one captured in a moving dragover event.
    this.panelDragModifiers.start(evt);
    if (evt.dataTransfer) {
      // "all" (not "copyMove") so a modifier held over the editor always resolves to a VALID dropEffect:
      // with "copyMove", a modifier the platform maps to "link" (and on macOS some ⌘/⌥ combos) yields
      // dropEffect "none", so the OS BLOCKS the drop before `editor-drop` ever fires — which is why the
      // modifier drag-out wouldn't drop / wouldn't change format (kdr). "all" = copy|move|link.
      evt.dataTransfer.effectAllowed = "all";
      // Marker payload only — detection uses the in-memory field, not getData (unreadable on dragover).
      evt.dataTransfer.setData(DRIVE_INTERNAL_DRAG_MIME, dragged.map((it) => it.id).join(","));
      // Drag-OUT to a note: stamp the link/embed Markdown as text/plain so Obsidian's editor drop
      // inserts it at the drop point. The in-panel move/copy path preventDefaults and reads the
      // in-memory marker instead, so this text is only ever consumed by an external (editor) drop.
      const dragOut = this.buildDragOutPayload(dragged);
      if (dragOut) {
        evt.dataTransfer.setData("text/plain", dragOut);
      }
      // Every enabled mode also stamps the item descriptors so an editor-drop can choose link/embed/
      // note from the modifiers held at DROP. A drop outside a Markdown editor is not intercepted and
      // keeps the default-format text/plain fallback above. Off stamps neither outbound payload.
      if (this.getSettings().panelDragOut !== "off") {
        const panelPayload = serializeDrivePanelDragItems(dragged);
        if (panelPayload) {
          evt.dataTransfer.setData(DRIVE_PANEL_DRAG_MIME, panelPayload);
        }
      }
    }
    const draggedIds = new Set(dragged.map((it) => it.id));
    this.contentEl.querySelectorAll(".gdab-drive-panel-row").forEach((el) => {
      if (el instanceof HTMLElement && el.dataset.itemId !== undefined && draggedIds.has(el.dataset.itemId)) {
        el.addClass("is-dragging");
      }
    });
  }

  // The text/plain a panel→editor drag inserts, per the `panelDragOut` setting: an inline link, a
  // `drive-preview` embed (files only; folders fall back to a link), or nothing when off. "note" mode
  // reuses the inline-link branch here as the fallback for un-intercepted drops (external apps, the
  // file tree). In an editor, DRIVE_PANEL_DRAG_MIME lets the drop-time modifier override this default.
  // Items missing a usable Drive link are skipped; a multi-selection joins its entries with a blank
  // line. Returns null when there's nothing to insert, so the caller leaves text/plain unset.
  private buildDragOutPayload(items: DriveBrowserItem[]): string | null {
    const mode = this.getSettings().panelDragOut;
    if (mode === "off") {
      return null;
    }
    const parts: string[] = [];
    for (const item of items) {
      const isFolder = item.mimeType === DRIVE_FOLDER_MIME_TYPE;
      if (mode === "embed" && !isFolder) {
        parts.push(this.insert.formatDriveEmbedBlock(item.id));
        continue;
      }
      if (item.webViewLink) {
        parts.push(this.insert.formatInlineDriveLink(item.name, item.webViewLink));
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  private handleRowDragEnd(): void {
    this.panelDragModifiers.stop();
    this.internalDrag = null;
    this.clearFolderRowDropHighlight();
    this.setDropHint(null);
    this.contentEl
      .querySelectorAll(".gdab-drive-panel-row.is-dragging")
      .forEach((el) => el.classList.remove("is-dragging"));
  }

  // Drive-internal drag hovering a folder row: light the row and show a move/copy cursor + hint. A drop
  // onto one of the dragged items (e.g. a folder dragged onto itself) is not a valid target.
  private handleInternalFolderRowDrag(evt: DragEvent, item: DriveBrowserItem, row: HTMLElement): void {
    const dragged = this.internalDrag;
    if (!dragged || this.isCurrentVirtualRoot() || dragged.some((it) => it.id === item.id)) {
      if (evt.dataTransfer) {
        evt.dataTransfer.dropEffect = "none";
      }
      row.removeClass("is-drop-target");
      return;
    }

    evt.preventDefault();
    evt.stopPropagation();
    const mode = this.internalDragMode(dragged, evt);
    if (evt.dataTransfer) {
      evt.dataTransfer.dropEffect = mode;
    }
    this.setPanelDropHighlight(false);
    row.addClass("is-drop-target");
    this.setDropHint(`${mode === "copy" ? "Copy" : "Move"} into "${item.name}"`);
  }

  private handleInternalFolderRowDrop(evt: DragEvent, item: DriveBrowserItem): void {
    const dragged = this.internalDrag;
    this.internalDrag = null;
    this.contentEl
      .querySelectorAll(".gdab-drive-panel-row.is-dragging")
      .forEach((el) => el.classList.remove("is-dragging"));
    if (!dragged) {
      return;
    }
    if (this.isCurrentVirtualRoot()) {
      new Notice(`Open a Drive folder before moving items. ${this.currentVirtualRootName()} is a collection, not a parent folder.`);
      return;
    }
    const targets = dragged.filter((it) => it.id !== item.id);
    if (targets.length === 0) {
      return;
    }

    const destination: DrivePanelLocation = { id: item.id, name: item.name };
    if (this.internalDragMode(targets, evt) === "copy") {
      void this.copyItems(targets, destination);
      return;
    }
    void this.moveItems(targets, { ...this.currentLocation }, destination);
  }

  // Move by default; Cmd/Ctrl held = copy, but only when every dragged item is a file (Drive can't copy
  // folders from this panel). A modifier over a folder or mixed drag falls back to a move.
  private internalDragMode(dragged: DriveBrowserItem[], evt: DragEvent): "move" | "copy" {
    if (!evt.metaKey && !evt.ctrlKey) {
      return "move";
    }
    const allFiles = dragged.every((it) => it.mimeType !== DRIVE_FOLDER_MIME_TYPE);
    return allFiles ? "copy" : "move";
  }

  // One in-panel status chip, anchored bottom-center of the panel: during a drag it names the drop
  // target ("Upload into X"); during an upload it shows live progress ("Uploading 3/10 → X"). null hides.
  private setDropHint(text: string | null): void {
    if (!text) {
      this.dropHintEl?.removeClass("is-visible");
      return;
    }
    if (!this.dropHintEl || !this.contentEl.contains(this.dropHintEl)) {
      this.dropHintEl = this.contentEl.createDiv({ cls: "gdab-drive-panel-drop-hint" });
    }
    this.dropHintEl.setText(text);
    this.dropHintEl.addClass("is-visible");
  }

  private setUploadPill(done: number, total: number, targetName: string): void {
    this.setDropHint(`Uploading ${done}/${total} → "${targetName}"`);
  }

  private openPanelDropConfirmModal(
    entries: FileSystemEntry[],
    files: File[],
    target: DrivePanelLocation,
    targetBreadcrumb: string,
  ): void {
    new PanelDropConfirmModal(this.app, {
      entries,
      files,
      targetBreadcrumb,
      targetName: target.name,
      onConfirm: () => this.startPanelDropUpload(entries, files, target),
    }).open();
  }

  private async uploadPanelDroppedFiles(
    files: File[],
    target: DrivePanelLocation,
    skippedJunk: number,
  ): Promise<void> {
    this.panelDropInFlight = true;
    this.contentEl.addClass("is-uploading");

    const stats: PanelDropUploadStats = {
      uploaded: 0,
      skippedDuplicates: 0,
      skippedJunk,
      failed: 0,
      failedNames: [],
    };
    const progress = new Notice(formatPanelUploadProgress(0, files.length, target.name, stats), 0);

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        this.setUploadPill(index + 1, files.length, target.name);
        progress.setMessage(formatPanelUploadProgress(index + 1, files.length, target.name, stats, file.name));

        try {
          const source = new FileUploadSource(file);
          const md5 = await computeMd5HexFromSource(source);
          const duplicate = await this.findPanelDropDuplicate(md5, file.name);

          if (duplicate) {
            stats.skippedDuplicates += 1;
            progress.setMessage(formatPanelUploadProgress(index + 1, files.length, target.name, stats));
            continue;
          }

          await this.upload.uploadFile({
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            source,
            parentFolderId: target.id,
            allowRootFallback: false,
          });
          stats.uploaded += 1;
        } catch (error) {
          stats.failed += 1;
          stats.failedNames.push(file.name);
          console.warn("[Drive Attachments] Drive panel upload failed.", error);
        }

        progress.setMessage(formatPanelUploadProgress(index + 1, files.length, target.name, stats));
      }

      if (this.currentLocation.id === target.id) {
        await this.loadCurrentFolder(true);
      } else {
        this.folderCache.delete(target.id);
      }
    } finally {
      progress.hide();
      this.panelDropInFlight = false;
      this.contentEl.removeClass("is-uploading");
      this.setDropHint(null);
    }

    new Notice(formatPanelUploadSummary(target.name, stats), stats.failed > 0 ? 10_000 : 5_000);
  }

  // Folder drop (Phase B): recreate the dropped directory tree under `target`, then upload each file
  // into its recreated folder. Faithful recreation is the goal here — unlike the flat path, nested
  // files are NOT md5-deduped, because skipping a duplicate would punch a hole in the recreated tree
  // (and Drive folder creation isn't deduped either, so a re-drop already yields a fresh copy).
  private async uploadPanelDroppedTree(entries: FileSystemEntry[], target: DrivePanelLocation): Promise<void> {
    this.panelDropInFlight = true;
    this.contentEl.addClass("is-uploading");

    const progress = new Notice(`Reading dropped folder for ${target.name}…`, 0);
    this.setDropHint(`Reading "${target.name}"…`);
    const stats: PanelDropUploadStats = {
      uploaded: 0,
      skippedDuplicates: 0,
      skippedJunk: 0,
      failed: 0,
      failedNames: [],
    };
    let foldersCreated = 0;
    let summary: string | null = null;

    try {
      let plan: FolderUploadPlan;
      try {
        plan = await walkDropEntries(entries);
      } catch (error) {
        console.warn("[Drive Attachments] Could not read the dropped folder tree.", error);
        summary = "Could not read the dropped folder. Try dropping it again.";
        return;
      }
      stats.skippedJunk = plan.skippedJunk;

      if (plan.files.length === 0 && plan.dirs.length === 0) {
        const junkNote = stats.skippedJunk > 0 ? ` (skipped ${formatCount(stats.skippedJunk, "junk file")})` : "";
        summary = `Nothing to upload from the dropped folder${junkNote}.`;
        return;
      }

      // Memoized, parent-first folder creation. The key is the relative dir path joined by "/"; ""
      // maps to the drop target itself so root-level loose files upload straight into it.
      const folderIdByPath = new Map<string, string>([["", target.id]]);
      const ensureFolder = async (dir: string[]): Promise<string> => {
        const key = dir.join("/");
        const existing = folderIdByPath.get(key);
        if (existing !== undefined) {
          return existing;
        }
        const parentId = await ensureFolder(dir.slice(0, -1));
        const id = await this.upload.createFolder(dir[dir.length - 1], parentId);
        foldersCreated += 1;
        folderIdByPath.set(key, id);
        return id;
      };

      // Recreate the directory tree first (shallow folders before deep ones) so even empty folders
      // appear. A folder we can't create is non-fatal here — the per-file loop records the files it
      // blocks via the same ensureFolder call.
      for (const dir of sortDirsByDepth(plan.dirs)) {
        try {
          await ensureFolder(dir);
        } catch (error) {
          console.warn("[Drive Attachments] Could not create a Drive folder for the dropped tree.", error);
        }
      }

      const total = plan.files.length;
      for (let index = 0; index < total; index += 1) {
        const { file, dir } = plan.files[index];
        const displayPath = dir.length > 0 ? `${dir.join("/")}/${file.name}` : file.name;
        this.setUploadPill(index + 1, total, target.name);
        progress.setMessage(formatTreeUploadProgress(index + 1, total, target.name, displayPath, foldersCreated, stats));

        try {
          const parentId = await ensureFolder(dir);
          await this.upload.uploadFile({
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            source: new FileUploadSource(file),
            parentFolderId: parentId,
            allowRootFallback: false,
          });
          stats.uploaded += 1;
        } catch (error) {
          stats.failed += 1;
          stats.failedNames.push(displayPath);
          console.warn("[Drive Attachments] Drive panel folder upload failed.", error);
        }

        progress.setMessage(formatTreeUploadProgress(index + 1, total, target.name, displayPath, foldersCreated, stats));
      }

      if (this.currentLocation.id === target.id) {
        await this.loadCurrentFolder(true);
      } else {
        this.folderCache.delete(target.id);
      }

      summary = formatTreeUploadSummary(target.name, foldersCreated, stats);
    } finally {
      progress.hide();
      this.panelDropInFlight = false;
      this.contentEl.removeClass("is-uploading");
      this.setDropHint(null);
      if (summary) {
        new Notice(summary, stats.failed > 0 ? 10_000 : 5_000);
      }
    }
  }

  // Panel drops are Drive-only (no note context), so Direct mode auto-reuses an existing Drive copy
  // instead of opening the editor-drop dedup modal.
  private async findPanelDropDuplicate(md5: string, fileName: string): Promise<DriveDedupHit | null> {
    try {
      return await this.dedup.findDuplicate({ md5, fileName });
    } catch (error) {
      console.warn("[Drive Attachments] Panel upload dedup check failed; proceeding with upload.", error);
      return null;
    }
  }

  private get currentLocation(): DrivePanelLocation {
    return this.path[this.path.length - 1];
  }

  private get currentBreadcrumb(): string {
    return this.path.map((location) => location.name).join(" / ");
  }

  private async loadCurrentFolder(force: boolean): Promise<void> {
    // Bump the generation up front so any in-flight load is invalidated the moment navigation
    // (back/breadcrumb/refresh) changes what we're showing — including when we return early via
    // the cache or scope guards below. Otherwise a slow load that errors after the user has
    // already navigated away would paint its error onto the now-current folder.
    const generation = ++this.loadGeneration;
    if (force) {
      // A refresh is the explicit retry path for thumbnails that previously failed (offline, stale
      // link, expired grant). Successful cached thumbnails remain and self-invalidate if their URL changes.
      this.thumbnailFailures.clear();
    }

    if (!this.canBrowse()) {
      this.loadingFolderId = null;
      this.errorMessage = null;
      this.clearSelection(false);
      this.render();
      return;
    }

    const folderId = this.currentLocation.id;
    if (!force && this.folderCache.has(folderId)) {
      this.loadingFolderId = null;
      this.errorMessage = null;
      this.pruneSelection(this.folderCache.get(folderId) ?? []);
      this.render();
      return;
    }

    this.loadingFolderId = folderId;
    this.errorMessage = null;
    this.render();

    try {
      const page = await this.listLocationItemsPage(folderId);
      if (generation !== this.loadGeneration) {
        return;
      }
      this.folderCache.set(folderId, sortFolderFirst(page.items));
      this.setNextPageToken(folderId, page.nextPageToken);
      this.pruneSelection(this.folderCache.get(folderId) ?? []);
      this.errorMessage = null;
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.loadGeneration) {
        this.loadingFolderId = null;
        this.render();
      }
    }
  }

  private setNextPageToken(folderId: string, token: string | undefined): void {
    if (token) {
      this.folderNextPageToken.set(folderId, token);
    } else {
      this.folderNextPageToken.delete(folderId);
    }
  }

  // "Load more" — fetch the current listing's next Drive page and append it. Guarded by the same
  // loadGeneration as loadCurrentFolder, so navigating away (or refreshing) while a page is in
  // flight discards the stale append instead of splicing it into another folder's list.
  private async loadMoreCurrentFolder(): Promise<void> {
    const folderId = this.currentLocation.id;
    const pageToken = this.folderNextPageToken.get(folderId);
    if (!pageToken || this.loadingMoreFolderId !== null) {
      return;
    }

    const generation = this.loadGeneration;
    this.loadingMoreFolderId = folderId;
    this.render();

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
        this.render();
      } else {
        this.loadingMoreFolderId = null;
      }
    }
  }

  private canBrowse(): boolean {
    const settings = this.getSettings();
    return settings.enableDriveSearch && this.auth.hasDriveSearchScope;
  }

  private async loadRoots(force: boolean): Promise<void> {
    const generation = ++this.rootGeneration;

    if (!this.canBrowse()) {
      this.sharedDriveRoots = [];
      this.rootsLoaded = false;
      this.rootsLoading = false;
      this.render();
      return;
    }

    if (!force && this.rootsLoaded) {
      return;
    }

    this.rootsLoading = true;
    this.render();

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
        this.render();
      }
    }
  }

  private render(): void {
    const { contentEl } = this;
    // render() rebuilds the whole panel on every selection change, which would otherwise drop the
    // list's keyboard focus and reset its scroll. Capture both first, then restore onto the fresh
    // list so arrow-key navigation survives re-renders and the view doesn't jump to the top.
    const prevList = this.listEl;
    const restoreFocus = !!prevList && document.activeElement === prevList;
    const prevScrollTop = prevList?.scrollTop ?? 0;
    const prevScrollFolderId = this.listFolderId;
    const previousSearchInput = contentEl.querySelector<HTMLInputElement>(".gdab-drive-panel-filter-input");
    const restoreSearchFocus = previousSearchInput !== null && document.activeElement === previousSearchInput;
    const searchSelectionStart = restoreSearchFocus ? previousSearchInput.selectionStart : null;
    const searchSelectionEnd = restoreSearchFocus ? previousSearchInput.selectionEnd : null;
    const scrollActive = this.scrollActiveIntoView;
    const focusDetailBar = this.focusDetailBarOnRender;
    this.scrollActiveIntoView = false;
    this.focusDetailBarOnRender = false;

    this.thumbnailObserver?.disconnect();
    contentEl.empty();
    contentEl.addClass("gdab-drive-panel");
    this.applyThemeClass();
    this.detailBarEl = null;

    this.renderHeader(contentEl);

    if (!this.canBrowse()) {
      this.listEl = null;
      this.activeRowEl = null;
      this.listFolderId = null;
      this.renderCallToAction(contentEl);
      return;
    }

    const searchInput = this.renderPanelToolbar(contentEl);
    const addressInput = this.renderBreadcrumbs(contentEl);
    this.renderPanelFilterChips(contentEl);
    this.renderBody(contentEl);

    const list = this.listEl;
    if (list) {
      if (this.listFolderId !== null && this.listFolderId === prevScrollFolderId) {
        list.scrollTop = prevScrollTop;
      }
      if (restoreFocus) {
        list.focus({ preventScroll: true });
      }
      if (scrollActive && this.activeRowEl) {
        this.activeRowEl.scrollIntoView({ block: "nearest" });
      }
    }
    if (focusDetailBar) {
      this.focusRenderedDetailBar();
    }
    if (addressInput) {
      addressInput.focus({ preventScroll: true });
      addressInput.select();
    } else if (restoreSearchFocus) {
      searchInput.focus({ preventScroll: true });
      if (searchSelectionStart !== null && searchSelectionEnd !== null) {
        searchInput.setSelectionRange(searchSelectionStart, searchSelectionEnd);
      }
    }
  }

  private focusRenderedDetailBar(): void {
    const bar = this.detailBarEl;
    if (!bar) {
      return;
    }
    bar.focus({ preventScroll: true });
    bar.scrollIntoView({ block: "nearest" });
  }

  private renderHeader(contentEl: HTMLElement): void {
    const header = contentEl.createDiv({ cls: "gdab-drive-panel-header" });
    header.createDiv({ cls: "gdab-drive-panel-title", text: "Google Drive" });

    const controls = header.createDiv({ cls: "gdab-drive-panel-controls" });
    const iconButton = (icon: string, label: string, disabled: boolean, onClick: () => void): void => {
      const button = controls.createEl("button", {
        cls: "clickable-icon gdab-drive-panel-icon-button",
        attr: { type: "button", "aria-label": label, title: label },
      });
      setIcon(button, icon);
      button.disabled = disabled;
      button.addEventListener("click", onClick);
    };

    // Browser-style Back/Forward through visited folders, plus a dedicated Up-to-parent button.
    // (Backspace and Cmd/Ctrl-↑ also go up a level.)
    iconButton("arrow-left", "Back", !this.canGoBack(), () => this.goBack());
    iconButton("arrow-right", "Forward", !this.canGoForward(), () => this.goForward());
    iconButton("arrow-up", "Up to parent folder", this.path.length <= 1, () => this.navigateUp());
    iconButton("refresh-cw", "Refresh", false, () => {
      void this.loadRoots(true);
      void this.loadCurrentFolder(true);
    });
  }

  private renderCallToAction(contentEl: HTMLElement): void {
    const settings = this.getSettings();
    const empty = contentEl.createDiv({ cls: "gdab-drive-panel-state" });

    if (!settings.enableDriveSearch) {
      empty.createDiv({ cls: "gdab-drive-panel-state-title", text: "Drive browsing is disabled." });
      empty.createDiv({
        cls: "gdab-drive-panel-state-detail",
        text: "Enable in-Obsidian Drive search to browse Drive from the sidebar.",
      });
      empty.createEl("button", { text: "Open settings" }).addEventListener("click", this.openSettings);
      return;
    }

    empty.createDiv({ cls: "gdab-drive-panel-state-title", text: "Connect Google Drive with read access." });
    empty.createDiv({
      cls: "gdab-drive-panel-state-detail",
      text: this.auth.isConnected
        ? "Reconnect to grant Drive read access for browsing."
        : "Connect Google Drive before browsing files and folders.",
    });
    empty.createEl("button", { text: this.auth.isConnected ? "Reconnect" : "Connect" }).addEventListener("click", () => {
      this.connect()
        .then(() => {
          void this.loadRoots(true);
          return this.loadCurrentFolder(true);
        })
        .catch((error) => {
          new Notice(`Google Drive connection failed: ${error instanceof Error ? error.message : String(error)}`);
          this.render();
        });
    });
  }

  private renderBreadcrumbs(contentEl: HTMLElement): HTMLInputElement | null {
    // A compact text trail (My Drive › folder1 › folder2 …) instead of a row of buttons — saves space.
    // Each segment also gets a small sibling menu: pick another folder at that path level and the
    // trail jumps there, dropping any now-invalid descendants. The same row becomes the editable
    // path field on demand; no second address-bar row or setting is needed.
    const breadcrumbs = contentEl.createDiv({
      cls:
        `gdab-drive-panel-breadcrumbs${this.path.length === 1 ? " is-root" : ""}` +
        `${this.addressBarEditing ? " is-editing" : ""}`,
    });
    if (this.addressBarEditing) {
      return this.renderAddressBar(breadcrumbs);
    }

    breadcrumbs.addEventListener("click", (evt) => {
      if (evt.target === breadcrumbs) {
        this.startAddressBarEdit();
      }
    });
    this.path.forEach((location, index) => {
      if (index > 0) {
        breadcrumbs.createSpan({ cls: "gdab-drive-panel-breadcrumb-sep", text: "›", attr: { "aria-hidden": "true" } });
      }

      const isCurrent = index === this.path.length - 1;
      const group = breadcrumbs.createSpan({ cls: "gdab-drive-panel-breadcrumb-group" });
      const segment = group.createSpan({
        text: location.name,
        cls: `gdab-drive-panel-breadcrumb${isCurrent ? " is-current" : ""}`,
        attr: { title: location.name },
      });
      if (index > 0 && !isVirtualRootId(location.id)) {
        segment.addEventListener("contextmenu", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          this.resetTypeAheadBuffer();
          void this.openBreadcrumbFolderMenu(evt, index);
        });
      }
      const menuButton = group.createEl("button", {
        cls: "clickable-icon gdab-drive-panel-breadcrumb-menu",
        attr: {
          "aria-label": `Show folders next to ${location.name}`,
          title: `Show folders next to ${location.name}`,
        },
      });
      setIcon(menuButton, "chevron-down");
      menuButton.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.resetTypeAheadBuffer();
        void this.openBreadcrumbSiblingMenu(index, menuButton);
      });

      if (isCurrent) {
        segment.setAttribute("aria-current", "true");
        return;
      }

      segment.setAttribute("role", "button");
      segment.setAttribute("tabindex", "0");
      const navigate = (): void => {
        this.exitDriveSearch();
        this.path.splice(index + 1);
        this.pushHistory();
        this.clearSelection(false);
        void this.loadCurrentFolder(false);
      };
      segment.addEventListener("click", navigate);
      segment.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          navigate();
        }
      });
    });

    const editSpace = breadcrumbs.createSpan({
      cls: "gdab-drive-panel-breadcrumb-edit-space",
      attr: { "aria-hidden": "true", title: "Edit Drive path" },
    });
    editSpace.addEventListener("click", () => this.startAddressBarEdit());

    const editButton = breadcrumbs.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-breadcrumb-edit",
      attr: { type: "button", "aria-label": "Edit Drive path", title: "Edit Drive path" },
    });
    setIcon(editButton, "pencil");
    editButton.disabled = this.addressBarBusy;
    editButton.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.startAddressBarEdit();
    });
    return null;
  }

  private async openBreadcrumbFolderMenu(evt: MouseEvent, index: number): Promise<void> {
    const location = this.path[index];
    const parent = this.path[index - 1];
    if (!location || !parent || index === 0 || isVirtualRootId(location.id)) {
      return;
    }

    const requestedPath = this.snapshotPath();
    try {
      const items = await this.getBreadcrumbFolderItems(parent.id);
      if (!samePathIds(this.path, requestedPath)) {
        return;
      }

      const folder = items.find(
        (item) => item.id === location.id && item.mimeType === DRIVE_FOLDER_MIME_TYPE,
      );
      if (!folder) {
        new Notice(`Could not load actions for Drive folder "${location.name}".`);
        return;
      }

      this.openPanelItemMenu(evt, folder);
    } catch (error) {
      if (!samePathIds(this.path, requestedPath)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not load actions for Drive folder "${location.name}": ${message}`);
    }
  }

  private async openBreadcrumbSiblingMenu(index: number, anchor: HTMLElement): Promise<void> {
    if (!this.canBrowse()) {
      return;
    }

    const position = menuPositionForElement(anchor);
    const requestedPath = this.snapshotPath();
    const menu = new Menu();

    try {
      if (index === 0) {
        // Root menu: grouped with separators like drive.google.com. Roots are local panel locations,
        // so (unlike the folder-level sibling menus below) this needs no fetch.
        this.addRootBreadcrumbMenuItems(menu);
      } else {
        const siblings = await this.getBreadcrumbSiblingLocations(index);
        if (!samePathIds(this.path, requestedPath)) {
          return;
        }

        if (siblings.length === 0) {
          menu.addItem((mi) => mi.setTitle("No sibling folders").setIcon("folder").setDisabled(true));
        } else {
          for (const sibling of siblings) {
            const isCurrentSegment = sibling.id === this.path[index]?.id;
            // No setChecked (see addRootBreadcrumbMenuItems): it would hide the "folder" icon. The
            // current sibling is shown disabled instead.
            menu.addItem((mi) =>
              mi
                .setTitle(sibling.name)
                .setIcon("folder")
                .setDisabled(isCurrentSegment)
                .onClick(() => this.navigateToBreadcrumbSibling(index, sibling)),
            );
          }
        }
      }
    } catch (error) {
      if (!samePathIds(this.path, requestedPath)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      menu.addItem((mi) => mi.setTitle("Could not load sibling folders").setIcon("alert-circle").setDisabled(true));
      new Notice(`Could not load sibling folders: ${message}`);
    }

    menu.showAtPosition(position, this.contentEl.ownerDocument);
  }

  // The root breadcrumb menu (the "My Drive ▾" segment), grouped with separators to mirror
  // drive.google.com's left nav: My Drive ─ shared drives ─ (Shared with me · Recent · Starred) ─ Trash.
  // An empty group (e.g. no shared drives) is skipped along with its divider, so no stray separators.
  private addRootBreadcrumbMenuItems(menu: Menu): void {
    const groups: DrivePanelLocation[][] = [
      [{ ...MY_DRIVE_ROOT }],
      this.sharedDriveRoots.map((root) => ({ id: root.id, name: root.name })),
      [{ ...SHARED_WITH_ME_ROOT }, { ...RECENT_ROOT }, { ...STARRED_ROOT }],
      [{ ...TRASH_ROOT }],
    ];
    let needSeparator = false;
    for (const group of groups) {
      if (group.length === 0) {
        continue;
      }
      if (needSeparator) {
        menu.addSeparator();
      }
      needSeparator = true;
      for (const root of group) {
        const isCurrentSegment = root.id === this.path[0]?.id;
        // The glyph is an emoji in the TITLE (setIcon renders nothing in this menu); the current root is
        // shown disabled (greyed + non-clickable) rather than checked.
        menu.addItem((mi) =>
          mi
            .setTitle(`${rootBreadcrumbGlyph(root.id)}  ${root.name}`)
            .setDisabled(isCurrentSegment)
            .onClick(() => this.navigateToBreadcrumbSibling(0, root)),
        );
      }
    }
    if (this.rootsLoading) {
      menu.addSeparator();
      menu.addItem((mi) => mi.setTitle("Shared drives loading...").setIcon("loader").setDisabled(true));
    }
  }

  private async getBreadcrumbSiblingLocations(index: number): Promise<DrivePanelLocation[]> {
    if (index === 0) {
      return [
        { ...MY_DRIVE_ROOT },
        { ...SHARED_WITH_ME_ROOT },
        { ...STARRED_ROOT },
        { ...RECENT_ROOT },
        { ...TRASH_ROOT },
        ...this.sharedDriveRoots.map((root) => ({ id: root.id, name: root.name })),
      ];
    }

    const parent = this.path[index - 1];
    if (!parent) {
      return [];
    }

    const items = await this.getBreadcrumbFolderItems(parent.id);
    return items
      .filter((item) => item.mimeType === DRIVE_FOLDER_MIME_TYPE)
      .map((item) => ({ id: item.id, name: item.name }));
  }

  private async getBreadcrumbFolderItems(folderId: string): Promise<DriveBrowserItem[]> {
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

  private navigateToBreadcrumbSibling(index: number, location: DrivePanelLocation): void {
    const currentSegment = this.path[index];
    if (!currentSegment || currentSegment.id === location.id) {
      return;
    }

    this.exitDriveSearch();
    this.resetTypeAheadBuffer();
    const previousRootId = this.path[0]?.id;
    const nextPath = this.path.slice(0, index).map((segment) => ({ ...segment }));
    nextPath.push({ ...location });
    this.path.splice(0, this.path.length, ...nextPath);
    this.pushHistory();
    if (index === 0 && previousRootId !== location.id) {
      this.folderCache.clear();
      this.folderNextPageToken.clear();
    }
    this.clearSelection(false);
    void this.loadCurrentFolder(false);
  }

  private startAddressBarEdit(): void {
    if (this.addressBarBusy || this.addressBarEditing) {
      return;
    }
    this.addressBarEditing = true;
    this.render();
  }

  private stopAddressBarEdit(): void {
    if (!this.addressBarEditing) {
      return;
    }
    this.addressBarEditing = false;
    this.render();
  }

  // Editable form of the breadcrumb row. Pre-filled with the current root-anchored path; Enter
  // resolves and jumps, while Escape or blur restores the clickable segments. Read-only with respect
  // to Drive: resolution walks folders with `listFolder` and never mutates anything.
  private renderAddressBar(breadcrumbs: HTMLElement): HTMLInputElement {
    const input = breadcrumbs.createEl("input", {
      cls: "gdab-drive-panel-address-input",
      attr: {
        type: "text",
        placeholder: "Go to a Drive path, e.g. My Drive/Projects",
        "aria-label": "Go to Drive path",
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
      },
    });
    input.value = this.currentPathString();
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        void this.submitAddressBar(input.value, input);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        this.stopAddressBarEdit();
      }
    });
    input.addEventListener("blur", () => {
      if (!this.addressBarEditing) {
        return;
      }
      // Let the pending click land before rebuilding the panel; removing its target synchronously on
      // blur would swallow toolbar/row clicks. A click that renders first sees this flag and restores
      // segments itself, so the deferred render is only needed while this input remains mounted.
      this.addressBarEditing = false;
      window.setTimeout(() => {
        if (input.isConnected) {
          this.render();
        }
      }, 0);
    });
    return input;
  }

  // The current path as a readable, root-anchored string (matches the breadcrumb trail), e.g.
  // "My Drive/Projects/2026". Used to pre-fill the address bar.
  private currentPathString(): string {
    return this.path.map((location) => location.name).join("/");
  }

  private async submitAddressBar(raw: string, input: HTMLInputElement): Promise<void> {
    if (this.addressBarBusy || !this.canBrowse()) {
      return;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      this.stopAddressBarEdit();
      return;
    }
    // URL/ID jump isn't wired yet (reconstructing breadcrumbs from an arbitrary id can land off a
    // recognized root and desync the root switcher) — guide the user to a path for now.
    if (/https?:\/\//i.test(trimmed) || trimmed.toLowerCase().includes("drive.google.com")) {
      new Notice("Type a Drive path like “My Drive/Projects”. Jumping by Drive URL isn't supported yet.");
      return;
    }

    const segments = trimmed
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      this.stopAddressBarEdit();
      return;
    }
    if (
      segments.length === this.path.length &&
      segments.every((segment, index) => segment.toLowerCase() === this.path[index]?.name.toLowerCase())
    ) {
      this.stopAddressBarEdit();
      return;
    }

    const root = this.matchRootByName(segments[0]);
    if (!root) {
      new Notice(`No Drive root named “${segments[0]}”. Start the path with My Drive or a shared drive name.`);
      return;
    }

    const requestedFromPath = this.snapshotPath();
    this.addressBarBusy = true;
    input.readOnly = true;
    input.setAttribute("aria-busy", "true");
    try {
      const resolved: DrivePanelLocation[] = [{ ...root }];
      let parentId = root.id;
      for (let depth = 1; depth < segments.length; depth += 1) {
        const items = await this.getBreadcrumbFolderItems(parentId);
        const match = pickFolderByName(items, segments[depth]);
        if (!match) {
          new Notice(`Folder not found: “${segments[depth]}”.`);
          return;
        }
        resolved.push({ id: match.id, name: match.name });
        parentId = match.id;
      }

      // The walk is async; bail if the user navigated elsewhere while it ran, or we're already there.
      if (!samePathIds(this.path, requestedFromPath) || samePathIds(this.path, resolved)) {
        if (samePathIds(this.path, resolved)) {
          this.stopAddressBarEdit();
        }
        return;
      }

      this.exitDriveSearch();
      this.resetTypeAheadBuffer();
      const previousRootId = this.path[0]?.id;
      this.path.splice(0, this.path.length, ...resolved);
      this.pushHistory();
      if (previousRootId !== resolved[0].id) {
        this.folderCache.clear();
        this.folderNextPageToken.clear();
      }
      this.clearSelection(false);
      this.addressBarEditing = false;
      void this.loadCurrentFolder(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not resolve that path: ${message}`);
    } finally {
      this.addressBarBusy = false;
      if (input.isConnected) {
        input.readOnly = false;
        input.removeAttribute("aria-busy");
      } else if (!this.addressBarEditing) {
        this.render();
      }
    }
  }

  // Match the first path segment against the panel's roots (My Drive + shared drives), exact then
  // case-insensitive, so "my drive/…" still resolves.
  private matchRootByName(name: string): DrivePanelLocation | null {
    const roots = this.folderPickerRoots();
    const exact = roots.find((root) => root.name === name);
    if (exact) {
      return exact;
    }
    const lower = name.toLowerCase();
    return roots.find((root) => root.name.toLowerCase() === lower) ?? null;
  }

  private renderBody(contentEl: HTMLElement): void {
    const folderId = this.currentLocation.id;
    const list = contentEl.createDiv({
      cls: `gdab-drive-panel-list is-view-${this.getSettings().panelViewMode}`,
      attr: { role: "listbox", "aria-multiselectable": "true", tabindex: "0" },
    });
    this.listEl = list;
    this.listFolderId = folderId;
    this.activeRowEl = null;
    list.addEventListener("click", (evt) => {
      if (evt.target === list) {
        this.clearSelection(true);
      }
    });
    list.addEventListener("contextmenu", (evt) => {
      const target = evt.target;
      if (target instanceof HTMLElement && target.closest(".gdab-drive-panel-row")) {
        return;
      }
      evt.preventDefault();
      evt.stopPropagation();
      this.openEmptySpaceMenu(evt);
    });
    list.addEventListener("keydown", (evt) => this.handleListKeydown(evt));

    if (this.isDriveSearchActive()) {
      const rawItems = this.getDriveSearchItems();
      if (this.searchLoading && rawItems.length === 0) {
        this.renderLoadingSkeleton(list, "Searching Drive...");
        return;
      }

      if (this.searchError && rawItems.length === 0) {
        const error = list.createDiv({
          cls: "gdab-drive-panel-state is-entering",
          attr: { role: "alert" },
        });
        error.createDiv({ cls: "gdab-drive-panel-state-title", text: "Could not search Google Drive." });
        error.createDiv({ cls: "gdab-drive-panel-state-detail", text: this.searchError });
        error.createEl("button", { text: "Retry" }).addEventListener("click", () => {
          this.queueDriveSearch(true);
        });
        return;
      }

      this.populateRows(list, rawItems, true);
      if (rawItems.length > 0) {
        this.renderDetailBar(contentEl, rawItems);
        this.renderSelectionBar(contentEl, rawItems);
      }
      this.renderDriveSearchStatus(list, rawItems);
      return;
    }

    if (this.loadingFolderId === folderId) {
      this.renderLoadingSkeleton(list);
      return;
    }

    if (this.errorMessage) {
      const error = list.createDiv({
        cls: "gdab-drive-panel-state is-entering",
        attr: { role: "alert" },
      });
      error.createDiv({
        cls: "gdab-drive-panel-state-title",
        text: this.isCurrentVirtualRoot() ? `Could not load ${this.currentVirtualRootName()}.` : "Could not load this Drive folder.",
      });
      error.createDiv({ cls: "gdab-drive-panel-state-detail", text: this.errorMessage });
      error.createEl("button", { text: "Retry" }).addEventListener("click", () => {
        void this.loadCurrentFolder(true);
      });
      return;
    }

    const rawItems = this.folderCache.get(folderId) ?? [];
    this.populateRows(list, rawItems, true);
    this.renderLoadMoreRow(list, folderId);
    if (rawItems.length > 0) {
      this.renderDetailBar(contentEl, rawItems);
      this.renderSelectionBar(contentEl, rawItems);
    }
  }

  // Drive serves listings 200 items per page; when a nextPageToken is pending for this location,
  // append a "Load more" row under the item rows so the tail of large folders stays reachable
  // (without it, item 201+ would silently not exist as far as the panel shows).
  private renderLoadMoreRow(list: HTMLElement, folderId: string): void {
    if (!this.folderNextPageToken.has(folderId)) {
      return;
    }
    const isLoading = this.loadingMoreFolderId === folderId;
    const row = list.createDiv({ cls: "gdab-drive-panel-load-more" });
    const button = row.createEl("button", {
      cls: "gdab-drive-panel-load-more-button",
      text: isLoading ? "Loading more..." : "Load more",
    });
    button.disabled = isLoading;
    button.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void this.loadMoreCurrentFolder();
    });
  }

  // Drive-style loading placeholder: shimmering skeleton rows that mirror the active view mode's row
  // shape (icon + name/meta lines, or grid cards) so real rows swap in with minimal layout shift. The
  // shimmer is purely decorative (aria-hidden); a visually-hidden status node announces the load to AT.
  private renderLoadingSkeleton(list: HTMLElement, label?: string): void {
    const mode = this.getSettings().panelViewMode;
    const count = mode === "grid" ? 12 : mode === "compact" ? 10 : 7;
    // Varied, deterministic name widths so the placeholder reads as a natural file list, not a barcode.
    const nameWidths = [82, 64, 73, 55, 88, 60, 70, 78, 58, 84, 67, 75];

    const wrap = list.createDiv({ cls: "gdab-drive-panel-skeleton-wrap" });
    const skeleton = wrap.createDiv({ cls: "gdab-drive-panel-skeleton", attr: { "aria-hidden": "true" } });
    for (let index = 0; index < count; index += 1) {
      const row = skeleton.createDiv({ cls: "gdab-drive-panel-skeleton-row" });
      row.createDiv({ cls: "gdab-drive-panel-skeleton-icon gdab-drive-panel-skeleton-block" });
      const lines = row.createDiv({ cls: "gdab-drive-panel-skeleton-lines" });
      const name = lines.createDiv({ cls: "gdab-drive-panel-skeleton-line is-name gdab-drive-panel-skeleton-block" });
      name.style.setProperty("--gdab-skeleton-w", `${nameWidths[index % nameWidths.length]}%`);
      lines.createDiv({ cls: "gdab-drive-panel-skeleton-line is-meta gdab-drive-panel-skeleton-block" });
    }

    wrap.createDiv({
      cls: "gdab-drive-panel-skeleton-label",
      attr: { role: "status", "aria-live": "polite" },
      text: label ?? (this.isCurrentVirtualRoot() ? `Loading ${this.currentVirtualRootName()}...` : "Loading Drive folder..."),
    });
  }

  private renderRow(list: HTMLElement, item: DriveBrowserItem): void {
    const isFolder = item.mimeType === DRIVE_FOLDER_MIME_TYPE;
    const isSelected = this.selectedItemIds.has(item.id);
    const isActive = this.activeItemId === item.id;
    const rowId = `gdab-drive-row-${item.id}`;
    const row = list.createDiv({
      cls: `gdab-drive-panel-row${isFolder ? " is-folder" : ""}${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`,
      attr: { id: rowId, role: "option", "aria-selected": isSelected ? "true" : "false", tabindex: "-1" },
    });
    if (isActive) {
      this.activeRowEl = row;
      list.setAttribute("aria-activedescendant", rowId);
    }
    row.addEventListener("click", (evt) => {
      this.handleRowClick(evt, item);
    });
    row.addEventListener("dblclick", (evt) => {
      this.handleRowDoubleClick(evt, item);
    });
    row.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.resetTypeAheadBuffer();
      if (!this.selectedItemIds.has(item.id)) {
        this.selectOnly(item.id, true);
      }
      this.openPanelItemMenu(evt, item);
    });

    // Every row is a Drive-internal drag SOURCE (drag onto a folder row to move; Cmd/Ctrl to copy files).
    // data-item-id lets the drag dim the right source rows without a re-render. Folder rows are ALSO drop
    // targets (handlers below); the self-drop guard stops a folder being dropped onto itself.
    row.dataset.itemId = item.id;
    row.draggable = true;
    row.addEventListener("dragstart", (evt) => this.handleRowDragStart(evt, item));
    row.addEventListener("dragend", () => this.handleRowDragEnd());

    if (isFolder) {
      // Drop ONTO a folder row → upload into that folder. These fire before the panel-wide handlers
      // (and stopPropagation), so the drop targets this row's folder, not the current path.
      row.addEventListener("dragover", (evt) => this.handleFolderRowDrag(evt, item, row));
      row.addEventListener("dragleave", (evt) => this.handleFolderRowDragLeave(evt, row));
      row.addEventListener("drop", (evt) => this.handleFolderRowDrop(evt, item, row));
    }

    const icon = row.createSpan({ cls: "gdab-drive-panel-row-icon", attr: { "aria-hidden": "true" } });
    // P5: color-code the row icon by file type (folder/image/video/audio/doc...) like the search
    // results + drive.google.com when enabled. A folder's own Drive color (set inline below),
    // custom icons, and thumbnails still win; the type class only tints currentColor icons.
    if (this.getSettings().panelTypeIconAccents) {
      icon.addClass("is-type-accented", getDriveResultTypeClass(item));
    }
    renderFileIcon(
      icon,
      item.mimeType,
      item.name,
      getDriveResultIcon(item),
      this.customIconSrc,
      this.getSettings().iconTheme,
    );
    if (isFolder) {
      // Tint the folder icon to match its Drive "Change color" choice (drive.google.com parity).
      // Setting it as a class lets the swatch submenu (next slice) toggle it live.
      const color = folderColorHex(item.folderColorRgb);
      if (color) {
        icon.style.color = color;
        icon.addClass("is-folder-colored");
      }
    } else if (item.thumbnailLink && this.getSettings().panelViewMode === "grid") {
      // Thumbnails are a GRID-view affordance only — list/compact keep the type icon (kdr: thumbnails
      // were leaking into list/compact). renderFileIcon already drew the icon above; only grid swaps it.
      this.renderPanelThumbnail(icon, item.id, item.thumbnailLink);
    }

    const main = row.createDiv({ cls: "gdab-drive-panel-row-main" });
    const title = main.createDiv({ cls: "gdab-drive-panel-row-title" });
    // Narrow-sidebar rows truncate long names (more so in grid); a native tooltip reveals the full
    // name on hover, like Finder/Explorer/Drive. `attr` sets the attribute safely (no innerHTML).
    const nameEl = title.createDiv({ cls: "gdab-drive-panel-row-name", attr: { title: item.name } });
    if (this.isDriveSearchActive()) {
      // While searching, highlight the matched query tokens in the result name — reuse the search
      // modal's DOM-span highlighter (colored gdab-search-hl-* spans, injection-safe, never innerHTML)
      // so the panel and the modal mark matches identically. Browse rows keep plain text.
      renderSearchHighlights(item.name, this.filterQuery, nameEl);
    } else {
      nameEl.setText(item.name);
    }
    if (item.starred) {
      const starredBadge = title.createSpan({
        cls: "gdab-drive-panel-row-badge is-starred",
        attr: { "aria-label": "Starred", title: "Starred" },
      });
      setIcon(starredBadge, "star");
    }
    this.renderSharingBadges(title, item);
    const meta = main.createDiv({ cls: "gdab-drive-panel-row-meta" });
    renderDriveResultHint(item, meta, false);
    const details = formatItemDetails(item);
    if (details) {
      meta.createSpan({ cls: "gdab-drive-panel-row-detail", text: details });
    }

    // One compact "⋮" overflow button instead of a row of icons — in a narrow sidebar the icons ate the
    // filename's width. The full action set lives in the menu (files and folders share it). The row
    // click still navigates into a folder.
    const actions = row.createDiv({ cls: "gdab-drive-panel-row-actions" });
    const moreButton = actions.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-row-action",
      attr: { "aria-label": "More actions" },
    });
    setIcon(moreButton, "more-vertical");
    moreButton.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openPanelItemMenu(evt, item);
    });
  }

  // Read-only drive.google.com-parity row badges for sharing/ownership. Both are derived from the
  // folder listing fields (no extra request): `shared` marks an item shared with others; an explicit
  // `ownedByMe === false` marks an item someone else owns (Drive's "Shared with me"), with the owner
  // surfaced in the tooltip. `ownedByMe` is absent on shared-drive items, so those show no owner badge.
  private renderSharingBadges(title: HTMLElement, item: DriveBrowserItem): void {
    if (item.ownedByMe === false) {
      const ownerLabel = panelPrimaryOwnerLabel(item);
      const tooltip = ownerLabel ? `Shared with you — owner: ${ownerLabel}` : "Shared with you";
      const ownerBadge = title.createSpan({
        cls: "gdab-drive-panel-row-badge is-shared-with-me",
        attr: { "aria-label": tooltip, title: tooltip },
      });
      setIcon(ownerBadge, "user");
    } else if (item.shared === true) {
      // Only show the generic "Shared" badge when the file is yours; otherwise the owner badge above
      // already conveys that it is shared, so we avoid stacking two near-identical icons.
      const sharedBadge = title.createSpan({
        cls: "gdab-drive-panel-row-badge is-shared",
        attr: { "aria-label": "Shared", title: "Shared with others" },
      });
      setIcon(sharedBadge, "users");
    }
  }

  private handleRowClick(evt: MouseEvent, item: DriveBrowserItem): void {
    evt.stopPropagation();
    if (evt.currentTarget instanceof HTMLElement) {
      evt.currentTarget.parentElement?.focus();
    }
    this.resetTypeAheadBuffer();

    if (evt.shiftKey) {
      this.selectRangeTo(item.id, true);
      return;
    }

    if (evt.metaKey || evt.ctrlKey) {
      this.toggleSelection(item.id, true);
      return;
    }

    const isFolder = item.mimeType === DRIVE_FOLDER_MIME_TYPE;
    if (isFolder && this.getSettings().panelOpenFolder === "single") {
      this.navigateToFolder(item);
      return;
    }

    const rowClick = this.getSettings().panelRowClick;
    if (rowClick === "select" || isFolder) {
      this.selectOnly(item.id, true);
      return;
    }

    this.selectOnly(item.id, false);
    if (rowClick === "open") {
      openDriveItemInBrowser(item);
      this.render();
      return;
    }

    openDriveItemPreview(item, this.rowActionContext());
    this.render();
  }

  private handleRowDoubleClick(evt: MouseEvent, item: DriveBrowserItem): void {
    evt.stopPropagation();

    if (item.mimeType === DRIVE_FOLDER_MIME_TYPE) {
      if (this.getSettings().panelOpenFolder === "double") {
        this.navigateToFolder(item);
      }
      return;
    }

    if (this.getSettings().panelRowClick === "select") {
      this.selectOnly(item.id, false);
      openDriveItemPreview(item, this.rowActionContext());
      this.render();
    }
  }

  private handleListKeydown(evt: KeyboardEvent): void {
    if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === "a") {
      evt.preventDefault();
      this.resetTypeAheadBuffer();
      this.selectAllCurrentItems(true);
      return;
    }

    if (evt.key === "Escape" && this.selectedItemIds.size > 0) {
      evt.preventDefault();
      this.clearSelection(true);
      return;
    }

    if ((evt.metaKey || evt.ctrlKey) && (evt.key === "[" || evt.key === "]")) {
      // Cmd/Ctrl-[ / -] navigate Back / Forward through folder history (Finder/browser convention;
      // mirrors the Back/Forward toolbar arrows and Cmd-↑ for Up).
      evt.preventDefault();
      if (evt.key === "[") {
        this.goBack();
      } else {
        this.goForward();
      }
      return;
    }

    switch (evt.key) {
      case "ArrowDown":
        evt.preventDefault();
        this.moveActiveCursor(this.verticalStep(), evt.shiftKey);
        return;
      case "ArrowUp":
        evt.preventDefault();
        if (evt.metaKey || evt.ctrlKey) {
          // Cmd/Ctrl-↑ goes up a level (Finder/Explorer), mirroring Backspace and the Back button.
          this.navigateUp();
          return;
        }
        this.moveActiveCursor(-this.verticalStep(), evt.shiftKey);
        return;
      case "ArrowRight":
        // Left/Right only navigate within the 2-D grid; in the single-column list/compact views the
        // horizontal arrows are left alone so they don't jump the cursor by a whole row.
        if (this.getSettings().panelViewMode !== "grid") {
          return;
        }
        evt.preventDefault();
        this.moveActiveCursor(1, evt.shiftKey);
        return;
      case "ArrowLeft":
        if (this.getSettings().panelViewMode !== "grid") {
          return;
        }
        evt.preventDefault();
        this.moveActiveCursor(-1, evt.shiftKey);
        return;
      case "Enter":
        evt.preventDefault();
        this.activateActiveItem();
        return;
      case "Delete":
        // Windows/Linux Delete (and mac fn-Delete) → send the selection to Drive's trash, matching
        // the row menu's "Move to trash" (or "Delete forever" when already inside the Trash view).
        evt.preventDefault();
        this.trashSelectionFromKeyboard();
        return;
      case "Backspace":
        evt.preventDefault();
        if (evt.metaKey || evt.ctrlKey) {
          // macOS Cmd-Delete (⌘⌫) is the platform "move to trash" gesture; Ctrl-Backspace mirrors it.
          this.trashSelectionFromKeyboard();
        } else {
          this.navigateUp();
        }
        return;
      default:
        if (this.handleTypeAheadKey(evt)) {
          return;
        }
        return;
    }
  }

  private handleTypeAheadKey(evt: KeyboardEvent): boolean {
    if (evt.metaKey || evt.ctrlKey || evt.altKey || evt.isComposing || evt.key.length !== 1) {
      return false;
    }
    if (this.typeAheadBuffer.length === 0 && evt.key.trim().length === 0) {
      return false;
    }

    const items = this.getCurrentItems();
    if (items.length === 0) {
      return false;
    }

    evt.preventDefault();

    const nextBuffer = `${this.typeAheadBuffer}${evt.key}`;
    let match = this.findTypeAheadMatch(items, nextBuffer);
    if (!match && this.typeAheadBuffer.length > 0) {
      match = this.findTypeAheadMatch(items, evt.key);
      this.typeAheadBuffer = match ? evt.key : nextBuffer;
    } else {
      this.typeAheadBuffer = nextBuffer;
    }

    this.scheduleTypeAheadReset();
    if (!match) {
      return true;
    }

    this.scrollActiveIntoView = true;
    this.selectOnly(match.id, true);
    return true;
  }

  private findTypeAheadMatch(items: DriveBrowserItem[], query: string): DriveBrowserItem | null {
    const normalizedQuery = normalizeTypeAhead(query);
    if (normalizedQuery.length === 0) {
      return null;
    }

    const activeIndex = this.activeItemId ? items.findIndex((item) => item.id === this.activeItemId) : -1;
    if (normalizedQuery.length > 1 && activeIndex >= 0 && normalizeTypeAhead(items[activeIndex].name).startsWith(normalizedQuery)) {
      return items[activeIndex];
    }

    const startIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
    for (let offset = 0; offset < items.length; offset += 1) {
      const item = items[(startIndex + offset) % items.length];
      if (normalizeTypeAhead(item.name).startsWith(normalizedQuery)) {
        return item;
      }
    }
    return null;
  }

  private scheduleTypeAheadReset(): void {
    if (this.typeAheadResetTimer !== null) {
      window.clearTimeout(this.typeAheadResetTimer);
    }
    this.typeAheadResetTimer = window.setTimeout(() => {
      this.typeAheadBuffer = "";
      this.typeAheadResetTimer = null;
    }, TYPE_AHEAD_RESET_MS);
  }

  private resetTypeAheadBuffer(): void {
    this.typeAheadBuffer = "";
    if (this.typeAheadResetTimer !== null) {
      window.clearTimeout(this.typeAheadResetTimer);
      this.typeAheadResetTimer = null;
    }
  }

  // Move the roving cursor by `delta` rows. Shift extends the selection from the anchor; otherwise the
  // cursor becomes the sole selection. Always flags the active row to be scrolled into view.
  private moveActiveCursor(delta: number, extend: boolean): void {
    const items = this.getCurrentItems();
    if (items.length === 0) {
      return;
    }
    this.resetTypeAheadBuffer();

    const currentIndex = this.activeItemId ? items.findIndex((item) => item.id === this.activeItemId) : -1;
    let nextIndex: number;
    if (currentIndex === -1) {
      nextIndex = delta > 0 ? 0 : items.length - 1;
    } else {
      nextIndex = Math.min(items.length - 1, Math.max(0, currentIndex + delta));
    }

    const target = items[nextIndex];
    this.scrollActiveIntoView = true;
    if (extend) {
      this.selectRangeTo(target.id, true);
    } else {
      this.selectOnly(target.id, true);
    }
  }

  // Vertical arrow step: one item in the single-column list/compact views, a full row (the live
  // column count) in the responsive grid so ↑/↓ move between rows and ←/→ move within a row.
  private verticalStep(): number {
    return this.getSettings().panelViewMode === "grid" ? this.gridColumnCount() : 1;
  }

  // Count the columns actually laid out in the grid by measuring how many rows share the first row's
  // top edge. The grid is `repeat(auto-fill, …)`, so the column count depends on the panel's current
  // width — read it from the DOM rather than assume a fixed number.
  private gridColumnCount(): number {
    const list = this.listEl;
    if (!list) {
      return 1;
    }
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".gdab-drive-panel-row"));
    if (rows.length <= 1) {
      return Math.max(1, rows.length);
    }
    const firstTop = rows[0].offsetTop;
    let columns = 0;
    for (const row of rows) {
      if (row.offsetTop !== firstTop) {
        break;
      }
      columns += 1;
    }
    return Math.max(1, columns);
  }

  // Keyboard delete: move the current selection to Drive's trash (or permanently delete when the
  // Trash view is open), reusing the same confirmation + scope guard as the row menu. The scope guard
  // (ensureCanModifyDrive) surfaces the right message when Full Drive access is off or not yet granted.
  private trashSelectionFromKeyboard(): void {
    const selected = this.getCurrentItems().filter((item) => this.selectedItemIds.has(item.id));
    if (selected.length === 0) {
      return;
    }
    if (this.isInTrashPath()) {
      this.confirmDeleteForever(selected);
    } else {
      this.confirmTrashItems(selected);
    }
  }

  private activateActiveItem(): void {
    this.resetTypeAheadBuffer();
    if (!this.activeItemId) {
      return;
    }
    const item = this.getCurrentItems().find((candidate) => candidate.id === this.activeItemId);
    if (!item) {
      return;
    }

    if (item.mimeType === DRIVE_FOLDER_MIME_TYPE) {
      this.navigateToFolder(item);
      return;
    }

    this.selectOnly(item.id, false);
    openDriveItemPreview(item, this.rowActionContext());
    this.render();
  }

  private navigateUp(): void {
    if (this.path.length <= 1) {
      return;
    }
    this.exitDriveSearch();
    this.resetTypeAheadBuffer();
    this.path.pop();
    this.pushHistory();
    this.clearSelection(false);
    void this.loadCurrentFolder(false);
  }

  private navigateToFolder(item: DriveBrowserItem): void {
    // A folder opened from Drive-wide search results may live anywhere in Drive, so it is NOT a child
    // of the current path. Trashed results remain flat/non-navigable, matching the panel's Trash root;
    // every other search scope skips the current-path Trash guard and opens a fresh location.
    const fromSearch = this.isDriveSearchActive();
    const fromTrashedSearch = fromSearch && this.searchLocation === "trashed";
    if (fromTrashedSearch || (!fromSearch && this.isInTrashPath())) {
      // Trashed folders list nothing here (listFolder filters `trashed = false`); their trashed
      // contents already appear flat in this Trash view. Keep trashed folders non-navigable so the
      // path never descends below the Trash root.
      new Notice("Trashed folders can't be opened. Their trashed contents are already listed in Trash; restore the folder to browse it.");
      return;
    }
    this.exitDriveSearch();
    this.resetTypeAheadBuffer();
    if (fromSearch) {
      // Open it as a fresh top-level location rather than appending a misleading deep trail onto the
      // unrelated folder we searched from. (Resolving the hit's TRUE ancestor breadcrumb from the
      // index's parents/paths lands with the Location-scope chip.)
      this.path.splice(0, this.path.length, { ...MY_DRIVE_ROOT }, { id: item.id, name: item.name });
    } else {
      this.path.push({ id: item.id, name: item.name });
    }
    this.pushHistory();
    this.clearSelection(false);
    void this.loadCurrentFolder(false);
  }

  // Seed history with the current path as the single entry (panel open / re-open).
  private resetHistory(): void {
    this.navHistory = [this.snapshotPath()];
    this.navHistoryIndex = 0;
  }

  // Record the current path as a new history entry, dropping any forward entries first. A no-op when
  // the destination already equals the current cursor entry, so Back/Forward never stall on a dupe.
  private pushHistory(): void {
    const snapshot = this.snapshotPath();
    const current = this.navHistory[this.navHistoryIndex];
    if (current && samePathIds(current, snapshot)) {
      return;
    }
    if (this.navHistoryIndex < this.navHistory.length - 1) {
      this.navHistory.splice(this.navHistoryIndex + 1);
    }
    this.navHistory.push(snapshot);
    this.navHistoryIndex = this.navHistory.length - 1;
  }

  private snapshotPath(): DrivePanelLocation[] {
    return this.path.map((location) => ({ ...location }));
  }

  private canGoBack(): boolean {
    return this.navHistoryIndex > 0;
  }

  private canGoForward(): boolean {
    return this.navHistoryIndex < this.navHistory.length - 1;
  }

  private goBack(): void {
    if (!this.canGoBack()) {
      return;
    }
    this.navHistoryIndex -= 1;
    this.restoreHistoryEntry();
  }

  private goForward(): void {
    if (!this.canGoForward()) {
      return;
    }
    this.navHistoryIndex += 1;
    this.restoreHistoryEntry();
  }

  // Replace the live path with the history entry at the cursor and reload — without recording (the
  // entry already exists). folderCache may have been cleared by a root switch, so this can refetch.
  private restoreHistoryEntry(): void {
    const entry = this.navHistory[this.navHistoryIndex];
    if (!entry) {
      return;
    }
    this.exitDriveSearch();
    this.resetTypeAheadBuffer();
    this.path.splice(0, this.path.length, ...entry.map((location) => ({ ...location })));
    this.clearSelection(false);
    void this.loadCurrentFolder(false);
  }

  private openPanelItemMenu(evt: MouseEvent, item: DriveBrowserItem): void {
    if (this.isInTrashPath()) {
      this.openTrashItemMenu(evt, item);
      return;
    }
    const isFolder = item.mimeType === DRIVE_FOLDER_MIME_TYPE;
    const context = this.rowActionContext();
    const targets = this.menuTargets(item);
    const downloadableTargets = targets.filter(isDownloadableDriveFile);
    const menu = new Menu();

    // Grouped to mirror drive.google.com's right-click menu order (Obsidian 1.5 has no public
    // submenu API, so Drive's "Share ▸"/"Organize ▸" submenus are flattened into separator-
    // delimited groups). Every Drive-write action is gated by canModifyDrive() at click time;
    // Rename targets only the clicked row, the rest target the whole selection when the clicked
    // row is part of a multi-selection (Finder-like).
    const allFiles = targets.every((target) => target.mimeType !== DRIVE_FOLDER_MIME_TYPE);
    const removeFromStarred = targets.every((target) => target.starred === true);

    // Open group — Drive's "Open" / "Open in new tab".
    if (isFolder) {
      menu.addItem((mi) =>
        mi.setTitle("Open folder").setIcon("folder-open").onClick(() => this.navigateToFolder(item)),
      );
    } else {
      menu.addItem((mi) =>
        mi.setTitle("Preview").setIcon("eye").onClick(() => openDriveItemPreview(item, context)),
      );
    }
    menu.addItem((mi) =>
      mi.setTitle("Open in Drive").setIcon("external-link").onClick(() => openDriveItemInBrowser(item)),
    );

    // Insert group — plugin-native (no Drive equivalent); kept prominent since inserting Drive
    // links into notes is this plugin's core workflow.
    menu.addSeparator();
    menu.addItem((mi) =>
      mi.setTitle("Insert link at cursor").setIcon("link").onClick(() => insertDriveItemLink(item, context)),
    );
    menu.addItem((mi) =>
      mi
        .setTitle("Insert as Drive-link note")
        .setIcon("file-plus")
        .onClick(() => void insertDriveItemAssetNote(item, context)),
    );
    menu.addItem((mi) =>
      mi
        .setTitle(isFolder ? "Embed folder card in note" : "Embed preview in note")
        .setIcon(isFolder ? "folder" : "image-plus")
        .onClick(() => embedDriveItemPreview(item, context)),
    );

    // File-actions group — Drive's Download / Rename / Make a copy.
    menu.addSeparator();
    menu.addItem((mi) =>
      mi
        .setTitle(downloadMenuTitle(targets, downloadableTargets.length))
        .setIcon("download")
        .setDisabled(downloadableTargets.length === 0)
        .onClick(() => void this.downloadItems(targets)),
    );
    if (targets.length === 1) {
      menu.addItem((mi) =>
        mi.setTitle("Rename").setIcon("pencil").onClick(() => this.openRenameModal(item)),
      );
    }
    if (allFiles) {
      menu.addItem((mi) =>
        mi
          .setTitle(copyMenuTitle(targets))
          .setIcon("copy-plus")
          .onClick(() => this.openCopyToModal(targets)),
      );
    }

    // Share group — Drive's "Share ▸" (Copy link, Share). "Manage access" opens the same browser-
    // side sharing surface as "Share in Drive", so it is folded in rather than duplicated.
    menu.addSeparator();
    menu.addItem((mi) =>
      mi.setTitle("Copy link").setIcon("copy").onClick(() => {
        void copyDriveItemLink(item);
      }),
    );
    menu.addItem((mi) =>
      mi.setTitle("Share in Drive").setIcon("share-2").onClick(() => openDriveItemSharePage(item)),
    );

    // Organize group — Drive's "Organize ▸" (Move, Add to Starred, Folder color).
    menu.addSeparator();
    if (!this.isCurrentVirtualRoot()) {
      menu.addItem((mi) =>
        mi
          .setTitle(moveMenuTitle(targets))
          .setIcon("folder-input")
          .onClick(() => this.openMoveToModal(targets)),
      );
    }
    menu.addItem((mi) =>
      mi
        .setTitle(starMenuTitle(targets, removeFromStarred))
        .setIcon(removeFromStarred ? "star-off" : "star")
        .onClick(() => void this.setItemsStarred(targets, !removeFromStarred)),
    );
    if (isFolder && targets.length === 1) {
      menu.addItem((mi) =>
        mi.setTitle("Change folder color...").setIcon("palette").onClick(() => this.openFolderColorPicker(item)),
      );
    }

    // File information group — reveal and focus the existing bottom details bar for this row. When
    // the persistent bar setting is off, this is a dismissible one-shot view rather than a settings
    // mutation.
    menu.addSeparator();
    menu.addItem((mi) =>
      mi.setTitle("Details").setIcon("info").onClick(() => this.showItemDetails(item)),
    );

    // Destructive — Drive's "Move to trash".
    menu.addSeparator();
    menu.addItem((mi) =>
      mi
        .setTitle(trashMenuTitle(targets))
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => this.confirmTrashItems(targets)),
    );

    menu.showAtMouseEvent(evt);
  }

  // Trash-specific row/"⋮" menu: read-only inspection plus Restore/Delete forever. Ordinary
  // mutations (Rename/Make a copy/Move/Star/Folder color/Move to trash) are intentionally suppressed.
  private openTrashItemMenu(evt: MouseEvent, item: DriveBrowserItem): void {
    const isFolder = item.mimeType === DRIVE_FOLDER_MIME_TYPE;
    const context = this.rowActionContext();
    const targets = this.menuTargets(item);
    const menu = new Menu();

    if (!isFolder) {
      menu.addItem((mi) =>
        mi.setTitle("Preview").setIcon("eye").onClick(() => openDriveItemPreview(item, context)),
      );
    }
    menu.addItem((mi) =>
      mi.setTitle("Open in Drive").setIcon("external-link").onClick(() => openDriveItemInBrowser(item)),
    );

    menu.addSeparator();
    menu.addItem((mi) =>
      mi.setTitle("Copy link").setIcon("copy").onClick(() => {
        void copyDriveItemLink(item);
      }),
    );
    menu.addItem((mi) =>
      mi.setTitle("Details").setIcon("info").onClick(() => this.showItemDetails(item)),
    );

    menu.addSeparator();
    menu.addItem((mi) =>
      mi
        .setTitle(restoreMenuTitle(targets))
        .setIcon("rotate-ccw")
        .onClick(() => void this.restoreItems(targets)),
    );
    menu.addItem((mi) =>
      mi
        .setTitle(deleteForeverMenuTitle(targets))
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => this.confirmDeleteForever(targets)),
    );

    menu.showAtMouseEvent(evt);
  }

  private openEmptySpaceMenu(evt: MouseEvent): void {
    const menu = new Menu();

    if (!this.isCurrentVirtualRoot()) {
      menu.addItem((mi) =>
        mi.setTitle("New folder...").setIcon("folder-plus").onClick(() => this.openNewFolderModal()),
      );
      menu.addItem((mi) =>
        mi.setTitle("Upload files...").setIcon("upload").onClick(() => this.openUploadFilesPicker()),
      );
      menu.addSeparator();
    }
    menu.addItem((mi) =>
      mi.setTitle("Refresh").setIcon("refresh-cw").onClick(() => {
        void this.loadRoots(true);
        void this.loadCurrentFolder(true);
      }),
    );

    menu.showAtMouseEvent(evt);
  }

  private showItemDetails(item: DriveBrowserItem): void {
    this.transientDetailBar = !this.getSettings().panelDetailBar;
    this.selectOnly(item.id, false);
    this.focusDetailBarOnRender = true;
    this.render();
  }

  private openNewFolderModal(): void {
    if (this.isCurrentVirtualRoot()) {
      new Notice(`Open a Drive folder before creating a folder. ${this.currentVirtualRootName()} is a collection.`);
      return;
    }
    if (!this.ensureCanModifyDrive()) {
      return;
    }

    new NewDriveFolderModal(this.app, this.currentBreadcrumb, (name) => {
      void this.createFolderInCurrentLocation(name);
    }).open();
  }

  private openUploadFilesPicker(): void {
    if (this.isCurrentVirtualRoot()) {
      new Notice(`Open a Drive folder before uploading files. ${this.currentVirtualRootName()} is a collection.`);
      return;
    }
    const target = { ...this.currentLocation };
    if (!this.canStartPanelManualUpload()) {
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      this.startManualFileUpload(files, target);
    });
    document.body.appendChild(input);
    input.click();
  }

  private canStartPanelManualUpload(): boolean {
    if (this.panelDropInFlight) {
      new Notice("Wait for the current Drive upload to finish before uploading more files.");
      return false;
    }

    if (!this.canBrowse()) {
      new Notice("Connect Google Drive with browsing access before uploading files from the Drive panel.");
      return false;
    }

    return true;
  }

  private startManualFileUpload(files: File[], target: DrivePanelLocation): void {
    if (files.length === 0) {
      return;
    }

    const uploadableFiles = files.filter((file) => file.name.trim().length > 0 && !isJunkFileName(file.name));
    const skippedJunk = files.length - uploadableFiles.length;
    if (uploadableFiles.length === 0) {
      new Notice(`Skipped ${formatCount(skippedJunk, "junk file")} from the Drive panel upload.`);
      return;
    }

    void this.uploadPanelDroppedFiles(uploadableFiles, target, skippedJunk);
  }

  private async createFolderInCurrentLocation(name: string): Promise<void> {
    if (!this.ensureCanModifyDrive()) {
      return;
    }

    const target = { ...this.currentLocation };
    try {
      const folderId = await this.upload.createFolder(name, target.id);
      this.folderCache.delete(target.id);
      this.selectedItemIds.clear();
      this.selectedItemIds.add(folderId);
      this.selectionAnchorId = folderId;
      await this.loadCurrentFolder(true);
      new Notice(`Created Drive folder: ${name}`);
    } catch (error) {
      new Notice(`Create Drive folder failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private canModifyDrive(): boolean {
    return this.auth.isConnected && this.getSettings().enableFullDriveAccess && this.auth.hasFullDriveScope;
  }

  private ensureCanModifyDrive(): boolean {
    if (this.canModifyDrive()) {
      return true;
    }

    if (!this.auth.isConnected) {
      new Notice("Connect Google Drive first to delete or modify files.", 8000);
      return false;
    }

    if (!this.getSettings().enableFullDriveAccess) {
      // Opt-in is off: the default drive.file scope can't touch files the plugin didn't upload.
      new Notice(
        "To delete or modify Drive files, turn on “Full Drive access” in the Drive Attachments " +
          "settings, then reconnect (Disconnect → Connect).",
        10_000,
      );
      return false;
    }

    // Opted in, but Google never actually granted the full-Drive scope — the user most likely hasn't
    // added it on their consent screen yet, or hasn't reconnected since. Point them at the exact fix.
    new Notice(
      "“Full Drive access” is on, but Google hasn't granted the full-Drive scope yet. Add the " +
        "https://www.googleapis.com/auth/drive scope in the Google Cloud console (Google Auth " +
        "Platform → Data Access), then Disconnect and Connect again in settings.",
      12_000,
    );
    return false;
  }

  // Which items a row action applies to: the whole selection when the clicked row is one of several
  // selected rows (so a right-click on a multi-selection acts on all of it), otherwise just that row.
  private menuTargets(item: DriveBrowserItem): DriveBrowserItem[] {
    if (this.selectedItemIds.has(item.id) && this.selectedItemIds.size > 1) {
      const selected = this.getCurrentItems().filter((it) => this.selectedItemIds.has(it.id));
      if (selected.length > 1) {
        return selected;
      }
    }
    return [item];
  }

  private openMoveToModal(items: DriveBrowserItem[]): void {
    if (items.length === 0) {
      return;
    }
    if (!this.ensureCanModifyDrive()) {
      return;
    }
    if (this.isCurrentVirtualRoot()) {
      new Notice(`Open the item's parent folder before moving it from ${this.currentVirtualRootName()}.`);
      return;
    }

    const source = { ...this.currentLocation };
    const excludedFolderIds = new Set(
      items.filter((item) => item.mimeType === DRIVE_FOLDER_MIME_TYPE).map((item) => item.id),
    );
    new PanelFolderPickerModal(this.app, {
      title: "Move to folder",
      detail: `Choose a destination for ${formatCount(items.length, "Drive item")}.`,
      actionLabel: "Move here",
      metadata: this.metadata,
      roots: this.folderPickerRoots(),
      initialPath: this.folderPickerInitialPath(),
      excludedFolderIds,
      excludedNotice: "Choose a folder outside the selected folders.",
      onChoose: (target) => {
        void this.moveItems(items, source, target);
      },
    }).open();
  }

  private openCopyToModal(items: DriveBrowserItem[]): void {
    const copyable = items.filter((item) => item.mimeType !== DRIVE_FOLDER_MIME_TYPE);
    if (copyable.length === 0) {
      new Notice("Google Drive folder copying is not supported from this panel yet.");
      return;
    }
    if (!this.ensureCanModifyDrive()) {
      return;
    }

    new PanelFolderPickerModal(this.app, {
      title: copyable.length === 1 ? "Make a copy" : "Make copies",
      detail: `Choose where to create ${formatCount(copyable.length, "file")} ${copyable.length === 1 ? "copy" : "copies"}.`,
      actionLabel: "Copy here",
      metadata: this.metadata,
      roots: this.folderPickerRoots(),
      initialPath: this.folderPickerInitialPath(),
      onChoose: (target) => {
        void this.copyItems(copyable, target);
      },
    }).open();
  }

  private folderPickerRoots(): DrivePanelLocation[] {
    return [
      { ...MY_DRIVE_ROOT },
      ...this.sharedDriveRoots.map((root) => ({ id: root.id, name: root.name })),
    ];
  }

  private folderPickerInitialPath(): DrivePanelLocation[] {
    if (this.isVirtualRootPath()) {
      return [{ ...MY_DRIVE_ROOT }];
    }
    return this.path.map((location) => ({ ...location }));
  }

  private openRenameModal(item: DriveBrowserItem): void {
    if (!this.ensureCanModifyDrive()) {
      return;
    }
    const isFolder = item.mimeType === DRIVE_FOLDER_MIME_TYPE;
    new RenameDriveItemModal(this.app, item.name, isFolder, (name) => {
      void this.renameItem(item, name);
    }).open();
  }

  private openFolderColorPicker(item: DriveBrowserItem): void {
    if (item.mimeType !== DRIVE_FOLDER_MIME_TYPE || !this.ensureCanModifyDrive()) {
      return;
    }

    new FolderColorPickerModal(this.app, this.metadata, item, (color) => {
      void this.setFolderColor(item, color);
    }).open();
  }

  private async setFolderColor(item: DriveBrowserItem, color: string | null): Promise<void> {
    if (!this.ensureCanModifyDrive() || !this.beginPanelWrite()) {
      return;
    }

    try {
      const appliedColor = await this.fileOps.setFolderColor(item.id, color);
      this.updateCachedFolderColor(item, appliedColor);
      this.render();
      new Notice(appliedColor ? `Changed the color of "${item.name}".` : `Reset the color of "${item.name}".`);
    } catch (error) {
      new Notice(`Change folder color failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.panelWriteInFlight = false;
    }
  }

  private updateCachedFolderColor(item: DriveBrowserItem, color: string | null): void {
    const normalized = folderColorHex(color ?? undefined) ?? undefined;
    item.folderColorRgb = normalized;
    for (const items of this.folderCache.values()) {
      const cached = items.find((candidate) => candidate.id === item.id);
      if (cached) {
        cached.folderColorRgb = normalized;
      }
    }
  }

  private async setItemsStarred(items: DriveBrowserItem[], starred: boolean): Promise<void> {
    if (items.length === 0 || !this.ensureCanModifyDrive() || !this.beginPanelWrite()) {
      return;
    }

    let updated = 0;
    const failedNames: string[] = [];
    const verb = starred ? "Adding" : "Removing";
    const destination = starred ? "to" : "from";
    const progress = new Notice(`${verb} 0/${items.length} ${destination} Starred...`, 0);

    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        progress.setMessage(`${verb} ${index + 1}/${items.length} ${destination} Starred: ${item.name}`);
        try {
          await this.fileOps.setStarred(item.id, starred);
          this.updateCachedStarred(item.id, starred);
          updated += 1;
        } catch (error) {
          failedNames.push(item.name);
          console.warn("[Drive Attachments] Drive panel starred update failed.", error);
        }
      }
      if (this.isCurrentVirtualRoot()) {
        await this.loadCurrentFolder(true);
      } else {
        this.render();
      }
    } finally {
      progress.hide();
      this.panelWriteInFlight = false;
    }

    new Notice(formatStarredSummary(updated, failedNames, starred), failedNames.length > 0 ? 10_000 : 5_000);
  }

  private updateCachedStarred(fileId: string, starred: boolean): void {
    for (const items of this.folderCache.values()) {
      const cached = items.find((candidate) => candidate.id === fileId);
      if (cached) {
        cached.starred = starred;
      }
    }
    // Starred is query-backed rather than a parent listing. Invalidate it after either transition;
    // when it is active, setItemsStarred() immediately refetches the authoritative result. (Recent
    // membership is unaffected by starring, so it needs no invalidation here.)
    this.folderCache.delete(STARRED_ROOT.id);
  }

  private async renameItem(item: DriveBrowserItem, name: string): Promise<void> {
    if (!this.ensureCanModifyDrive()) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed || trimmed === item.name) {
      return;
    }
    if (!this.beginPanelWrite()) {
      return;
    }

    try {
      await this.fileOps.renameFile(item.id, trimmed);
      this.forgetDetailMetadata([item.id]);
      new Notice(`Renamed to "${trimmed}".`);
      // Refetch the authoritative listing so the row's name (and the folder-first sort) update.
      await this.loadCurrentFolder(true);
    } catch (error) {
      new Notice(`Rename failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.panelWriteInFlight = false;
    }
  }

  private async moveItems(
    items: DriveBrowserItem[],
    source: DrivePanelLocation,
    target: DrivePanelLocation,
  ): Promise<void> {
    if (!this.ensureCanModifyDrive()) {
      return;
    }
    if (source.id === target.id) {
      new Notice("Choose a different folder to move Drive items.");
      return;
    }
    if (items.some((item) => item.id === target.id)) {
      new Notice("Choose a folder outside the selected folders.");
      return;
    }
    if (!this.beginPanelWrite()) {
      return;
    }

    let moved = 0;
    const failedNames: string[] = [];
    const progress = new Notice(`Moving 0/${items.length} to ${target.name}...`, 0);

    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        progress.setMessage(`Moving ${index + 1}/${items.length} to ${target.name}: ${item.name}`);
        try {
          await this.fileOps.moveFile(item.id, target.id, source.id);
          this.selectedItemIds.delete(item.id);
          moved += 1;
        } catch (error) {
          failedNames.push(item.name);
          console.warn("[Drive Attachments] Drive panel move failed.", error);
        }
      }

      this.folderCache.delete(source.id);
      this.folderCache.delete(target.id);
      if (this.currentLocation.id === source.id || this.currentLocation.id === target.id) {
        await this.loadCurrentFolder(true);
      } else {
        this.render();
      }
    } finally {
      progress.hide();
      this.panelWriteInFlight = false;
    }

    new Notice(formatMoveSummary(moved, failedNames, target.name), failedNames.length > 0 ? 10_000 : 5_000);
  }

  private async copyItems(items: DriveBrowserItem[], target: DrivePanelLocation): Promise<void> {
    if (!this.ensureCanModifyDrive()) {
      return;
    }
    if (!this.beginPanelWrite()) {
      return;
    }

    let copied = 0;
    const copiedIds: string[] = [];
    const failedNames: string[] = [];
    const progress = new Notice(`Copying 0/${items.length} to ${target.name}...`, 0);

    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        progress.setMessage(`Copying ${index + 1}/${items.length} to ${target.name}: ${item.name}`);
        try {
          const copy = await this.fileOps.copyFile(item.id, target.id);
          copiedIds.push(copy.id);
          copied += 1;
        } catch (error) {
          failedNames.push(item.name);
          console.warn("[Drive Attachments] Drive panel copy failed.", error);
        }
      }

      this.folderCache.delete(target.id);
      if (this.currentLocation.id === target.id) {
        this.selectedItemIds.clear();
        for (const copiedId of copiedIds) {
          this.selectedItemIds.add(copiedId);
        }
        this.selectionAnchorId = copiedIds[0] ?? null;
        await this.loadCurrentFolder(true);
      } else {
        this.render();
      }
    } finally {
      progress.hide();
      this.panelWriteInFlight = false;
    }

    new Notice(formatCopySummary(copied, failedNames, target.name), failedNames.length > 0 ? 10_000 : 5_000);
  }

  private async downloadItems(items: DriveBrowserItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    if (!this.canBrowse()) {
      new Notice("Connect Google Drive with read access before downloading files.");
      return;
    }

    const downloadable = items.filter(isDownloadableDriveFile);
    const skippedUnsupported = items.length - downloadable.length;
    if (downloadable.length === 0) {
      new Notice("Only regular Drive files can be downloaded here. Open folders or Google Docs files in Drive to export them.");
      return;
    }
    if (!this.beginPanelWrite()) {
      return;
    }

    const sourcePath = this.getActiveMarkdownEditor()?.file?.path ?? "";
    const failedNames: string[] = [];
    const savedPaths: string[] = [];
    const progress = new Notice(`Downloading 0/${downloadable.length} to the vault...`, 0);

    try {
      for (let index = 0; index < downloadable.length; index += 1) {
        const item = downloadable[index];
        progress.setMessage(`Downloading ${index + 1}/${downloadable.length}: ${item.name}`);
        try {
          const data = await this.fileOps.downloadFile(item.id);
          const filename = sanitizeDownloadedFileName(item.name);
          const path = await this.app.fileManager.getAvailablePathForAttachment(filename, sourcePath);
          const file = await this.app.vault.createBinary(path, data);
          savedPaths.push(file.path);
        } catch (error) {
          failedNames.push(item.name);
          console.warn("[Drive Attachments] Drive panel download failed.", error);
        }
      }
    } finally {
      progress.hide();
      this.panelWriteInFlight = false;
    }

    new Notice(
      formatDownloadSummary(savedPaths, failedNames, skippedUnsupported),
      failedNames.length > 0 ? 10_000 : 5_000,
    );
  }

  private confirmTrashItems(items: DriveBrowserItem[]): void {
    if (items.length === 0) {
      return;
    }
    if (!this.ensureCanModifyDrive()) {
      return;
    }
    new PanelDeleteConfirmModal(this.app, items, () => {
      void this.trashItems(items);
    }).open();
  }

  private async trashItems(items: DriveBrowserItem[]): Promise<void> {
    if (!this.ensureCanModifyDrive()) {
      return;
    }
    if (!this.beginPanelWrite()) {
      return;
    }

    let trashed = 0;
    const failedNames: string[] = [];
    const progress = new Notice(`Moving 0/${items.length} to Drive trash...`, 0);

    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        progress.setMessage(`Moving ${index + 1}/${items.length} to Drive trash: ${item.name}`);
        try {
          await this.fileOps.trashFile(item.id);
          this.selectedItemIds.delete(item.id);
          trashed += 1;
        } catch (error) {
          failedNames.push(item.name);
          console.warn("[Drive Attachments] Drive panel trash failed.", error);
        }
      }
      await this.loadCurrentFolder(true);
    } finally {
      progress.hide();
      this.panelWriteInFlight = false;
    }

    new Notice(formatTrashSummary(trashed, failedNames), failedNames.length > 0 ? 10_000 : 5_000);
  }

  // Claim the single panel-write slot; false (with a Notice) if another panel operation is mid-flight.
  private beginPanelWrite(): boolean {
    if (this.panelWriteInFlight) {
      new Notice("Wait for the current Drive operation to finish.");
      return false;
    }
    this.panelWriteInFlight = true;
    return true;
  }

  // P4 — read-only details bar at the bottom of the panel. Reflects the current selection using only
  // cached list metadata (no extra Drive calls). Bottom-bar is the first of three planned placements;
  // a side pane and a popover are noted as future options. Owner/sharing/thumbnail need extra fields
  // (a follow-up turn). Re-renders with every selection change because selection mutations call render().
  private renderDetailBar(contentEl: HTMLElement, items: DriveBrowserItem[]): void {
    const isTransient = !this.getSettings().panelDetailBar && this.transientDetailBar;
    if (!this.getSettings().panelDetailBar && !isTransient) {
      return;
    }
    const selected = items.filter((item) => this.selectedItemIds.has(item.id));
    if (selected.length === 0) {
      return;
    }

    const bar = contentEl.createDiv({
      cls: `gdab-drive-panel-detail-bar${isTransient ? " is-transient" : ""}`,
      attr: { role: "region", "aria-label": "Drive item details", tabindex: "-1" },
    });
    this.detailBarEl = bar;
    if (isTransient) {
      const closeButton = bar.createEl("button", {
        cls: "clickable-icon gdab-drive-panel-detail-close",
        attr: { "aria-label": "Close details" },
      });
      setIcon(closeButton, "x");
      closeButton.addEventListener("click", () => {
        this.transientDetailBar = false;
        this.render();
        this.listEl?.focus({ preventScroll: true });
      });
    }
    if (selected.length === 1) {
      this.renderSingleDetail(bar, selected[0]);
    } else {
      this.renderAggregateDetail(bar, selected);
    }
  }

  private renderSingleDetail(bar: HTMLElement, item: DriveBrowserItem): void {
    const record = this.detailMetadataCache.get(item.id);
    if (!record && !this.detailMetadataErrors.has(item.id)) {
      this.ensureSingleDetailMetadata(item.id);
    }

    const content = bar.createDiv({ cls: "gdab-drive-panel-detail-content" });
    if (record?.thumbnailUrl) {
      content.createEl("img", {
        cls: "gdab-drive-panel-detail-thumbnail",
        attr: {
          src: record.thumbnailUrl,
          alt: "",
          loading: "lazy",
        },
      });
    }

    const text = content.createDiv({ cls: "gdab-drive-panel-detail-text" });
    text.createDiv({ cls: "gdab-drive-panel-detail-name", text: item.name });

    const meta: string[] = [friendlyMimeType(item.mimeType)];
    if (item.size && item.mimeType !== DRIVE_FOLDER_MIME_TYPE) {
      meta.push(formatBytes(item.size));
    }
    if (item.modifiedTime) {
      meta.push(formatModifiedTime(item.modifiedTime));
    }
    text.createDiv({ cls: "gdab-drive-panel-detail-meta", text: meta.join(" · ") });

    const location = this.isDriveSearchActive()
      ? this.searchResultLocation(item)
      : this.currentBreadcrumb;
    if (location) {
      text.createDiv({ cls: "gdab-drive-panel-detail-location", text: `Location: ${location}` });
    }

    if (record) {
      this.renderSingleDetailMetadata(text, record.metadata);
    } else if (this.detailMetadataLoadingIds.has(item.id)) {
      text.createDiv({ cls: "gdab-drive-panel-detail-status", text: "Loading owner and thumbnail..." });
    } else {
      const error = this.detailMetadataErrors.get(item.id);
      if (error) {
        text.createDiv({ cls: "gdab-drive-panel-detail-status is-error", text: error });
      }
    }
  }

  private searchResultLocation(item: DriveBrowserItem): string {
    // The detail "Location" must show where the RESULT lives, not the folder the search started in.
    // Index hits carry a precomputed parent-folder path; server-only hits carry parent ids we resolve
    // against the folder index. Returns "" (the line is omitted) rather than show a misleading path.
    if (item.path) {
      return item.path;
    }
    const parentId = item.parents?.[0];
    if (parentId) {
      const parent = this.index.getItems().find((entry) => entry.id === parentId);
      if (parent) {
        return parent.path ? `${parent.path}/${parent.name}` : parent.name;
      }
    }
    return "";
  }

  private renderSingleDetailMetadata(text: HTMLElement, metadata: DriveMetadata): void {
    const owner = formatPanelOwner(metadata, this.getSettings().accountEmail);
    if (owner) {
      text.createDiv({ cls: "gdab-drive-panel-detail-extra", text: `Owner: ${owner}` });
    }
    if (typeof metadata.shared === "boolean") {
      text.createDiv({
        cls: "gdab-drive-panel-detail-extra",
        text: `Sharing: ${metadata.shared ? "Shared" : "Not shared"}`,
      });
    }
  }

  private ensureSingleDetailMetadata(fileId: string): void {
    if (
      this.detailMetadataCache.has(fileId) ||
      this.detailMetadataLoadingIds.has(fileId) ||
      this.detailMetadataErrors.has(fileId)
    ) {
      return;
    }

    this.detailMetadataLoadingIds.add(fileId);
    void this.loadSingleDetailMetadata(fileId);
  }

  private async loadSingleDetailMetadata(fileId: string): Promise<void> {
    try {
      const metadata = await this.metadata.getFileMetadata(fileId);
      let thumbnailUrl: string | null = null;
      if (metadata.thumbnailLink) {
        try {
          // Header-authenticated fetch → data URL (never puts the OAuth token in the DOM/URL).
          thumbnailUrl = await this.thumbnails.getDataUrl(fileId, metadata.thumbnailLink);
        } catch (error) {
          console.warn("[Drive Attachments] Drive panel thumbnail load failed.", error);
        }
      }
      this.detailMetadataCache.set(fileId, { metadata, thumbnailUrl });
    } catch (error) {
      this.detailMetadataErrors.set(fileId, formatDetailMetadataError(error));
    } finally {
      this.detailMetadataLoadingIds.delete(fileId);
      if (this.isOnlySelected(fileId)) {
        // Only the detail bar's contents changed — refresh it without rebuilding the row list (which
        // would re-decode the grid thumbnails and flicker). Falls back to a full render if list is gone.
        this.refreshSelectionOnly(false);
      }
    }
  }

  private isOnlySelected(fileId: string): boolean {
    return this.selectedItemIds.size === 1 && this.selectedItemIds.has(fileId);
  }

  private forgetDetailMetadata(fileIds: Iterable<string>): void {
    for (const fileId of fileIds) {
      this.detailMetadataCache.delete(fileId);
      this.detailMetadataErrors.delete(fileId);
      this.detailMetadataLoadingIds.delete(fileId);
    }
  }

  private renderAggregateDetail(bar: HTMLElement, selected: DriveBrowserItem[]): void {
    const folders = selected.filter((it) => it.mimeType === DRIVE_FOLDER_MIME_TYPE).length;
    const files = selected.length - folders;
    bar.createDiv({
      cls: "gdab-drive-panel-detail-name",
      text: `${formatCount(selected.length, "item")} selected`,
    });

    const parts: string[] = [];
    if (folders > 0) {
      parts.push(formatCount(folders, "folder"));
    }
    if (files > 0) {
      parts.push(formatCount(files, "file"));
    }

    let totalBytes = 0;
    let sizedFiles = 0;
    for (const item of selected) {
      if (item.mimeType === DRIVE_FOLDER_MIME_TYPE || !item.size) {
        continue;
      }
      const size = Number(item.size);
      if (Number.isFinite(size) && size >= 0) {
        totalBytes += size;
        sizedFiles += 1;
      }
    }
    if (sizedFiles > 0) {
      parts.push(`${formatBytes(String(totalBytes))} total`);
    }

    bar.createDiv({ cls: "gdab-drive-panel-detail-meta", text: parts.join(" · ") });
  }

  private renderSelectionBar(contentEl: HTMLElement, items: DriveBrowserItem[]): void {
    const selected = items.filter((item) => this.selectedItemIds.has(item.id));
    if (selected.length === 0) {
      return;
    }
    if (this.isInTrashPath()) {
      this.renderTrashSelectionBar(contentEl, selected);
      return;
    }
    const downloadable = selected.filter(isDownloadableDriveFile);

    const bar = contentEl.createDiv({ cls: "gdab-drive-panel-selection-bar" });
    bar.createSpan({ cls: "gdab-drive-panel-selection-count", text: `${selected.length} selected` });

    const copyButton = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-selection-action",
      attr: { "aria-label": "Copy selected Drive links" },
    });
    setIcon(copyButton, "copy");
    copyButton.addEventListener("click", () => {
      void this.copySelectedLinks(selected);
    });

    const downloadButton = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-selection-action",
      attr: { "aria-label": `Download ${formatCount(downloadable.length, "selected file")}` },
    });
    setIcon(downloadButton, "download");
    downloadButton.disabled = downloadable.length === 0;
    downloadButton.addEventListener("click", () => {
      void this.downloadItems(selected);
    });

    const deleteButton = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-selection-action is-danger",
      attr: { "aria-label": `Delete ${formatCount(selected.length, "selected item")}` },
    });
    setIcon(deleteButton, "trash-2");
    deleteButton.addEventListener("click", () => this.confirmTrashItems(selected));

    const clearButton = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-selection-action",
      attr: { "aria-label": "Clear selection" },
    });
    setIcon(clearButton, "x");
    clearButton.addEventListener("click", () => this.clearSelection(true));
  }

  // Trash selection bar: Copy links + Restore + Delete forever. Download and Move-to-trash do not
  // apply to already-trashed items.
  private renderTrashSelectionBar(contentEl: HTMLElement, selected: DriveBrowserItem[]): void {
    const bar = contentEl.createDiv({ cls: "gdab-drive-panel-selection-bar" });
    bar.createSpan({ cls: "gdab-drive-panel-selection-count", text: `${selected.length} selected` });

    const copyButton = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-selection-action",
      attr: { "aria-label": "Copy selected Drive links" },
    });
    setIcon(copyButton, "copy");
    copyButton.addEventListener("click", () => {
      void this.copySelectedLinks(selected);
    });

    const restoreButton = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-selection-action",
      attr: { "aria-label": `Restore ${formatCount(selected.length, "selected item")}` },
    });
    setIcon(restoreButton, "rotate-ccw");
    restoreButton.addEventListener("click", () => void this.restoreItems(selected));

    const deleteButton = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-selection-action is-danger",
      attr: { "aria-label": `Delete ${formatCount(selected.length, "selected item")} forever` },
    });
    setIcon(deleteButton, "trash-2");
    deleteButton.addEventListener("click", () => this.confirmDeleteForever(selected));

    const clearButton = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-selection-action",
      attr: { "aria-label": "Clear selection" },
    });
    setIcon(clearButton, "x");
    clearButton.addEventListener("click", () => this.clearSelection(true));
  }

  // Restore trashed items (PATCH `{trashed:false}`). Non-destructive, so no confirm modal (Drive
  // restores immediately too); gated by Full Drive access and serialized through the panel-write slot.
  // Restored items leave Trash and may re-enter Starred/Recent, so those collection caches are dropped.
  private async restoreItems(items: DriveBrowserItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    if (!this.ensureCanModifyDrive()) {
      return;
    }
    if (!this.beginPanelWrite()) {
      return;
    }

    let restored = 0;
    const failedNames: string[] = [];
    const progress = new Notice(`Restoring 0/${items.length} from Drive trash...`, 0);

    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        progress.setMessage(`Restoring ${index + 1}/${items.length} from Drive trash: ${item.name}`);
        try {
          await this.fileOps.restoreFile(item.id);
          this.selectedItemIds.delete(item.id);
          restored += 1;
        } catch (error) {
          failedNames.push(item.name);
          console.warn("[Drive Attachments] Drive panel restore failed.", error);
        }
      }
      this.folderCache.delete(STARRED_ROOT.id);
      this.folderCache.delete(RECENT_ROOT.id);
      await this.loadCurrentFolder(true);
    } finally {
      progress.hide();
      this.panelWriteInFlight = false;
    }

    new Notice(formatRestoreSummary(restored, failedNames), failedNames.length > 0 ? 10_000 : 5_000);
  }

  private confirmDeleteForever(items: DriveBrowserItem[]): void {
    if (items.length === 0 || !this.ensureCanModifyDrive()) {
      return;
    }
    new PanelPermanentDeleteConfirmModal(this.app, items, () => {
      void this.deleteForeverItems(items);
    }).open();
  }

  private async deleteForeverItems(items: DriveBrowserItem[]): Promise<void> {
    if (!this.ensureCanModifyDrive() || !this.beginPanelWrite()) {
      return;
    }

    let deleted = 0;
    const failedNames: string[] = [];
    const progress = new Notice(`Deleting 0/${items.length} forever from Drive...`, 0);

    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        progress.setMessage(`Deleting ${index + 1}/${items.length} forever from Drive: ${item.name}`);
        try {
          await this.fileOps.deleteForever(item.id);
          this.selectedItemIds.delete(item.id);
          deleted += 1;
        } catch (error) {
          failedNames.push(item.name);
          console.warn("[Drive Attachments] Drive panel permanent delete failed.", error);
        }
      }
      this.folderCache.delete(STARRED_ROOT.id);
      this.folderCache.delete(RECENT_ROOT.id);
      await this.loadCurrentFolder(true);
    } finally {
      progress.hide();
      this.panelWriteInFlight = false;
    }

    new Notice(formatPermanentDeleteSummary(deleted, failedNames), failedNames.length > 0 ? 10_000 : 5_000);
  }

  private async copySelectedLinks(selected: DriveBrowserItem[]): Promise<void> {
    const links = selected
      .map((item) => item.webViewLink)
      .filter((link): link is string => typeof link === "string" && link.trim().length > 0);

    if (links.length === 0) {
      new Notice("No selected Drive items have links to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(links.join("\n"));
      new Notice(`Copied ${formatCount(links.length, "Drive link")}.`);
    } catch (error) {
      new Notice(`Copy selected links failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private selectOnly(itemId: string, render: boolean): void {
    this.selectedItemIds.clear();
    this.selectedItemIds.add(itemId);
    this.selectionAnchorId = itemId;
    this.activeItemId = itemId;
    if (render) {
      this.refreshSelectionOnly(this.consumeScrollActive());
    }
  }

  private toggleSelection(itemId: string, render: boolean): void {
    if (this.selectedItemIds.has(itemId)) {
      this.selectedItemIds.delete(itemId);
    } else {
      this.selectedItemIds.add(itemId);
    }
    this.selectionAnchorId = itemId;
    this.activeItemId = itemId;
    if (render) {
      this.refreshSelectionOnly(this.consumeScrollActive());
    }
  }

  private selectRangeTo(itemId: string, render: boolean): void {
    const items = this.getCurrentItems();
    const targetIndex = items.findIndex((item) => item.id === itemId);
    if (targetIndex === -1) {
      return;
    }

    const anchorId = this.selectionAnchorId ?? itemId;
    const anchorIndex = items.findIndex((item) => item.id === anchorId);
    if (anchorIndex === -1) {
      this.selectOnly(itemId, render);
      return;
    }

    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    this.selectedItemIds.clear();
    for (const item of items.slice(start, end + 1)) {
      this.selectedItemIds.add(item.id);
    }
    this.activeItemId = itemId;
    if (render) {
      this.refreshSelectionOnly(this.consumeScrollActive());
    }
  }

  private selectAllCurrentItems(render: boolean): void {
    const items = this.getCurrentItems();
    this.selectedItemIds.clear();
    for (const item of items) {
      this.selectedItemIds.add(item.id);
    }
    if (items.length > 0) {
      this.selectionAnchorId = items[0].id;
      this.activeItemId = items[0].id;
    }
    if (render) {
      this.refreshSelectionOnly(this.consumeScrollActive());
    }
  }

  private clearSelection(render: boolean): void {
    const hasTypeAhead = this.typeAheadBuffer.length > 0 || this.typeAheadResetTimer !== null;
    if (
      this.selectedItemIds.size === 0 &&
      this.selectionAnchorId === null &&
      this.activeItemId === null &&
      !hasTypeAhead &&
      !this.transientDetailBar
    ) {
      return;
    }
    this.selectedItemIds.clear();
    this.selectionAnchorId = null;
    this.activeItemId = null;
    this.transientDetailBar = false;
    this.resetTypeAheadBuffer();
    if (render) {
      this.render();
    }
  }

  private pruneSelection(items: DriveBrowserItem[]): void {
    const visibleIds = new Set(items.map((item) => item.id));
    for (const selectedId of this.selectedItemIds) {
      if (!visibleIds.has(selectedId)) {
        this.selectedItemIds.delete(selectedId);
      }
    }
    if (this.selectionAnchorId !== null && !visibleIds.has(this.selectionAnchorId)) {
      this.selectionAnchorId = null;
    }
    if (this.activeItemId !== null && !visibleIds.has(this.activeItemId)) {
      this.activeItemId = null;
    }
  }

  private getCurrentItems(): DriveBrowserItem[] {
    return this.displayItems(this.getCurrentRawItems());
  }

  private getCurrentRawItems(): DriveBrowserItem[] {
    return this.isDriveSearchActive()
      ? this.getDriveSearchItems()
      : (this.folderCache.get(this.currentLocation.id) ?? []);
  }

  // Apply the Drive-style chips then sort the active folder/search result set. The name query is
  // already evaluated by the index + server engines before search results reach this method.
  // Single source of truth: render, keyboard nav, select-all, and menu targets all read getCurrentItems().
  private displayItems(raw: DriveBrowserItem[]): DriveBrowserItem[] {
    let filtered = raw;
    if (this.typeFilter) {
      const category = this.typeFilter;
      filtered = filtered.filter((it) => matchesTypeCategory(it.mimeType, category));
    }
    if (this.peopleFilter) {
      const ownerKey = this.peopleFilter.key;
      filtered = filtered.filter((it) => itemHasOwner(it, ownerKey));
    }
    if (this.modifiedFilter) {
      const range = this.modifiedFilter;
      const cutoff = modifiedRangeCutoff(range, Date.now());
      filtered = filtered.filter((it) => itemModifiedSince(it, cutoff));
    }
    const s = this.getSettings();
    return sortDriveItems(filtered, s.panelSortKey, s.panelSortDir, s.panelFoldersFirst);
  }

  // Render the current folder's rows into `list`, applying the live filter + sort. Distinguishes a
  // genuinely empty folder from one filtered down to nothing.
  private populateRows(list: HTMLElement, rawItems: DriveBrowserItem[], animateEmptyState: boolean): void {
    this.activeRowEl = null;
    const items = this.displayItems(rawItems);
    if (items.length === 0) {
      const q = this.filterQuery.trim();
      let msg: string;
      if (this.isDriveSearchActive() && rawItems.length === 0) {
        msg = `No Drive items match "${q}".`;
      } else if (rawItems.length === 0) {
        msg = this.isCurrentVirtualRoot()
          ? this.virtualRootEmptyMessage(this.currentLocation.id)
          : "This Drive folder is empty.";
      } else if (this.typeFilter && !this.peopleFilter && !this.modifiedFilter && !q) {
        msg = `No loaded items are ${panelTypeLabel(this.typeFilter).toLowerCase()}.`;
      } else if (this.peopleFilter && !this.typeFilter && !this.modifiedFilter && !q) {
        msg = `No loaded items are owned by ${this.peopleFilter.label}.`;
      } else if (this.modifiedFilter && !this.typeFilter && !this.peopleFilter && !q) {
        msg = `No loaded items were modified ${panelModifiedPhrase(this.modifiedFilter)}.`;
      } else {
        msg = "No items match the current filters.";
      }
      list.createDiv({
        cls: `gdab-drive-panel-state${animateEmptyState ? " is-entering" : ""}`,
        attr: { role: "status" },
        text: msg,
      });
      return;
    }
    for (const item of items) {
      this.renderRow(list, item);
    }
  }

  // Re-render only the row list (not the toolbar) while typing/searching so the input keeps its focus
  // and caret. Falls back to a full render if the list element isn't mounted.
  private refreshListOnly(): void {
    const list = this.listEl;
    if (!list) {
      this.render();
      return;
    }
    this.thumbnailObserver?.disconnect();
    list.empty();
    list.removeAttribute("aria-activedescendant");
    this.detailBarEl?.remove();
    this.detailBarEl = null;
    this.contentEl.querySelectorAll(".gdab-drive-panel-selection-bar").forEach((element) => element.remove());

    if (this.isDriveSearchActive()) {
      const rawItems = this.getDriveSearchItems();
      if (this.searchLoading && rawItems.length === 0) {
        this.renderLoadingSkeleton(list, "Searching Drive...");
        return;
      }
      if (this.searchError && rawItems.length === 0) {
        const error = list.createDiv({ cls: "gdab-drive-panel-state", attr: { role: "alert" } });
        error.createDiv({ cls: "gdab-drive-panel-state-title", text: "Could not search Google Drive." });
        error.createDiv({ cls: "gdab-drive-panel-state-detail", text: this.searchError });
        error.createEl("button", { text: "Retry" }).addEventListener("click", () => this.queueDriveSearch(true));
        return;
      }
      this.populateRows(list, rawItems, false);
      this.renderDetailBar(this.contentEl, rawItems);
      this.renderSelectionBar(this.contentEl, rawItems);
      this.renderDriveSearchStatus(list, rawItems);
      return;
    }

    this.populateRows(list, this.folderCache.get(this.currentLocation.id) ?? [], false);
  }

  // A selection/cursor move changes WHICH rows are selected/active, not which rows exist. A full
  // render() (or refreshListOnly()) would empty and rebuild the list, recreating every row's icon —
  // including cached thumbnail <img>s, which then re-decode and fade in again, so the grid flickers on
  // every arrow keypress. Instead, toggle the state classes on the existing rows in place and rebuild
  // only the bottom bars (which mirror the selection and carry no thumbnails). Falls back to a full
  // render when the list isn't mounted yet.
  private refreshSelectionOnly(scrollActive: boolean): void {
    const list = this.listEl;
    if (!list) {
      this.render();
      return;
    }

    let activeRow: HTMLElement | null = null;
    list.removeAttribute("aria-activedescendant");
    for (const row of Array.from(list.querySelectorAll<HTMLElement>(".gdab-drive-panel-row"))) {
      const id = row.dataset.itemId;
      if (!id) {
        continue;
      }
      const isSelected = this.selectedItemIds.has(id);
      const isActive = this.activeItemId === id;
      row.toggleClass("is-selected", isSelected);
      row.toggleClass("is-active", isActive);
      row.setAttribute("aria-selected", isSelected ? "true" : "false");
      if (isActive) {
        activeRow = row;
        list.setAttribute("aria-activedescendant", row.id);
      }
    }
    this.activeRowEl = activeRow;

    // Rebuild the detail + selection bars from the live item set so their counts/contents track the
    // new selection. They live outside the list and hold no thumbnails, so this is flicker-free.
    const rawItems = this.getCurrentRawItems();
    this.detailBarEl?.remove();
    this.detailBarEl = null;
    this.contentEl.querySelectorAll(".gdab-drive-panel-selection-bar").forEach((element) => element.remove());
    this.renderDetailBar(this.contentEl, rawItems);
    this.renderSelectionBar(this.contentEl, rawItems);

    if (scrollActive && activeRow) {
      activeRow.scrollIntoView({ block: "nearest" });
    }
  }

  // Read and clear the "scroll the active row into view on the next paint" flag, so a selection-only
  // refresh honors it exactly like render() does.
  private consumeScrollActive(): boolean {
    const scroll = this.scrollActiveIntoView;
    this.scrollActiveIntoView = false;
    return scroll;
  }

  private isDriveSearchActive(): boolean {
    return this.filterQuery.trim().length > 0;
  }

  private getDriveSearchItems(): DriveBrowserItem[] {
    return this.locationScopedDriveSearchItems().slice(0, DRIVE_PANEL_SEARCH_RESULT_LIMIT);
  }

  private mergeDriveSearchItems(): DriveBrowserItem[] {
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

  private locationScopedDriveSearchItems(): DriveBrowserItem[] {
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

  private hasMoreDriveSearchItems(): boolean {
    return this.searchHasMore || this.locationScopedDriveSearchItems().length > DRIVE_PANEL_SEARCH_RESULT_LIMIT;
  }

  private getSearchMetadataFilterStatus(items: DriveBrowserItem[]): string | null {
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

  // The Drive-search results footer: searching/error states, the "more matches exist" pagination hint,
  // and the metadata-filter disclosure. Shared by both render paths — the full `render()` (chip toggles
  // route here via `setPeopleFilter`/`setModifiedFilter`) and the in-place `refreshListOnly()` (typing,
  // results arriving) — so the People/Modified "hidden indexed matches" warning shows in every path, not
  // only when results stream in. `rawItems` is the location-scoped, pre-`displayItems` merged result set.
  private renderDriveSearchStatus(list: HTMLElement, rawItems: DriveBrowserItem[]): void {
    const hasMore = this.hasMoreDriveSearchItems();
    const metadataFilterStatus = this.getSearchMetadataFilterStatus(rawItems);
    if (!(this.searchLoading || hasMore || metadataFilterStatus || this.searchError)) {
      return;
    }
    list.createDiv({
      cls: `gdab-drive-panel-search-status${this.searchError ? " is-error" : ""}`,
      attr: { role: this.searchError ? "alert" : "status" },
      text: this.searchError
        ? this.searchError
        : this.searchLoading
          ? "Searching Drive..."
          : metadataFilterStatus
            ? `${metadataFilterStatus}${
                hasMore ? " More matches also exist in Drive; refine the search to narrow them." : ""
              }`
            : "More matches exist in Drive. Refine the search to narrow them.",
    });
  }

  private queueDriveSearch(immediate = false, refreshChrome = false): void {
    const generation = ++this.searchGeneration;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }

    const query = this.filterQuery.trim();
    let searchModeChanged = false;
    if (query && this.searchOriginPath === null) {
      this.searchOriginPath = this.path.map((location) => ({ ...location }));
      this.searchLocation = defaultPanelSearchLocation(this.currentLocation.id);
      searchModeChanged = true;
    } else if (!query && this.searchOriginPath !== null) {
      this.searchOriginPath = null;
      this.searchLocation = "current-folder";
      searchModeChanged = true;
    }
    this.searchServerItems = [];
    this.searchHasMore = false;
    this.searchError = null;
    this.clearSelection(false);
    if (!query) {
      this.searchIndexItems = [];
      this.searchLoading = false;
      if (searchModeChanged || refreshChrome) {
        this.render();
      } else {
        this.refreshListOnly();
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
      this.render();
    } else {
      this.refreshListOnly();
    }
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.runDriveSearch(query, generation);
    }, immediate ? 0 : DRIVE_PANEL_SEARCH_DEBOUNCE_MS);
  }

  private async runDriveSearch(query: string, generation: number): Promise<void> {
    const requests: Promise<void>[] = [];
    if (this.searchLocationUsesIndex()) {
      requests.push(this.ensurePanelIndex().then((items) => {
        if (generation === this.searchGeneration) {
          this.searchIndexItems = this.matchDriveIndexItems(items, query);
          this.refreshListOnly();
        }
      }));
    }
    requests.push(this.search.searchByName(query, panelSearchServerLocation(this.searchLocation)).then((response) => {
      if (generation === this.searchGeneration) {
        this.searchServerItems = response.results;
        this.searchHasMore = response.hasMore;
        this.refreshListOnly();
      }
    }));

    const settled = await Promise.allSettled(requests);
    if (generation !== this.searchGeneration) {
      return;
    }

    this.searchLoading = false;
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length === settled.length) {
      const reason = failures[0]?.reason;
      this.searchError = reason instanceof Error ? reason.message : String(reason ?? "Drive search failed.");
    }
    this.refreshListOnly();
  }

  private searchLocationUsesIndex(): boolean {
    return this.searchLocation === "anywhere" || this.searchLocation === "current-folder";
  }

  private matchDriveIndexItems(items: DriveIndexItem[], query: string): DriveIndexItem[] {
    const fuzzySearch = prepareFuzzySearch(query.normalize("NFC"));
    return items.filter((item) => fuzzySearch(item.name.normalize("NFC")) !== null);
  }

  private ensurePanelIndex(): Promise<DriveIndexItem[]> {
    if (!this.panelIndexPromise) {
      this.panelIndexPromise = this.index.ensureLoaded().catch((error: unknown) => {
        this.panelIndexPromise = null;
        throw error;
      });
    }
    return this.panelIndexPromise;
  }

  private cancelDriveSearch(): void {
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
  private exitDriveSearch(): boolean {
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

  // Drive thumbnail URLs require OAuth and therefore cannot be assigned directly to <img>. Keep the
  // type icon visible as the stable fallback, observe only rows near the viewport, then swap in the
  // authenticated data URL when its bytes arrive.
  private renderPanelThumbnail(icon: HTMLElement, fileId: string, sourceUrl: string): void {
    icon.addClass("has-thumbnail-source");
    icon.dataset.thumbnailId = fileId;
    this.thumbnailTargets.set(icon, { fileId, sourceUrl });

    const cached = this.thumbnails.getCached(fileId, sourceUrl);
    if (cached) {
      this.showPanelThumbnail(icon, cached);
      return;
    }
    if (this.thumbnailFailures.has(fileId)) {
      return;
    }

    this.getThumbnailObserver().observe(icon);
  }

  private getThumbnailObserver(): IntersectionObserver {
    if (this.thumbnailObserver) {
      return this.thumbnailObserver;
    }
    this.thumbnailObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          this.thumbnailObserver?.unobserve(entry.target);
          const target = this.thumbnailTargets.get(entry.target);
          if (target) {
            void this.loadPanelThumbnail(target.fileId, target.sourceUrl);
          }
        }
      },
      { root: this.contentEl, rootMargin: "96px" },
    );
    return this.thumbnailObserver;
  }

  private async loadPanelThumbnail(fileId: string, sourceUrl: string): Promise<void> {
    const generation = this.thumbnailGeneration;
    try {
      const dataUrl = await this.thumbnails.getDataUrl(fileId, sourceUrl);
      if (generation !== this.thumbnailGeneration) {
        return;
      }
      this.contentEl.querySelectorAll<HTMLElement>(".gdab-drive-panel-row-icon").forEach((element) => {
        const target = this.thumbnailTargets.get(element);
        if (target?.fileId === fileId && target.sourceUrl === sourceUrl) {
          this.showPanelThumbnail(element, dataUrl);
        }
      });
    } catch (error) {
      this.thumbnailFailures.add(fileId);
      console.warn("[Drive Attachments] Drive panel thumbnail failed; keeping the type icon.", error);
    }
  }

  private showPanelThumbnail(icon: HTMLElement, dataUrl: string): void {
    if (icon.querySelector(".gdab-drive-panel-row-thumbnail")) {
      return;
    }
    const image = icon.createEl("img", {
      cls: "gdab-drive-panel-row-thumbnail",
      attr: { alt: "", draggable: "false" },
    });
    image.addEventListener("load", () => icon.addClass("is-thumbnail-ready"), { once: true });
    image.addEventListener("error", () => {
      image.remove();
      icon.removeClass("is-thumbnail-ready");
      const target = this.thumbnailTargets.get(icon);
      if (target) {
        this.thumbnails.invalidate(target.fileId);
        this.thumbnailFailures.add(target.fileId);
      }
    }, { once: true });
    image.src = dataUrl;
  }

  // Drive-wide search and view controls. render() mounts this above the breadcrumbs, matching Drive.
  private renderPanelToolbar(contentEl: HTMLElement): HTMLInputElement {
    const bar = contentEl.createDiv({ cls: "gdab-drive-panel-toolbar" });

    const filterWrap = bar.createDiv({ cls: "gdab-drive-panel-filter" });
    setIcon(
      filterWrap.createSpan({ cls: "gdab-drive-panel-filter-icon", attr: { "aria-hidden": "true" } }),
      "search",
    );
    const input = filterWrap.createEl("input", {
      cls: "gdab-drive-panel-filter-input",
      attr: {
        type: "text",
        placeholder: "Search Drive",
        "aria-label": "Search Google Drive",
      },
    });
    input.value = this.filterQuery;
    const clearBtn = filterWrap.createEl("button", {
      cls: "gdab-drive-panel-filter-clear",
      attr: { type: "button", "aria-label": "Clear search", title: "Clear search" },
    });
    setIcon(clearBtn, "x");
    clearBtn.toggleClass("is-hidden", this.filterQuery.length === 0);
    input.addEventListener("input", () => {
      this.filterQuery = input.value;
      clearBtn.toggleClass("is-hidden", input.value.length === 0);
      this.queueDriveSearch();
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape" && input.value) {
        evt.preventDefault();
        evt.stopPropagation();
        input.value = "";
        this.filterQuery = "";
        clearBtn.addClass("is-hidden");
        this.queueDriveSearch();
      }
    });
    clearBtn.addEventListener("click", () => {
      input.value = "";
      this.filterQuery = "";
      clearBtn.addClass("is-hidden");
      this.queueDriveSearch();
      input.focus();
    });

    const sortBtn = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-icon-button gdab-drive-panel-toolbar-btn",
      attr: { type: "button", "aria-label": "Sort items", title: "Sort items", "aria-haspopup": "menu" },
    });
    setIcon(sortBtn, "arrow-up-down");
    sortBtn.addEventListener("click", (evt) => this.openSortMenu(evt));

    const viewBtn = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-icon-button gdab-drive-panel-toolbar-btn",
      attr: { type: "button", "aria-label": "Change view", title: "Change view", "aria-haspopup": "menu" },
    });
    setIcon(viewBtn, panelViewIcon(this.getSettings().panelViewMode));
    viewBtn.addEventListener("click", (evt) => this.openViewMenu(evt));

    const themeBtn = bar.createEl("button", {
      cls: "clickable-icon gdab-drive-panel-icon-button gdab-drive-panel-toolbar-btn",
      attr: { type: "button", "aria-label": "Change panel theme", title: "Change panel theme", "aria-haspopup": "menu" },
    });
    setIcon(themeBtn, "palette");
    themeBtn.addEventListener("click", (evt) => this.openThemeMenu(evt));
    return input;
  }

  // Drive-style filter chips (drive.google.com's chip row). Type and People are single-select; all
  // active chips AND together over either the loaded folder or Drive-wide search results.
  private renderPanelFilterChips(contentEl: HTMLElement): void {
    const bar = contentEl.createDiv({ cls: "gdab-drive-panel-chips" });
    const typeActive = this.typeFilter !== null;
    const peopleActive = this.peopleFilter !== null;
    const modifiedActive = this.modifiedFilter !== null;

    if (this.isDriveSearchActive()) {
      const location = panelSearchLocationOption(this.searchLocation, this.searchOriginFolder()?.name);
      const locationChip = bar.createEl("button", {
        cls: "gdab-drive-panel-chip is-active",
        attr: {
          type: "button",
          "aria-haspopup": "menu",
          "aria-label": `Search location: ${location.label}`,
        },
      });
      setIcon(
        locationChip.createSpan({ cls: "gdab-drive-panel-chip-icon", attr: { "aria-hidden": "true" } }),
        location.icon,
      );
      locationChip.createSpan({ cls: "gdab-drive-panel-chip-label", text: location.label });
      setIcon(
        locationChip.createSpan({ cls: "gdab-drive-panel-chip-caret", attr: { "aria-hidden": "true" } }),
        "chevron-down",
      );
      locationChip.addEventListener("click", (evt) => this.openSearchLocationMenu(evt));
    }

    const typeChip = bar.createEl("button", {
      cls: "gdab-drive-panel-chip",
      attr: { type: "button", "aria-haspopup": "menu" },
    });
    typeChip.toggleClass("is-active", typeActive);
    setIcon(
      typeChip.createSpan({ cls: "gdab-drive-panel-chip-icon", attr: { "aria-hidden": "true" } }),
      typeActive ? panelTypeIcon(this.typeFilter as PanelTypeCategory) : "shapes",
    );
    typeChip.createSpan({
      cls: "gdab-drive-panel-chip-label",
      text: typeActive ? panelTypeLabel(this.typeFilter as PanelTypeCategory) : "Type",
    });
    setIcon(
      typeChip.createSpan({ cls: "gdab-drive-panel-chip-caret", attr: { "aria-hidden": "true" } }),
      "chevron-down",
    );
    typeChip.setAttribute(
      "aria-label",
      typeActive ? `Type filter: ${panelTypeLabel(this.typeFilter as PanelTypeCategory)}` : "Filter by type",
    );
    typeChip.addEventListener("click", (evt) => this.openTypeFilterMenu(evt));

    const peopleChip = bar.createEl("button", {
      cls: "gdab-drive-panel-chip",
      attr: { type: "button", "aria-haspopup": "menu" },
    });
    peopleChip.toggleClass("is-active", peopleActive);
    setIcon(
      peopleChip.createSpan({ cls: "gdab-drive-panel-chip-icon", attr: { "aria-hidden": "true" } }),
      "user",
    );
    peopleChip.createSpan({
      cls: "gdab-drive-panel-chip-label",
      text: peopleActive ? (this.peopleFilter as PanelOwnerOption).label : "People",
    });
    setIcon(
      peopleChip.createSpan({ cls: "gdab-drive-panel-chip-caret", attr: { "aria-hidden": "true" } }),
      "chevron-down",
    );
    peopleChip.setAttribute(
      "aria-label",
      peopleActive ? `People filter: ${(this.peopleFilter as PanelOwnerOption).label}` : "Filter by owner",
    );
    if (peopleActive) {
      peopleChip.setAttribute("title", (this.peopleFilter as PanelOwnerOption).menuLabel);
    }
    peopleChip.addEventListener("click", (evt) => this.openPeopleFilterMenu(evt));

    const modifiedChip = bar.createEl("button", {
      cls: "gdab-drive-panel-chip",
      attr: { type: "button", "aria-haspopup": "menu" },
    });
    modifiedChip.toggleClass("is-active", modifiedActive);
    setIcon(
      modifiedChip.createSpan({ cls: "gdab-drive-panel-chip-icon", attr: { "aria-hidden": "true" } }),
      modifiedActive ? panelModifiedIcon(this.modifiedFilter as PanelModifiedRange) : "calendar",
    );
    modifiedChip.createSpan({
      cls: "gdab-drive-panel-chip-label",
      text: modifiedActive ? panelModifiedLabel(this.modifiedFilter as PanelModifiedRange) : "Modified",
    });
    setIcon(
      modifiedChip.createSpan({ cls: "gdab-drive-panel-chip-caret", attr: { "aria-hidden": "true" } }),
      "chevron-down",
    );
    modifiedChip.setAttribute(
      "aria-label",
      modifiedActive
        ? `Modified filter: ${panelModifiedLabel(this.modifiedFilter as PanelModifiedRange)}`
        : "Filter by modified date",
    );
    modifiedChip.addEventListener("click", (evt) => this.openModifiedFilterMenu(evt));

    if (typeActive || peopleActive || modifiedActive) {
      const clearChip = bar.createEl("button", {
        cls: "gdab-drive-panel-chip is-clear",
        attr: { type: "button", "aria-label": "Clear filters" },
      });
      setIcon(
        clearChip.createSpan({ cls: "gdab-drive-panel-chip-icon", attr: { "aria-hidden": "true" } }),
        "x",
      );
      clearChip.createSpan({ cls: "gdab-drive-panel-chip-label", text: "Clear filters" });
      clearChip.addEventListener("click", () => this.clearPanelFilters());
    }
  }

  private openSearchLocationMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const origin = this.searchOriginFolder();
    menu.addItem((mi) => mi.setTitle("Location").setIsLabel(true));

    const options: PanelSearchLocationOption[] = [
      panelSearchLocationOption("anywhere"),
      ...(origin && !isVirtualRootId(origin.id)
        ? [panelSearchLocationOption("current-folder", origin.name)]
        : []),
      panelSearchLocationOption("my-drive"),
      panelSearchLocationOption("shared-with-me"),
      panelSearchLocationOption("starred"),
      panelSearchLocationOption("trashed"),
    ];
    for (const option of options) {
      menu.addItem((mi) =>
        mi
          .setTitle(option.label)
          .setIcon(option.icon)
          .setChecked(this.searchLocation === option.key)
          .onClick(() => this.setSearchLocation(option.key)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private setSearchLocation(value: PanelSearchLocation): void {
    if (this.searchLocation === value || !this.isDriveSearchActive()) {
      return;
    }
    this.searchLocation = value;
    this.resetTypeAheadBuffer();
    this.queueDriveSearch(true, true);
  }

  private searchOriginFolder(): DrivePanelLocation | null {
    const origin = this.searchOriginPath;
    return origin?.[origin.length - 1] ?? null;
  }

  private openTypeFilterMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((mi) => mi.setTitle("Type — loaded items only").setIsLabel(true));
    menu.addItem((mi) =>
      mi
        .setTitle("All types")
        .setIcon("layers")
        .setChecked(this.typeFilter === null)
        .onClick(() => this.setTypeFilter(null)),
    );
    menu.addSeparator();
    for (const option of PANEL_TYPE_OPTIONS) {
      menu.addItem((mi) =>
        mi
          .setTitle(option.label)
          .setIcon(option.icon)
          .setChecked(this.typeFilter === option.key)
          .onClick(() => this.setTypeFilter(option.key)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private setTypeFilter(value: PanelTypeCategory | null): void {
    if (this.typeFilter === value) {
      return;
    }
    this.typeFilter = value;
    this.resetTypeAheadBuffer();
    this.render(); // the chip row, list, and detail/selection bars all reflect the active filter
  }

  private openPeopleFilterMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const options = panelOwnerOptions(this.getCurrentRawItems());
    menu.addItem((mi) => mi.setTitle("People — current results").setIsLabel(true));
    menu.addItem((mi) =>
      mi
        .setTitle("Anyone")
        .setIcon("users")
        .setChecked(this.peopleFilter === null)
        .onClick(() => this.setPeopleFilter(null)),
    );
    menu.addSeparator();
    if (options.length === 0) {
      menu.addItem((mi) => mi.setTitle("No owners in this folder").setIsLabel(true));
    } else {
      for (const option of options) {
        menu.addItem((mi) =>
          mi
            .setTitle(option.menuLabel)
            .setIcon("user")
            .setChecked(this.peopleFilter?.key === option.key)
            .onClick(() => this.setPeopleFilter(option)),
        );
      }
    }
    menu.showAtMouseEvent(evt);
  }

  private setPeopleFilter(value: PanelOwnerOption | null): void {
    if (this.peopleFilter?.key === value?.key) {
      return;
    }
    this.peopleFilter = value;
    this.resetTypeAheadBuffer();
    this.render();
  }

  private openModifiedFilterMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((mi) => mi.setTitle("Modified — loaded items only").setIsLabel(true));
    menu.addItem((mi) =>
      mi
        .setTitle("Any time")
        .setIcon("infinity")
        .setChecked(this.modifiedFilter === null)
        .onClick(() => this.setModifiedFilter(null)),
    );
    menu.addSeparator();
    for (const option of PANEL_MODIFIED_OPTIONS) {
      menu.addItem((mi) =>
        mi
          .setTitle(option.label)
          .setIcon(option.icon)
          .setChecked(this.modifiedFilter === option.key)
          .onClick(() => this.setModifiedFilter(option.key)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private setModifiedFilter(value: PanelModifiedRange | null): void {
    if (this.modifiedFilter === value) {
      return;
    }
    this.modifiedFilter = value;
    this.resetTypeAheadBuffer();
    this.render();
  }

  private clearPanelFilters(): void {
    if (this.typeFilter === null && this.peopleFilter === null && this.modifiedFilter === null) {
      return;
    }
    this.typeFilter = null;
    this.peopleFilter = null;
    this.modifiedFilter = null;
    this.resetTypeAheadBuffer();
    this.render();
  }

  // Mirrors drive.google.com's Sort menu: a "Sort by" group (Name + three date keys, with
  // Size/Type kept as extras), a "Sort direction" group whose labels track the chosen key
  // (New↔old for dates, A↔Z for name/type, Smallest↔Largest for size), and a "Folders"
  // On-top / Mixed-with-files pair (the persisted `panelFoldersFirst`).
  private openSortMenu(evt: MouseEvent): void {
    const s = this.getSettings();
    const menu = new Menu();

    menu.addItem((mi) => mi.setTitle("Sort by").setIsLabel(true));
    const driveKeys: Array<{ key: PanelSortKey; label: string; icon: string }> = [
      { key: "name", label: "Name", icon: "case-sensitive" },
      { key: "modified", label: "Date modified", icon: "clock" },
      { key: "modifiedByMe", label: "Date modified by me", icon: "pencil" },
      { key: "viewedByMe", label: "Date opened by me", icon: "eye" },
    ];
    const extraKeys: Array<{ key: PanelSortKey; label: string; icon: string }> = [
      { key: "size", label: "Size", icon: "scale" },
      { key: "type", label: "Type", icon: "shapes" },
    ];
    const addKeyItem = (k: { key: PanelSortKey; label: string; icon: string }): void => {
      menu.addItem((mi) =>
        mi
          .setTitle(k.label)
          .setIcon(k.icon)
          .setChecked(s.panelSortKey === k.key)
          .onClick(() => void this.setSortSetting({ key: k.key })),
      );
    };
    driveKeys.forEach(addKeyItem);
    menu.addSeparator();
    extraKeys.forEach(addKeyItem);

    menu.addSeparator();
    menu.addItem((mi) => mi.setTitle("Sort direction").setIsLabel(true));
    for (const opt of sortDirectionOptions(s.panelSortKey)) {
      menu.addItem((mi) =>
        mi
          .setTitle(opt.label)
          .setIcon(opt.icon)
          .setChecked(s.panelSortDir === opt.dir)
          .onClick(() => void this.setSortSetting({ dir: opt.dir })),
      );
    }

    menu.addSeparator();
    menu.addItem((mi) => mi.setTitle("Folders").setIsLabel(true));
    menu.addItem((mi) =>
      mi
        .setTitle("On top")
        .setIcon("folder")
        .setChecked(s.panelFoldersFirst)
        .onClick(() => void this.setSortSetting({ foldersFirst: true })),
    );
    menu.addItem((mi) =>
      mi
        .setTitle("Mixed with files")
        .setIcon("folders")
        .setChecked(!s.panelFoldersFirst)
        .onClick(() => void this.setSortSetting({ foldersFirst: false })),
    );

    menu.showAtMouseEvent(evt);
  }

  private async setSortSetting(change: {
    key?: PanelSortKey;
    dir?: PanelSortDir;
    foldersFirst?: boolean;
  }): Promise<void> {
    const s = this.getSettings();
    if (change.key) {
      s.panelSortKey = change.key;
    }
    if (change.dir) {
      s.panelSortDir = change.dir;
    }
    if (typeof change.foldersFirst === "boolean") {
      s.panelFoldersFirst = change.foldersFirst;
    }
    await this.saveSettings();
    this.refreshListOnly();
  }

  private openViewMenu(evt: MouseEvent): void {
    const current = this.getSettings().panelViewMode;
    const menu = new Menu();
    const modes: Array<{ mode: PanelViewMode; label: string; icon: string }> = [
      { mode: "list", label: "List", icon: "list" },
      { mode: "compact", label: "Compact", icon: "menu" },
      { mode: "grid", label: "Grid", icon: "layout-grid" },
    ];
    for (const m of modes) {
      menu.addItem((mi) =>
        mi
          .setTitle(m.label)
          .setIcon(m.icon)
          .setChecked(current === m.mode)
          .onClick(() => void this.setViewMode(m.mode)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private async setViewMode(mode: PanelViewMode): Promise<void> {
    if (this.getSettings().panelViewMode === mode) {
      return;
    }
    this.getSettings().panelViewMode = mode;
    await this.saveSettings();
    this.render(); // view mode changes the list's layout class, so re-render the whole panel
  }

  private openThemeMenu(evt: MouseEvent): void {
    const current = this.currentPanelTheme();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Panel theme").setIsLabel(true));
    for (const option of PANEL_THEME_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(option.label)
          .setChecked(current === option.value)
          .onClick(() => void this.setPanelTheme(option.value)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private async setPanelTheme(theme: PanelTheme): Promise<void> {
    if (this.currentPanelTheme() === theme) {
      return;
    }
    this.getSettings().panelTheme = theme;
    await this.saveSettings();
    this.applyThemeClass();
  }

  private currentPanelTheme(): PanelTheme {
    const theme = this.getSettings().panelTheme;
    return isPanelTheme(theme) ? theme : "default";
  }

  private applyThemeClass(): void {
    for (const className of Array.from(this.contentEl.classList)) {
      if (className.startsWith("gdab-theme-")) {
        this.contentEl.removeClass(className);
      }
    }
    this.contentEl.addClass(`gdab-theme-${this.currentPanelTheme()}`);
  }

  // Shared row-action helpers need a target editor. The panel lives in the sidebar, so it resolves
  // the most-recent markdown leaf (the root-split editor the user was last in), not the focused leaf.
  private rowActionContext(): DriveRowActionContext {
    return {
      app: this.app,
      insert: this.insert,
      preview: this.preview,
      resolveEditor: () => this.getActiveMarkdownEditor(),
    };
  }

  private getActiveMarkdownEditor(): { editor: Editor; file: TFile | null } | null {
    const view = this.app.workspace.getMostRecentLeaf()?.view;
    if (view instanceof MarkdownView) {
      return { editor: view.editor, file: view.file };
    }
    return null;
  }

  // Route a virtual collection root to its query-backed service call; a real
  // Drive folder id falls through to the normal parent listing. One page per call —
  // pass the previous page's nextPageToken to continue the same listing.
  private listLocationItemsPage(folderId: string, pageToken?: string): Promise<DriveBrowserPage> {
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

  private isCurrentVirtualRoot(): boolean {
    return this.path.length === 1 && isVirtualRootId(this.currentLocation.id);
  }

  private isVirtualRootPath(): boolean {
    return isVirtualRootId(this.path[0]?.id);
  }

  // True anywhere under the Trash virtual root. Trash descent is blocked (navigateToFolder no-ops
  // there), so today this only matches the Trash root itself, but the path[0] check stays correct if
  // that ever changes. Used to swap ordinary mutations for Restore/Delete-forever in the Trash view.
  private isInTrashPath(): boolean {
    return this.path[0]?.id === TRASH_ROOT.id;
  }

  // Display name of the active virtual collection (e.g. "Starred" / "Recent" / "Trash") for copy.
  private currentVirtualRootName(): string {
    return virtualRootName(this.path[0]?.id);
  }

  // Collection-specific empty-state copy for a virtual root with no items.
  private virtualRootEmptyMessage(rootId: string): string {
    if (rootId === SHARED_WITH_ME_ROOT.id) {
      return "No Drive items have been shared with you.";
    }
    if (rootId === RECENT_ROOT.id) {
      return "No recent Drive items.";
    }
    if (rootId === TRASH_ROOT.id) {
      return "Trash is empty.";
    }
    return "No starred Drive items.";
  }
}

interface PanelDropConfirmOptions {
  entries: FileSystemEntry[];
  files: File[];
  targetBreadcrumb: string;
  targetName: string;
  onConfirm: () => void;
}

class PanelDropConfirmModal extends Modal {
  constructor(app: DrivePanelView["app"], private readonly options: PanelDropConfirmOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("gdab-panel-drop-confirm");
    contentEl.createEl("h2", { text: "Upload to Google Drive" });
    contentEl.createDiv({
      cls: "gdab-panel-drop-confirm-target",
      text: `Target: ${this.options.targetBreadcrumb || this.options.targetName}`,
    });

    const items = describePanelDropItems(this.options.entries, this.options.files);
    const countLabel = formatCount(items.length, "item");
    contentEl.createDiv({ cls: "gdab-panel-drop-confirm-summary", text: `${countLabel} ready to upload.` });

    const list = contentEl.createEl("ul", { cls: "gdab-panel-drop-confirm-list" });
    for (const item of items.slice(0, 12)) {
      list.createEl("li", { text: `${item.kind}: ${item.name}` });
    }
    if (items.length > 12) {
      list.createEl("li", { text: `...and ${formatCount(items.length - 12, "more item")}` });
    }

    const buttons = contentEl.createDiv({ cls: "gdab-panel-drop-confirm-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.close();
    });
    const uploadButton = buttons.createEl("button", { cls: "mod-cta", text: "Upload" });
    uploadButton.addEventListener("click", () => {
      this.close();
      this.options.onConfirm();
    });
  }
}

class NewDriveFolderModal extends Modal {
  private inputEl: HTMLInputElement | null = null;

  constructor(
    app: DrivePanelView["app"],
    private readonly targetBreadcrumb: string,
    private readonly onCreate: (name: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("gdab-new-folder-modal");
    contentEl.createEl("h2", { text: "New Drive folder" });
    contentEl.createDiv({ cls: "gdab-new-folder-target", text: `Location: ${this.targetBreadcrumb}` });

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      cls: "gdab-new-folder-input",
      attr: { placeholder: "Folder name", "aria-label": "Folder name" },
    });
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.submit();
      }
    });

    const buttons = contentEl.createDiv({ cls: "gdab-new-folder-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const createButton = buttons.createEl("button", { cls: "mod-cta", text: "Create" });
    createButton.addEventListener("click", () => this.submit());

    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  private submit(): void {
    const name = this.inputEl?.value.trim() ?? "";
    if (!name) {
      new Notice("Enter a folder name.");
      return;
    }

    this.close();
    this.onCreate(name);
  }
}

class RenameDriveItemModal extends Modal {
  private inputEl: HTMLInputElement | null = null;

  constructor(
    app: DrivePanelView["app"],
    private readonly currentName: string,
    private readonly isFolder: boolean,
    private readonly onSubmit: (name: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("gdab-rename-modal");
    contentEl.createEl("h2", { text: this.isFolder ? "Rename folder" : "Rename file" });

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      cls: "gdab-rename-input",
      attr: { "aria-label": "New name" },
    });
    this.inputEl.value = this.currentName;
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.submit();
      }
    });

    const buttons = contentEl.createDiv({ cls: "gdab-rename-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const renameButton = buttons.createEl("button", { cls: "mod-cta", text: "Rename" });
    renameButton.addEventListener("click", () => this.submit());

    window.setTimeout(() => {
      this.inputEl?.focus();
      this.inputEl?.select();
    }, 0);
  }

  private submit(): void {
    const name = this.inputEl?.value.trim() ?? "";
    if (!name) {
      new Notice("Enter a name.");
      return;
    }

    this.close();
    this.onSubmit(name);
  }
}

class FolderColorPickerModal extends Modal {
  private colors: string[] = [];
  private loading = false;
  private errorMessage: string | null = null;
  private generation = 0;

  constructor(
    app: DrivePanelView["app"],
    private readonly metadata: DriveMetadataService,
    private readonly folder: DriveBrowserItem,
    private readonly onSelect: (color: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
    void this.loadPalette();
  }

  onClose(): void {
    this.generation += 1;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gdab-folder-color-modal");
    contentEl.createEl("h2", { text: "Change folder color" });
    contentEl.createDiv({ cls: "gdab-folder-color-detail", text: this.folder.name });

    if (this.loading) {
      contentEl.createDiv({ cls: "gdab-folder-color-state", text: "Loading Drive colors..." });
      return;
    }

    if (this.errorMessage) {
      contentEl.createDiv({ cls: "gdab-folder-color-state", text: this.errorMessage });
      const retry = contentEl.createEl("button", { text: "Retry" });
      retry.addEventListener("click", () => void this.loadPalette());
      return;
    }

    if (this.colors.length === 0) {
      return;
    }

    const currentColor = folderColorHex(this.folder.folderColorRgb)?.toUpperCase() ?? null;
    const reset = contentEl.createEl("button", {
      cls: `gdab-folder-color-default${currentColor === null ? " is-selected" : ""}`,
      attr: { "aria-pressed": String(currentColor === null) },
    });
    const defaultIcon = reset.createSpan({ cls: "gdab-folder-color-default-icon", attr: { "aria-hidden": "true" } });
    setIcon(defaultIcon, "folder");
    reset.createSpan({ text: "Default" });
    reset.addEventListener("click", () => this.choose(null));

    const grid = contentEl.createDiv({
      cls: "gdab-folder-color-grid",
      attr: { role: "group", "aria-label": "Google Drive folder colors" },
    });
    let selectedButton: HTMLButtonElement | null = currentColor === null ? reset : null;
    this.colors.forEach((color, index) => {
      const selected = color === currentColor;
      const swatch = grid.createEl("button", {
        cls: `gdab-folder-color-swatch${selected ? " is-selected" : ""}`,
        attr: {
          "aria-label": `Folder color ${index + 1}: ${color}`,
          "aria-pressed": String(selected),
          title: color,
        },
      });
      swatch.style.backgroundColor = color;
      swatch.addEventListener("click", () => this.choose(color));
      if (selected) {
        selectedButton = swatch;
      }
    });
    selectedButton ??= reset;

    const buttons = contentEl.createDiv({ cls: "gdab-folder-color-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    window.setTimeout(() => selectedButton?.focus(), 0);
  }

  private async loadPalette(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.errorMessage = null;
    this.render();

    try {
      const colors = await this.metadata.getFolderColorPalette();
      if (generation !== this.generation) {
        return;
      }
      this.colors = colors.map((color) => color.toUpperCase());
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private choose(color: string | null): void {
    this.close();
    this.onSelect(color);
  }
}

// Recoverable "move to Drive trash" confirmation for single and bulk deletes — names the affected
// items (first 12) and the count, and makes clear the move is restorable from Drive for ~30 days.
class PanelDeleteConfirmModal extends Modal {
  constructor(
    app: DrivePanelView["app"],
    private readonly items: DriveBrowserItem[],
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("gdab-panel-delete-confirm");
    contentEl.createEl("h2", { text: "Move to Drive trash" });

    const count = formatCount(this.items.length, "item");
    const them = this.items.length === 1 ? "it" : "them";
    contentEl.createDiv({
      cls: "gdab-panel-delete-confirm-summary",
      text: `Move ${count} to the Google Drive trash? You can restore ${them} from Drive for about 30 days.`,
    });

    const list = contentEl.createEl("ul", { cls: "gdab-panel-delete-confirm-list" });
    for (const item of this.items.slice(0, 12)) {
      const kind = item.mimeType === DRIVE_FOLDER_MIME_TYPE ? "Folder" : "File";
      list.createEl("li", { text: `${kind}: ${item.name}` });
    }
    if (this.items.length > 12) {
      list.createEl("li", { text: `...and ${formatCount(this.items.length - 12, "more item")}` });
    }

    const buttons = contentEl.createDiv({ cls: "gdab-panel-delete-confirm-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const deleteButton = buttons.createEl("button", { cls: "mod-warning", text: "Move to trash" });
    deleteButton.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }
}

// Irreversible permanent-delete confirmation. It deliberately does not reuse the recoverable-trash
// copy above: the warning must state that Drive cannot restore the affected items.
class PanelPermanentDeleteConfirmModal extends Modal {
  constructor(
    app: DrivePanelView["app"],
    private readonly items: DriveBrowserItem[],
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("gdab-panel-delete-confirm");
    contentEl.createEl("h2", { text: "Delete forever from Drive?" });

    contentEl.createDiv({
      cls: "gdab-panel-delete-confirm-summary",
      text: `Permanently delete ${formatCount(this.items.length, "item")} from Google Drive? This can't be undone.`,
    });

    const list = contentEl.createEl("ul", { cls: "gdab-panel-delete-confirm-list" });
    for (const item of this.items.slice(0, 12)) {
      const kind = item.mimeType === DRIVE_FOLDER_MIME_TYPE ? "Folder" : "File";
      list.createEl("li", { text: `${kind}: ${item.name}` });
    }
    if (this.items.length > 12) {
      list.createEl("li", { text: `...and ${formatCount(this.items.length - 12, "more item")}` });
    }

    const buttons = contentEl.createDiv({ cls: "gdab-panel-delete-confirm-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const deleteButton = buttons.createEl("button", { cls: "mod-warning", text: "Delete forever" });
    deleteButton.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }
}

interface PanelFolderPickerOptions {
  title: string;
  detail: string;
  actionLabel: string;
  metadata: DriveMetadataService;
  roots: DrivePanelLocation[];
  initialPath: DrivePanelLocation[];
  excludedFolderIds?: Set<string>;
  excludedNotice?: string;
  onChoose: (folder: DrivePanelLocation) => void;
}

class PanelFolderPickerModal extends Modal {
  private path: DrivePanelLocation[];
  private folders: DriveBrowserItem[] = [];
  private loading = false;
  private errorMessage: string | null = null;
  private generation = 0;

  constructor(app: DrivePanelView["app"], private readonly options: PanelFolderPickerOptions) {
    super(app);
    this.path = options.initialPath.length > 0 ? options.initialPath.map((location) => ({ ...location })) : [{ ...MY_DRIVE_ROOT }];
  }

  onOpen(): void {
    this.render();
    void this.loadCurrentFolder();
  }

  private get currentLocation(): DrivePanelLocation {
    return this.path[this.path.length - 1];
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gdab-folder-picker-modal");
    contentEl.createEl("h2", { text: this.options.title });
    contentEl.createDiv({ cls: "gdab-folder-picker-detail", text: this.options.detail });

    this.renderRootSelect(contentEl);
    this.renderBreadcrumbs(contentEl);

    const body = contentEl.createDiv({ cls: "gdab-folder-picker-body" });
    if (this.loading) {
      body.createDiv({ cls: "gdab-folder-picker-state", text: "Loading folders..." });
    } else if (this.errorMessage) {
      body.createDiv({ cls: "gdab-folder-picker-state", text: this.errorMessage });
      body.createEl("button", { text: "Retry" }).addEventListener("click", () => {
        void this.loadCurrentFolder();
      });
    } else if (this.folders.length === 0) {
      body.createDiv({ cls: "gdab-folder-picker-state", text: "No subfolders here." });
    } else {
      for (const folder of this.folders) {
        this.renderFolderRow(body, folder);
      }
    }

    const buttons = contentEl.createDiv({ cls: "gdab-folder-picker-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const chooseButton = buttons.createEl("button", { cls: "mod-cta", text: this.options.actionLabel });
    chooseButton.disabled = this.loading || this.isExcluded(this.currentLocation.id);
    chooseButton.addEventListener("click", () => this.chooseCurrentFolder());
  }

  private renderRootSelect(contentEl: HTMLElement): void {
    if (this.options.roots.length <= 1) {
      return;
    }

    const rootRow = contentEl.createDiv({ cls: "gdab-folder-picker-root-row" });
    const select = rootRow.createEl("select", {
      cls: "dropdown gdab-folder-picker-root-select",
      attr: { "aria-label": "Drive root" },
    });
    for (const root of this.options.roots) {
      select.createEl("option", { text: root.name, value: root.id });
    }
    select.value = this.path[0]?.id ?? MY_DRIVE_ROOT.id;
    select.addEventListener("change", () => {
      const root = this.options.roots.find((candidate) => candidate.id === select.value) ?? { ...MY_DRIVE_ROOT };
      this.path = [{ id: root.id, name: root.name }];
      void this.loadCurrentFolder();
    });
  }

  private renderBreadcrumbs(contentEl: HTMLElement): void {
    const breadcrumbs = contentEl.createDiv({ cls: "gdab-folder-picker-breadcrumbs" });
    this.path.forEach((location, index) => {
      if (index > 0) {
        breadcrumbs.createSpan({ cls: "gdab-folder-picker-breadcrumb-sep", text: "›", attr: { "aria-hidden": "true" } });
      }

      const current = index === this.path.length - 1;
      const segment = breadcrumbs.createSpan({
        text: location.name,
        cls: `gdab-folder-picker-breadcrumb${current ? " is-current" : ""}`,
        attr: { title: location.name },
      });
      if (current) {
        segment.setAttribute("aria-current", "true");
        return;
      }
      segment.setAttribute("role", "button");
      segment.setAttribute("tabindex", "0");
      const navigate = (): void => {
        this.path.splice(index + 1);
        void this.loadCurrentFolder();
      };
      segment.addEventListener("click", navigate);
      segment.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          navigate();
        }
      });
    });
  }

  private renderFolderRow(body: HTMLElement, folder: DriveBrowserItem): void {
    const row = body.createDiv({ cls: "gdab-folder-picker-row" });
    const icon = row.createSpan({ cls: "gdab-folder-picker-row-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "folder");
    row.createDiv({ cls: "gdab-folder-picker-row-name", text: folder.name });
    const openButton = row.createEl("button", {
      cls: "clickable-icon gdab-folder-picker-row-open",
      attr: { "aria-label": `Open ${folder.name}` },
    });
    setIcon(openButton, "chevron-right");
    const open = (): void => {
      this.path.push({ id: folder.id, name: folder.name });
      void this.loadCurrentFolder();
    };
    row.addEventListener("dblclick", open);
    openButton.addEventListener("click", open);
  }

  private async loadCurrentFolder(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.errorMessage = null;
    this.render();

    try {
      // The picker must offer every subfolder as a target, so walk ALL listing pages (200/page) —
      // stopping at a folder count 201+ would silently hide valid move/pick destinations. Capped at
      // 10 pages (2,000 items) as a runaway guard; folders sort first, so they arrive earliest.
      const folders: DriveBrowserItem[] = [];
      let pageToken: string | undefined;
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const page: DriveBrowserPage = await this.options.metadata.listFolderPage(this.currentLocation.id, pageToken);
        if (generation !== this.generation) {
          return;
        }
        folders.push(...page.items.filter((item) => item.mimeType === DRIVE_FOLDER_MIME_TYPE));
        pageToken = page.nextPageToken;
        if (!pageToken) {
          break;
        }
      }
      this.folders = folders;
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.folders = [];
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private chooseCurrentFolder(): void {
    const folder = this.currentLocation;
    if (this.isExcluded(folder.id)) {
      new Notice(this.options.excludedNotice ?? "Choose a different folder.");
      return;
    }
    this.close();
    this.options.onChoose({ ...folder });
  }

  private isExcluded(folderId: string): boolean {
    return this.options.excludedFolderIds?.has(folderId) ?? false;
  }
}

function sortFolderFirst(items: DriveBrowserItem[]): DriveBrowserItem[] {
  return [...items].sort((left, right) => {
    const leftFolder = left.mimeType === DRIVE_FOLDER_MIME_TYPE;
    const rightFolder = right.mimeType === DRIVE_FOLDER_MIME_TYPE;
    if (leftFolder !== rightFolder) {
      return leftFolder ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

// Direction labels for the Sort menu, tracking the chosen key the way drive.google.com does:
// date keys read "New to old / Old to new", Size reads "Smallest / Largest first", and Name/Type
// read "A → Z / Z → A". The order returned is Drive's (primary direction first).
function sortDirectionOptions(
  key: PanelSortKey,
): Array<{ dir: PanelSortDir; label: string; icon: string }> {
  if (key === "modified" || key === "modifiedByMe" || key === "viewedByMe") {
    return [
      { dir: "desc", label: "New to old", icon: "arrow-down-wide-narrow" },
      { dir: "asc", label: "Old to new", icon: "arrow-up-narrow-wide" },
    ];
  }
  if (key === "size") {
    return [
      { dir: "asc", label: "Smallest first", icon: "arrow-up-narrow-wide" },
      { dir: "desc", label: "Largest first", icon: "arrow-down-wide-narrow" },
    ];
  }
  return [
    { dir: "asc", label: "A → Z", icon: "arrow-up-narrow-wide" },
    { dir: "desc", label: "Z → A", icon: "arrow-down-wide-narrow" },
  ];
}

// User-chosen sort for the panel listing (Drive's Name/Date-modified/Date-modified-by-me/
// Date-opened-by-me keys, plus Size/Type extras, asc/desc). Folders-first, when on, keeps
// directories grouped above files regardless of direction (Finder/Explorer behavior). Ties and
// folder-vs-folder always fall back to a numeric-aware name compare so the order is stable.
function sortDriveItems(
  items: DriveBrowserItem[],
  key: PanelSortKey,
  dir: PanelSortDir,
  foldersFirst: boolean,
): DriveBrowserItem[] {
  const sign = dir === "desc" ? -1 : 1;
  const byName = (a: DriveBrowserItem, b: DriveBrowserItem): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  return [...items].sort((a, b) => {
    if (foldersFirst) {
      const fa = a.mimeType === DRIVE_FOLDER_MIME_TYPE;
      const fb = b.mimeType === DRIVE_FOLDER_MIME_TYPE;
      if (fa !== fb) {
        return fa ? -1 : 1; // folders stay on top regardless of sort direction
      }
    }
    const byTime = (field: "modifiedTime" | "modifiedByMeTime" | "viewedByMeTime"): number =>
      (Date.parse(a[field] ?? "") || 0) - (Date.parse(b[field] ?? "") || 0);
    let cmp = 0;
    switch (key) {
      case "modified":
        cmp = byTime("modifiedTime");
        break;
      case "modifiedByMe":
        cmp = byTime("modifiedByMeTime");
        break;
      case "viewedByMe":
        cmp = byTime("viewedByMeTime");
        break;
      case "size":
        cmp = (Number(a.size) || 0) - (Number(b.size) || 0);
        break;
      case "type":
        cmp = a.mimeType.localeCompare(b.mimeType, undefined, { sensitivity: "base" }) || byName(a, b);
        break;
      default:
        cmp = byName(a, b);
    }
    if (cmp === 0) {
      cmp = byName(a, b);
    }
    return cmp * sign;
  });
}

function panelViewIcon(mode: PanelViewMode): string {
  return mode === "grid" ? "layout-grid" : mode === "compact" ? "menu" : "list";
}

function formatItemDetails(item: DriveBrowserItem): string {
  const details: string[] = [];
  if (item.modifiedTime) {
    details.push(formatModifiedTime(item.modifiedTime));
  }
  if (item.size) {
    details.push(formatBytes(item.size));
  }
  return details.join(" | ");
}

function formatModifiedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatPanelOwner(metadata: DriveMetadata, accountEmail: string | null | undefined): string | null {
  const owner = metadata.owners?.find((candidate) => candidate.displayName || candidate.emailAddress);
  if (owner) {
    if (owner.displayName && owner.emailAddress) {
      return `${owner.displayName} <${owner.emailAddress}>`;
    }
    return owner.displayName ?? owner.emailAddress ?? null;
  }

  if (metadata.driveId) {
    return formatAccountDomain(accountEmail);
  }

  return null;
}

function formatAccountDomain(accountEmail: string | null | undefined): string | null {
  if (typeof accountEmail !== "string") {
    return null;
  }
  const atIndex = accountEmail.lastIndexOf("@");
  if (atIndex === -1 || atIndex === accountEmail.length - 1) {
    return null;
  }
  return accountEmail.slice(atIndex);
}

function formatDetailMetadataError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bHTTP 401\b/.test(message)) {
    return "Reconnect Drive to load owner and thumbnail.";
  }
  if (/\bHTTP 403\b/.test(message)) {
    return /quota|rateLimit|userRateLimit/i.test(message)
      ? "Drive quota limited owner and thumbnail loading."
      : "No permission to load owner and thumbnail.";
  }
  if (/\bHTTP 404\b/.test(message)) {
    return "Drive item not found.";
  }
  return "Could not load owner and thumbnail.";
}

// Human-friendly label for a Drive mimeType, used in the details bar. Known types map directly;
// everything else falls back to a "<SUBTYPE> image/video/.../file" shape, with opaque subtypes
// (vnd.*, x-*, octet-stream) collapsed to a plain category word.
// Drive's "Type ▾" filter categories. Single-select (matches drive.google.com's Type chip), evaluated
// client-side over the loaded folder listing via `matchesTypeCategory`.
type PanelTypeCategory =
  | "folder"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "archive";

interface PanelTypeOption {
  key: PanelTypeCategory;
  label: string;
  icon: string;
}

interface PanelOwnerOption {
  key: string;
  label: string;
  menuLabel: string;
}

const PANEL_TYPE_OPTIONS: PanelTypeOption[] = [
  { key: "folder", label: "Folders", icon: "folder" },
  { key: "document", label: "Documents", icon: "file-text" },
  { key: "spreadsheet", label: "Spreadsheets", icon: "table" },
  { key: "presentation", label: "Presentations", icon: "presentation" },
  { key: "pdf", label: "PDFs", icon: "file-type-2" },
  { key: "image", label: "Photos & images", icon: "image" },
  { key: "video", label: "Videos", icon: "film" },
  { key: "audio", label: "Audio", icon: "music" },
  { key: "archive", label: "Archives", icon: "archive" },
];

const DOCUMENT_MIME_TYPES = new Set([
  "application/vnd.google-apps.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
]);
const SPREADSHEET_MIME_TYPES = new Set([
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
]);
const PRESENTATION_MIME_TYPES = new Set([
  "application/vnd.google-apps.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.presentation",
]);
const ARCHIVE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
]);

function matchesTypeCategory(mimeType: string, category: PanelTypeCategory): boolean {
  switch (category) {
    case "folder":
      return mimeType === DRIVE_FOLDER_MIME_TYPE;
    case "image":
      return mimeType.startsWith("image/");
    case "video":
      return mimeType.startsWith("video/");
    case "audio":
      return mimeType.startsWith("audio/");
    case "pdf":
      return mimeType === "application/pdf";
    case "document":
      // Office/Docs/OpenDocument word-processing plus generic text, minus csv (a spreadsheet below).
      return DOCUMENT_MIME_TYPES.has(mimeType) || (mimeType.startsWith("text/") && mimeType !== "text/csv");
    case "spreadsheet":
      return SPREADSHEET_MIME_TYPES.has(mimeType);
    case "presentation":
      return PRESENTATION_MIME_TYPES.has(mimeType);
    case "archive":
      return ARCHIVE_MIME_TYPES.has(mimeType);
    default:
      return false;
  }
}

function panelTypeLabel(category: PanelTypeCategory): string {
  return PANEL_TYPE_OPTIONS.find((option) => option.key === category)?.label ?? "Type";
}

function panelTypeIcon(category: PanelTypeCategory): string {
  return PANEL_TYPE_OPTIONS.find((option) => option.key === category)?.icon ?? "shapes";
}

function panelOwnerOption(owner: DriveOwner): PanelOwnerOption | null {
  const displayName = owner.displayName?.trim() ?? "";
  const emailAddress = owner.emailAddress?.trim() ?? "";
  if (!displayName && !emailAddress) {
    return null;
  }
  return {
    key: emailAddress ? `email:${emailAddress.toLowerCase()}` : `name:${displayName.toLowerCase()}`,
    label: displayName || emailAddress,
    menuLabel: displayName && emailAddress ? `${displayName} (${emailAddress})` : displayName || emailAddress,
  };
}

function panelOwnerOptions(items: DriveBrowserItem[]): PanelOwnerOption[] {
  const byKey = new Map<string, PanelOwnerOption>();
  for (const item of items) {
    for (const owner of item.owners ?? []) {
      const option = panelOwnerOption(owner);
      if (option && !byKey.has(option.key)) {
        byKey.set(option.key, option);
      }
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.menuLabel.localeCompare(right.menuLabel, undefined, { sensitivity: "base" }),
  );
}

function itemHasOwner(item: DriveBrowserItem, ownerKey: string): boolean {
  return item.owners?.some((owner) => panelOwnerOption(owner)?.key === ownerKey) ?? false;
}

// First resolvable owner display name/email for a row badge tooltip; null when the listing omits owners
// (common on shared-drive items, which Drive owns at the organization level).
function panelPrimaryOwnerLabel(item: DriveBrowserItem): string | null {
  for (const owner of item.owners ?? []) {
    const option = panelOwnerOption(owner);
    if (option) {
      return option.label;
    }
  }
  return null;
}

type PanelSearchLocation =
  | "anywhere"
  | "current-folder"
  | "my-drive"
  | "shared-with-me"
  | "starred"
  | "trashed";

interface PanelSearchLocationOption {
  key: PanelSearchLocation;
  label: string;
  icon: string;
}

function defaultPanelSearchLocation(locationId: string): PanelSearchLocation {
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

function panelSearchServerLocation(location: PanelSearchLocation): DriveSearchLocationQuery {
  return location === "current-folder" ? "anywhere" : location;
}

function panelSearchLocationOption(
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

// Drive's "Modified ▾" filter windows. Single-select (matches drive.google.com's Modified chip),
// evaluated client-side over the loaded folder listing's `modifiedTime`.
type PanelModifiedRange = "today" | "last7" | "last30" | "thisYear";

interface PanelModifiedOption {
  key: PanelModifiedRange;
  label: string;
  icon: string;
}

const PANEL_MODIFIED_OPTIONS: PanelModifiedOption[] = [
  { key: "today", label: "Today", icon: "calendar-check" },
  { key: "last7", label: "Last 7 days", icon: "calendar-days" },
  { key: "last30", label: "Last 30 days", icon: "calendar-range" },
  { key: "thisYear", label: "This year", icon: "calendar-clock" },
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Lower-bound timestamp (ms) for a Modified range, computed from `now`. Items modified at or after
// this instant match. "Today" and "This year" anchor to the local calendar's start-of-period; the
// rolling windows subtract whole days from now.
function modifiedRangeCutoff(range: PanelModifiedRange, now: number): number {
  const ref = new Date(now);
  switch (range) {
    case "today":
      return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
    case "last7":
      return now - 7 * ONE_DAY_MS;
    case "last30":
      return now - 30 * ONE_DAY_MS;
    case "thisYear":
      return new Date(ref.getFullYear(), 0, 1).getTime();
    default:
      return now;
  }
}

function itemModifiedSince(item: DriveBrowserItem, cutoff: number): boolean {
  if (!item.modifiedTime) {
    return false;
  }
  const ts = Date.parse(item.modifiedTime);
  return !Number.isNaN(ts) && ts >= cutoff;
}

function panelModifiedLabel(range: PanelModifiedRange): string {
  return PANEL_MODIFIED_OPTIONS.find((option) => option.key === range)?.label ?? "Modified";
}

function panelModifiedIcon(range: PanelModifiedRange): string {
  return PANEL_MODIFIED_OPTIONS.find((option) => option.key === range)?.icon ?? "calendar";
}

// Reads naturally after "No loaded items were modified …" in the filtered-empty state.
function panelModifiedPhrase(range: PanelModifiedRange): string {
  switch (range) {
    case "today":
      return "today";
    case "last7":
      return "in the last 7 days";
    case "last30":
      return "in the last 30 days";
    case "thisYear":
      return "this year";
    default:
      return "in that range";
  }
}

const FRIENDLY_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.folder": "Folder",
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.script": "Apps Script",
  "application/pdf": "PDF",
  "application/zip": "ZIP archive",
  "application/x-zip-compressed": "ZIP archive",
  "application/json": "JSON",
  "application/msword": "Word document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/vnd.ms-excel": "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel spreadsheet",
  "application/vnd.ms-powerpoint": "PowerPoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
};

function friendlyMimeType(mimeType: string): string {
  const known = FRIENDLY_MIME_TYPES[mimeType];
  if (known) {
    return known;
  }

  const slash = mimeType.indexOf("/");
  const type = slash >= 0 ? mimeType.slice(0, slash) : mimeType;
  const subtype = slash >= 0 ? mimeType.slice(slash + 1) : "";
  const shortSub = subtype.split(/[.+]/)[0].toUpperCase();
  const opaque =
    shortSub === "" || shortSub === "VND" || shortSub === "X" || shortSub === "OCTET-STREAM";

  switch (type) {
    case "image":
      return opaque ? "Image" : `${shortSub} image`;
    case "video":
      return opaque ? "Video" : `${shortSub} video`;
    case "audio":
      return opaque ? "Audio" : `${shortSub} audio`;
    case "text":
      return opaque ? "Text" : `${shortSub} text`;
    default:
      return opaque ? "File" : `${shortSub} file`;
  }
}

interface PanelDropUploadStats {
  uploaded: number;
  skippedDuplicates: number;
  skippedJunk: number;
  failed: number;
  failedNames: string[];
}

interface FolderUploadPlan {
  // Files to upload, each tagged with its relative directory chain ([] = directly under the target).
  files: Array<{ file: File; dir: string[] }>;
  // Every directory path seen while walking — drives folder recreation (so empty folders appear too).
  dirs: string[][];
  skippedJunk: number;
}

// Synchronously turn a drop's items into FileSystemEntry handles via webkitGetAsEntry(). MUST run
// inside the drop handler before any await: the DataTransfer items are live only for that tick.
function captureDropEntries(dataTransfer: DataTransfer | null): FileSystemEntry[] {
  if (!dataTransfer || !dataTransfer.items) {
    return [];
  }
  const entries: FileSystemEntry[] = [];
  for (let index = 0; index < dataTransfer.items.length; index += 1) {
    const item = dataTransfer.items[index];
    if (item.kind !== "file") {
      continue;
    }
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function isDirectoryEntry(entry: FileSystemEntry): boolean {
  return entry.isDirectory;
}

// Walk the captured entry tree (async — this is the part that runs after the synchronous capture)
// into a flat plan of files + directories, skipping OS junk files along the way.
async function walkDropEntries(entries: FileSystemEntry[]): Promise<FolderUploadPlan> {
  const plan: FolderUploadPlan = { files: [], dirs: [], skippedJunk: 0 };
  for (const entry of entries) {
    await visitDropEntry(entry, [], plan);
  }
  return plan;
}

async function visitDropEntry(entry: FileSystemEntry, dir: string[], plan: FolderUploadPlan): Promise<void> {
  if (entry.isFile) {
    const file = await entryToFile(entry as FileSystemFileEntry);
    if (file.name.trim().length === 0) {
      return;
    }
    if (isJunkFileName(file.name)) {
      plan.skippedJunk += 1;
      return;
    }
    plan.files.push({ file, dir });
    return;
  }

  if (entry.isDirectory) {
    const childDir = [...dir, entry.name];
    plan.dirs.push(childDir);
    const children = await readAllDirectoryEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) {
      await visitDropEntry(child, childDir, plan);
    }
  }
}

function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

// readEntries() is paginated: each call yields a batch (browsers cap it, often at 100) and an empty
// array signals the end. Loop until drained so large folders aren't silently truncated.
function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function sortDirsByDepth(dirs: string[][]): string[][] {
  return [...dirs].sort((left, right) => left.length - right.length);
}

function describePanelDropItems(
  entries: FileSystemEntry[],
  files: File[],
): Array<{ name: string; kind: "File" | "Folder" }> {
  if (entries.length > 0) {
    return entries
      .filter((entry) => entry.name.trim().length > 0)
      .map((entry) => ({ name: entry.name, kind: entry.isDirectory ? "Folder" : "File" }));
  }

  return files.map((file) => ({ name: file.name, kind: "File" }));
}

function formatTreeUploadProgress(
  current: number,
  total: number,
  targetName: string,
  displayPath: string,
  foldersCreated: number,
  stats: PanelDropUploadStats,
): string {
  const status = [
    `${stats.uploaded} uploaded`,
    `${formatCount(foldersCreated, "folder")}`,
    `${stats.failed} failed`,
  ].join(", ");
  return `Uploading ${current}/${total} to ${targetName}: ${displayPath} (${status})`;
}

function formatTreeUploadSummary(targetName: string, foldersCreated: number, stats: PanelDropUploadStats): string {
  const parts = [
    `${formatCount(stats.uploaded, "file")} uploaded to ${targetName}`,
    `${formatCount(foldersCreated, "folder")} created`,
  ];
  if (stats.skippedJunk > 0) {
    parts.push(`${formatCount(stats.skippedJunk, "junk file")} skipped`);
  }
  if (stats.failed > 0) {
    const failedNames = stats.failedNames.slice(0, 3).join(", ");
    const extra = stats.failedNames.length > 3 ? `, +${stats.failedNames.length - 3} more` : "";
    parts.push(`${formatCount(stats.failed, "file")} failed (${failedNames}${extra})`);
  }
  return `Drive panel folder upload complete: ${parts.join("; ")}.`;
}

function hasLocalFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }
  return Array.from(dataTransfer.types).includes("Files") || dataTransfer.files.length > 0;
}

function extractPanelDropFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.files).filter((file) => file.name.trim().length > 0);
}

function isJunkFileName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === ".ds_store" || normalized === "thumbs.db";
}

function formatPanelUploadProgress(
  current: number,
  total: number,
  targetName: string,
  stats: PanelDropUploadStats,
  fileName?: string,
): string {
  const status = [
    `${stats.uploaded} uploaded`,
    `${stats.skippedDuplicates} duplicate`,
    `${stats.failed} failed`,
  ].join(", ");
  const activeFile = fileName ? `: ${fileName}` : "";
  return `Uploading ${current}/${total} to ${targetName}${activeFile} (${status})`;
}

function formatPanelUploadSummary(targetName: string, stats: PanelDropUploadStats): string {
  const parts = [
    `${formatCount(stats.uploaded, "file")} uploaded to ${targetName}`,
    `${formatCount(stats.skippedDuplicates, "duplicate")} skipped`,
  ];
  if (stats.skippedJunk > 0) {
    parts.push(`${formatCount(stats.skippedJunk, "junk file")} skipped`);
  }
  if (stats.failed > 0) {
    const failedNames = stats.failedNames.slice(0, 3).join(", ");
    const extra = stats.failedNames.length > 3 ? `, +${stats.failedNames.length - 3} more` : "";
    parts.push(`${formatCount(stats.failed, "file")} failed (${failedNames}${extra})`);
  }
  return `Drive panel upload complete: ${parts.join("; ")}.`;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function normalizeTypeAhead(value: string): string {
  return value.trimStart().toLowerCase();
}

// Two breadcrumb trails point at the same place iff their segment ids match in order.
function samePathIds(a: DrivePanelLocation[], b: DrivePanelLocation[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((location, index) => location.id === b[index].id);
}

function menuPositionForElement(element: HTMLElement): { x: number; y: number; width: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 2, width: rect.width };
}

// Find the child folder a path segment names — exact match first, then case-insensitive. Files are
// ignored. Drive permits duplicate folder names; the first match wins (good enough for path jumps).
function pickFolderByName(items: DriveBrowserItem[], name: string): DriveBrowserItem | null {
  const folders = items.filter((item) => item.mimeType === DRIVE_FOLDER_MIME_TYPE);
  const exact = folders.find((folder) => folder.name === name);
  if (exact) {
    return exact;
  }
  const lower = name.toLowerCase();
  return folders.find((folder) => folder.name.toLowerCase() === lower) ?? null;
}

// Drive returns folderColorRgb as a "#RRGGBB" hex string from its fixed palette. Validate before
// tinting so a malformed/unexpected value can't reach the inline style; an invalid or absent color
// leaves the folder its default muted tint.
function folderColorHex(rgb: string | undefined): string | null {
  if (!rgb) {
    return null;
  }
  const trimmed = rgb.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : null;
}

function trashMenuTitle(targets: DriveBrowserItem[]): string {
  if (targets.length > 1) {
    return `Move ${formatCount(targets.length, "item")} to trash`;
  }
  return "Move to trash";
}

function restoreMenuTitle(targets: DriveBrowserItem[]): string {
  return targets.length > 1 ? `Restore ${formatCount(targets.length, "item")}` : "Restore";
}

function deleteForeverMenuTitle(targets: DriveBrowserItem[]): string {
  return targets.length > 1 ? `Delete ${formatCount(targets.length, "item")} forever` : "Delete forever";
}

function moveMenuTitle(targets: DriveBrowserItem[]): string {
  return targets.length > 1 ? `Move ${formatCount(targets.length, "item")}...` : "Move to...";
}

function starMenuTitle(targets: DriveBrowserItem[], remove: boolean): string {
  if (targets.length === 1) {
    return remove ? "Remove from Starred" : "Add to Starred";
  }
  return `${remove ? "Remove" : "Add"} ${formatCount(targets.length, "item")} ${remove ? "from" : "to"} Starred`;
}

function copyMenuTitle(targets: DriveBrowserItem[]): string {
  return targets.length > 1 ? `Make ${formatCopyCount(targets.length)}` : "Make a copy";
}

function downloadMenuTitle(targets: DriveBrowserItem[], downloadableCount: number): string {
  if (downloadableCount === 0) {
    return "Download unavailable";
  }
  return targets.length > 1 ? `Download ${formatCount(downloadableCount, "file")}...` : "Download to vault";
}

function formatTrashSummary(trashed: number, failedNames: string[]): string {
  const parts = [`${formatCount(trashed, "item")} moved to Drive trash`];
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "item")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

function formatRestoreSummary(restored: number, failedNames: string[]): string {
  const parts = [`${formatCount(restored, "item")} restored from Drive trash`];
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "item")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

function formatPermanentDeleteSummary(deleted: number, failedNames: string[]): string {
  const parts = [`${formatCount(deleted, "item")} permanently deleted from Drive`];
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "item")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

function formatMoveSummary(moved: number, failedNames: string[], targetName: string): string {
  const parts = [`${formatCount(moved, "item")} moved to ${targetName}`];
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "item")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

function formatStarredSummary(updated: number, failedNames: string[], starred: boolean): string {
  const parts = [
    `${formatCount(updated, "item")} ${starred ? "added to" : "removed from"} Starred`,
  ];
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "item")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

function formatCopySummary(copied: number, failedNames: string[], targetName: string): string {
  const parts = [`${formatCopyCount(copied)} created in ${targetName}`];
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "item")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

function formatCopyCount(count: number): string {
  return `${count} ${count === 1 ? "copy" : "copies"}`;
}

function formatDownloadSummary(savedPaths: string[], failedNames: string[], skippedUnsupported: number): string {
  if (savedPaths.length === 1 && failedNames.length === 0 && skippedUnsupported === 0) {
    return `Downloaded to ${savedPaths[0]}.`;
  }

  const parts = [`${formatCount(savedPaths.length, "file")} downloaded to the vault`];
  if (skippedUnsupported > 0) {
    parts.push(`${formatCount(skippedUnsupported, "unsupported item")} skipped`);
  }
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "file")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

function isDownloadableDriveFile(item: DriveBrowserItem): boolean {
  return item.mimeType !== DRIVE_FOLDER_MIME_TYPE && !item.mimeType.startsWith("application/vnd.google-apps.");
}

function sanitizeDownloadedFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "")
    .trim();
  return sanitized.length > 0 ? sanitized : "Downloaded Drive file";
}
