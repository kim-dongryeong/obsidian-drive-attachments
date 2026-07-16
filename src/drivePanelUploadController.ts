import { Notice } from "obsidian";
import { DriveDedupService } from "./driveDedupService";
import { DriveUploadService, FileUploadSource } from "./driveUploadService";
import { formatCount } from "./drivePanelText";
import {
  captureDropEntries,
  extractPanelDropFiles,
  FolderUploadPlan,
  formatPanelUploadProgress,
  formatPanelUploadSummary,
  formatTreeUploadProgress,
  formatTreeUploadSummary,
  hasLocalFileDrag,
  isDirectoryEntry,
  isJunkFileName,
  PanelDropUploadStats,
  sortDirsByDepth,
  walkDropEntries,
} from "./drivePanelDropUtil";
import { DrivePanelLocation, isVirtualRootId, virtualRootName } from "./drivePanelLocation";

// The view-side hooks the upload controller calls back into. It owns the panel-drop upload
// WORKFLOW + in-flight guard (T-011 P8); drag visuals, the confirm modal, and folder reloads
// stay with the view.
export interface DrivePanelUploadHost {
  canBrowse(): boolean;
  // The persisted panel-drop mode: "off" | "confirm" | "direct".
  dropUploadMode(): string;
  currentFolderId(): string;
  // Toggle the panel's "is-uploading" chrome (cursor/overlay CSS state).
  setUploadingUi(active: boolean): void;
  // The bottom-center status chip ("Uploading 3/10 → X"); null hides it.
  setDropHint(text: string | null): void;
  // Clear the whole-panel and folder-row drop highlights after a drop resolves.
  clearDropVisuals(): void;
  // mode === "confirm": show the drop-confirm modal; the modal's Confirm calls back `onConfirm`.
  confirmDrop(entries: FileSystemEntry[], files: File[], target: DrivePanelLocation, targetBreadcrumb: string, onConfirm: () => void): void;
  // Refresh the upload target's listing: reload when it is the folder on screen, else just
  // invalidate its cache so the next visit refetches.
  refreshTargetFolder(targetId: string): Promise<void>;
  // Show/update the in-panel upload progress card (drive.google.com-style). null hides it.
  showUploadCard(state: PanelUploadCardState | null): void;
  // Names already present in the target folder (first page of its listing) — used to uniquify
  // upload names with " (1)", " (2)" suffixes the way drive.google.com does.
  existingTargetNames(targetId: string): Promise<Set<string>>;
}

// What the in-panel upload card renders: the target, overall progress, the file in flight, and
// whether Cancel is still meaningful.
export interface PanelUploadCardState {
  targetName: string;
  done: number;
  total: number;
  currentFile: string | null;
  cancellable: boolean;
  // Batches waiting behind the running one (drops made mid-upload).
  queued: number;
}

// The Drive panel's drag-and-drop upload workflow: the drop router (off/confirm/direct), the flat
// md5-deduped file path, the recursive folder-tree path (memoized parent-first ensureFolder), the
// progress pill/Notice updates, and the single panelDropInFlight guard. Extracted from
// drivePanelView.ts (T-011 P8) — bodies verbatim, view side effects routed through
// DrivePanelUploadHost.
export class DrivePanelUploadController {
  // One in-flight guard for panel drop uploads, separate from rename/trash writes, so a second
  // drop can't interleave with an upload (and its follow-up reload) already running.
  inFlight = false;
  // Set by the card's Cancel button; the upload loops check it between files and stop early.
  private cancelRequested = false;
  // Drops made while an upload runs wait here and start in order when the current batch finishes
  // (drive.google.com queues uploads instead of rejecting them).
  private readonly queue: Array<{ entries: FileSystemEntry[]; files: File[]; target: DrivePanelLocation }> = [];
  // Last card state pushed to the view — re-rendered when the queue changes mid-upload.
  private lastCardState: PanelUploadCardState | null = null;

