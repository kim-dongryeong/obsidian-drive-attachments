import { App, Editor, Notice, normalizePath, parseYaml, stringifyYaml, TFile, TFolder } from "obsidian";
import {
  applyDriveMetadataToFrontmatter,
  ASSET_NOTE_METADATA_KEYS,
  formatAssetNoteFrontmatter,
  DRIVE_ORIGIN_KEY,
  DriveNoteOrigin,
  DrivePathInfo,
} from "./assetNoteMetadata";
import { assertValidDrivePickerItem, isDriveFolder, DrivePickerItem } from "./driveTypes";
import { formatExportLinksSection, upsertExportLinksSection } from "./exportLinksSection";
import { formatActionsSection, upsertActionsSection } from "./actionsSection";
import { PREVIEW_LANG } from "./codeBlockLang";
import { formatPreviewSection, upsertPreviewSection } from "./previewSection";
import { DriveAuthService } from "./driveAuthService";
import { DriveMetadata, DriveMetadataService } from "./driveMetadataService";
import { DrivePickerService, PickOptions } from "./drivePickerService";
import {
  DEFAULT_ASSET_NOTE_FOLDER_PATH,
  DEFAULT_ASSET_NOTE_NAME_TEMPLATE,
  DEFAULT_ASSET_NOTE_SUBFOLDER_NAME,
  GoogleDriveAttachmentBridgeSettings,
} from "./settings";

export class InsertService {
  private readonly assetNotePathsByDriveId = new Map<string, string>();

  // Last note-name template we warned about missing {{name}} — warn once per distinct bad value,
  // not on every insert/rename (and again if kdr edits it to a different still-bad value).
  private lastWarnedNameTemplate: string | null = null;

  constructor(
    private readonly app: App,
    private readonly auth: DriveAuthService,
    private readonly picker: DrivePickerService,
    private readonly metadata: DriveMetadataService,
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
  ) {}

  async insertDriveLinkAtCursor(editor: Editor, sourceFile?: TFile | null): Promise<void> {
    const item = await this.pickValidatedDriveItem();
    if (!item) {
      return;
    }

    await this.insertDriveItemAtCursor(editor, item, sourceFile);
  }

