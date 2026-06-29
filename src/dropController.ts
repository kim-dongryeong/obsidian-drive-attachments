import { App, ButtonComponent, Editor, EditorPosition, MarkdownFileInfo, MarkdownView, Modal, Notice } from "obsidian";
import { askDriveDedupAction } from "./driveDedupModal";
import { computeMd5Hex, DriveDedupHit, DriveDedupService } from "./driveDedupService";
import { DriveMetadataService } from "./driveMetadataService";
import { DriveUploadService } from "./driveUploadService";
import {
  DRIVE_PANEL_DRAG_MIME,
  DrivePickerItem,
  parseDrivePanelDragItems,
} from "./driveTypes";
import { InsertService } from "./insertService";
import { PanelDragModifierState, PanelDragModifierTracker } from "./panelDragModifierTracker";
import { GoogleDriveAttachmentBridgeSettings, PanelDragOutMode } from "./settings";

// Monotonic per-session counter that makes each upload placeholder string unique, so we can find it
// again with indexOf even after the document shifts around it during the (async) upload.
let uploadPlaceholderSeq = 0;

/**
 * Intercepts local-file drops in the editor so the plugin can offer to upload them to Google Drive
 * instead of writing them into the Git-tracked vault (the project's core idea).
 *
 * **D3 — the load-bearing rule.** Obsidian's `editor-drop` event is synchronous: Obsidian performs
 * its default attachment insert the instant this handler returns. You therefore CANNOT await a modal
 * and then prevent — by then the default has already fired. The correct shape is:
 *   1. detect a local-file drop and capture `Array.from(dataTransfer.files)` **synchronously**;
 *   2. call `evt.preventDefault()` **synchronously**, before any `await`, to stop the vault insert.
 */
export class DropController {
  constructor(
    private readonly app: App,
    private readonly upload: DriveUploadService,
    private readonly insert: InsertService,
    private readonly dedup: DriveDedupService,
    private readonly metadata: DriveMetadataService,
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
    private readonly panelDragModifiers: PanelDragModifierTracker,
  ) {}

  /**
   * Handle one `editor-drop`. Returns `true` when this was a panel or local-file drop we claimed
   * (default prevented), `false` when we left the event untouched for Obsidian to handle.
   */
  handleEditorDrop(evt: DragEvent, editor: Editor, info: MarkdownFileInfo): boolean {
    if (evt.defaultPrevented) {
      return false;
    }

    // Panel drag-OUT: read the modifier NOW (on drop) and insert in the chosen format. Shared with the
    // document-level ⌘ fallback (handlePanelDropFallback).
    if (this.dispatchPanelDrop(evt, editor, info.file)) {
      return true;
    }

    const files = extractLocalFiles(evt.dataTransfer);
    if (files.length === 0) {
      // Not a local-file drop — dragged text, an Obsidian internal link, or a URL (those carry no
      // `dataTransfer.files`). Leave Obsidian's default drop behavior completely alone: do NOT
      // preventDefault, or we would break normal text/link drops.
      return false;
    }

    // Local files present. Stop Obsidian's default vault insert NOW, synchronously, before any
    // async work — this is the D3 rule. `files` is already captured above so the refs cannot go
    // stale once the event finishes dispatching.
    evt.preventDefault();
    const dropPosition = { ...editor.getCursor() };
    const sourceFile = info.file;
    const sourcePath = info.file?.path ?? "";

    new DropActionModal(
      this.app,
      files,
      async () => {
        await this.saveFilesLocally(files, editor, dropPosition, sourcePath);
      },
      () => {
        void this.uploadFilesToDrive(files, editor, dropPosition, sourcePath, sourceFile);
      },
    ).open();
    return true;
  }