  constructor(
    private readonly upload: DriveUploadService,
    private readonly dedup: DriveDedupService,
    private readonly host: DrivePanelUploadHost,
  ) {}

  processPanelDrop(evt: DragEvent, targetLocation: DrivePanelLocation, targetBreadcrumb: string): void {
    this.host.setDropHint(null);
    const mode = this.host.dropUploadMode();
    if (mode === "off") {
      if (hasLocalFileDrag(evt.dataTransfer)) {
        evt.preventDefault();
        evt.stopPropagation();
        this.host.clearDropVisuals();
        new Notice("Drive panel uploads are off in settings.");
      }
      return;
    }

    if (isVirtualRootId(targetLocation.id) && hasLocalFileDrag(evt.dataTransfer)) {
      evt.preventDefault();
      evt.stopPropagation();
      this.host.clearDropVisuals();
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
    this.host.clearDropVisuals();

    const target = { ...targetLocation };
    if (mode === "confirm") {
      if (!this.canStartPanelDropUpload()) {
        return;
      }
      this.host.confirmDrop(entries, files, target, targetBreadcrumb, () =>
        this.startPanelDropUpload(entries, files, target),
      );
      return;
    }

    this.startPanelDropUpload(entries, files, target);
  }

  startPanelDropUpload(entries: FileSystemEntry[], files: File[], target: DrivePanelLocation): void {
    if (this.inFlight) {
      // Queue instead of rejecting (drive.google.com behavior): this batch starts when the
      // running one finishes. Shown inside the in-panel card — no top-right Notice (kdr: those
      // vanish too fast and add noise).
      this.queue.push({ entries, files, target });
      if (this.lastCardState) {
        this.showCard({ ...this.lastCardState });
      }
      return;
    }
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

  canStartPanelDropUpload(): boolean {
    if (this.host.dropUploadMode() === "off") {
      new Notice("Drive panel uploads are off in settings.");
      return false;
    }

    if (!this.host.canBrowse()) {
      new Notice("Connect Google Drive with browsing access before dropping files onto the Drive panel.");
      return false;
    }

    return true;
  }

  // Start the next queued batch, if any, once the current one fully settles.
  private drainQueue(): void {
    const next = this.queue.shift();
    if (next) {
      this.startPanelDropUpload(next.entries, next.files, next.target);
    }
  }

  // Uniquify against the target folder the way drive.google.com does: "name.ext" → "name (1).ext",
  // counting up until free. `taken` accumulates this batch's own uploads too.
  private uniquifyName(name: string, taken: Set<string>): string {
    if (!taken.has(name.toLowerCase())) {
      taken.add(name.toLowerCase());
      return name;
    }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; ; n += 1) {
      const candidate = `${stem} (${n})${ext}`;
      if (!taken.has(candidate.toLowerCase())) {
        taken.add(candidate.toLowerCase());
        return candidate;
      }
    }
  }

  // The card's Cancel button: stop before the next file (the file currently uploading finishes).
  requestCancel(): void {
    this.cancelRequested = true;
  }

  private setUploadPill(done: number, total: number, targetName: string, currentFile: string | null): void {
    this.showCard({ targetName, done, total, currentFile, cancellable: true, queued: 0 });
  }

  private showCard(state: PanelUploadCardState | null): void {
    this.lastCardState = state ? { ...state, queued: this.queue.length } : null;
    this.host.showUploadCard(this.lastCardState);
  }

  // Public: the toolbar "Upload files..." picker reuses this flat path for manually chosen files.
  async uploadPanelDroppedFiles(
    files: File[],
    target: DrivePanelLocation,
    skippedJunk: number,
  ): Promise<void> {
    this.inFlight = true;
    this.cancelRequested = false;
    this.host.setUploadingUi(true);

    const stats: PanelDropUploadStats = {
      uploaded: 0,
      skippedDuplicates: 0,
      skippedJunk,
      failed: 0,
      failedNames: [],
    };
    const progress = new Notice(formatPanelUploadProgress(0, files.length, target.name, stats), 0);
    let cancelled = false;
    let takenNames: Set<string>;
    try {
      takenNames = new Set([...(await this.host.existingTargetNames(target.id))].map((n) => n.toLowerCase()));
    } catch {
      takenNames = new Set();
    }

    try {
      for (let index = 0; index < files.length; index += 1) {
        if (this.cancelRequested) {
          cancelled = true;
          break;
        }
        const file = files[index];
        this.setUploadPill(index + 1, files.length, target.name, file.name);
        progress.setMessage(formatPanelUploadProgress(index + 1, files.length, target.name, stats, file.name));

        try {
          // drive.google.com parity (kdr QA): never skip as a "duplicate" — a same-named file
          // uploads under "name (1).ext". (The old md5 skip also disagreed with the tree path,
          // which always re-uploaded — one drop shape skipped, the other didn't.)
          await this.upload.uploadFile({
            name: this.uniquifyName(file.name, takenNames),
            mimeType: file.type || "application/octet-stream",
            source: new FileUploadSource(file),
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

      await this.host.refreshTargetFolder(target.id);
    } finally {
      progress.hide();
      this.inFlight = false;
      this.host.setUploadingUi(false);
      this.showCard(null);
      this.host.setDropHint(null);
    }

    const summary = formatPanelUploadSummary(target.name, stats);
    new Notice(cancelled ? `Upload cancelled. ${summary}` : summary, stats.failed > 0 ? 10_000 : 5_000);
    this.drainQueue();
  }

  // Folder drop (Phase B): recreate the dropped directory tree under `target`, then upload each file
  // into its recreated folder. Faithful recreation is the goal here — unlike the flat path, nested
  // files are NOT md5-deduped, because skipping a duplicate would punch a hole in the recreated tree
  // (and Drive folder creation isn't deduped either, so a re-drop already yields a fresh copy).
  private async uploadPanelDroppedTree(entries: FileSystemEntry[], target: DrivePanelLocation): Promise<void> {
    this.inFlight = true;
    this.cancelRequested = false;
    this.host.setUploadingUi(true);

    const progress = new Notice(`Reading dropped folder for ${target.name}…`, 0);
    this.host.setDropHint(`Reading "${target.name}"…`);
    let cancelled = false;
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

      // Root-level name pool for drive.google.com-style " (1)" suffixes: what the target already
      // holds. Only entries created DIRECTLY in the target need uniquifying — everything deeper
      // goes into folders this drop just created.
      let rootNames: Set<string>;
      try {
        rootNames = new Set([...(await this.host.existingTargetNames(target.id))].map((n) => n.toLowerCase()));
      } catch {
        rootNames = new Set();
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
        const rawName = dir[dir.length - 1];
        const folderName = dir.length === 1 ? this.uniquifyName(rawName, rootNames) : rawName;
        const id = await this.upload.createFolder(folderName, parentId);
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
        if (this.cancelRequested) {
          cancelled = true;
          break;
        }
        const { file, dir } = plan.files[index];
        const displayPath = dir.length > 0 ? `${dir.join("/")}/${file.name}` : file.name;
        this.setUploadPill(index + 1, total, target.name, displayPath);
        progress.setMessage(formatTreeUploadProgress(index + 1, total, target.name, displayPath, foldersCreated, stats));

        try {
          const parentId = await ensureFolder(dir);
          await this.upload.uploadFile({
            name: dir.length === 0 ? this.uniquifyName(file.name, rootNames) : file.name,
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

      await this.host.refreshTargetFolder(target.id);

      summary = formatTreeUploadSummary(target.name, foldersCreated, stats);
      if (cancelled) {
        summary = `Upload cancelled. ${summary}`;
      }
    } finally {
      progress.hide();
      this.inFlight = false;
      this.host.setUploadingUi(false);
      this.showCard(null);
      this.host.setDropHint(null);
      if (summary) {
        new Notice(summary, stats.failed > 0 ? 10_000 : 5_000);
      }
    }
    this.drainQueue();
  }
}
