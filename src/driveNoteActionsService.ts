import { App, ButtonComponent, MarkdownPostProcessorContext, Notice, TFile } from "obsidian";
import { DriveMetadataService } from "./driveMetadataService";
import { askDriveTrashAction } from "./driveTrashModal";
import { DriveScopeError, DriveTrashService } from "./driveTrashService";
import { GoogleDriveAttachmentBridgeSettings } from "./settings";

const DRIVE_FOLDER_URL = "https://drive.google.com/drive/folders/";
const DRIVE_FILE_VIEW_URL = "https://drive.google.com/file/d/";

interface ActionsFrontmatter {
  drive_id?: unknown;
  drive_name?: unknown;
  drive_path?: unknown;
  drive_size_human?: unknown;
  drive_web_view_link?: unknown;
}

// Per-note Drive actions, shared by the commands, the file-menu, and the in-note `drive-actions`
// button block: open the file in Drive, open its CURRENT containing folder, and delete it.
export class DriveNoteActionsService {
  constructor(
    private readonly app: App,
    private readonly metadata: DriveMetadataService,
    private readonly trash: DriveTrashService,
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
    // Called after a file is trashed/deleted so the caller can drop cached previews and re-render.
    private readonly onFileRemoved?: (driveId: string) => void,
  ) {}

  openInDrive(driveId: string, webViewLink?: string | null): void {
    const url = webViewLink && webViewLink.length > 0 ? webViewLink : `${DRIVE_FILE_VIEW_URL}${driveId}/view`;
    window.open(url);
  }