  // The panel drag-OUT insert, shared by `editor-drop` and the document-level ⌘ fallback. Reads the
  // modifier held AT DROP (tracker ORed with the event), picks note/link/embed, inserts at the cursor.
  // Returns true when it claimed the drop (preventDefault'd + inserted). "off" or a non-panel drop → false.
  private dispatchPanelDrop(evt: DragEvent, editor: Editor, file: MarkdownFileInfo["file"]): boolean {
    const panelItems = parseDrivePanelDragItems(readPanelDragPayload(evt.dataTransfer));
    if (panelItems.length === 0) {
      return false;
    }
    const mode = resolvePanelDragOutMode(this.panelDragModifiers.current(evt), this.getSettings().panelDragOut);
    if (mode === "off") {
      return false;
    }
    evt.preventDefault();
    const dropPosition = { ...editor.getCursor() };
    if (mode === "note") {
      this.insertDriveLinkNotesAtDrop(panelItems, editor, dropPosition, file).catch((error) => {
        new Notice(`Drive-link note drop failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      this.insertFormattedDriveItemsAtDrop(panelItems, mode, editor, dropPosition);
    }
    return true;
  }

  // Fallback for the ⌘ drag-OUT only macOS can explain: holding ⌘ forces the drag operation to "move"
  // (the dropEffect we set is IGNORED — kdr saw a plain "move" pointer, no copy/link badge), and the
  // editor never fires `editor-drop` for a "move" drop, so ⌘ silently did nothing. This catches the raw
  // DOM `drop` at document level (registered bubble-phase in main.ts, so a copy/link drop already claimed
  // by `editor-drop` is skipped via defaultPrevented). Resolve the active Markdown editor and insert.
  handlePanelDropFallback(evt: DragEvent): void {
    if (evt.defaultPrevented) {
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }
    this.dispatchPanelDrop(evt, view.editor, view.file);
  }

  private insertFormattedDriveItemsAtDrop(
    items: DrivePickerItem[],
    mode: "link" | "embed",
    editor: Editor,
    dropPosition: EditorPosition,
  ): void {
    const markdown = items.map((item) => {
      // Folders embed too now (the drive-preview block renders a folder card), so ⌥-dragging a folder
      // into a note no longer falls back to an inline link.
      if (mode === "embed") {
        return this.insert.formatDriveEmbedBlock(item.id);
      }
      return this.insert.formatInlineDriveLink(item.name, item.webViewLink);
    });
    // Single newline between items (kdr's pick) — consistent with the note drop above; embeds stack
    // back-to-back without a blank line.
    editor.replaceRange(markdown.join("\n"), dropPosition);
  }

  // Async branch of a "note"-mode drag-OUT (default already prevented in handleEditorDrop). For each
  // dragged Drive item, ensure its asset note exists (reusing the row action's path) and collect the
  // wikilink, then insert them at the captured drop position. Each item is independent — one failure
  // shows its own Notice and the rest still land. Nothing is inserted if every item failed.
  private async insertDriveLinkNotesAtDrop(
    items: DrivePickerItem[],
    editor: Editor,
    dropPosition: EditorPosition,
    sourceFile: MarkdownFileInfo["file"],
  ): Promise<void> {
    const wikilinks: string[] = [];
    for (const item of items) {
      try {
        const { wikilink } = await this.insert.ensureDriveLinkNoteForItem(item, sourceFile, "linked");
        wikilinks.push(wikilink);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        new Notice(`Could not create a Drive-link note for "${item.name}": ${detail}`);
      }
    }
    if (wikilinks.length === 0) {
      return;
    }
    // Single newline (no blank line) between items, consistent with the link/embed drop
    // (insertFormattedDriveItemsAtDrop). kdr's pick — and embeds (fenced drive-preview blocks) render
    // fine back-to-back, so no blank line is needed.
    editor.replaceRange(wikilinks.join("\n"), dropPosition);
    new Notice(
      wikilinks.length === 1
        ? "Inserted a Drive-link note."
        : `Inserted ${wikilinks.length} Drive-link notes.`,
    );
  }

  /**
   * Handle one `editor-paste`. Routes pasted images (e.g. screenshots) per the `pastedImageDestination`
   * setting: "vault" leaves Obsidian's default alone, "drive" uploads straight away, "ask" shows the
   * same Save/Upload modal as a drop. Returns true when we claimed the paste (default prevented).
   *
   * Same D3 rule as drops: `editor-paste` is synchronous, so we capture the files and call
   * `evt.preventDefault()` BEFORE any await, or Obsidian's default attachment save already fired.
   */
  handleEditorPaste(evt: ClipboardEvent, editor: Editor, info: MarkdownFileInfo): boolean {
    const destination = this.getSettings().pastedImageDestination;
    if (destination === "vault" || evt.defaultPrevented) {
      return false;
    }

    const files = extractPastedImageFiles(evt.clipboardData);
    if (files.length === 0) {
      // Not an image paste (plain text, markdown, an internal link, an HTML snippet). Leave
      // Obsidian's default paste completely untouched.
      return false;
    }

    evt.preventDefault();
    const pastePosition = { ...editor.getCursor() };
    const sourceFile = info.file;
    const sourcePath = info.file?.path ?? "";

    if (destination === "drive") {
      // Pasted images embed inline (drive-preview) rather than insert a wikilink — kdr's default.
      void this.uploadFilesToDrive(files, editor, pastePosition, sourcePath, sourceFile, true);
      return true;
    }

    new DropActionModal(
      this.app,
      files,
      async () => {
        await this.saveFilesLocally(files, editor, pastePosition, sourcePath);
      },
      () => {
        void this.uploadFilesToDrive(files, editor, pastePosition, sourcePath, sourceFile, true);
      },
      "pasted",
    ).open();
    return true;
  }

  private async saveFilesLocally(
    files: File[],
    editor: Editor,
    dropPosition: ReturnType<Editor["getCursor"]>,
    sourcePath: string,
  ): Promise<void> {
    const links: string[] = [];

    for (const file of files) {
      links.push(await this.saveFileLocally(file, sourcePath));
    }

    editor.replaceRange(links.join("\n"), dropPosition);
    new Notice(`Saved ${files.length} dropped file(s) locally.`);
  }

  private async saveFileLocally(file: File, sourcePath: string): Promise<string> {
    const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
    const createdFile = await this.app.vault.createBinary(path, await file.arrayBuffer());
    return this.app.fileManager.generateMarkdownLink(createdFile, sourcePath);
  }

  // Upload-to-Drive branch (D3: default already prevented, so we own the insert). Insert one unique
  // text placeholder per file at the drop cursor SYNCHRONOUSLY, then upload each file and swap its
  // placeholder for the Drive link via InsertService. Each file is independent — one failure marks
  // only its own placeholder and shows an actionable Notice, never a silent loss.
  private async uploadFilesToDrive(
    files: File[],
    editor: Editor,
    dropPosition: EditorPosition,
    sourcePath: string,
    sourceFile: MarkdownFileInfo["file"],
    embedImages = false,
  ): Promise<void> {
    const placeholders = files.map((file) => makeUploadPlaceholder(file.name));
    const placeholderText = placeholders.join("\n");
    editor.replaceRange(placeholderText, dropPosition);
    // Move the cursor to the END of the placeholder so the user can press Enter for a line below right
    // away — and when the async upload swaps the placeholder for the embed, a cursor sitting at the end
    // of the replaced range maps to the end of the embed, so Enter still opens a new line under it.
    editor.setCursor(editor.offsetToPos(editor.posToOffset(dropPosition) + placeholderText.length));
    new Notice(`Uploading ${files.length} dropped file(s) to Google Drive…`);

    const parentFolderId = this.getSettings().defaultUploadFolderId || undefined;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const placeholder = placeholders[index];
      try {
        const data = await file.arrayBuffer();
        const md5 = computeMd5Hex(data);
        const duplicate = await this.findUploadDuplicate(md5, file.name);

        if (duplicate) {
          const action = await askDriveDedupAction(this.app, duplicate, this.metadata);
          if (action === null) {
            removePlaceholder(editor, placeholder);
            continue;
          }
          if (action === "use-existing") {
            const markdown = await this.formatUploadedItem(duplicate.item, sourceFile, embedImages);
            this.seedDedupFromInsertedAssetNote(md5, duplicate.item.id);
            if (!replacePlaceholder(editor, placeholder, markdown)) {
              new Notice(`Linked existing Drive file ${duplicate.item.name}, but its placeholder was gone — link: ${markdown}`);
            } else {
              new Notice(`Linked existing Drive file: ${duplicate.item.name}`);
            }
            continue;
          }
          // "upload-anyway" falls through to the unchanged upload path, reusing the same buffer.
        }

        const result = await this.upload.uploadFile({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data,
          parentFolderId,
        });
        const markdown = await this.formatUploadedItem(result.item, sourceFile, embedImages);
        this.seedDedupFromInsertedAssetNote(md5, result.item.id);

        if (!replacePlaceholder(editor, placeholder, markdown)) {
          // The placeholder was edited/removed while the upload was in flight — surface the link in a
          // Notice so the successful upload is never silently lost.
          new Notice(`Uploaded ${result.item.name}, but its placeholder was gone — link: ${markdown}`);
        } else if (result.usedRootFallback) {
          new Notice(
            `Uploaded ${result.item.name} to Google Drive root because the upload folder was not writable. Needs live Drive verification.`,
          );
        } else {
          new Notice(`Uploaded to Google Drive: ${result.item.name}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          const localMarkdown = await this.saveFileLocally(file, sourcePath);
          const fallbackMessage = `${localMarkdown}\n\n**⚠️ Drive upload failed; saved locally instead: ${file.name}**`;
          if (!replacePlaceholder(editor, placeholder, fallbackMessage)) {
            new Notice(`Upload failed for ${file.name}; saved locally instead. Link: ${localMarkdown}`);
          } else {
            new Notice(`Upload failed for ${file.name}; saved locally instead. Drive error: ${detail}`);
          }
        } catch (localError) {
          const localDetail = localError instanceof Error ? localError.message : String(localError);
          replacePlaceholder(editor, placeholder, `**⚠️ Drive upload failed: ${file.name}**`);
          new Notice(`Upload to Drive failed (${file.name}): ${detail}. Local fallback also failed: ${localDetail}`);
        }
      }
    }
  }

  // Dedup must never block an upload: any local/cache/API/modal lookup failure means "no match" and
  // this drop item proceeds through the pre-existing upload path.
  private async findUploadDuplicate(md5: string, fileName: string): Promise<DriveDedupHit | null> {
    try {
      return await this.dedup.findDuplicate({
        md5,
        fileName,
      });
    } catch (error) {
      console.warn("[Drive Attachment Bridge] Upload dedup check failed; proceeding with upload.", error);
      return null;
    }
  }

  // Paste-to-Drive embeds the image inline (drive-preview) instead of inserting a wikilink; drop keeps
  // the configured link format. Both still create/reuse the asset note for metadata + dedup.
  private async formatUploadedItem(
    item: DrivePickerItem,
    sourceFile: MarkdownFileInfo["file"],
    embed: boolean,
  ): Promise<string> {
    return embed
      ? await this.insert.createAssetNoteAndEmbed(item, sourceFile, "uploaded")
      : await this.insert.formatDriveItemMarkdown(item, sourceFile, "uploaded");
  }

  private seedDedupFromInsertedAssetNote(md5: string, driveId: string): void {
    if (this.getSettings().linkFormat !== "asset-note") {
      return;
    }

    const path = this.insert.getAssetNotePathForDriveId(driveId);
    if (path) {
      this.dedup.rememberVaultAssetNote(md5, path);
    }
  }
}

class DropActionModal extends Modal {
  constructor(
    app: App,
    private readonly files: File[],
    private readonly onSaveLocally: () => Promise<void>,
    private readonly onUploadToDrive: () => void,
    private readonly kind: "dropped" | "pasted" = "dropped",
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.kind === "pasted" ? "Handle pasted image" : "Handle dropped file");
    contentEl.empty();