  // `origin` records how this note was created (uploaded from Obsidian vs linked from an existing
  // Drive file); it defaults to "linked" so the many picker/search callers need no change, and the
  // upload paths pass "uploaded" explicitly. It's only stamped on brand-new asset notes.
  async insertDriveItemAtCursor(
    editor: Editor,
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<void> {
    editor.replaceSelection(await this.formatDriveItemMarkdown(item, sourceFile, origin));
  }

  async insertDriveItemAsAssetNoteAtCursor(
    editor: Editor,
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<void> {
    assertValidDrivePickerItem(item);
    editor.replaceSelection(await this.createAssetNoteAndWikilink(item, sourceFile, origin));
  }

  // Force a plain inline Markdown link regardless of the global linkFormat setting. The Drive panel's
  // 🔗 row action uses this so it stays distinct from the Drive-link-note action even when the default
  // format is asset-note (M7) — otherwise both actions would create a note.
  insertDriveItemAsInlineLinkAtCursor(editor: Editor, item: DrivePickerItem): void {
    assertValidDrivePickerItem(item);
    editor.replaceSelection(formatMarkdownLink(item.name, item.webViewLink));
  }

  // Build the inline Markdown link for a Drive item WITHOUT inserting it. The Drive panel's
  // drag-OUT-to-editor flow needs the string synchronously at `dragstart` (it stamps it on the drag's
  // `text/plain` so Obsidian's editor drop inserts it). Mirrors `insertDriveItemAsInlineLinkAtCursor`.
  formatInlineDriveLink(name: string, webViewLink: string): string {
    return formatMarkdownLink(name, webViewLink);
  }

  // Build a `drive-preview` EMBED block for a Drive file WITHOUT inserting it or creating the asset
  // note — matches the panel's "Embed preview" row action. Also used by the panel drag-OUT flow.
  formatDriveEmbedBlock(driveId: string): string {
    return ["```" + PREVIEW_LANG, driveId, "width: 480", "```"].join("\n");
  }

  // Insert an inline `drive-preview` EMBED (and ensure the asset note exists for metadata/dedup). Used
  // by search→insert for previewable files (image/video/pdf), so they show inline by default.
  async insertDriveItemAsEmbedAtCursor(
    editor: Editor,
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<void> {
    editor.replaceSelection(await this.createAssetNoteAndEmbed(item, sourceFile, origin));
  }

  async ensureDriveLinkNoteForItem(
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<{ wikilink: string; path: string | null }> {
    assertValidDrivePickerItem(item);
    const wikilink = await this.createAssetNoteAndWikilink(item, sourceFile, origin);
    return {
      wikilink,
      path: this.getAssetNotePathForDriveId(item.id),
    };
  }

  // Where this service last created/updated the asset note for a Drive id this session (null in
  // inline-link mode or before any insert). Lets the upload-dedup wiring seed its md5 session map
  // with the note path right after an insert, without rescanning the vault.
  getAssetNotePathForDriveId(driveId: string): string | null {
    return this.assetNotePathsByDriveId.get(driveId) ?? null;
  }

  // Build the Markdown for a Drive item (inline link or asset-note wikilink, per settings) WITHOUT
  // inserting it. The drop→upload flow needs the string to swap into a placeholder it already
  // inserted at the drop cursor; `insertDriveItemAtCursor` is the replaceSelection wrapper around it.
  async formatDriveItemMarkdown(
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<string> {
    assertValidDrivePickerItem(item);

    return this.getSettings().linkFormat === "asset-note"
      ? await this.createAssetNoteAndWikilink(item, sourceFile, origin)
      : formatMarkdownLink(item.name, item.webViewLink);
  }

  // Ensure the Drive-link note exists (for metadata/dedup) and return a `drive-preview` EMBED rather
  // than a wikilink — used for the paste-to-Drive flow, where the user wants to see the image inline.
  async createAssetNoteAndEmbed(
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<string> {
    assertValidDrivePickerItem(item);
    await this.openOrCreateAssetNoteFile(item, sourceFile, origin);
    return ["```" + PREVIEW_LANG, item.id, "width: 480", "```"].join("\n");
  }

  async attachPickedFolderToFrontmatter(file: TFile): Promise<void> {
    const item = await this.pickValidatedDriveItem({ foldersOnly: true });
    if (!item) {
      return;
    }

    await this.attachDriveFolderToFrontmatter(file, item);
  }

  // Write a known Drive folder's webViewLink to the note's `googleDriveFolderUrl` frontmatter (the
  // same key `openAttachedFolder` reads back). Shared by the picker-driven command and the sidebar
  // panel's folder row action, so both paths validate + folder-check identically.
  async attachDriveFolderToFrontmatter(file: TFile, item: DrivePickerItem): Promise<void> {
    assertValidDrivePickerItem(item);

    if (!isDriveFolder(item)) {
      new Notice("Choose a Google Drive folder for frontmatter attach.");
      return;
    }

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.googleDriveFolderUrl = item.webViewLink;
    });
    new Notice(`Attached Drive folder: ${item.name}`);
  }

  openAttachedFolder(file: TFile): boolean {
    const folderUrl = this.getAttachedFolderUrl(file);
    if (!folderUrl) {
      new Notice("No Google Drive folder attached to this note.");
      return false;
    }

    window.open(folderUrl);
    return true;
  }

  hasAttachedFolder(file: TFile): boolean {
    return this.getAttachedFolderUrl(file) !== null;
  }

  async refreshDriveMetadata(file: TFile): Promise<void> {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const driveId = frontmatter?.drive_id;
    if (typeof driveId !== "string" || driveId.trim().length === 0) {
      throw new Error("Current note does not have a drive_id frontmatter field.");
    }

    const metadata = await this.metadata.getFileMetadata(driveId);
    const pathInfo = await this.resolveDrivePathInfo(metadata);
    // applyDriveMetadataToFrontmatter also deletes the legacy `drive_export_links` key (it clears
    // every managed key and no longer re-adds that one); the links land in the body section instead.
    await this.app.fileManager.processFrontMatter(file, (target) => {
      applyDriveMetadataToFrontmatter(target, metadata, pathInfo, this.getSettings().accountEmail);
    });
    if (metadata.exportLinks && Object.keys(metadata.exportLinks).length > 0) {
      await this.app.vault.process(file, (content) =>
        upsertExportLinksSection(content, metadata.exportLinks, DRIVE_PATH_LOG_HEADING),
      );
    }
    this.rememberAssetNotePath(driveId, file.path);

    new Notice(`Refreshed Drive metadata: ${metadata.name}`);
  }

  private async pickValidatedDriveItem(options?: PickOptions): Promise<DrivePickerItem | null> {
    const accessToken = await this.auth.getAccessToken();
    const item = await this.picker.pickFileOrFolder(accessToken, options);
    if (!item) {
      return null;
    }

    assertValidDrivePickerItem(item);
    return item;
  }

  private async createAssetNoteAndWikilink(
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<string> {
    const existing = this.findExistingAssetNote(item.id);
    if (existing) {
      const basename = await this.updateExistingAssetNote(existing, item);
      return `[[${basename}]]`;
    }

    const file = await this.createNewAssetNoteFile(item, sourceFile, origin);
    return `[[${file.basename}]]`;
  }

  // Resolve the Drive-link (asset) note for this item, creating it if none exists. Unlike the insert
  // flow it does NOT touch an existing note (no metadata refresh, no path-log line), so it is safe to
  // call repeatedly from a "go to the note" affordance. Returns the note's TFile.
  async openOrCreateAssetNoteFile(
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<TFile> {
    const existing = this.findExistingAssetNote(item.id);
    if (existing) {
      return existing;
    }
    return this.createNewAssetNoteFile(item, sourceFile, origin);
  }

  private async createNewAssetNoteFile(
    item: DrivePickerItem,
    sourceFile?: TFile | null,
    origin: DriveNoteOrigin = "linked",
  ): Promise<TFile> {
    const metadata = await this.fetchAssetNoteMetadata(item);
    const pathInfo = await this.resolveDrivePathInfo(metadata);
    const targetFolderPath = this.resolveAssetNoteFolderPath(sourceFile);
    await this.ensureFolderExists(targetFolderPath);
    const basename = await this.findAvailableAssetNoteBasename(item, undefined, targetFolderPath);
    const path = this.joinVaultPath(targetFolderPath, `${basename}.md`);
    const exportLinksSection = formatExportLinksSection(metadata?.exportLinks);
    const includePreview = this.shouldAddPreviewBlock(metadata, item);
    const includeActions = this.getSettings().addActionsBlockToNewNotes;
    const body = [
      "---",
      ...formatAssetNoteFrontmatter(item, metadata, pathInfo, this.getSettings().accountEmail),
      // Write-once provenance (uploaded vs linked). Sits between the Drive-managed keys and the
      // user's extra frontmatter; the parser below reserves `drive_origin`, so the extra block can't
      // duplicate it, and a metadata refresh leaves it alone (it's not a managed key).
      ...(this.getSettings().recordDriveOrigin ? [`${DRIVE_ORIGIN_KEY}: ${origin}`] : []),
      ...parseExtraAssetNoteFrontmatter(this.getSettings().assetNoteExtraFrontmatter),
      "---",
      "",
      ...(includePreview ? [formatPreviewSection(item.id), ""] : []),
      ...(includeActions ? [formatActionsSection(item.id), ""] : []),
      ...(exportLinksSection ? [exportLinksSection, ""] : []),
      formatDrivePathLogSection(metadata ?? item, pathInfo),
      "",
    ].join("\n");

    const existingFile = this.app.vault.getAbstractFileByPath(path);
    const file = existingFile instanceof TFile ? existingFile : await this.app.vault.create(path, body);
    this.rememberAssetNotePath(item.id, file.path);
    return file;
  }

  // Re-inserting a link to a file that already has an asset note (same `drive_id`) must update that
  // note in place rather than create a duplicate. Re-fetch metadata + path (additive: a failed
  // lookup still records the check), refresh the Drive-managed frontmatter when metadata is
  // available, append one log line, and rename the note if Drive's current filename changed.
  private async updateExistingAssetNote(file: TFile, item: DrivePickerItem): Promise<string> {
    const metadata = await this.fetchAssetNoteMetadata(item);
    const pathInfo = await this.resolveDrivePathInfo(metadata);

    if (metadata) {
      await this.app.fileManager.processFrontMatter(file, (target) => {
        applyDriveMetadataToFrontmatter(target, metadata, pathInfo, this.getSettings().accountEmail);
      });
    }

    // Backfill the configured extra frontmatter (e.g. categories) onto an existing note — but only
    // keys that are missing or empty, so a value kdr set himself is never overwritten.
    const extraFrontmatter = parseExtraAssetNoteFrontmatterObject(this.getSettings().assetNoteExtraFrontmatter);
    if (Object.keys(extraFrontmatter).length > 0) {
      await this.app.fileManager.processFrontMatter(file, (target) => {
        const record = target as Record<string, unknown>;
        for (const [key, value] of Object.entries(extraFrontmatter)) {
          if (isEmptyFrontmatterValue(record[key])) {
            record[key] = value;
          }
        }
      });
    }

    const logLine = formatDrivePathLogLine(metadata ?? item, pathInfo);
    const includePreview = this.shouldAddPreviewBlock(metadata, item);
    const includeActions = this.getSettings().addActionsBlockToNewNotes;
    await this.app.vault.process(file, (content) => {
      const withExportLinks = upsertExportLinksSection(content, metadata?.exportLinks, DRIVE_PATH_LOG_HEADING);
      const withPreview = includePreview
        ? upsertPreviewSection(withExportLinks, item.id, DRIVE_PATH_LOG_HEADING)
        : withExportLinks;
      const withActions = includeActions
        ? upsertActionsSection(withPreview, item.id, DRIVE_PATH_LOG_HEADING)
        : withPreview;
      return appendDrivePathLogLine(withActions, logLine);
    });

    if (!metadata) {
      this.rememberAssetNotePath(item.id, file.path);
      return file.basename;
    }

    const basename = await this.renameAssetNoteForDriveName(file, metadata);
    // file.path is live (renameFile updates it), and unlike `${basename}.md` it keeps the real
    // location of a note kdr moved out of the vault root — a reconstructed root path could later
    // match an unrelated same-named note and misdirect the dedup update onto it.
    this.rememberAssetNotePath(item.id, file.path);
    return basename;
  }

  // Image-only auto-preview, gated by the setting (default on). Prefer the freshly fetched
  // metadata mimeType; fall back to the picker/search item's when metadata was unavailable so a
  // degraded note still previews. The `drive-preview` block resolves its id from the note's own
  // `drive_id` frontmatter, so it keeps working after a Drive rename. Added for ALL file types now —
  // a non-previewable file (sheet/pptx/…) just renders the type-icon "card" instead of inline media.
  private shouldAddPreviewBlock(_metadata: DriveMetadata | null, _item: DrivePickerItem): boolean {
    return this.getSettings().addPreviewBlockToNewNotes;
  }

  // Enrichment must be additive: the picker/search item already carries a
  // validated id/name/mimeType/webViewLink, so a failed metadata lookup should
  // degrade to a basic note (pre-M3 behavior) rather than break the insert.
  private async fetchAssetNoteMetadata(item: DrivePickerItem): Promise<DriveMetadata | null> {
    try {
      return await this.metadata.getFileMetadata(item.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`Drive metadata unavailable — created a basic Drive-link note. ${detail}`);
      return null;
    }
  }

  // Resolve the Drive folder path best-effort and stamp the check time. This walks parent folders
  // (extra files.get calls) and may be partial under `drive.file` when a parent folder isn't
  // readable; `resolveDrivePath` never throws, but the try/catch guards an auth failure too. A
  // failed lookup yields a null path with a timestamp recording that we looked.
  private async resolveDrivePathInfo(metadata: DriveMetadata | null): Promise<DrivePathInfo | null> {
    if (!metadata) {
      return null;
    }

    const checkedAt = new Date().toISOString();
    let path: string | null = null;
    try {
      path = await this.metadata.resolveDrivePath(metadata);
    } catch {
      path = null;
    }
    return { path, checkedAt };
  }

  // Public lookup of the Drive-link note for a Drive id (used by the preview service to read a file's
  // trashed/deleted state). Scans the vault by frontmatter drive_id, same as the dedup path.
  findAssetNoteFileByDriveId(driveId: string): TFile | null {
    return this.findExistingAssetNote(driveId);
  }

  private findExistingAssetNote(driveId: string): TFile | null {
    const cached = this.getRememberedAssetNote(driveId);
    if (cached) {
      return cached;
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter && frontmatter.drive_id === driveId) {
        this.rememberAssetNotePath(driveId, file.path);
        return file;
      }
    }
    return null;
  }

  private getRememberedAssetNote(driveId: string): TFile | null {
    const path = this.assetNotePathsByDriveId.get(driveId);
    if (!path) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return file;
    }

    this.assetNotePathsByDriveId.delete(driveId);
    return null;
  }

  private rememberAssetNotePath(driveId: string, path: string): void {
    this.assetNotePathsByDriveId.set(driveId, normalizePath(path));
  }

  private getAttachedFolderUrl(file: TFile): string | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const value = frontmatter?.googleDriveFolderUrl;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private async renameAssetNoteForDriveName(file: TFile, metadata: DriveMetadata): Promise<string> {
    const folderPath = this.getFileFolderPath(file);
    const basename = await this.findAvailableAssetNoteBasename(metadata, file, folderPath);
    if (basename === file.basename) {
      return file.basename;
    }

    await this.app.fileManager.renameFile(file, this.joinVaultPath(folderPath, `${basename}.md`));
    return basename;
  }

  private async findAvailableAssetNoteBasename(
    item: DrivePickerItem,
    existingFile?: TFile,
    folderPath = "",
  ): Promise<string> {
    const base = this.renderAssetNoteBasename(item.name, isDriveFolder(item));
    if (this.isAssetNotePathAvailable(base, existingFile, folderPath)) {
      return base;
    }

    const suffix = item.id.slice(0, 8);
    const idFallback = `${base} (${suffix})`;
    if (this.isAssetNotePathAvailable(idFallback, existingFile, folderPath)) {
      return idFallback;
    }

    for (let index = 2; ; index += 1) {
      const candidate = `${idFallback} ${index}`;
      if (this.isAssetNotePathAvailable(candidate, existingFile, folderPath)) {
        return candidate;
      }
    }
  }

  // Render the configured note-name template for a Drive file name. A template without {{name}}
  // would collapse every asset note onto one basename (id-suffix collisions all the way down), so
  // it falls back to the default with a one-time warning; an empty template means "use the default"
  // and warns nothing. {{name}} gets the sanitized Drive name, and the rendered whole is sanitized
  // again so invalid filename characters typed into the template itself can't break note creation.
  // Folders get a 📁 prefix on the resulting basename so the [[wikilink]] (and cmd-O, backlinks,
  // graph) reads as a folder at a glance — prepended OUTSIDE the template so it stays orthogonal to
  // the user's configurable template (which is shared with files) and the glyph survives sanitizing.
  private renderAssetNoteBasename(driveName: string, isFolder = false): string {
    let template = this.getSettings().assetNoteNameTemplate.trim();
    if (template.length === 0) {
      template = DEFAULT_ASSET_NOTE_NAME_TEMPLATE;
    } else if (!template.includes("{{name}}")) {
      if (this.lastWarnedNameTemplate !== template) {
        this.lastWarnedNameTemplate = template;
        new Notice(`Drive-link note name template needs {{name}} — using "${DEFAULT_ASSET_NOTE_NAME_TEMPLATE}".`);
      }
      template = DEFAULT_ASSET_NOTE_NAME_TEMPLATE;
    }

    const rendered = sanitizeFileBasename(template.split("{{name}}").join(sanitizeFileBasename(driveName)));
    return isFolder ? `${FOLDER_ASSET_NOTE_PREFIX}${rendered}` : rendered;
  }

  private isAssetNotePathAvailable(basename: string, existingFile?: TFile, folderPath = ""): boolean {
    const file = this.app.vault.getAbstractFileByPath(this.joinVaultPath(folderPath, `${basename}.md`));
    return file === null || (!!existingFile && file.path === existingFile.path);
  }

  private resolveAssetNoteFolderPath(sourceFile?: TFile | null): string {
    const settings = this.getSettings();
    switch (settings.assetNoteLocation) {
      case "current-folder":
        return this.getFileFolderPath(sourceFile);
      // Empty subfolder/path settings mean the greyed placeholder default, not vault root —
      // the input shows it and the note must actually land there (Obsidian placeholder convention).
      case "subfolder": {
        const subfolder = sanitizeVaultFolderPath(settings.assetNoteSubfolderName) || DEFAULT_ASSET_NOTE_SUBFOLDER_NAME;
        return this.joinVaultPath(this.getFileFolderPath(sourceFile), subfolder);
      }
      case "specified-folder":
        return sanitizeVaultFolderPath(settings.assetNoteFolderPath) || DEFAULT_ASSET_NOTE_FOLDER_PATH;
      case "vault-root":
      default:
        return "";
    }
  }

  private getFileFolderPath(file?: TFile | null): string {
    const parent = file?.parent;
    return parent && !parent.isRoot() ? normalizePath(parent.path) : "";
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    if (!folderPath) {
      return;
    }

    const parts = folderPath.split("/").filter((part) => part.length > 0);
    let current = "";
    for (const part of parts) {
      current = this.joinVaultPath(current, part);
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) {
        continue;
      }
      if (existing) {
        throw new Error(`Cannot create Drive-link note folder; a file already exists at ${current}.`);
      }
      await this.app.vault.createFolder(current);
    }
  }

  private joinVaultPath(folderPath: string, childPath: string): string {
    return normalizePath(folderPath ? `${folderPath}/${childPath}` : childPath);
  }
}

function escapeMarkdownLinkText(value: string): string {
  return normalizeInlineText(value).replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function escapeMarkdownLinkDestination(value: string): string {
  return value.replace(/[\r\n]+/g, "").replace(/</g, "%3C").replace(/>/g, "%3E");
}

function formatMarkdownLink(label: string, destination: string): string {
  return `[${escapeMarkdownLinkText(label)}](<${escapeMarkdownLinkDestination(destination)}>)`;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const DRIVE_PATH_LOG_HEADING = "## Drive path log";

// The log lives in a fenced code block so its monospace font keeps the `timestamp · name · path`
// columns aligned (Obsidian's proportional body font misaligns plain bullets — kdr's request).
function formatDrivePathLogSection(item: DrivePickerItem | DriveMetadata, pathInfo: DrivePathInfo | null): string {
  return [DRIVE_PATH_LOG_HEADING, "", "```text", formatDrivePathLogLine(item, pathInfo), "```"].join("\n");
}

function formatDrivePathLogLine(item: DrivePickerItem | DriveMetadata, pathInfo: DrivePathInfo | null): string {
  const checkedAt = pathInfo?.checkedAt ?? new Date().toISOString();
  const timestamp = formatPathLogTimestamp(checkedAt);
  const fileName = normalizeInlineText(item.name) || "Untitled Drive asset";
  const drivePath = pathInfo?.path ? normalizeInlineText(pathInfo.path) : "Drive path unavailable";

  return `${timestamp} · ${fileName} · ${drivePath}`;
}

// Append a line to the note body's Drive path log (a fenced code block), keeping every check. If the
// code block exists, insert just before its closing fence (newest at the bottom); otherwise create
// the section. Only the body is touched — frontmatter (above the first heading) is preserved verbatim.
function appendDrivePathLogLine(content: string, logLine: string): string {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === DRIVE_PATH_LOG_HEADING);

  if (headingIndex === -1) {
    const trimmedEnd = content.replace(/\s+$/, "");
    const prefix = trimmedEnd.length > 0 ? `${trimmedEnd}\n\n` : "";
    return `${prefix}${DRIVE_PATH_LOG_HEADING}\n\n\`\`\`text\n${logLine}\n\`\`\`\n`;
  }

  // The first non-blank line under the heading should open the code fence.
  let fenceStart = -1;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith("```")) {
      fenceStart = i;
    }
    break;
  }

  if (fenceStart !== -1) {
    for (let i = fenceStart + 1; i < lines.length; i += 1) {
      if (lines[i].trim().startsWith("```")) {
        lines.splice(i, 0, logLine);
        return lines.join("\n");
      }
    }
  }

  // Heading present but no usable code block (e.g. a pre-code-block note): drop a fresh one in.
  lines.splice(headingIndex + 1, 0, "", "```text", logLine, "```");
  return lines.join("\n");
}

function formatPathLogTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp.slice(0, 16).replace("T", " ");
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// Drive-link notes for FOLDERS carry this prefix on their basename so the wikilink shows folder-ness
// at a glance (kdr's choice over a per-link alias, which would clutter cmd-O and every backlink). Only
// folders get it, so file-note names stay clean.
const FOLDER_ASSET_NOTE_PREFIX = "📁 ";

function sanitizeFileBasename(value: string): string {
  // Normalize to NFC. Drive file names from macOS can be NFD (decomposed Hangul / 자소분리), but
  // Obsidian registers note names in NFC (완성형). A non-NFC basename makes the asset-note `[[wikilink]]`
  // (which reuses this basename) fail to resolve to its own NFC note, so Obsidian creates an empty
  // duplicate ("Drive - … 1.md"). Normalizing keeps the created file AND the wikilink in NFC — the form
  // Obsidian matches. (kdr diagnosed this from the NFD/NFC mismatch.)
  const sanitized = value
    .normalize("NFC")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .trim();

  return sanitized.length > 0 ? sanitized : "Untitled Drive asset";
}

function sanitizeVaultFolderPath(value: string): string {
  const normalized = normalizePath(value.trim()).replace(/^\/+|\/+$/g, "");
  return normalized === "." ? "" : normalized;
}

// Keys the plugin owns and must never let the user's extra-frontmatter template set: the refreshable
// `drive_*` metadata keys plus the write-once `drive_origin` provenance key.
const DRIVE_MANAGED_FRONTMATTER_KEYS = new Set<string>([...ASSET_NOTE_METADATA_KEYS, DRIVE_ORIGIN_KEY]);

// Parse the user's extra-frontmatter YAML into a key→value object, minus any Drive-managed keys.
// Returns {} on empty/invalid input (with a one-time Notice for invalid YAML).
function parseExtraAssetNoteFrontmatterObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    new Notice(`Extra Drive-link note frontmatter is invalid YAML; skipping it. ${formatErrorMessage(error)}`);
    return {};
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isPlainRecord(parsed)) {
    new Notice("Extra Drive-link note frontmatter must be a YAML mapping; skipping it.");
    return {};
  }

  const extraFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!DRIVE_MANAGED_FRONTMATTER_KEYS.has(key)) {
      extraFrontmatter[key] = value;
    }
  }
  return extraFrontmatter;
}

function parseExtraAssetNoteFrontmatter(raw: string): string[] {
  const extraFrontmatter = parseExtraAssetNoteFrontmatterObject(raw);
  if (Object.keys(extraFrontmatter).length === 0) {
    return [];
  }

  return stringifyYaml(extraFrontmatter)
    .replace(/\s+$/, "")
    .split("\n")
    .filter((line) => line.length > 0);
}

// A frontmatter value counts as "empty" (eligible for backfill) when absent, null, "", or [].
function isEmptyFrontmatterValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
