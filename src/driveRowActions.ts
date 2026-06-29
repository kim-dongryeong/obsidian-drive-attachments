import { App, Editor, Menu, Notice, TFile } from "obsidian";
import { DriveLightboxModal } from "./driveLightboxModal";
import { DrivePreviewService } from "./drivePreviewService";
import { DRIVE_FOLDER_MIME_TYPE, DrivePickerItem } from "./driveTypes";
import { InsertService } from "./insertService";

// The minimal item shape the row-action menu needs. The panel's `DriveBrowserItem`, the index
// `DriveIndexItem`, and the server `DriveSearchResult` all satisfy it, so the same menu serves
// every Drive row (panel + both search modals) without forking the action set.
export interface DriveActionItem {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string | null;
}

export interface DriveRowActionContext {
  app: App;
  insert: InsertService;
  preview: DrivePreviewService;
  // Resolve the editor (and its file) the insert/embed actions target. The panel lives in the
  // sidebar, so it resolves the most-recent markdown leaf; the search modals supply the editor
  // captured when their command ran. Returns null when no markdown editor is available, so each
  // action surfaces its own "Open a note" Notice instead of throwing.
  resolveEditor: () => { editor: Editor; file: TFile | null } | null;
}

// The shared per-row action menu. Files and folders both get open-in-browser, insert-link,
// insert-as-Drive-link-note, and embed (a `drive-preview` block — a folder card for folders, an
// inline preview for files); files additionally get the quick-preview modal. (Folders no longer
// write the frontmatter attach — kdr asked for the file-style link/note actions instead.)
export function openDriveItemMenu(evt: MouseEvent, item: DriveActionItem, context: DriveRowActionContext): void {
  const isFolder = item.mimeType === DRIVE_FOLDER_MIME_TYPE;
  const menu = new Menu();

  menu.addItem((mi) =>
    mi
      .setTitle("Open in browser")
      .setIcon("external-link")
      .onClick(() => {
        openDriveItemInBrowser(item);
      }),
  );
  menu.addItem((mi) =>
    mi.setTitle("Share in Drive").setIcon("share-2").onClick(() => openDriveItemSharePage(item)),
  );
  menu.addItem((mi) =>
    mi.setTitle("Copy Drive link").setIcon("copy").onClick(() => {
      void copyDriveItemLink(item);
    }),
  );
  menu.addItem((mi) =>
    mi.setTitle("Insert link at cursor").setIcon("link").onClick(() => insertDriveItemLink(item, context)),
  );
  menu.addItem((mi) =>
    mi
      .setTitle("Insert as Drive-link note")
      .setIcon("file-plus")
      .onClick(() => void insertDriveItemAssetNote(item, context)),
  );

  menu.addSeparator();
  menu.addItem((mi) =>
    mi
      .setTitle(isFolder ? "Embed folder card in note" : "Embed preview in note")
      .setIcon(isFolder ? "folder" : "image-plus")
      .onClick(() => embedDriveItemPreview(item, context)),
  );
  if (!isFolder) {
    menu.addItem((mi) =>
      mi.setTitle("Quick preview").setIcon("eye").onClick(() => openDriveItemPreview(item, context)),
    );
  }

  menu.showAtMouseEvent(evt);
}

export function openDriveItemInBrowser(item: DriveActionItem): void {
  if (item.webViewLink) {
    window.open(item.webViewLink);
  } else {
    new Notice(`"${item.name}" has no Drive link to open.`);
  }
}

// Open Google's browser-side sharing surface rather than mutating permissions through the API.
// This remains available under read-only scopes; the user makes any sharing change in Drive itself.
export function openDriveItemSharePage(item: DriveActionItem): void {
  if (!item.webViewLink) {
    new Notice(`"${item.name}" has no Drive link to share.`);
    return;
  }

  try {
    const shareUrl = new URL(item.webViewLink);
    shareUrl.searchParams.set("usp", "sharing");
    window.open(shareUrl.toString());
  } catch {
    new Notice(`"${item.name}" has no usable Drive share link.`);
  }
}

export async function copyDriveItemLink(item: DriveActionItem): Promise<void> {
  if (!item.webViewLink) {
    new Notice(`"${item.name}" has no Drive link to copy.`);
    return;
  }

  try {
    await navigator.clipboard.writeText(item.webViewLink);
    new Notice(`Copied Drive link: ${item.name}`);
  } catch (error) {
    new Notice(`Copy Drive link failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Insert a plain inline Markdown link to the Drive item at the resolved editor's cursor. Forces the
// inline form (insertDriveItemAtCursor would follow the global linkFormat setting, which defaults to
// asset-note) so the menu's "Insert link" always means a link.
export function insertDriveItemLink(item: DriveActionItem, context: DriveRowActionContext): void {
  const target = context.resolveEditor();
  if (!target) {
    new Notice("Open a note to insert a Drive link.");
    return;
  }

  const pickerItem = toPickerItem(item);
  if (!pickerItem) {
    return;
  }

  try {
    context.insert.insertDriveItemAsInlineLinkAtCursor(target.editor, pickerItem);
    new Notice(`Inserted Drive link: ${item.name}`);
  } catch (error) {
    new Notice(`Insert Drive link failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Force an asset-note wikilink for this action even when the global insert setting is inline links.
export async function insertDriveItemAssetNote(item: DriveActionItem, context: DriveRowActionContext): Promise<void> {
  const target = context.resolveEditor();
  if (!target) {
    new Notice("Open a note to insert a Drive-link note.");
    return;
  }

  const pickerItem = toPickerItem(item);
  if (!pickerItem) {
    return;
  }

  try {
    await context.insert.insertDriveItemAsAssetNoteAtCursor(target.editor, pickerItem, target.file);
    new Notice(`Inserted Drive-link note: ${item.name}`);
  } catch (error) {
    new Notice(`Insert Drive-link note failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Embed an inline preview of this Drive item in the resolved note's body — inserts a `drive-preview`
// code block carrying the id. It renders via authed bytes (no public sharing). Distinct from the eye
// action, which opens a transient modal. The block degrades to a card for non-image/oversized files,
// and to a folder card (folder icon + name + Open-in-Drive) for folders.
export function embedDriveItemPreview(item: DriveActionItem, context: DriveRowActionContext): void {
  const target = context.resolveEditor();
  if (!target) {
    new Notice("Open a note to embed a Drive preview.");
    return;
  }

  const isFolder = item.mimeType === DRIVE_FOLDER_MIME_TYPE;
  // A fenced block must start at column 0 to parse, so break the line first if the cursor isn't there.
  // The `width:` line is the default size and is left in so the user can adjust it inline.
  const prefix = target.editor.getCursor().ch > 0 ? "\n" : "";
  target.editor.replaceSelection(`${prefix}\`\`\`drive-preview\n${item.id}\nwidth: 480\n\`\`\`\n`);
  new Notice(`Embedded Drive ${isFolder ? "folder card" : "preview"}: ${item.name}`);
}

export function openDriveItemPreview(item: DriveActionItem, context: DriveRowActionContext): void {
  new DriveLightboxModal(context.app, context.preview, item).open();
}

function toPickerItem(item: DriveActionItem): DrivePickerItem | null {
  if (!item.webViewLink) {
    new Notice(`"${item.name}" has no usable Drive link to insert.`);
    return null;
  }

  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    webViewLink: item.webViewLink,
  };
}