    contentEl.createEl("p", {
      text: formatFilesSummary(this.files, this.kind),
      cls: ["setting-item-description", "gdab-drop-file-summary"],
    });

    const buttonRow = contentEl.createDiv();
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";
    buttonRow.style.justifyContent = "flex-end";
    buttonRow.style.marginTop = "16px";

    new ButtonComponent(buttonRow)
      .setButtonText("Save locally")
      .onClick(async () => {
        try {
          await this.onSaveLocally();
          this.close();
        } catch (error) {
          new Notice(`Save local attachment failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });

    new ButtonComponent(buttonRow)
      .setButtonText("Upload to Drive")
      .setCta()
      .onClick(() => {
        // Close first, then kick off the upload: it inserts progress placeholders into the editor
        // and reports via Notices, so the modal does not need to stay open blocking on a large file.
        this.close();
        this.onUploadToDrive();
      });

    new ButtonComponent(buttonRow)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Synchronously pull the local files out of a drop's `DataTransfer`. Returns `[]` for non-file drops
 * (text, an Obsidian link, a URL) so the caller can leave Obsidian's default behavior untouched.
 */
function extractLocalFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.files);
}

// Read the panel drag payload off a drop's DataTransfer. getData is readable on drop (the
// cross-origin restriction only applies during dragover/dragenter), so other drops return "".
function readPanelDragPayload(dataTransfer: DataTransfer | null): string {
  if (!dataTransfer) {
    return "";
  }
  return dataTransfer.getData(DRIVE_PANEL_DRAG_MIME);
}

function resolvePanelDragOutMode(modifiers: PanelDragModifierState, fallback: PanelDragOutMode): PanelDragOutMode {
  if (fallback === "off") {
    return "off";
  }
  if (modifiers.metaKey || modifiers.ctrlKey) {
    return "note";
  }
  if (modifiers.altKey) {
    return "embed";
  }
  if (modifiers.shiftKey) {
    return "link";
  }
  return fallback;
}

function formatFilesSummary(files: File[], kind: "dropped" | "pasted"): string {
  const verb = kind === "pasted" ? "Pasted" : "Dropped";
  const names = files.map((file) => file.name).join(", ");
  return files.length === 1
    ? `${verb} file: ${names}`
    : `${verb} ${files.length} files: ${names}`;
}

// Pull pasted IMAGE files (screenshots, copied images) out of a paste's clipboard. Non-image file
// data and plain text/markdown/HTML pastes yield `[]`, so the caller leaves Obsidian's default paste
// alone. Clipboard screenshots arrive as the generic name "image.png"; give those a stable, sortable
// "Pasted image <timestamp>" name (like Obsidian's own) so each upload is a distinct, findable file.
function extractPastedImageFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) {
    return [];
  }
  const images = Array.from(clipboardData.files).filter((file) => file.type.startsWith("image/"));
  return images.map((file, index) => renameGenericPastedImage(file, index));
}

function renameGenericPastedImage(file: File, index: number): File {
  const base = file.name.replace(/\.[^.]+$/, "");
  if (base && base.toLowerCase() !== "image") {
    return file;
  }
  const suffix = index > 0 ? `-${index + 1}` : "";
  // A new File over the same bytes — File.name is read-only, so we can't rename in place.
  return new File([file], `Pasted image ${pasteTimestamp()}${suffix}.${imageExtension(file)}`, {
    type: file.type,
  });
}

function imageExtension(file: File): string {
  const fromName = file.name.match(/\.([A-Za-z0-9]+)$/);
  if (fromName) {
    return fromName[1].toLowerCase();
  }
  const fromMime = file.type.split("/")[1];
  return fromMime ? fromMime.toLowerCase() : "png";
}

function pasteTimestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

// A visible, unique progress placeholder. The trailing `[gdab-upload:N]` token is what makes it
// findable with indexOf — the sequence never repeats within a session, so we always replace the
// right one even if several uploads are in flight at once.
export function makeUploadPlaceholder(name: string): string {
  uploadPlaceholderSeq += 1;
  return `⏳ Uploading "${name}" to Google Drive… [gdab-upload:${uploadPlaceholderSeq}]`;
}

// Swap the first occurrence of `placeholder` for `replacement`. Returns false if it is no longer in
// the document (user edited/removed it mid-upload), so the caller can avoid losing the result.
export function replacePlaceholder(editor: Editor, placeholder: string, replacement: string): boolean {
  const offset = editor.getValue().indexOf(placeholder);
  if (offset === -1) {
    return false;
  }
  editor.replaceRange(replacement, editor.offsetToPos(offset), editor.offsetToPos(offset + placeholder.length));
  return true;
}

function removePlaceholder(editor: Editor, placeholder: string): boolean {
  const value = editor.getValue();
  const offset = value.indexOf(placeholder);
  if (offset === -1) {
    return false;
  }

  let start = offset;
  let end = offset + placeholder.length;
  if (value.charAt(end) === "\n") {
    end += 1;
  } else if (value.charAt(start - 1) === "\n") {
    start -= 1;
  }

  editor.replaceRange("", editor.offsetToPos(start), editor.offsetToPos(end));
  return true;
}