  // Open the file's CURRENT containing folder. The parent is resolved live (a Drive file's parent can
  // change when it's moved, and there's no fixed file→folder URL), so this is always correct rather
  // than relying on a stored value that could go stale.
  async openContainingFolder(driveId: string): Promise<void> {
    try {
      const metadata = await this.metadata.getFileMetadata(driveId);
      const parentId = metadata.parents?.[0];
      if (!parentId) {
        new Notice("Couldn't find a parent folder for this file (it may sit in a drive root, or be trashed).");
        return;
      }
      window.open(`${DRIVE_FOLDER_URL}${parentId}`);
    } catch (error) {
      new Notice(`Could not open the Drive folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Confirm, then trash (recoverable) or permanently delete the note's Drive file, and stamp the note
  // so it records that its Drive file is gone. The note itself is left in place.
  async deleteDriveFile(file: TFile, driveId: string): Promise<void> {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const driveName = typeof frontmatter.drive_name === "string" && frontmatter.drive_name.trim().length > 0
      ? frontmatter.drive_name
      : driveId;

    const choice = await askDriveTrashAction(this.app, {
      name: driveName,
      path: typeof frontmatter.drive_path === "string" ? frontmatter.drive_path : null,
      sizeHuman: typeof frontmatter.drive_size_human === "string" ? frontmatter.drive_size_human : null,
    });
    if (!choice) {
      return;
    }

    try {
      if (choice === "trash") {
        await this.trash.trashFile(driveId);
        await this.stampDeletionState(file, "trashed");
        new Notice(`Moved to Drive trash (recoverable ~30 days): ${driveName}`);
      } else {
        await this.trash.deleteFilePermanently(driveId);
        await this.stampDeletionState(file, "deleted");
        new Notice(`Permanently deleted from Drive: ${driveName}`);
      }
      // Drop cached previews + re-render so embeds reflect the deletion instead of showing stale bytes.
      this.onFileRemoved?.(driveId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The scope message is long and actionable — keep it up until clicked; others get a 10s Notice.
      new Notice(`Delete Drive file failed: ${message}`, error instanceof DriveScopeError ? 0 : 10000);
    }
  }

  private async stampDeletionState(file: TFile, kind: "trashed" | "deleted"): Promise<void> {
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter[kind === "trashed" ? "drive_trashed" : "drive_deleted"] = true;
        frontmatter.drive_deleted_checked = new Date().toISOString();
      });
    } catch (error) {
      // The Drive file is already gone; failing to annotate the note is non-fatal.
      console.warn("[Drive Attachment Bridge] Could not stamp deletion state on the note.", error);
    }
  }

  // Render the `drive-actions` fenced block: a row of buttons plus (optionally) the embed-backlinks
  // list. Resolves the file id from the block body (first non-blank line) or the host note's drive_id
  // frontmatter.
  renderActionsBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    el.empty();
    el.addClass("gdab-drive-actions-block");

    const driveId = this.resolveDriveId(source, ctx);
    if (!driveId) {
      el.createDiv({
        cls: "gdab-drive-actions-empty",
        text: "No Drive file id — use this block in a Drive-link note (or add an id line).",
      });
      return;
    }

    const frontmatter = this.getSourceFrontmatter(ctx);
    const webViewLink = typeof frontmatter?.drive_web_view_link === "string" ? frontmatter.drive_web_view_link : null;

    const buttons = el.createDiv({ cls: "gdab-drive-actions" });
    new ButtonComponent(buttons)
      .setButtonText("Open in Drive")
      .onClick(() => this.openInDrive(driveId, webViewLink));

    new ButtonComponent(buttons)
      .setButtonText("Open folder")
      .onClick(() => void this.openContainingFolder(driveId));

    new ButtonComponent(buttons)
      .setButtonText("Delete file…")
      .setWarning()
      .onClick(() => {
        const host = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (host instanceof TFile) {
          void this.deleteDriveFile(host, driveId);
        } else {
          new Notice("Open this note as a file to delete its Drive file.");
        }
      });

    if (this.getSettings().showEmbedBacklinks) {
      const backlinks = el.createDiv({ cls: "gdab-drive-backlinks" });
      void this.fillEmbedBacklinks(backlinks, driveId, ctx.sourcePath);
    }
  }

  // List every OTHER note that embeds this Drive file — the "backlinks" Obsidian can't build for a
  // rendered code block. Counts only real `drive-preview` fences whose body holds this exact id (not
  // bare mentions of the id in prose, which would false-positive on e.g. a chat transcript), and shows
  // a per-note count when a note embeds it more than once, like Obsidian's own backlinks.
  private async fillEmbedBacklinks(host: HTMLElement, driveId: string, selfPath: string): Promise<void> {
    host.empty();
    host.createDiv({ cls: "gdab-drive-backlinks-status", text: "Finding notes that embed this file…" });

    const matches: { file: TFile; count: number }[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path === selfPath) {
        continue;
      }
      let content: string;
      try {
        content = await this.app.vault.cachedRead(file);
      } catch {
        continue;
      }
      const count = countDrivePreviewEmbeds(content, driveId);
      if (count > 0) {
        matches.push({ file, count });
      }
    }

    host.empty();
    if (matches.length === 0) {
      host.createDiv({ cls: "gdab-drive-backlinks-empty", text: "Not embedded in any other note." });
      return;
    }

    const totalEmbeds = matches.reduce((sum, m) => sum + m.count, 0);
    host.createDiv({
      cls: "gdab-drive-backlinks-title",
      text: `Embedded ${totalEmbeds}× in ${matches.length} note${matches.length === 1 ? "" : "s"}:`,
    });
    const list = host.createEl("ul", { cls: "gdab-drive-backlinks-list" });
    for (const { file, count } of matches) {
      const li = list.createEl("li");
      const link = li.createEl("a", {
        cls: "internal-link",
        text: file.basename,
        attr: { href: file.path },
      });
      if (count > 1) {
        li.createSpan({ cls: "gdab-drive-backlinks-count", text: ` (${count})` });
      }
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void this.app.workspace.openLinkText(file.path, selfPath);
      });
    }
  }

  private resolveDriveId(source: string, ctx: MarkdownPostProcessorContext): string | null {
    const explicit = source
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (explicit) {
      return explicit;
    }
    const id = this.getSourceFrontmatter(ctx)?.drive_id;
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  }

  private getSourceFrontmatter(ctx: MarkdownPostProcessorContext): ActionsFrontmatter | null {
    if (ctx.frontmatter && typeof ctx.frontmatter === "object") {
      return ctx.frontmatter as ActionsFrontmatter;
    }
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) {
      return null;
    }
    return this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
  }
}

// Count `drive-preview` fenced blocks whose body holds this exact Drive id (one non-option line equal
// to it). Restricting to the fence avoids false positives where the id merely appears in prose or
// frontmatter elsewhere (e.g. a verbatim chat transcript).
function countDrivePreviewEmbeds(content: string, driveId: string): number {
  const fenceRe = /```+drive-preview[^\n]*\n([\s\S]*?)```/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(content)) !== null) {
    const body = match[1] ?? "";
    if (body.split("\n").some((line) => line.trim() === driveId)) {
      count += 1;
    }
  }
  return count;
}
