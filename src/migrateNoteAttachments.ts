import {
  App,
  ButtonComponent,
  EmbedCache,
  LinkCache,
  Modal,
  Notice,
  ReferenceCache,
  TFile,
} from "obsidian";
import { formatBytes } from "./byteFormat";
import { PREVIEW_LANG } from "./codeBlockLang";
import { computeMd5Hex, DriveDedupHit, DriveDedupService } from "./driveDedupService";
import { DrivePickerItem } from "./driveTypes";
import { BufferUploadSource, DriveUploadService } from "./driveUploadService";
import { InsertService } from "./insertService";
import { GoogleDriveAttachmentBridgeSettings } from "./settings";

export type AttachmentReferenceKind = "embed" | "link";

export interface AttachmentReference {
  kind: AttachmentReferenceKind;
  linkpath: string;
  original: string;
  startOffset: number;
  endOffset: number;
}

export interface LocalAttachmentCandidate {
  file: TFile;
  references: AttachmentReference[];
}

export type MigrationUploadPlanStatus = "pending-upload" | "reuse-existing" | "blocked";

export interface MigrationUploadPlan {
  candidate: LocalAttachmentCandidate;
  md5: string | null;
  dedupHit: DriveDedupHit | null;
  status: MigrationUploadPlanStatus;
  reason?: string;
}

export type MigrationUploadSource = "uploaded" | "reused";

export interface ReferenceRewrite {
  reference: AttachmentReference;
  // Exact text to splice into the source note over [reference.startOffset, reference.endOffset).
  replacement: string;
  // A fenced code block (the drive-preview embed) must sit on its own line to parse. Set for the
  // embed case so applyReferenceRewrites pads it with newlines when the original reference wasn't
  // already alone on its line.
  blockLevel?: boolean;
}

export interface MigrationUploadResult {
  plan: MigrationUploadPlan;
  source: MigrationUploadSource;
  item: DrivePickerItem;
  usedRootFallback: boolean;
  driveLinkNoteWikilink: string;
  driveLinkNotePath: string | null;
  referenceRewrites: ReferenceRewrite[];
}

export function scanActiveNoteLocalAttachments(app: App, sourceFile: TFile): LocalAttachmentCandidate[] {
  const cache = app.metadataCache.getFileCache(sourceFile);
  if (!cache) {
    return [];
  }

  const byPath = new Map<string, LocalAttachmentCandidate>();

  for (const ref of cache.embeds ?? []) {
    addResolvedAttachment(app, sourceFile, ref, "embed", byPath);
  }
  for (const ref of cache.links ?? []) {
    addResolvedAttachment(app, sourceFile, ref, "link", byPath);
  }

  return Array.from(byPath.values()).sort((left, right) => left.file.path.localeCompare(right.file.path));
}

export class MigrateNoteAttachmentsPreviewModal extends Modal {
  private isClosed = false;
  // Plans captured as the sequential dedup checks complete, reused on Confirm so execution doesn't
  // recompute md5/dedup. Keyed by attachment file path.
  private readonly plans = new Map<string, MigrationUploadPlan>();
  private confirmButton: ButtonComponent | null = null;
  private executing = false;

