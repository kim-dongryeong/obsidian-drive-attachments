import {
  Editor,
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Scope,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { formatBytes } from "./byteFormat";
import { DriveDedupService } from "./driveDedupService";
import { DriveAuthService } from "./driveAuthService";
import { DriveIndexService } from "./driveIndexService";
import {
  DriveBrowserItem,
  DriveMetadata,
  DriveMetadataService,
} from "./driveMetadataService";
import { DrivePreviewService } from "./drivePreviewService";
import {
  folderColorHex,
  formatDetailMetadataError,
  formatItemDetails,
  formatModifiedTime,
  formatPanelOwner,
  friendlyMimeType,
  itemHasOwner,
  itemModifiedSince,
  matchesTypeCategory,
  modifiedRangeCutoff,
  PANEL_MODIFIED_OPTIONS,
  PANEL_TYPE_OPTIONS,
  PanelModifiedRange,
  panelModifiedIcon,
  panelModifiedLabel,
  panelModifiedPhrase,
  panelOwnerOptions,
  PanelOwnerOption,
  panelPrimaryOwnerLabel,
  PanelTypeCategory,
  panelTypeIcon,
  panelTypeLabel,
  panelViewIcon,
  sortDirectionOptions,
  sortDriveItems,
  sortDriveItemsByTrashedTime,
} from "./drivePanelFormat";
import {
  hasLocalFileDrag,
  isJunkFileName,
} from "./drivePanelDropUtil";
import {
  copyMenuTitle,
  deleteForeverMenuTitle,
  downloadMenuTitle,
  formatCopySummary,
  formatCount,
  formatDownloadSummary,
  formatMoveSummary,
  formatPermanentDeleteSummary,
  formatRestoreSummary,
  formatStarredSummary,
  formatTrashSummary,
  isDownloadableDriveFile,
  moveMenuTitle,
  restoreMenuTitle,
  sanitizeDownloadedFileName,
  starMenuTitle,
  trashMenuTitle,
} from "./drivePanelText";
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
import { DrivePanelThumbnails } from "./drivePanelThumbnails";
import { DrivePanelDataController } from "./drivePanelDataController";
import { DrivePanelUploadController, PanelUploadCardState } from "./drivePanelUploadController";
import {
  DrivePanelSearchController,
  PanelSearchLocation,
  PanelSearchLocationOption,
  panelSearchLocationOption,
} from "./drivePanelSearchController";
import {
  DrivePanelLocation,
  isVirtualRootId,
  MY_DRIVE_ROOT,
  RECENT_ROOT,
  rootBreadcrumbGlyph,
  SHARED_WITH_ME_ROOT,
  STARRED_ROOT,
  TRASH_ROOT,
  virtualRootName,
} from "./drivePanelLocation";
import {
  FolderColorPickerModal,
  NewDriveFolderModal,
  PanelDeleteConfirmModal,
  PanelDropConfirmModal,
  PanelFolderPickerModal,
  PanelPermanentDeleteConfirmModal,
  RenameDriveItemModal,
} from "./drivePanelModals";

// Legacy internal id from the pre-rename era ("Drive Attachment Bridge") — kept so existing vaults'
// saved workspace layouts still resolve this view. Same for the `gdab-` CSS/MIME prefixes: internal
// namespaces, not user-visible; renaming them buys nothing and breaks compatibility.
export const DRIVE_PANEL_VIEW_TYPE = "drive-attachment-bridge-panel";

interface DrivePanelDetailRecord {
  metadata: DriveMetadata;
  thumbnailUrl: string | null;
}


const TYPE_AHEAD_RESET_MS = 900;

// DataTransfer marker stamped on a Drive-internal row drag. Detection actually keys off the in-memory
// `internalDrag` field; this payload only ensures Electron registers the drag and keeps the move/copy
// path cleanly distinct from an OS-file drop (which uploads).
const DRIVE_INTERNAL_DRAG_MIME = "application/x-gdab-drive-items";

export class DrivePanelView extends ItemView {
  private readonly path: DrivePanelLocation[] = [{ ...MY_DRIVE_ROOT }];
  // Panel drag-and-drop upload workflow + in-flight guard — see drivePanelUploadController.ts
  // (T-011 P8). The view keeps drag visuals, the confirm modal, and folder reloads.
  private readonly uploadCtl: DrivePanelUploadController;
  // Hybrid search + chip-filter state (query, scope, index/server merge, Type/People/Modified) —
  // see drivePanelSearchController.ts (T-011 P7). The view reads state and calls search methods.
  private readonly searchCtl: DrivePanelSearchController;
  // Folder listings, pagination tokens, shared-drive roots, and their generation guards — see
  // drivePanelDataController.ts (T-011 P6). The view reads state and calls load methods on it.
  private readonly data: DrivePanelDataController;
  // True when the keyboard cursor sits on the "Load more" button (arrow-down past the last row parks
  // it there — revealing the button like a mouse scroll would — instead of auto-fetching the page).
  private loadMoreCursorActive = false;
  private panelDropEventsRegistered = false;
  // One in-flight guard for panel Drive-write ops (rename/trash), separate from upload drops, so a
  // mutation and its follow-up reload can't overlap a second mutation fired in quick succession.
  private panelWriteInFlight = false;
  // One in-flight guard for an address-bar path resolution (a chain of `listFolder` reads) so a
  // second Enter can't start a competing walk while the first is mid-flight.
  private addressBarBusy = false;
  private addressBarEditing = false;
  private dropHintEl: HTMLElement | null = null;
  private uploadCardEl: HTMLElement | null = null;
  // The Drive items being dragged within the panel (a row, or the whole selection). Non-null only
  // during a Drive-internal drag; lets the folder-row handlers route to MOVE/COPY instead of upload.
  private internalDrag: DriveBrowserItem[] | null = null;
  private readonly selectedItemIds = new Set<string>();
  private selectionAnchorId: string | null = null;
  // Roving keyboard cursor: the row ↑/↓ move from and Enter acts on. Kept in sync with mouse
  // selection so a click then arrows feels continuous. `selectionAnchorId` stays the fixed end for
  // Shift-range extension; `activeItemId` is the moving end.
  private activeItemId: string | null = null;
  // After navigating up a level, the cursor should land on the child folder we just left (Finder
  // behaviour) rather than the top of the list. navigateUp records that folder id here; the next
  // load applies it once the parent's items are present.
  private pendingActiveItemId: string | null = null;
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
  // View-side lazy-thumbnail machinery (observer/queue/failures) — see drivePanelThumbnails.ts.
  private readonly panelThumbnails: DrivePanelThumbnails;
  // Search-only sort state (session-scoped): drive.google.com search offers exactly Most relevant
  // and Date modified (asc/desc) — name/size sorts are meaningless over a relevance-capped partial
  // result set, so we mirror that. null = Most relevant (the fuzzy-score/merge order).
  private searchSortByModified = false;
  private searchSortDir: PanelSortDir = "desc";
  // Trash-only sort state (session-scoped, not persisted): drive.google.com's Trash defaults to
  // "Date trashed" — a key that doesn't exist outside the Trash view, so it can't live in
  // panelSortKey. null = Date trashed; a PanelSortKey overrides it for this view instance.
  private trashSortOverride: PanelSortKey | null = null;
  private trashSortDir: PanelSortDir = "desc";

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
    this.panelThumbnails = new DrivePanelThumbnails(this.thumbnails, () => this.contentEl);
    // A view-local keymap scope: active while this leaf has focus, and consulted BEFORE the global
    // hotkeys — the only reliable way to keep F2 from triggering Obsidian's "rename note title"
    // (its keymap runs in the capture phase, so a list-level stopPropagation can't beat it).
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "F2", () => {
      const list = this.listEl;
      if (!list || this.contentEl.ownerDocument.activeElement !== list) {
        return true; // focus is elsewhere (e.g. the panel's search input) — let the default run
      }
      const active = this.getActiveItem();
      if (!active) {
        return true;
      }
      this.resetTypeAheadBuffer();
      this.openRenameModal(active);
      return false; // handled: preventDefault + stop the global hotkey
    });
    this.uploadCtl = new DrivePanelUploadController(upload, dedup, {
      canBrowse: () => this.canBrowse(),
      dropUploadMode: () => this.getSettings().panelDropUpload,
      currentFolderId: () => this.currentLocation.id,
      setUploadingUi: (active) => this.contentEl.toggleClass("is-uploading", active),
      setDropHint: (text) => this.setDropHint(text),
      clearDropVisuals: () => {
        this.setPanelDropHighlight(false);
        this.clearFolderRowDropHighlight();
      },
      confirmDrop: (entries, files, target, targetBreadcrumb, onConfirm) =>
        this.openPanelDropConfirmModal(entries, files, target, targetBreadcrumb, onConfirm),
      refreshTargetFolder: async (targetId) => {
        if (this.currentLocation.id === targetId) {
          await this.data.loadCurrentFolder(true);
        } else {
          this.data.invalidate(targetId);
        }
      },
      showUploadCard: (state) => this.renderUploadCard(state),
      existingTargetNames: async (targetId) => {
        const items = await this.data.getBreadcrumbFolderItems(targetId);
        return new Set(items.map((item) => item.name));
      },
    });
    this.searchCtl = new DrivePanelSearchController(index, search, {
      currentPath: () => this.path,
      currentLocationId: () => this.currentLocation.id,
      render: () => this.render(),
      refreshListOnly: () => this.refreshListOnly(),
      clearSelection: () => this.clearSelection(false),
    });
    this.data = new DrivePanelDataController(metadata, {
      canBrowse: () => this.canBrowse(),
      currentFolderId: () => this.currentLocation.id,
      render: () => this.render(),
      onCannotBrowse: () => this.clearSelection(false),
      onFolderItemsApplied: (folderId) => this.pruneSelection(this.data.getCached(folderId) ?? []),
      onFolderLoadSettled: () => this.applyPendingActiveItem(),
      onForceRefresh: () => this.panelThumbnails.clearFailures(),
      onLoadMoreStarted: () => {
        this.loadMoreCursorActive = false;
      },
    });
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
    void this.data.loadRoots(false);
    void this.searchCtl.ensurePanelIndex().catch(() => undefined);
    await this.data.loadCurrentFolder(false);
  }

  async onClose(): Promise<void> {
    // Abandon any in-flight folder/root load so its late .then can't paint a torn-down view.
    this.data.cancelInFlight();
    this.searchCtl.cancelDriveSearch();
    this.searchCtl.resetIndexPromise();
    this.data.invalidateAll();
    this.clearSelection(false);
    this.resetTypeAheadBuffer();
    this.setPanelDropHighlight(false);
    this.contentEl.removeClass("is-uploading");
    this.panelWriteInFlight = false;
    this.internalDrag = null;
    this.panelThumbnails.reset();
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
    this.searchCtl.exitDriveSearch();
    this.searchCtl.resetIndexPromise();
    void this.data.loadRoots(true);
    if (this.canBrowse()) {
      void this.searchCtl.ensurePanelIndex().catch(() => undefined);
    }
    void this.data.loadCurrentFolder(true);
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
    if (active && this.uploadCtl.inFlight) {
      // An upload is running: the drop is accepted and queued (drive.google.com behavior).
      this.setDropHint("Drop to queue — uploads after the current batch.");
      return;
    }
    this.setDropHint(active ? `Upload to "${this.currentLocation.name}"` : null);
  }

  private handlePanelDrop(evt: DragEvent): void {
    // A drop on empty space or a file row targets the folder currently shown in the panel.
    this.uploadCtl.processPanelDrop(evt, this.currentLocation, this.currentBreadcrumb);
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
    this.uploadCtl.processPanelDrop(evt, { id: item.id, name: item.name }, breadcrumb);
  }

  private canAcceptPanelDrop(target: DrivePanelLocation = this.currentLocation): boolean {
    // An in-flight upload no longer blocks the drop — it queues (drive.google.com behavior).
    return !isVirtualRootId(target.id)
      && this.getSettings().panelDropUpload !== "off"
      && this.canBrowse();
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
      if (el.instanceOf(HTMLElement) && el.dataset.itemId !== undefined && draggedIds.has(el.dataset.itemId)) {
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

  // drive.google.com-style in-panel upload progress card (bottom of the panel): target, n/m
  // progress, the file in flight, and a Cancel button that stops before the next file.
  private renderUploadCard(state: PanelUploadCardState | null): void {
    if (!state) {
      this.uploadCardEl?.remove();
      this.uploadCardEl = null;
      return;
    }
    if (!this.uploadCardEl || !this.contentEl.contains(this.uploadCardEl)) {
      this.uploadCardEl?.remove();
      this.uploadCardEl = this.contentEl.createDiv({ cls: "gdab-drive-panel-upload-card" });
    }
    const card = this.uploadCardEl;
    card.empty();
    card.createDiv({ cls: "gdab-drive-panel-upload-card-title", text: "Uploading to Google Drive" });
    card.createDiv({ cls: "gdab-drive-panel-upload-card-target", text: `Target: ${state.targetName}` });
    card.createDiv({
      cls: "gdab-drive-panel-upload-card-progress",
      text: state.currentFile ? `${state.done}/${state.total} · ${state.currentFile}` : `${state.done}/${state.total}`,
    });
    if (state.queued > 0) {
      card.createDiv({
        cls: "gdab-drive-panel-upload-card-queued",
        text: `${state.queued} ${state.queued === 1 ? "batch" : "batches"} queued — uploads next`,
      });
    }
    const barWrap = card.createDiv({ cls: "gdab-drive-panel-upload-card-bar" });
    const fill = barWrap.createDiv({ cls: "gdab-drive-panel-upload-card-bar-fill" });
    fill.style.width = `${state.total > 0 ? Math.round(((state.done - 1) / state.total) * 100) : 0}%`;
    if (state.cancellable) {
      const cancel = card.createEl("button", { cls: "gdab-drive-panel-upload-card-cancel", text: "Cancel" });
      cancel.addEventListener("click", () => {
        cancel.disabled = true;
        cancel.setText("Cancelling…");
        this.uploadCtl.requestCancel();
      });
    }
  }

  private openPanelDropConfirmModal(
    entries: FileSystemEntry[],
    files: File[],
    target: DrivePanelLocation,
    targetBreadcrumb: string,
    onConfirm: () => void,
  ): void {
    new PanelDropConfirmModal(this.app, {
      entries,
      files,
      targetBreadcrumb,
      targetName: target.name,
      onConfirm,
    }).open();
  }

  private get currentLocation(): DrivePanelLocation {
    return this.path[this.path.length - 1];
  }

  private get currentBreadcrumb(): string {
    return this.path.map((location) => location.name).join(" / ");
  }

  private canBrowse(): boolean {
    const settings = this.getSettings();
    return settings.enableDriveSearch && this.auth.hasDriveSearchScope;
  }

  private render(): void {
    const { contentEl } = this;
    // A full rebuild recreates the Load more button fresh (no cursor highlight), so drop the parked
    // state to match — an arrow-down re-parks it if the cursor is still on the last row.
    this.loadMoreCursorActive = false;
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

    this.panelThumbnails.disconnectObserver();
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
    // Always-reachable "New folder" — the empty-space context menu needs blank space below the rows,
    // which a long listing never shows without scrolling to the very bottom (kdr QA).
    iconButton("folder-plus", "New folder", this.isCurrentVirtualRoot(), () => this.openNewFolderModal());
    iconButton("refresh-cw", "Refresh", false, () => {
      void this.data.loadRoots(true);
      void this.data.loadCurrentFolder(true);
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
          void this.data.loadRoots(true);
          return this.data.loadCurrentFolder(true);
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

    // While searching, the results can come from anywhere in Drive, so the path trail is meaningless
    // — show "Search results" instead (drive.google.com parity). Each result's true location is
    // reachable via its row menu's "Open location".
    if (this.searchCtl.isDriveSearchActive()) {
      breadcrumbs.addClass("is-search-results");
      breadcrumbs.createSpan({
        cls: "gdab-drive-panel-breadcrumb is-current",
        text: "Search results",
        attr: { "aria-current": "true" },
      });
      return null;
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
        this.searchCtl.exitDriveSearch();
        this.path.splice(index + 1);
        this.pushHistory();
        this.clearSelection(false);
        void this.data.loadCurrentFolder(false);
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
      const items = await this.data.getBreadcrumbFolderItems(parent.id);
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
      this.data.sharedDriveRoots.map((root) => ({ id: root.id, name: root.name })),
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
    if (this.data.rootsLoading) {
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
        ...this.data.sharedDriveRoots.map((root) => ({ id: root.id, name: root.name })),
      ];
    }

    const parent = this.path[index - 1];
    if (!parent) {
      return [];
    }

    const items = await this.data.getBreadcrumbFolderItems(parent.id);
    return items
      .filter((item) => item.mimeType === DRIVE_FOLDER_MIME_TYPE)
      .map((item) => ({ id: item.id, name: item.name }));
  }

  private navigateToBreadcrumbSibling(index: number, location: DrivePanelLocation): void {
    const currentSegment = this.path[index];
    if (!currentSegment || currentSegment.id === location.id) {
      return;
    }

    this.searchCtl.exitDriveSearch();
    this.resetTypeAheadBuffer();
    const previousRootId = this.path[0]?.id;
    const nextPath = this.path.slice(0, index).map((segment) => ({ ...segment }));
    nextPath.push({ ...location });
    this.path.splice(0, this.path.length, ...nextPath);
    this.pushHistory();
    if (index === 0 && previousRootId !== location.id) {
      this.data.invalidateAll();
    }
    this.clearSelection(false);
    void this.data.loadCurrentFolder(false);
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
        const items = await this.data.getBreadcrumbFolderItems(parentId);
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

      this.searchCtl.exitDriveSearch();
      this.resetTypeAheadBuffer();
      const previousRootId = this.path[0]?.id;
      this.path.splice(0, this.path.length, ...resolved);
      this.pushHistory();
      if (previousRootId !== resolved[0].id) {
        this.data.invalidateAll();
      }
      this.clearSelection(false);
      this.addressBarEditing = false;
      void this.data.loadCurrentFolder(false);
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

    if (this.searchCtl.isDriveSearchActive()) {
      const rawItems = this.searchCtl.getDriveSearchItems();
      if (this.searchCtl.searchLoading && rawItems.length === 0) {
        this.renderLoadingSkeleton(list, "Searching Drive...");
        return;
      }

      if (this.searchCtl.searchError && rawItems.length === 0) {
        const error = list.createDiv({
          cls: "gdab-drive-panel-state is-entering",
          attr: { role: "alert" },
        });
        error.createDiv({ cls: "gdab-drive-panel-state-title", text: "Could not search Google Drive." });
        error.createDiv({ cls: "gdab-drive-panel-state-detail", text: this.searchCtl.searchError });
        error.createEl("button", { text: "Retry" }).addEventListener("click", () => {
          this.searchCtl.queueDriveSearch(true);
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

    if (this.data.loadingFolderId === folderId) {
      this.renderLoadingSkeleton(list);
      return;
    }

    if (this.data.errorMessage) {
      const error = list.createDiv({
        cls: "gdab-drive-panel-state is-entering",
        attr: { role: "alert" },
      });
      error.createDiv({
        cls: "gdab-drive-panel-state-title",
        text: this.isCurrentVirtualRoot() ? `Could not load ${this.currentVirtualRootName()}.` : "Could not load this Drive folder.",
      });
      error.createDiv({ cls: "gdab-drive-panel-state-detail", text: this.data.errorMessage });
      error.createEl("button", { text: "Retry" }).addEventListener("click", () => {
        void this.data.loadCurrentFolder(true);
      });
      return;
    }

    const rawItems = this.data.getCached(folderId) ?? [];
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
    if (!this.data.hasMorePages(folderId)) {
      return;
    }
    const isLoading = this.data.loadingMoreFolderId === folderId;
    const row = list.createDiv({ cls: "gdab-drive-panel-load-more" });
    const button = row.createEl("button", {
      cls: "gdab-drive-panel-load-more-button",
      text: isLoading ? "Loading more..." : "Load more",
    });
    button.disabled = isLoading;
    button.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void this.data.loadMoreCurrentFolder();
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
      // EVERY folder goes through the same mask+fill pipeline: the API sends folderColorRgb for
      // listed folders (default gray #8f8f8f included), but search-index hits omit the field —
      // rendering those as the raw pack image made the same folder gray in browsing and the pack's
      // own color in search results (kdr QA). Missing value = Drive's default gray.
      const color = folderColorHex(item.folderColorRgb) ?? "#8f8f8f";
      // Custom-pack <img> and bundled-theme SVGs carry their own baked colors, so a CSS tint
      // can't reach them directly. Keep the PACK's folder silhouette by using the pack image as a
      // CSS mask filled with the Drive color; only without pack art fall back to a tinted glyph.
      const packSrc = this.customIconSrc?.(item.mimeType, item.name);
      icon.empty();
      if (packSrc) {
        const tinted = icon.createSpan({ cls: "gdab-folder-tint-mask", attr: { "aria-hidden": "true" } });
        tinted.style.setProperty("--gdab-folder-mask", `url("${packSrc}")`);
        tinted.style.backgroundColor = color;
      } else {
        // folder-closed = folder silhouette + an inner horizontal line; the CSS strokes only that
        // line in the background color, so the flap edge shows without outlining the whole glyph.
        setIcon(icon, "folder-closed");
        icon.style.color = color;
        icon.addClass("is-folder-colored");
      }
    } else if (item.thumbnailLink && this.getSettings().panelViewMode === "grid") {
      // Thumbnails are a GRID-view affordance only — list/compact keep the type icon (kdr: thumbnails
      // were leaking into list/compact). renderFileIcon already drew the icon above; only grid swaps it.
      this.panelThumbnails.renderInto(icon, item.id, item.thumbnailLink);
    }

    const main = row.createDiv({ cls: "gdab-drive-panel-row-main" });
    const title = main.createDiv({ cls: "gdab-drive-panel-row-title" });
    // Narrow-sidebar rows truncate long names (more so in grid); a native tooltip reveals the full
    // name on hover, like Finder/Explorer/Drive. `attr` sets the attribute safely (no innerHTML).
    const nameEl = title.createDiv({ cls: "gdab-drive-panel-row-name", attr: { title: item.name } });
    if (this.searchCtl.isDriveSearchActive()) {
      // While searching, highlight the matched query tokens in the result name — reuse the search
      // modal's DOM-span highlighter (colored gdab-search-hl-* spans, injection-safe, never innerHTML)
      // so the panel and the modal mark matches identically. Browse rows keep plain text.
      renderSearchHighlights(item.name, this.searchCtl.filterQuery, nameEl);
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
    if (this.searchCtl.isDriveSearchActive() && item.path) {
      // Search hits show WHERE they live, tucked onto the right end of the existing meta line (no
      // extra row — kdr). Long paths ellipsize at the START so the nearest folders stay readable;
      // hover reveals the full path.
      meta.createSpan({
        cls: "gdab-drive-panel-row-path",
        text: item.path,
        attr: { title: item.path },
      });
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
    if (evt.key === "Escape" && this.searchCtl.isDriveSearchActive()) {
      // Esc with the LIST focused ends search mode too — the input's own Esc handler only fires
      // while the box has focus, which it never does after clicking/arrowing into the results.
      evt.preventDefault();
      evt.stopPropagation();
      this.searchCtl.exitDriveSearch();
      void this.data.loadCurrentFolder(false);
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

    // Finder/Explorer keyboard affordances on the focused row: F2 renames (Explorer), and the
    // platform context-menu chords — Ctrl+Enter (Finder), Shift+F10 and the dedicated ≣ menu key
    // (Explorer) — open the same menu as a right-click on the row.
    if (evt.key === "F2") {
      const active = this.getActiveItem();
      if (active) {
        // stopPropagation too: Obsidian's global F2 hotkey (rename the active note title) also
        // listens on keydown and would otherwise steal focus to the editor (kdr QA).
        evt.preventDefault();
        evt.stopPropagation();
        this.resetTypeAheadBuffer();
        this.openRenameModal(active);
      }
      return;
    }
    if (
      evt.key === "ContextMenu" ||
      (evt.key === "F10" && evt.shiftKey) ||
      (evt.key === "Enter" && evt.ctrlKey && !evt.metaKey)
    ) {
      const active = this.getActiveItem();
      if (active) {
        evt.preventDefault();
        evt.stopPropagation();
        this.resetTypeAheadBuffer();
        this.openMenuForActiveRow(active);
      }
      return;
    }

    switch (evt.key) {
      case "ArrowDown":
        evt.preventDefault();
        if (this.loadMoreCursorActive) {
          // Cursor already parked on Load more → a second arrow-down fetches the next page.
          void this.data.loadMoreCurrentFolder();
          return;
        }
        // At the last item with more pages pending, arrow-down reveals + parks the cursor on the
        // "Load more" button rather than dead-ending at the bottom (or auto-loading).
        if (this.tryFocusLoadMore()) {
          return;
        }
        this.moveActiveCursor(this.verticalStep(), evt.shiftKey);
        return;
      case "Home":
        evt.preventDefault();
        this.setActiveCursorToIndex(0, evt.shiftKey);
        return;
      case "End":
        evt.preventDefault();
        this.setActiveCursorToIndex(this.getCurrentItems().length - 1, evt.shiftKey);
        return;
      case "PageDown":
        evt.preventDefault();
        this.moveActiveCursor(this.pageStep(), evt.shiftKey);
        return;
      case "PageUp":
        evt.preventDefault();
        this.moveActiveCursor(-this.pageStep(), evt.shiftKey);
        return;
      case "ArrowUp":
        evt.preventDefault();
        if (this.loadMoreCursorActive) {
          // Step back off the Load more button onto the last row.
          this.setLoadMoreCursor(false);
          return;
        }
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
        if (this.loadMoreCursorActive) {
          void this.data.loadMoreCurrentFolder();
          return;
        }
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

  // Move the cursor to an absolute index (Home/End), clamped into range.
  private setActiveCursorToIndex(index: number, extend: boolean): void {
    const items = this.getCurrentItems();
    if (items.length === 0) {
      return;
    }
    this.resetTypeAheadBuffer();
    const target = items[Math.min(items.length - 1, Math.max(0, index))];
    this.scrollActiveIntoView = true;
    if (extend) {
      this.selectRangeTo(target.id, true);
    } else {
      this.selectOnly(target.id, true);
    }
  }

  // How many items a PageUp/PageDown jumps: about one viewport of rows (grid multiplies by columns).
  private pageStep(): number {
    const list = this.listEl;
    const rows = list ? Array.from(list.querySelectorAll<HTMLElement>(".gdab-drive-panel-row")) : [];
    const rowHeight = rows[0]?.offsetHeight || 28;
    const visibleRows = list ? Math.max(1, Math.floor(list.clientHeight / rowHeight) - 1) : 10;
    const columns = this.getSettings().panelViewMode === "grid" ? this.gridColumnCount() : 1;
    return visibleRows * columns;
  }

  // Arrow-down past the last row: park the cursor ON the "Load more" button (scroll it into view +
  // highlight) instead of auto-fetching — a mouse user scrolls a hair to reveal that button, so the
  // keyboard should reveal it too. A second arrow-down (or Enter) on the button then fetches the page.
  // Returns true when the key was consumed here.
  private tryFocusLoadMore(): boolean {
    if (this.searchCtl.isDriveSearchActive() || this.data.loadingMoreFolderId !== null) {
      return false;
    }
    if (!this.data.hasMorePages(this.currentLocation.id)) {
      return false;
    }
    const items = this.getCurrentItems();
    if (items.length === 0 || this.activeItemId !== items[items.length - 1].id) {
      return false;
    }
    if (!this.loadMoreButtonEl()) {
      return false;
    }
    this.setLoadMoreCursor(true);
    return true;
  }

  private loadMoreButtonEl(): HTMLElement | null {
    return this.listEl?.querySelector<HTMLElement>(".gdab-drive-panel-load-more-button") ?? null;
  }

  // Move the visible keyboard cursor onto (true) or off (false) the Load more button. On: drop the row
  // highlight and reveal the button. Off: restore the active row's highlight (activeItemId is unchanged).
  private setLoadMoreCursor(active: boolean): void {
    this.loadMoreCursorActive = active;
    const button = this.loadMoreButtonEl();
    if (active) {
      this.listEl
        ?.querySelectorAll<HTMLElement>(".gdab-drive-panel-row.is-active")
        .forEach((row) => row.removeClass("is-active"));
      button?.addClass("is-cursor");
      button?.scrollIntoView({ block: "nearest" });
    } else {
      button?.removeClass("is-cursor");
      this.refreshSelectionOnly(true);
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

  // The item under the keyboard cursor, or null when no row is active.
  private getActiveItem(): DriveBrowserItem | null {
    if (!this.activeItemId) {
      return null;
    }
    return this.getCurrentItems().find((candidate) => candidate.id === this.activeItemId) ?? null;
  }

  // Keyboard context menu (Ctrl+Enter / Shift+F10 / ≣): open the row's right-click menu anchored to
  // the active row itself — synthesize the MouseEvent showAtMouseEvent reads coordinates from.
  private openMenuForActiveRow(item: DriveBrowserItem): void {
    if (!this.selectedItemIds.has(item.id)) {
      this.selectOnly(item.id, true);
    }
    const row = this.activeRowEl;
    const rect = row?.getBoundingClientRect();
    const evt = new MouseEvent("contextmenu", {
      clientX: rect ? rect.left + Math.min(rect.width, 48) : 0,
      clientY: rect ? rect.bottom - 2 : 0,
    });
    this.openPanelItemMenu(evt, item);
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
    // Remember the folder we're leaving so the cursor lands back on it in the parent (Finder/Explorer).
    const exitedFolderId = this.path[this.path.length - 1].id;
    this.searchCtl.exitDriveSearch();
    this.resetTypeAheadBuffer();
    this.path.pop();
    this.pushHistory();
    this.clearSelection(false);
    this.pendingActiveItemId = exitedFolderId;
    void this.data.loadCurrentFolder(false);
  }

  // Consume pendingActiveItemId (set by navigateUp): if that folder is in the freshly-loaded list,
  // make it the active/selected cursor and scroll it into view. Called right before each of
  // loadCurrentFolder's renders. No-op (and clears the pending id) when the folder isn't present.
  private applyPendingActiveItem(): void {
    const id = this.pendingActiveItemId;
    this.pendingActiveItemId = null;
    if (!id || this.searchCtl.isDriveSearchActive()) {
      return;
    }
    if (this.getCurrentItems().some((item) => item.id === id)) {
      this.selectedItemIds.clear();
      this.selectedItemIds.add(id);
      this.selectionAnchorId = id;
      this.activeItemId = id;
      this.scrollActiveIntoView = true;
    }
  }

  private navigateToFolder(item: DriveBrowserItem): void {
    // A folder opened from Drive-wide search results may live anywhere in Drive, so it is NOT a child
    // of the current path. Trashed results remain flat/non-navigable, matching the panel's Trash root;
    // every other search scope skips the current-path Trash guard and opens a fresh location.
    const fromSearch = this.searchCtl.isDriveSearchActive();
    const fromTrashedSearch = fromSearch && this.searchCtl.searchLocation === "trashed";
    if (fromTrashedSearch || (!fromSearch && this.isInTrashPath())) {
      // Trashed folders list nothing here (listFolder filters `trashed = false`); their trashed
      // contents already appear flat in this Trash view. Keep trashed folders non-navigable so the
      // path never descends below the Trash root.
      new Notice("Trashed folders can't be opened. Their trashed contents are already listed in Trash; restore the folder to browse it.");
      return;
    }
    this.searchCtl.exitDriveSearch();
    this.resetTypeAheadBuffer();
    if (fromSearch) {
      // Open the hit under its TRUE ancestor breadcrumb, resolved from the index's folders-only
      // crawl (kdr QA: the fabricated "My Drive / <name>" trail contradicted the detail bar's real
      // Location and made Open location look wrong). Falls back to the flat trail only when the
      // index can't resolve the chain (still loading / outside the crawl).
      const ancestry = this.index.getFolderAncestry(item.id);
      const segments = ancestry ?? [{ id: item.id, name: item.name }];
      this.path.splice(0, this.path.length, { ...MY_DRIVE_ROOT }, ...segments.map((seg) => ({ ...seg })));
    } else {
      this.path.push({ id: item.id, name: item.name });
    }
    this.pushHistory();
    this.clearSelection(false);
    void this.data.loadCurrentFolder(false);
  }

  // "Open location" for a search result: open the folder the item lives in (its parent) and put the
  // cursor on the item. The hit carries parent ids (server) + a precomputed folder path (index).
  private openItemLocation(item: DriveBrowserItem): void {
    const parentId = item.parents?.[0];
    if (!parentId) {
      new Notice("This item has no accessible parent folder to open.");
      return;
    }
    const parentName = item.path?.split("/").filter(Boolean).pop() || "Folder";
    // navigateToFolder reads isDriveSearchActive() to open the parent as a fresh location; set the
    // pending cursor first so the item is highlighted once the parent's listing loads.
    this.pendingActiveItemId = item.id;
    this.navigateToFolder({ id: parentId, name: parentName, mimeType: DRIVE_FOLDER_MIME_TYPE });
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
    this.searchCtl.exitDriveSearch();
    this.resetTypeAheadBuffer();
    this.path.splice(0, this.path.length, ...entry.map((location) => ({ ...location })));
    this.clearSelection(false);
    void this.data.loadCurrentFolder(false);
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
    // "Open location" for a search hit: jump to the folder the item actually lives in (drive.google.com
    // parity). Only meaningful while searching, where the result isn't a child of the current folder.
    if (this.searchCtl.isDriveSearchActive() && item.parents && item.parents.length > 0) {
      menu.addItem((mi) =>
        mi.setTitle("Open location").setIcon("folder-tree").onClick(() => this.openItemLocation(item)),
      );
    }

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
        void this.data.loadRoots(true);
        void this.data.loadCurrentFolder(true);
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

    const input = createEl("input", {
      cls: "gdab-hidden-file-input",
      attr: { type: "file", multiple: true },
    });
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      this.startManualFileUpload(files, target);
    });
    this.contentEl.ownerDocument.body.appendChild(input);
    input.click();
  }

  private canStartPanelManualUpload(): boolean {
    if (this.uploadCtl.inFlight) {
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

    void this.uploadCtl.uploadPanelDroppedFiles(uploadableFiles, target, skippedJunk);
  }

  private async createFolderInCurrentLocation(name: string): Promise<void> {
    if (!this.ensureCanModifyDrive()) {
      return;
    }

    const target = { ...this.currentLocation };
    try {
      const folderId = await this.upload.createFolder(name, target.id);
      this.data.invalidate(target.id);
      this.selectedItemIds.clear();
      this.selectedItemIds.add(folderId);
      this.selectionAnchorId = folderId;
      // Same post-modal focus restore as rename: cursor on the new folder, keyboard back in the list.
      this.pendingActiveItemId = folderId;
      await this.data.loadCurrentFolder(true);
      this.listEl?.focus();
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
      ...this.data.sharedDriveRoots.map((root) => ({ id: root.id, name: root.name })),
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
    for (const items of this.data.cachedLists()) {
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
        await this.data.loadCurrentFolder(true);
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
    for (const items of this.data.cachedLists()) {
      const cached = items.find((candidate) => candidate.id === fileId);
      if (cached) {
        cached.starred = starred;
      }
    }
    // Starred is query-backed rather than a parent listing. Invalidate it after either transition;
    // when it is active, setItemsStarred() immediately refetches the authoritative result. (Recent
    // membership is unaffected by starring, so it needs no invalidation here.)
    this.data.invalidate(STARRED_ROOT.id);
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
      // The modal stole DOM focus and the reload rebuilds the rows, so re-anchor the keyboard
      // cursor on the renamed item and give focus back to the list (kdr QA: arrows went dead).
      this.pendingActiveItemId = item.id;
      await this.data.loadCurrentFolder(true);
      this.listEl?.focus();
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

      this.data.invalidate(source.id);
      this.data.invalidate(target.id);
      if (this.currentLocation.id === source.id || this.currentLocation.id === target.id) {
        await this.data.loadCurrentFolder(true);
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

      this.data.invalidate(target.id);
      if (this.currentLocation.id === target.id) {
        this.selectedItemIds.clear();
        for (const copiedId of copiedIds) {
          this.selectedItemIds.add(copiedId);
        }
        this.selectionAnchorId = copiedIds[0] ?? null;
        await this.data.loadCurrentFolder(true);
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
      await this.data.loadCurrentFolder(true);
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

    const location = this.searchCtl.isDriveSearchActive()
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
      this.data.invalidate(STARRED_ROOT.id);
      this.data.invalidate(RECENT_ROOT.id);
      await this.data.loadCurrentFolder(true);
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
      this.data.invalidate(STARRED_ROOT.id);
      this.data.invalidate(RECENT_ROOT.id);
      await this.data.loadCurrentFolder(true);
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
    this.loadMoreCursorActive = false;
    this.selectedItemIds.clear();
    this.selectedItemIds.add(itemId);
    this.selectionAnchorId = itemId;
    this.activeItemId = itemId;
    if (render) {
      this.refreshSelectionOnly(this.consumeScrollActive());
    }
  }

  private toggleSelection(itemId: string, render: boolean): void {
    this.loadMoreCursorActive = false;
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
    this.loadMoreCursorActive = false;
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
    return this.searchCtl.isDriveSearchActive()
      ? this.searchCtl.getDriveSearchItems()
      : (this.data.getCached(this.currentLocation.id) ?? []);
  }

  // Apply the Drive-style chips then sort the active folder/search result set. The name query is
  // already evaluated by the index + server engines before search results reach this method.
  // Single source of truth: render, keyboard nav, select-all, and menu targets all read getCurrentItems().
  private displayItems(raw: DriveBrowserItem[]): DriveBrowserItem[] {
    let filtered = raw;
    if (this.searchCtl.typeFilter) {
      const category = this.searchCtl.typeFilter;
      filtered = filtered.filter((it) => matchesTypeCategory(it.mimeType, category));
    }
    if (this.searchCtl.peopleFilter) {
      const ownerKey = this.searchCtl.peopleFilter.key;
      filtered = filtered.filter((it) => itemHasOwner(it, ownerKey));
    }
    if (this.searchCtl.modifiedFilter) {
      const range = this.searchCtl.modifiedFilter;
      const cutoff = modifiedRangeCutoff(range, Date.now());
      filtered = filtered.filter((it) => itemModifiedSince(it, cutoff));
    }
    const s = this.getSettings();
    if (this.searchCtl.isDriveSearchActive()) {
      // drive.google.com search sorts: Most relevant (the fuzzy-score/merge order) or Date
      // modified — nothing else, because anything alphabetical over a partial result set lies.
      return this.searchSortByModified
        ? sortDriveItems(filtered, "modified", this.searchSortDir, false)
        : filtered;
    }
    if (!this.searchCtl.isDriveSearchActive() && this.isInTrashPath()) {
      // Trash defaults to "Date trashed" (drive.google.com); the Sort menu can override per session.
      return this.trashSortOverride
        ? sortDriveItems(filtered, this.trashSortOverride, this.trashSortDir, s.panelFoldersFirst)
        : sortDriveItemsByTrashedTime(filtered, s.panelFoldersFirst, this.trashSortDir);
    }
    return sortDriveItems(filtered, s.panelSortKey, s.panelSortDir, s.panelFoldersFirst);
  }

  // Render the current folder's rows into `list`, applying the live filter + sort. Distinguishes a
  // genuinely empty folder from one filtered down to nothing.
  private populateRows(list: HTMLElement, rawItems: DriveBrowserItem[], animateEmptyState: boolean): void {
    this.activeRowEl = null;
    const items = this.displayItems(rawItems);
    if (items.length === 0) {
      const q = this.searchCtl.filterQuery.trim();
      let msg: string;
      if (this.searchCtl.isDriveSearchActive() && rawItems.length === 0) {
        msg = `No Drive items match "${q}".`;
      } else if (rawItems.length === 0) {
        msg = this.isCurrentVirtualRoot()
          ? this.virtualRootEmptyMessage(this.currentLocation.id)
          : "This Drive folder is empty.";
      } else if (this.searchCtl.typeFilter && !this.searchCtl.peopleFilter && !this.searchCtl.modifiedFilter && !q) {
        msg = `No loaded items are ${panelTypeLabel(this.searchCtl.typeFilter).toLowerCase()}.`;
      } else if (this.searchCtl.peopleFilter && !this.searchCtl.typeFilter && !this.searchCtl.modifiedFilter && !q) {
        msg = `No loaded items are owned by ${this.searchCtl.peopleFilter.label}.`;
      } else if (this.searchCtl.modifiedFilter && !this.searchCtl.typeFilter && !this.searchCtl.peopleFilter && !q) {
        msg = `No loaded items were modified ${panelModifiedPhrase(this.searchCtl.modifiedFilter)}.`;
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
    this.panelThumbnails.disconnectObserver();
    list.empty();
    list.removeAttribute("aria-activedescendant");
    this.detailBarEl?.remove();
    this.detailBarEl = null;
    this.contentEl.querySelectorAll(".gdab-drive-panel-selection-bar").forEach((element) => element.remove());

    if (this.searchCtl.isDriveSearchActive()) {
      const rawItems = this.searchCtl.getDriveSearchItems();
      if (this.searchCtl.searchLoading && rawItems.length === 0) {
        this.renderLoadingSkeleton(list, "Searching Drive...");
        return;
      }
      if (this.searchCtl.searchError && rawItems.length === 0) {
        const error = list.createDiv({ cls: "gdab-drive-panel-state", attr: { role: "alert" } });
        error.createDiv({ cls: "gdab-drive-panel-state-title", text: "Could not search Google Drive." });
        error.createDiv({ cls: "gdab-drive-panel-state-detail", text: this.searchCtl.searchError });
        error.createEl("button", { text: "Retry" }).addEventListener("click", () => this.searchCtl.queueDriveSearch(true));
        return;
      }
      this.populateRows(list, rawItems, false);
      this.renderDetailBar(this.contentEl, rawItems);
      this.renderSelectionBar(this.contentEl, rawItems);
      this.renderDriveSearchStatus(list, rawItems);
      return;
    }

    this.populateRows(list, this.data.getCached(this.currentLocation.id) ?? [], false);
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

  // The Drive-search results footer: searching/error states, the "more matches exist" pagination hint,
  // and the metadata-filter disclosure. Shared by both render paths — the full `render()` (chip toggles
  // route here via `setPeopleFilter`/`setModifiedFilter`) and the in-place `refreshListOnly()` (typing,
  // results arriving) — so the People/Modified "hidden indexed matches" warning shows in every path, not
  // only when results stream in. `rawItems` is the location-scoped, pre-`displayItems` merged result set.
  private renderDriveSearchStatus(list: HTMLElement, rawItems: DriveBrowserItem[]): void {
    const hasMore = this.searchCtl.hasMoreDriveSearchItems();
    const metadataFilterStatus = this.searchCtl.getSearchMetadataFilterStatus(rawItems);
    if (!(this.searchCtl.searchLoading || hasMore || metadataFilterStatus || this.searchCtl.searchError)) {
      return;
    }
    list.createDiv({
      cls: `gdab-drive-panel-search-status${this.searchCtl.searchError ? " is-error" : ""}`,
      attr: { role: this.searchCtl.searchError ? "alert" : "status" },
      text: this.searchCtl.searchError
        ? this.searchCtl.searchError
        : this.searchCtl.searchLoading
          ? "Searching Drive..."
          : metadataFilterStatus
            ? `${metadataFilterStatus}${
                hasMore ? " More matches also exist in Drive; refine the search to narrow them." : ""
              }`
            : "More matches exist in Drive. Refine the search to narrow them.",
    });
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
    input.value = this.searchCtl.filterQuery;
    const clearBtn = filterWrap.createEl("button", {
      cls: "gdab-drive-panel-filter-clear",
      attr: { type: "button", "aria-label": "Clear search", title: "Clear search" },
    });
    setIcon(clearBtn, "x");
    clearBtn.toggleClass("is-hidden", this.searchCtl.filterQuery.length === 0);
    input.addEventListener("input", () => {
      this.searchCtl.filterQuery = input.value;
      clearBtn.toggleClass("is-hidden", input.value.length === 0);
      this.searchCtl.queueDriveSearch();
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape" && input.value) {
        evt.preventDefault();
        evt.stopPropagation();
        input.value = "";
        this.searchCtl.filterQuery = "";
        clearBtn.addClass("is-hidden");
        this.searchCtl.queueDriveSearch();
      }
    });
    clearBtn.addEventListener("click", () => {
      input.value = "";
      this.searchCtl.filterQuery = "";
      clearBtn.addClass("is-hidden");
      this.searchCtl.queueDriveSearch();
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
    const typeActive = this.searchCtl.typeFilter !== null;
    const peopleActive = this.searchCtl.peopleFilter !== null;
    const modifiedActive = this.searchCtl.modifiedFilter !== null;

    if (this.searchCtl.isDriveSearchActive()) {
      const location = panelSearchLocationOption(this.searchCtl.searchLocation, this.searchOriginFolder()?.name);
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
      typeActive ? panelTypeIcon(this.searchCtl.typeFilter as PanelTypeCategory) : "shapes",
    );
    typeChip.createSpan({
      cls: "gdab-drive-panel-chip-label",
      text: typeActive ? panelTypeLabel(this.searchCtl.typeFilter as PanelTypeCategory) : "Type",
    });
    setIcon(
      typeChip.createSpan({ cls: "gdab-drive-panel-chip-caret", attr: { "aria-hidden": "true" } }),
      "chevron-down",
    );
    typeChip.setAttribute(
      "aria-label",
      typeActive ? `Type filter: ${panelTypeLabel(this.searchCtl.typeFilter as PanelTypeCategory)}` : "Filter by type",
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
      text: peopleActive ? (this.searchCtl.peopleFilter as PanelOwnerOption).label : "People",
    });
    setIcon(
      peopleChip.createSpan({ cls: "gdab-drive-panel-chip-caret", attr: { "aria-hidden": "true" } }),
      "chevron-down",
    );
    peopleChip.setAttribute(
      "aria-label",
      peopleActive ? `People filter: ${(this.searchCtl.peopleFilter as PanelOwnerOption).label}` : "Filter by owner",
    );
    if (peopleActive) {
      peopleChip.setAttribute("title", (this.searchCtl.peopleFilter as PanelOwnerOption).menuLabel);
    }
    peopleChip.addEventListener("click", (evt) => this.openPeopleFilterMenu(evt));

    const modifiedChip = bar.createEl("button", {
      cls: "gdab-drive-panel-chip",
      attr: { type: "button", "aria-haspopup": "menu" },
    });
    modifiedChip.toggleClass("is-active", modifiedActive);
    setIcon(
      modifiedChip.createSpan({ cls: "gdab-drive-panel-chip-icon", attr: { "aria-hidden": "true" } }),
      modifiedActive ? panelModifiedIcon(this.searchCtl.modifiedFilter as PanelModifiedRange) : "calendar",
    );
    modifiedChip.createSpan({
      cls: "gdab-drive-panel-chip-label",
      text: modifiedActive ? panelModifiedLabel(this.searchCtl.modifiedFilter as PanelModifiedRange) : "Modified",
    });
    setIcon(
      modifiedChip.createSpan({ cls: "gdab-drive-panel-chip-caret", attr: { "aria-hidden": "true" } }),
      "chevron-down",
    );
    modifiedChip.setAttribute(
      "aria-label",
      modifiedActive
        ? `Modified filter: ${panelModifiedLabel(this.searchCtl.modifiedFilter as PanelModifiedRange)}`
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
      // No current-folder entry when the search began at the My Drive root — the dedicated
      // "My Drive" option below is the same scope and would render the label twice (kdr QA).
      ...(origin && !isVirtualRootId(origin.id) && origin.id !== MY_DRIVE_ROOT.id
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
          .setChecked(this.searchCtl.searchLocation === option.key)
          .onClick(() => this.setSearchLocation(option.key)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private setSearchLocation(value: PanelSearchLocation): void {
    if (this.searchCtl.searchLocation === value || !this.searchCtl.isDriveSearchActive()) {
      return;
    }
    this.searchCtl.searchLocation = value;
    this.resetTypeAheadBuffer();
    this.searchCtl.queueDriveSearch(true, true);
  }

  private searchOriginFolder(): DrivePanelLocation | null {
    const origin = this.searchCtl.searchOriginPath;
    return origin?.[origin.length - 1] ?? null;
  }

  private openTypeFilterMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((mi) => mi.setTitle("Type — loaded items only").setIsLabel(true));
    menu.addItem((mi) =>
      mi
        .setTitle("All types")
        .setIcon("layers")
        .setChecked(this.searchCtl.typeFilter === null)
        .onClick(() => this.setTypeFilter(null)),
    );
    menu.addSeparator();
    for (const option of PANEL_TYPE_OPTIONS) {
      menu.addItem((mi) =>
        mi
          .setTitle(option.label)
          .setIcon(option.icon)
          .setChecked(this.searchCtl.typeFilter === option.key)
          .onClick(() => this.setTypeFilter(option.key)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private setTypeFilter(value: PanelTypeCategory | null): void {
    if (this.searchCtl.typeFilter === value) {
      return;
    }
    this.searchCtl.typeFilter = value;
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
        .setChecked(this.searchCtl.peopleFilter === null)
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
            .setChecked(this.searchCtl.peopleFilter?.key === option.key)
            .onClick(() => this.setPeopleFilter(option)),
        );
      }
    }
    menu.showAtMouseEvent(evt);
  }

  private setPeopleFilter(value: PanelOwnerOption | null): void {
    if (this.searchCtl.peopleFilter?.key === value?.key) {
      return;
    }
    this.searchCtl.peopleFilter = value;
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
        .setChecked(this.searchCtl.modifiedFilter === null)
        .onClick(() => this.setModifiedFilter(null)),
    );
    menu.addSeparator();
    for (const option of PANEL_MODIFIED_OPTIONS) {
      menu.addItem((mi) =>
        mi
          .setTitle(option.label)
          .setIcon(option.icon)
          .setChecked(this.searchCtl.modifiedFilter === option.key)
          .onClick(() => this.setModifiedFilter(option.key)),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private setModifiedFilter(value: PanelModifiedRange | null): void {
    if (this.searchCtl.modifiedFilter === value) {
      return;
    }
    this.searchCtl.modifiedFilter = value;
    this.resetTypeAheadBuffer();
    this.render();
  }

  private clearPanelFilters(): void {
    if (this.searchCtl.typeFilter === null && this.searchCtl.peopleFilter === null && this.searchCtl.modifiedFilter === null) {
      return;
    }
    this.searchCtl.typeFilter = null;
    this.searchCtl.peopleFilter = null;
    this.searchCtl.modifiedFilter = null;
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
    if (this.searchCtl.isDriveSearchActive()) {
      // Search offers exactly drive.google.com's options: Most relevant, or Date modified with a
      // direction. Name/size sorts over a relevance-capped partial result set would mislead.
      menu.addItem((mi) => mi.setTitle("Sort by").setIsLabel(true));
      menu.addItem((mi) =>
        mi
          .setTitle("Most relevant")
          .setIcon("sparkles")
          .setChecked(!this.searchSortByModified)
          .onClick(() => {
            this.searchSortByModified = false;
            this.refreshListOnly();
          }),
      );
      menu.addItem((mi) =>
        mi
          .setTitle("Date modified")
          .setIcon("clock")
          .setChecked(this.searchSortByModified)
          .onClick(() => {
            this.searchSortByModified = true;
            this.refreshListOnly();
          }),
      );
      if (this.searchSortByModified) {
        menu.addSeparator();
        menu.addItem((mi) => mi.setTitle("Sort direction").setIsLabel(true));
        for (const opt of sortDirectionOptions("modified")) {
          menu.addItem((mi) =>
            mi
              .setTitle(opt.label)
              .setIcon(opt.icon)
              .setChecked(this.searchSortDir === opt.dir)
              .onClick(() => {
                this.searchSortDir = opt.dir;
                this.refreshListOnly();
              }),
          );
        }
      }
      menu.showAtMouseEvent(evt);
      return;
    }
    const inTrash = this.isInTrashPath();
    const checkedKey: PanelSortKey | null = inTrash ? this.trashSortOverride : s.panelSortKey;

    menu.addItem((mi) => mi.setTitle("Sort by").setIsLabel(true));
    if (inTrash) {
      // Trash-only key, checked by default — drive.google.com's Trash sorts by trashed date.
      menu.addItem((mi) => {
        mi
          .setTitle("Date trashed")
          .setIcon("trash-2")
          .setChecked(this.trashSortOverride === null)
          .onClick(() => this.setTrashSort({ clearKey: true }));
      });
      // Honest labelling, always visible: menu tooltips proved unreliable on kdr's setup (neither
      // title= nor setTooltip shows inside Obsidian menus), so a muted non-clickable label line
      // sits right under the option. Drive's API gives a real trashedTime only for shared-drive items.
      menu.addItem((mi) => mi.setTitle("· My Drive items: by modified date (API limit)").setIsLabel(true));
    }
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
          .setChecked(checkedKey === k.key)
          .onClick(() =>
            inTrash ? this.setTrashSort({ key: k.key }) : void this.setSortSetting({ key: k.key }),
          ),
      );
    };
    driveKeys.forEach(addKeyItem);
    menu.addSeparator();
    extraKeys.forEach(addKeyItem);

    menu.addSeparator();
    menu.addItem((mi) => mi.setTitle("Sort direction").setIsLabel(true));
    // Date-trashed is a date key, so its direction labels read New↔old like the other date keys.
    const directionKey = inTrash ? (this.trashSortOverride ?? "modified") : s.panelSortKey;
    const checkedDir = inTrash ? this.trashSortDir : s.panelSortDir;
    for (const opt of sortDirectionOptions(directionKey)) {
      menu.addItem((mi) =>
        mi
          .setTitle(opt.label)
          .setIcon(opt.icon)
          .setChecked(checkedDir === opt.dir)
          .onClick(() =>
            inTrash ? this.setTrashSort({ dir: opt.dir }) : void this.setSortSetting({ dir: opt.dir }),
          ),
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

  // Trash-view sort changes are session-scoped (never persisted): clearKey returns to the default
  // "Date trashed" ordering; key overrides it; dir applies to whichever key is active.
  private setTrashSort(change: { key?: PanelSortKey; clearKey?: boolean; dir?: PanelSortDir }): void {
    if (change.clearKey) {
      this.trashSortOverride = null;
    } else if (change.key) {
      this.trashSortOverride = change.key;
    }
    if (change.dir) {
      this.trashSortDir = change.dir;
    }
    this.refreshListOnly();
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
