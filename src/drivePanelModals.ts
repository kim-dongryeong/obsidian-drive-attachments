// The Drive panel's seven modal dialogs — drop confirm, new folder, rename, folder color picker,
// trash/permanent-delete confirms, and the destination folder picker (with its own pagination).
// Extracted from drivePanelView.ts (T-011 P4: behaviour-preserving move; the only edit is typing
// the constructors' `app` as obsidian's App instead of App — the same type).

import { App, Modal, Notice, setIcon } from "obsidian";
import { DRIVE_FOLDER_MIME_TYPE } from "./driveTypes";
import { DriveBrowserItem, DriveBrowserPage, DriveMetadataService } from "./driveMetadataService";
import { formatCount } from "./drivePanelText";
import { describePanelDropItems } from "./drivePanelDropUtil";
import { folderColorHex } from "./drivePanelFormat";
import { DrivePanelLocation, MY_DRIVE_ROOT } from "./drivePanelLocation";
import { normalizeDriveFolderId } from "./driveFolderLink";

export interface PanelDropConfirmOptions {
  entries: FileSystemEntry[];
  files: File[];
  targetBreadcrumb: string;
  targetName: string;
  onConfirm: () => void;
}

export class PanelDropConfirmModal extends Modal {
  constructor(app: App, private readonly options: PanelDropConfirmOptions) {
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

export class NewDriveFolderModal extends Modal {
  private inputEl: HTMLInputElement | null = null;

  constructor(
    app: App,
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

export class RenameDriveItemModal extends Modal {
  private inputEl: HTMLInputElement | null = null;

  constructor(
    app: App,
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

export class FolderColorPickerModal extends Modal {
  private colors: string[] = [];
  private loading = false;
  private errorMessage: string | null = null;
  private generation = 0;

  constructor(
    app: App,
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
export class PanelDeleteConfirmModal extends Modal {
  constructor(
    app: App,
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
export class PanelPermanentDeleteConfirmModal extends Modal {
  constructor(
    app: App,
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

export interface PanelFolderPickerOptions {
  title: string;
  detail: string;
  actionLabel: string;
  metadata: DriveMetadataService;
  roots: DrivePanelLocation[];
  initialPath: DrivePanelLocation[];
  excludedFolderIds?: Set<string>;
  excludedNotice?: string;
  onChoose: (folder: DrivePanelLocation) => void;
  // Optional "New folder" affordance in the picker's button row: creates a folder under the currently
  // browsed location (undefined = My Drive root) and returns its id. Absent → the button is hidden.
  createFolder?: (name: string, parentFolderId: string | undefined) => Promise<string>;
  // Optional collapsed "Use a folder link or ID" disclosure at the bottom of the modal, letting a
  // folder be chosen by pasted link/ID instead of browsing. Absent → the disclosure is hidden.
  allowLinkEntry?: boolean;
  // Called from onClose when the modal closes WITHOUT a folder having been chosen (Cancel, Esc,
  // clicking outside) — never called after onChoose already fired.
  onCancel?: () => void;
}

export class PanelFolderPickerModal extends Modal {
  private path: DrivePanelLocation[];
  private folders: DriveBrowserItem[] = [];
  private loading = false;
  private errorMessage: string | null = null;
  private generation = 0;
  private chosen = false;
  private linkEntryExpanded = false;
  private linkEntryValue = "";

  constructor(app: App, private readonly options: PanelFolderPickerOptions) {
    super(app);
    this.path = options.initialPath.length > 0 ? options.initialPath.map((location) => ({ ...location })) : [{ ...MY_DRIVE_ROOT }];
  }

  onOpen(): void {
    this.render();
    void this.loadCurrentFolder();
  }

  onClose(): void {
    if (!this.chosen) {
      this.options.onCancel?.();
    }
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
    if (this.options.createFolder) {
      const newFolderButton = buttons.createEl("button", { text: "New folder" });
      newFolderButton.disabled = this.loading;
      newFolderButton.addEventListener("click", () => this.openNewFolderModal());
    }
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const chooseButton = buttons.createEl("button", { cls: "mod-cta", text: this.options.actionLabel });
    chooseButton.disabled = this.loading || this.isExcluded(this.currentLocation.id);
    chooseButton.addEventListener("click", () => this.chooseCurrentFolder());

    if (this.options.allowLinkEntry) {
      this.renderLinkEntry(contentEl);
    }
  }

  // Collapsed-by-default disclosure offering a folder link/ID as an alternative to browsing —
  // handy when the target folder is buried deep or was just shared as a link.
  private renderLinkEntry(contentEl: HTMLElement): void {
    const row = contentEl.createDiv({
      cls: `gdab-folder-picker-link-row${this.linkEntryExpanded ? " is-expanded" : ""}`,
    });
    const toggle = row.createEl("button", { cls: "gdab-folder-picker-link-toggle" });
    const chevron = toggle.createSpan({ cls: "gdab-folder-picker-link-chevron", attr: { "aria-hidden": "true" } });
    setIcon(chevron, "chevron-right");
    toggle.createSpan({ text: "Use a folder link or ID" });
    toggle.setAttribute("aria-expanded", String(this.linkEntryExpanded));
    toggle.addEventListener("click", () => {
      this.linkEntryExpanded = !this.linkEntryExpanded;
      this.render();
    });

    if (!this.linkEntryExpanded) {
      return;
    }

    const linkBody = row.createDiv({ cls: "gdab-folder-picker-link-body" });
    linkBody.createEl("p", {
      cls: "gdab-folder-picker-link-hint",
      text: "Paste a folder link from drive.google.com, or its ID.",
    });
    const inputRow = linkBody.createDiv({ cls: "gdab-folder-picker-link-input-row" });
    const input = inputRow.createEl("input", {
      type: "text",
      cls: "gdab-folder-picker-link-input",
      attr: { "aria-label": "Folder link or ID" },
    });
    input.value = this.linkEntryValue;
    input.addEventListener("input", () => {
      this.linkEntryValue = input.value;
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.confirmLinkEntry();
      }
    });
    const confirmButton = inputRow.createEl("button", { cls: "mod-cta", text: "Use folder" });
    confirmButton.addEventListener("click", () => this.confirmLinkEntry());
    window.setTimeout(() => input.focus(), 0);
  }

  private confirmLinkEntry(): void {
    const folderId = normalizeDriveFolderId(this.linkEntryValue);
    if (!folderId) {
      new Notice("Enter a folder link or ID.");
      return;
    }
    this.chosen = true;
    this.close();
    this.options.onChoose({ id: folderId, name: "" });
  }

  // Creates a folder under the currently browsed location (undefined = My Drive root, matching
  // createFolder's own parentFolderId convention), then refreshes the current listing and navigates
  // into the new folder.
  private openNewFolderModal(): void {
    const createFolder = this.options.createFolder;
    if (!createFolder) {
      return;
    }
    const breadcrumb = this.path.map((location) => location.name).join(" / ");
    const parentFolderId = this.currentLocation.id === MY_DRIVE_ROOT.id ? undefined : this.currentLocation.id;
    new NewDriveFolderModal(this.app, breadcrumb, (name) => {
      void (async () => {
        try {
          const folderId = await createFolder(name, parentFolderId);
          this.path.push({ id: folderId, name });
          await this.loadCurrentFolder();
        } catch (error) {
          new Notice(`Couldn't create folder: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }).open();
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
    this.chosen = true;
    this.close();
    this.options.onChoose({ ...folder });
  }

  private isExcluded(folderId: string): boolean {
    return this.options.excludedFolderIds?.has(folderId) ?? false;
  }
}