  constructor(
    app: App,
    private readonly sourceFile: TFile,
    private readonly candidates: LocalAttachmentCandidate[],
    private readonly dedup: DriveDedupService,
    private readonly upload: DriveUploadService,
    private readonly insert: InsertService,
    private readonly settings: GoogleDriveAttachmentBridgeSettings,
    // First upload forces the folder choice: resolves the default upload folder, opening a picker
    // modal when none is set yet, so a migration run never scatters uploads across Drive root.
    // Resolves null if that picker is cancelled. Injected from main.ts (wraps
    // plugin.ensureDefaultUploadFolder).
    private readonly ensureDefaultUploadFolder: () => Promise<string | null>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.isClosed = false;
    const { contentEl } = this;
    this.titleEl.setText("Migrate this note's attachments to Drive");
    contentEl.empty();

    contentEl.createEl("p", {
      text: this.settings.deleteLocalAfterMigrate
        ? "On Confirm: upload (or reuse by md5) each attachment, create its Drive-link note, rewrite this note's references (embeds become inline Drive previews), then move the local file to trash (recoverable). A file still referenced by other notes is kept."
        : "On Confirm: upload (or reuse by md5) each attachment, create its Drive-link note, and rewrite this note's references (embeds become inline Drive previews). Local files are kept — enable “Delete local file after migrating” in settings to slim the vault.",
      cls: "setting-item-description",
    });

    if (this.candidates.length === 0) {
      contentEl.createDiv({
        text: "No local binary attachments were found in this note.",
        cls: "setting-item-description",
      });
      this.renderButtons(false);
      return;
    }

    const summary = this.candidates.reduce(
      (total, candidate) => total + candidate.references.length,
      0,
    );
    contentEl.createDiv({
      text: `${this.candidates.length} local attachment(s), ${summary} reference(s) in ${this.sourceFile.path}.`,
      cls: "setting-item-description",
    });

    const list = contentEl.createDiv({ cls: "gdab-migrate-preview-list" });
    const dedupTargets: Array<{ candidate: LocalAttachmentCandidate; el: HTMLElement }> = [];
    for (const candidate of this.candidates) {
      dedupTargets.push({ candidate, el: this.renderCandidate(list, candidate) });
    }

    this.renderButtons(true);

    // Run the per-file dedup checks SEQUENTIALLY, not all at once. Each check does a full
    // `vault.readBinary` (the whole attachment goes resident) plus a Drive index-wait + name-lookup
    // burst. This milestone targets LARGE attachments, so firing every candidate concurrently would
    // hold the sum of all of them in memory and fan out N parallel Drive API bursts — an OOM/quota
    // hazard in exactly the case we care about. One binary resident and one lookup in flight at a
    // time bounds memory to the largest single file and the API load to one row's worth.
    void this.runDedupChecks(dedupTargets);
  }

  private async runDedupChecks(
    targets: Array<{ candidate: LocalAttachmentCandidate; el: HTMLElement }>,
  ): Promise<void> {
    for (const target of targets) {
      if (this.isClosed) {
        return;
      }
      await this.renderDedupVerdict(target.candidate, target.el);
    }

    if (this.isClosed) {
      return;
    }

    // Enable Confirm only once every attachment has a captured plan and at least one is migratable.
    const migratable = Array.from(this.plans.values()).some((plan) => plan.status !== "blocked");
    if (this.confirmButton) {
      if (migratable) {
        this.confirmButton.setDisabled(false).setTooltip("");
      } else {
        this.confirmButton.setDisabled(true).setTooltip("No attachment can be migrated (all checks failed).");
      }
    }
  }

  onClose(): void {
    this.isClosed = true;
    this.contentEl.empty();
  }

  private renderCandidate(parent: HTMLElement, candidate: LocalAttachmentCandidate): HTMLElement {
    const item = parent.createDiv({ cls: "gdab-migrate-preview-item" });
    item.createDiv({ text: candidate.file.name, cls: "gdab-migrate-preview-name" });
    item.createDiv({
      text: candidate.file.path,
      cls: "gdab-migrate-preview-path",
    });

    const details = item.createDiv({ cls: "gdab-migrate-preview-details" });
    details.createDiv({ text: `Size: ${formatBytes(String(candidate.file.stat.size))}` });
    const dedupEl = details.createDiv({ text: "Dedup: queued…" });
    details.createDiv({ text: `Refs to rewrite: ${candidate.references.length} in ${this.sourceFile.basename}` });
    details.createDiv({
      text: this.settings.deleteLocalAfterMigrate
        ? "Will delete: yes — moved to trash (recoverable) only after a fully successful migration"
        : "Will delete: no — local file kept (delete setting off)",
    });

    const refs = item.createDiv({ cls: "gdab-migrate-preview-refs" });
    for (const ref of candidate.references) {
      refs.createDiv({
        text: `${ref.kind === "embed" ? "Embed" : "Link"}: ${ref.original}`,
        cls: "setting-item-description",
      });
    }

    return dedupEl;
  }

  private async renderDedupVerdict(candidate: LocalAttachmentCandidate, targetEl: HTMLElement): Promise<void> {
    targetEl.setText("Dedup: checking…");
    try {
      const plan = await this.buildMigrationUploadPlan(candidate);
      this.plans.set(candidate.file.path, plan);

      if (this.isClosed) {
        return;
      }

      targetEl.setText(formatMigrationPlanVerdict(plan));
    } catch (error) {
      if (this.isClosed) {
        return;
      }

      const detail = error instanceof Error ? error.message : String(error);
      targetEl.setText(`Dedup: check failed (${detail})`);
    }
  }

  private renderButtons(hasCandidates: boolean): void {
    const buttonRow = this.contentEl.createDiv({ cls: "gdab-migrate-preview-buttons" });
    const confirm = new ButtonComponent(buttonRow)
      .setButtonText("Confirm")
      .setCta()
      .setDisabled(true)
      .setTooltip(hasCandidates ? "Checking attachments…" : "No local attachments to migrate.")
      .onClick(() => {
        void this.execute();
      });
    this.confirmButton = hasCandidates ? confirm : null;

    new ButtonComponent(buttonRow)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });
  }

  // Execute the migration. Order matters for correctness + safety:
  //   1. Per candidate (independently): upload-or-reuse + create/reuse its Drive-link note. A failure
  //      here is recorded and excludes only that candidate; others proceed.
  //   2. ONE combined `vault.process` rewrites every successful candidate's references in a single pass.
  //      All offsets were computed against the same original snapshot, so they must be applied together
  //      in descending order — per-candidate process calls would shift later candidates' stale offsets.
  //      `applyReferenceRewrites` validates each span still equals its `original` and throws otherwise,
  //      so a note edited mid-run aborts the rewrite cleanly (uploads stand; nothing is deleted).
  //   3. Deletion (only when the setting is ON AND the rewrite succeeded AND the file isn't referenced
  //      by any OTHER note) moves the local file to trash — recoverable, never a hard unlink.
  private async execute(): Promise<void> {
    if (this.executing) {
      return;
    }
    this.executing = true;
    this.confirmButton?.setDisabled(true).setButtonText("Migrating…");

    // Resolve (or let the user choose) the upload folder ONCE, before any candidate is touched — a
    // cancelled folder picker aborts the whole run rather than uploading some files and stalling on
    // others.
    if ((await this.ensureDefaultUploadFolder()) === null) {
      new Notice("Migration cancelled — no upload folder chosen.");
      this.executing = false;
      this.confirmButton?.setDisabled(false).setButtonText("Confirm");
      return;
    }

    const outcomes: MigrationOutcome[] = [];
    for (const candidate of this.candidates) {
      const plan = this.plans.get(candidate.file.path) ?? (await this.buildMigrationUploadPlan(candidate));
      if (plan.status === "blocked" || !plan.md5) {
        outcomes.push({ candidate, kind: "skipped", detail: plan.reason ?? "preview check failed" });
        continue;
      }
      try {
        const result = await this.uploadOrReuseAndCreateDriveLinkNote(plan);
        outcomes.push({ candidate, kind: "migrated", result });
      } catch (error) {
        outcomes.push({ candidate, kind: "failed", detail: errorMessage(error) });
      }
    }

    // Combined single-pass rewrite of every migrated candidate's references.
    const migrated = outcomes.filter((o): o is MigratedOutcome => o.kind === "migrated");
    const allRewrites = migrated.flatMap((o) => o.result.referenceRewrites);
    let rewriteError: string | null = null;
    if (allRewrites.length > 0 && !this.isClosed) {
      try {
        await this.app.vault.process(this.sourceFile, (text) => applyReferenceRewrites(text, allRewrites));
      } catch (error) {
        rewriteError = errorMessage(error);
      }
    }
    const rewriteOk = rewriteError === null;

    // Gated deletion: setting ON, rewrite succeeded, and the file is not referenced by another note.
    if (this.settings.deleteLocalAfterMigrate && rewriteOk) {
      for (const outcome of migrated) {
        if (isReferencedByOtherNote(this.app, outcome.result.plan.candidate.file, this.sourceFile.path)) {
          outcome.deletion = { state: "kept-referenced" };
          continue;
        }
        try {
          await this.app.fileManager.trashFile(outcome.result.plan.candidate.file);
          outcome.deletion = { state: "trashed" };
        } catch (error) {
          outcome.deletion = { state: "delete-failed", detail: errorMessage(error) };
        }
      }
    }

    if (!this.isClosed) {
      this.renderSummary(outcomes, rewriteOk, rewriteError);
    }
    this.executing = false;
  }

  private renderSummary(outcomes: MigrationOutcome[], rewriteOk: boolean, rewriteError: string | null): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("Migration complete");

    const migratedCount = outcomes.filter(isMigrated).length;
    const skippedCount = outcomes.length - migratedCount;
    const trashedCount = outcomes.filter((o) => isMigrated(o) && o.deletion?.state === "trashed").length;

    contentEl.createEl("p", {
      text: `${migratedCount} migrated, ${skippedCount} skipped${this.settings.deleteLocalAfterMigrate ? `, ${trashedCount} local file(s) moved to trash` : ""}.`,
      cls: "setting-item-description",
    });
    if (!rewriteOk) {
      contentEl.createDiv({
        cls: "setting-item-description",
        text: `References were NOT rewritten (${rewriteError ?? "unknown error"}). Uploads + Drive-link notes were created; your local files and links are unchanged, so nothing was deleted. Re-run to retry (md5 dedup prevents re-uploads).`,
      });
    }

    const list = contentEl.createDiv({ cls: "gdab-migrate-preview-list" });
    for (const outcome of outcomes) {
      const row = list.createDiv({ cls: "gdab-migrate-preview-item" });
      row.createDiv({ text: outcome.candidate.file.name, cls: "gdab-migrate-preview-name" });
      row.createDiv({ text: summarizeOutcome(outcome, rewriteOk), cls: "gdab-migrate-preview-path" });
    }

    const buttonRow = contentEl.createDiv({ cls: "gdab-migrate-preview-buttons" });
    new ButtonComponent(buttonRow)
      .setButtonText("Close")
      .setCta()
      .onClick(() => this.close());
  }

  private async buildMigrationUploadPlan(candidate: LocalAttachmentCandidate): Promise<MigrationUploadPlan> {
    try {
      const data = await this.app.vault.readBinary(candidate.file);
      const md5 = computeMd5Hex(data);
      const duplicate = await this.dedup.findDuplicate({
        md5,
        fileName: candidate.file.name,
      });

      return {
        candidate,
        md5,
        dedupHit: duplicate,
        status: duplicate ? "reuse-existing" : "pending-upload",
      };
    } catch (error) {
      return {
        candidate,
        md5: null,
        dedupHit: null,
        status: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async uploadOrReuseAndCreateDriveLinkNote(plan: MigrationUploadPlan): Promise<MigrationUploadResult> {
    if (plan.status === "blocked" || !plan.md5) {
      throw new Error(plan.reason ?? "Attachment cannot be migrated because its preview check failed.");
    }

    let item: DrivePickerItem;
    let source: MigrationUploadSource;
    let usedRootFallback = false;
    if (plan.dedupHit) {
      item = plan.dedupHit.item;
      source = "reused";
    } else {
      // vault.readBinary only hands out whole buffers, so migration keeps the buffer-backed source
      // (no streaming win here — vault attachments were small enough to live in the vault).
      const data = await this.app.vault.readBinary(plan.candidate.file);
      // Already resolved once up front in execute() before any upload started; settings.defaultUploadFolderId
      // is set by then, so this just reads it back (no re-prompt).
      const parentFolderId = await this.ensureDefaultUploadFolder();
      const uploaded = await this.upload.uploadFile({
        name: plan.candidate.file.name,
        mimeType: getLocalAttachmentMimeType(plan.candidate.file),
        source: new BufferUploadSource(data),
        parentFolderId: parentFolderId ?? undefined,
      });
      item = uploaded.item;
      source = "uploaded";
      usedRootFallback = uploaded.usedRootFallback;
    }

    // Both branches (fresh upload or reuse of an existing same-md5 Drive file) are a local vault
    // attachment becoming Drive-backed, so the note's provenance is "uploaded from Obsidian".
    const driveLinkNote = await this.insert.ensureDriveLinkNoteForItem(item, this.sourceFile, "uploaded");
    if (driveLinkNote.path) {
      this.dedup.rememberVaultAssetNote(plan.md5, driveLinkNote.path);
    }

    return {
      plan,
      source,
      item,
      usedRootFallback,
      driveLinkNoteWikilink: driveLinkNote.wikilink,
      driveLinkNotePath: driveLinkNote.path,
      referenceRewrites: planReferenceRewrites(plan.candidate, driveLinkNote.wikilink, item.id),
    };
  }
}

interface DeletionState {
  state: "trashed" | "kept-referenced" | "delete-failed";
  detail?: string;
}

interface MigratedOutcome {
  candidate: LocalAttachmentCandidate;
  kind: "migrated";
  result: MigrationUploadResult;
  deletion?: DeletionState;
}

interface SkippedOutcome {
  candidate: LocalAttachmentCandidate;
  kind: "skipped" | "failed";
  detail: string;
}

type MigrationOutcome = MigratedOutcome | SkippedOutcome;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMigrated(outcome: MigrationOutcome): outcome is MigratedOutcome {
  return outcome.kind === "migrated";
}

// True if any note OTHER than `exceptNotePath` still references `file` — deleting it would break them,
// so the migration keeps it. The active note's own references are excluded (they've just been rewritten).
function isReferencedByOtherNote(app: App, file: TFile, exceptNotePath: string): boolean {
  for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (source !== exceptNotePath && targets[file.path]) {
      return true;
    }
  }
  return false;
}

function summarizeOutcome(outcome: MigrationOutcome, rewriteOk: boolean): string {
  if (!isMigrated(outcome)) {
    return outcome.kind === "skipped" ? `Skipped — ${outcome.detail}` : `Failed — ${outcome.detail}`;
  }

  const source = outcome.result.source === "uploaded" ? "uploaded" : "reused existing";
  const relink = rewriteOk ? "refs rewritten" : "refs NOT rewritten";
  let deletion = "";
  switch (outcome.deletion?.state) {
    case "trashed":
      deletion = "; local moved to trash";
      break;
    case "kept-referenced":
      deletion = "; local kept (used by other notes)";
      break;
    case "delete-failed":
      deletion = `; delete failed (${outcome.deletion.detail})`;
      break;
  }
  return `${source} → ${outcome.result.driveLinkNoteWikilink}; ${relink}${deletion}`;
}

// Pure planning step — NO file is touched here (deletion and the actual splice are later increments).
// Given the wikilink to the freshly created/reused Drive-link note ("[[basename]]") and the file's
// Drive id, compute the replacement text for each local reference in the source note:
//   • an embed (`![[img.png]]` or `![alt](img.png)`) → an inline `drive-preview` EMBED block for the
//     Drive file directly (matching the plugin-wide embed default), marked blockLevel so it lands on
//     its own line.
//   • any other reference (a `[[wikilink]]` or a `[text](path)` link) → a LINK to the Drive-link note
//     (`[[basename]]`).
// Reference offsets are carried through unchanged so the execution increment can splice replacements in
// DESCENDING offset order (an earlier splice must not shift the offsets of later, earlier-in-file refs).
export function planReferenceRewrites(
  candidate: LocalAttachmentCandidate,
  driveLinkNoteWikilink: string,
  driveId: string,
): ReferenceRewrite[] {
  const embedReplacement = ["```" + PREVIEW_LANG, driveId, "width: 480", "```"].join("\n");
  return candidate.references.map((reference) =>
    reference.kind === "embed"
      ? { reference, replacement: embedReplacement, blockLevel: true }
      : { reference, replacement: driveLinkNoteWikilink },
  );
}

// Pure note-text transform — applies one candidate's planned ReferenceRewrites to `noteText`,
// returning the rewritten text. NO file is touched here; the caller feeds this through a single
// `vault.process(note, applyReferenceRewrites)` write in a later increment, so the transform must be
// pure (process may re-invoke it on a retry).
//
// Each rewrite splices its `replacement` over the half-open span [startOffset, endOffset) of the
// SAME text it was planned against. Splices run in DESCENDING start-offset order, so replacing a
// later-in-file reference never shifts the offsets of an earlier, not-yet-applied one.
//
// SAFETY (this milestone's whole point): the offsets come from `metadataCache`, computed against a
// snapshot of the note. If the note changed underneath us they are stale, and a blind splice could
// mangle unrelated text. So we VALIDATE every span against the original `noteText` BEFORE mutating
// anything — bounds, no overlap, and that the span still holds the reference's `original` text — and
// throw on any violation. A throw fails the whole candidate cleanly (its deletion is skipped, other
// candidates proceed) rather than risk corrupting the note.
export function applyReferenceRewrites(noteText: string, rewrites: ReferenceRewrite[]): string {
  const ordered = [...rewrites].sort(
    (left, right) => right.reference.startOffset - left.reference.startOffset,
  );

  // Validate against the ORIGINAL text first (offsets were computed against it). `previousStart`
  // walks down the file: each span must end at or before where the previous (later) span began.
  let previousStart = noteText.length;
  for (const { reference } of ordered) {
    const { startOffset, endOffset, original } = reference;

    if (startOffset < 0 || startOffset > endOffset || endOffset > noteText.length) {
      throw new Error(
        `Reference "${original}" offsets [${startOffset}, ${endOffset}) fall outside the note ` +
          `(length ${noteText.length}); refusing to rewrite to avoid corrupting it.`,
      );
    }
    if (endOffset > previousStart) {
      throw new Error(
        `Reference "${original}" at [${startOffset}, ${endOffset}) overlaps a later reference; ` +
          "refusing to rewrite to avoid corrupting it.",
      );
    }
    const span = noteText.slice(startOffset, endOffset);
    if (span !== original) {
      throw new Error(
        `Note text at [${startOffset}, ${endOffset}) is "${span}", expected "${original}"; the note ` +
          "changed since it was scanned, so the rewrite was skipped to avoid corrupting it.",
      );
    }

    previousStart = startOffset;
  }

  // Apply in the same descending order — every splice leaves all earlier offsets still valid.
  let result = noteText;
  for (const { reference, replacement, blockLevel } of ordered) {
    // A fenced code block (blockLevel) must start and end on its own line to parse. An inline
    // reference like `text ![[img.png]] more text` isn't already alone on its line, so pad with
    // newlines on whichever side isn't already at a line boundary.
    let spliced = replacement;
    if (blockLevel) {
      const atLineStart = reference.startOffset === 0 || result.charAt(reference.startOffset - 1) === "\n";
      const atLineEnd = reference.endOffset === result.length || result.charAt(reference.endOffset) === "\n";
      spliced = `${atLineStart ? "" : "\n"}${replacement}${atLineEnd ? "" : "\n"}`;
    }
    result = result.slice(0, reference.startOffset) + spliced + result.slice(reference.endOffset);
  }
  return result;
}

function addResolvedAttachment(
  app: App,
  sourceFile: TFile,
  ref: EmbedCache | LinkCache,
  kind: AttachmentReferenceKind,
  byPath: Map<string, LocalAttachmentCandidate>,
): void {
  const target = app.metadataCache.getFirstLinkpathDest(ref.link, sourceFile.path);
  if (!(target instanceof TFile) || !isLocalBinaryAttachment(app, target)) {
    return;
  }

  const candidate = byPath.get(target.path) ?? {
    file: target,
    references: [],
  };
  candidate.references.push({
    kind,
    linkpath: ref.link,
    original: ref.original,
    startOffset: getStartOffset(ref),
    endOffset: getEndOffset(ref),
  });
  byPath.set(target.path, candidate);
}

function isLocalBinaryAttachment(app: App, file: TFile): boolean {
  if (file.extension.toLowerCase() === "md") {
    return false;
  }

  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  return !(typeof frontmatter?.drive_id === "string" && frontmatter.drive_id.length > 0);
}

function getStartOffset(ref: ReferenceCache): number {
  return ref.position.start.offset;
}

function getEndOffset(ref: ReferenceCache): number {
  return ref.position.end.offset;
}

export function openMigrateNoteAttachmentsPreview(
  app: App,
  dedup: DriveDedupService,
  upload: DriveUploadService,
  insert: InsertService,
  settings: GoogleDriveAttachmentBridgeSettings,
  ensureDefaultUploadFolder: () => Promise<string | null>,
): void {
  const activeFile = app.workspace.getActiveFile();
  if (!(activeFile instanceof TFile) || activeFile.extension !== "md") {
    new Notice("Open a Markdown note to migrate its local attachments.");
    return;
  }

  new MigrateNoteAttachmentsPreviewModal(
    app,
    activeFile,
    scanActiveNoteLocalAttachments(app, activeFile),
    dedup,
    upload,
    insert,
    settings,
    ensureDefaultUploadFolder,
  ).open();
}

function formatMigrationPlanVerdict(plan: MigrationUploadPlan): string {
  if (plan.status === "blocked") {
    return `Dedup: check failed (${plan.reason ?? "unknown error"})`;
  }

  if (!plan.md5) {
    return "Dedup: check failed (missing md5)";
  }

  if (!plan.dedupHit) {
    return `Dedup: new upload needed (md5 ${plan.md5})`;
  }

  const path = plan.dedupHit.drivePath ? ` at ${plan.dedupHit.drivePath}` : "";
  const assetNote = plan.dedupHit.assetNote ? `; note ${plan.dedupHit.assetNote.path}` : "";
  return `Dedup: reuse existing ${formatDedupSource(plan.dedupHit.source)} "${plan.dedupHit.item.name}"${path}${assetNote} (md5 ${plan.dedupHit.matchedMd5})`;
}

function formatDedupSource(source: DriveDedupHit["source"]): string {
  switch (source) {
    case "vault-asset-note":
      return "Drive-link note";
    case "drive-index":
      return "Drive index hit";
    case "drive-name":
      return "Drive name lookup hit";
  }
}

function getLocalAttachmentMimeType(file: TFile): string {
  return KNOWN_LOCAL_MIME_TYPES[file.extension.toLowerCase()] ?? "application/octet-stream";
}

const KNOWN_LOCAL_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  gif: "image/gif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/mp4",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  zip: "application/zip",
};
