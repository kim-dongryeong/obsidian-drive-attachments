import { debounce, EventRef, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { DriveAuthService } from "./driveAuthService";
import { CustomIconPackService } from "./customIconPack";
import { askDriveDedupAction } from "./driveDedupModal";
import { computeMd5HexFromSource, DriveDedupHit, DriveDedupService } from "./driveDedupService";
import { DriveIndexService, PersistedDriveIndexSnapshot } from "./driveIndexService";
import { DriveMediaProxyService } from "./driveMediaProxyService";
import { DriveMetadataService } from "./driveMetadataService";
import { DRIVE_PANEL_VIEW_TYPE, DrivePanelView } from "./drivePanelView";
import { DRIVE_PANEL_DRAG_MIME } from "./driveTypes";
import { DrivePickerService } from "./drivePickerService";
import { DrivePreviewService } from "./drivePreviewService";
import { DriveSearchModal } from "./driveSearchModal";
import { DriveSearchService } from "./driveSearchService";
import { DriveTrashService } from "./driveTrashService";
import { DriveUploadResult, DriveUploadService, FileUploadSource } from "./driveUploadService";
import { DriveNoteActionsService } from "./driveNoteActionsService";
import { DropController, makeUploadPlaceholder, removePlaceholder, replacePlaceholder } from "./dropController";
import { PanelFolderPickerModal } from "./drivePanelModals";
import { MY_DRIVE_ROOT, DrivePanelLocation } from "./drivePanelLocation";
import { PanelDragModifierTracker } from "./panelDragModifierTracker";
import { ACTIONS_LANGS, PREVIEW_LANGS } from "./codeBlockLang";
import { InsertService } from "./insertService";
import { openMigrateNoteAttachmentsPreview } from "./migrateNoteAttachments";
import { DEFAULT_SETTINGS, GoogleDriveAttachmentBridgeSettings, parseOAuthClientJson } from "./settings";
import { GoogleDriveAttachmentBridgeSettingTab } from "./settingsTab";

interface AppWithSettings {
  setting?: {
    openTabById: (id: string) => void;
  };
}

export default class GoogleDriveAttachmentBridgePlugin extends Plugin {
  settings: GoogleDriveAttachmentBridgeSettings = { ...DEFAULT_SETTINGS };
  auth!: DriveAuthService;
  picker!: DrivePickerService;
  metadata!: DriveMetadataService;
  index!: DriveIndexService;
  search!: DriveSearchService;
  upload!: DriveUploadService;
  mediaProxy!: DriveMediaProxyService;
  preview!: DrivePreviewService;
  insert!: InsertService;
  dedup!: DriveDedupService;
  trash!: DriveTrashService;
  noteActions!: DriveNoteActionsService;
  dropController!: DropController;
  customIconPack!: CustomIconPackService;
  // Shared by the panel (start/stop per row drag), the capture-phase dragover (picks the dropEffect the
  // macOS modifier expects so the OS accepts the drop), and the editor-drop (reads the drop-time mode).
  panelDragModifiers!: PanelDragModifierTracker;
  // Memoized in-flight promise for ensureDefaultUploadFolder() so concurrent first uploads (e.g. a
  // multi-file drop) share one folder-picker modal instead of each opening their own.
  private ensureDefaultUploadFolderPromise: Promise<string | null> | null = null;

  onunload(): void {
    // Release preview blob URLs / cached data URLs so their byte buffers can be GC'd.
    this.preview?.dispose();
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    this.auth = new DriveAuthService(() => this.settings, () => this.saveSettings());
    this.picker = new DrivePickerService(() => this.settings);
    this.metadata = new DriveMetadataService(this.auth);
    // Persist the Drive index to a sidecar file (not data.json — a large snapshot would bloat the
    // settings the plugin rewrites on every change) so a restart hydrates + delta-syncs instead of
    // re-crawling the whole Drive (T-010).
    const indexSnapshotPath = `${this.manifest.dir ?? this.app.vault.configDir + "/plugins/drive-attachments"}/drive-index.json`;
    const adapter = this.app.vault.adapter;
    this.index = new DriveIndexService(this.auth, () => this.settings.indexPageLimit, {
      async load() {
        try {
          if (!(await adapter.exists(indexSnapshotPath))) {
            return null;
          }
          return JSON.parse(await adapter.read(indexSnapshotPath)) as PersistedDriveIndexSnapshot;
        } catch {
          return null;
        }
      },
      async save(snapshot) {
        await adapter.write(indexSnapshotPath, JSON.stringify(snapshot));
      },
    });
    this.search = new DriveSearchService(this.auth);
    this.upload = new DriveUploadService(this.auth);
    this.mediaProxy = new DriveMediaProxyService(this.auth);
    this.customIconPack = new CustomIconPackService(
      this.app.vault.adapter,
      () => this.settings.customIconPackFolder,
      this.app.vault.configDir,
    );
    await this.customIconPack.reload();
    // Apply pack edits (drop or delete an SVG in the folder) without an Obsidian restart. The `raw`
    // event fires for config-dir files too — unlike create/modify/delete, which only cover the vault's
    // markdown/attachment index — but it isn't in the public types, so reach it via a narrow cast. It
    // can fire in bursts, so debounce and only reload when the changed path is inside the pack folder.
    const rawVault = this.app.vault as unknown as {
      on(name: "raw", callback: (path: string) => void): EventRef;
    };
    this.registerEvent(
      rawVault.on(
        "raw",
        debounce((path: string) => {
          const folder = this.customIconPack.folder;
          if (folder && (path === folder || path.startsWith(`${folder}/`))) {
            void this.reloadCustomIconPack();
          }
        }, 400, true),
      ),
    );
    this.applyCustomIconSize();
    this.insert = new InsertService(this.app, this.auth, this.picker, this.metadata, () => this.settings);
    this.preview = new DrivePreviewService(
      this.app,
      this.auth,
      this.metadata,
      this.mediaProxy,
      this.insert,
      () => this.settings,
      () => this.noteActions,
      (mimeType, name) => this.customIconPack.customIconImgSrc(mimeType, name),
    );
    this.dedup = new DriveDedupService(this.app, this.auth, this.index);
    this.trash = new DriveTrashService(this.auth);
    this.noteActions = new DriveNoteActionsService(this.app, this.metadata, this.trash, () => this.settings, (driveId) => {
      this.preview.invalidate(driveId);
      this.forceRefreshDrivePreviews();
    });
    this.panelDragModifiers = new PanelDragModifierTracker();
    this.dropController = new DropController(this.app, this.upload, this.insert, this.dedup, this.metadata, () => this.settings, this.panelDragModifiers, () => this.ensureDefaultUploadFolder());

    this.addSettingTab(new GoogleDriveAttachmentBridgeSettingTab(this.app, this));
    this.registerView(
      DRIVE_PANEL_VIEW_TYPE,
      (leaf) =>
        new DrivePanelView(
          leaf,
          this.auth,
          this.metadata,
          this.index,
          this.search,
          this.upload,
          this.dedup,
          this.insert,
          this.preview,
          () => this.settings,
          () => this.saveSettings(),
          async () => {
            if (!this.settings.clientId || !this.settings.clientSecret) {
              if (!(await this.importCredentialsJson())) {
                return;
              }
            }
            const email = await this.auth.connect();
            this.refreshDrivePanelAvailability();
            new Notice(`Connected to Google Drive as ${email}.`);
          },
          () => this.openSettingsTab(),
          this.panelDragModifiers,
          (mimeType, name) => this.customIconPack.customIconImgSrc(mimeType, name),
        ),
    );
    this.addRibbonIcon("hard-drive", "Open Drive panel", () => {
      void this.openDrivePanel();
    });

    // Register the namespaced language AND the legacy generic one (read-compat for pre-rename notes).
    for (const lang of PREVIEW_LANGS) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => this.preview.render(source, el, ctx));
    }
    for (const lang of ACTIONS_LANGS) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) =>
        this.noteActions.renderActionsBlock(source, el, ctx),
      );
    }

    // M5: intercept local-file drops so we can offer "upload to Drive" instead of a vault copy.
    // The handler MUST stay synchronous up to preventDefault (D3) — DropController enforces that,
    // then opens the Save locally / Upload to Drive modal.
    this.registerEvent(
      this.app.workspace.on("editor-drop", (evt, editor, info) => {
        if (evt.defaultPrevented) {
          return;
        }
        this.dropController.handleEditorDrop(evt, editor, info);
      }),
    );

    // Make a panel drag-OUT droppable over a Markdown editor WHILE keeping CodeMirror's drop caret
    // visible. Two jobs: (1) set the dropEffect macOS expects for the held modifier — ⌃→link, ⌥/⇧/none
    // →copy — so the OS keeps accepting the drop (a mismatch resolves to "none" and the drop is
    // cancelled). ⌘ is forced to "move" by macOS regardless of what we set and the editor rejects move,
    // so ⌘ can't drop into an editor at all — ⌃ is the note modifier on macOS. (2) preventDefault so the
    // drop is armed. CRUCIAL: this runs in BUBBLE phase, AFTER CodeMirror's own dragover. If we
    // preventDefault in CAPTURE (before CM), CM's dropCursor sees defaultPrevented and skips rendering
    // the insert caret (kdr: "can't tell where the drop lands"). Running after CM lets the caret render
    // first, then we still preventDefault (idempotent) to guarantee the drop. Modifier from current(evt)
    // (live event ORed with the key tracker). Gated to our MIME over an editor; all other drags untouched.
    this.registerDomEvent(
      document,
      "dragover",
      (evt) => {
        const dt = evt.dataTransfer;
        if (!dt || !Array.from(dt.types).includes(DRIVE_PANEL_DRAG_MIME)) {
          return;
        }
        const target = evt.target;
        if (
          target instanceof HTMLElement &&
          target.closest(".cm-editor, .markdown-source-view, .markdown-reading-view, .markdown-preview-view")
        ) {
          const mods = this.panelDragModifiers.current(evt);
          dt.dropEffect = mods.ctrlKey || mods.metaKey ? "link" : "copy";
          evt.preventDefault();
        }
      },
      { capture: false },
    );

    // ⌘ drag-OUT fallback. macOS forces ⌘'s drag operation to "move" and ignores the dropEffect we set
    // (kdr saw a plain "move" pointer), and Obsidian's `editor-drop` never fires for a "move" drop — so
    // ⌘ alone did nothing. Catch the raw DOM `drop` here at document level in BUBBLE phase: it runs AFTER
    // `editor-drop`, so a copy/link drop that handler already claimed is skipped (defaultPrevented), and
    // only the ⌘/"move" drop that slipped through reaches this. Gated to our panel MIME over a Markdown
    // editor, so every other drop is untouched.
    this.registerDomEvent(document, "drop", (evt) => {
      if (evt.defaultPrevented) {
        return;
      }
      const dt = evt.dataTransfer;
      if (!dt || !Array.from(dt.types).includes(DRIVE_PANEL_DRAG_MIME)) {
        return;
      }
      const target = evt.target;
      if (
        target instanceof HTMLElement &&
        target.closest(".cm-editor, .markdown-source-view, .markdown-reading-view, .markdown-preview-view")
      ) {
        this.dropController.handlePanelDropFallback(evt);
      }
    });

    // Intercept pasted images (screenshots etc.) the same way, gated by the pastedImageDestination
    // setting. Default "vault" makes this a no-op so paste behaves exactly as Obsidian's own.
    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, editor, info) => {
        if (evt.defaultPrevented) {
          return;
        }
        this.dropController.handleEditorPaste(evt, editor, info);
      }),
    );

    this.addCommand({
      id: "open-drive-panel",
      name: "Open Drive panel",
      callback: () => {
        void this.openDrivePanel();
      },
    });

    this.addCommand({
      id: "reload-custom-icon-pack",
      name: "Reload custom icon pack",
      callback: async () => {
        await this.reloadCustomIconPack();
        new Notice(
          this.settings.customIconPackFolder
            ? "Reloaded the custom icon pack."
            : "No custom icon pack folder is set — using the built-in icons.",
        );
      },
    });

    // Export/Import icon pack live as BUTTONS in Settings (next to the folder + size), not commands —
    // they're pack-management actions, more discoverable beside the setting. See exportIconPackToJson /
    // importIconPackFromJson below. The "Reload custom icon pack" command stays (handy + hotkey-able).

    this.addCommand({
      id: "migrate-this-notes-attachments-to-drive",
      name: "Migrate this note's attachments to Drive",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canRun = file instanceof TFile && file.extension === "md";
        if (!canRun || checking) {
          return canRun;
        }

        openMigrateNoteAttachmentsPreview(this.app, this.dedup, this.upload, this.insert, this.settings, () => this.ensureDefaultUploadFolder());
        return true;
      },
    });

    this.addCommand({
      id: "insert-drive-link-at-cursor",
      name: "Open Drive picker and insert preview",
      editorCallback: async (editor) => {
        try {
          await this.insert.pickAndInsertPreviewAtCursor(editor, this.app.workspace.getActiveFile());
        } catch (error) {
          new Notice(`Insert Drive preview failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.addCommand({
      id: "search-drive-and-insert-link",
      name: "Search Google Drive and insert preview",
      editorCallback: (editor) => {
        new DriveSearchModal(
          this.app,
          editor,
          this.auth,
          this.index,
          this.search,
          this.metadata,
          this.insert,
          this.preview,
          () => this.settings,
          (mimeType, name) => this.customIconPack.customIconImgSrc(mimeType, name),
        ).open();
      },
    });

    this.addCommand({
      id: "refresh-drive-index",
      name: "Refresh Drive index",
      callback: async () => {
        try {
          if (!this.settings.enableDriveSearch) {
            new Notice("Enable in-Obsidian Drive search in settings.");
            return;
          }

          if (!this.auth.hasDriveSearchScope) {
            new Notice(
              this.auth.isConnected
                ? "Grant Drive read access in settings to use in-Obsidian search."
                : "Connect Google Drive in settings to use in-Obsidian search.",
            );
            return;
          }

          new Notice("Refreshing Google Drive index...");
          const items = await this.index.refresh();
          const state = this.index.getState();
          const capHint = state.capped ? " Index page cap reached — raise the index page limit in settings to index older files." : "";
          new Notice(`Google Drive index refreshed: ${items.length} items.${capHint}`);
        } catch (error) {
          new Notice(`Refresh Drive index failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.addCommand({
      id: "upload-local-file-to-drive",
      name: "Upload local file to Drive and insert preview",
      editorCallback: async (editor) => {
        try {
          const sourceFile = this.app.workspace.getActiveFile();
          const file = await chooseLocalFile();
          if (!file) {
            return;
          }

          // M5.5 (D10): one chunk-readable source shared by the dedup hash and the upload — a large
          // file streams in 5-8 MiB windows instead of ever being fully resident.
          const source = new FileUploadSource(file);
          const md5 = await computeMd5HexFromSource(source);
          const duplicate = await this.findUploadDuplicate(md5, file.name);

          if (duplicate) {
            const action = await askDriveDedupAction(this.app, duplicate, this.metadata);
            if (action === null) {
              // Cancel aborts cleanly — the command flow has inserted nothing yet.
              return;
            }
            if (action === "use-existing") {
              await this.insert.insertDriveItemAtCursor(editor, duplicate.item, sourceFile, "uploaded");
              this.seedDedupFromInsertedAssetNote(md5, duplicate.item.id);
              new Notice(`Linked existing Drive file: ${duplicate.item.name}`);
              return;
            }
            // "upload-anyway" falls through to the unchanged upload path.
          }

          // Same in-editor progress placeholder as the drop flow (kdr: the picker-command path
          // showed only a Notice). Inserted at the cursor, swapped for the link or a failure marker.
          const placeholder = makeUploadPlaceholder(file.name);
          editor.replaceSelection(placeholder);
          new Notice(`Uploading to Google Drive: ${file.name}`);
          const parentFolderId = await this.ensureDefaultUploadFolder();
          if (parentFolderId === null) {
            removePlaceholder(editor, placeholder);
            new Notice("Upload cancelled — no upload folder chosen.");
            return;
          }
          let result: DriveUploadResult;
          try {
            result = await this.upload.uploadFile({
              name: file.name,
              mimeType: file.type || "application/octet-stream",
              source,
              parentFolderId,
            });
          } catch (error) {
            replacePlaceholder(editor, placeholder, `**⚠️ Drive upload failed: ${file.name}**`);
            throw error;
          }
          const markdown = await this.insert.formatDriveItemMarkdown(result.item, sourceFile, "uploaded");
          if (!replacePlaceholder(editor, placeholder, markdown)) {
            new Notice(`Uploaded ${result.item.name}, but its placeholder was gone — link: ${markdown}`);
          }
          this.seedDedupFromInsertedAssetNote(md5, result.item.id);

          if (result.usedRootFallback) {
            new Notice(
              "Uploaded to Google Drive root because the selected upload folder was not writable. This needs live Drive verification.",
            );
          } else {
            new Notice(`Uploaded to Google Drive: ${result.item.name}`);
          }
        } catch (error) {
          new Notice(`Upload to Drive failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.addCommand({
      id: "refresh-drive-metadata",
      name: "Refresh Drive metadata",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const driveId: unknown = file instanceof TFile
          ? this.app.metadataCache.getFileCache(file)?.frontmatter?.drive_id
          : null;
        const canRun = file instanceof TFile && file.extension === "md" && typeof driveId === "string" && driveId.length > 0;
        if (!canRun || checking) {
          return canRun;
        }

        this.insert.refreshDriveMetadata(file).catch((error) => {
          new Notice(`Refresh Drive metadata failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return true;
      },
    });

    this.addCommand({
      id: "delete-this-notes-drive-file",
      name: "Delete this note's Drive file…",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const driveId = this.readActiveNoteDriveId(file);
        if (!driveId) {
          return false;
        }
        if (checking) {
          return true;
        }

        if (!(file instanceof TFile)) {
          return false;
        }
        void this.noteActions.deleteDriveFile(file, driveId);
        return true;
      },
    });

    this.addCommand({
      id: "open-this-notes-drive-folder",
      name: "Open this note's Drive folder",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const driveId = this.readActiveNoteDriveId(file);
        if (!driveId) {
          return false;
        }
        if (checking) {
          return true;
        }

        void this.noteActions.openContainingFolder(driveId);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") {
          return;
        }

        const menuDriveId = this.readActiveNoteDriveId(file);
        if (menuDriveId) {
          menu.addItem((item) => {
            item
              .setTitle("Open Drive folder")
              .setIcon("folder")
              .onClick(() => {
                void this.noteActions.openContainingFolder(menuDriveId);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle("Delete Drive file…")
              .setIcon("trash")
              .onClick(() => {
                void this.noteActions.deleteDriveFile(file, menuDriveId);
              });
          });
        }
      }),
    );
  }

  // First upload forces the folder choice: when no default upload folder is set, open the folder
  // picker (with the link/ID disclosure) and wait for the user to pick or create one — nothing is
  // auto-created. Resolves the chosen folder id, or null if the picker was cancelled. Memoized on
  // ensureDefaultUploadFolderPromise so concurrent uploads (a multi-file drop) share one modal instead
  // of each opening its own.
  async ensureDefaultUploadFolder(): Promise<string | null> {
    if (this.settings.defaultUploadFolderId) {
      return this.settings.defaultUploadFolderId;
    }
    if (!this.ensureDefaultUploadFolderPromise) {
      this.ensureDefaultUploadFolderPromise = this.promptForDefaultUploadFolder().finally(() => {
        this.ensureDefaultUploadFolderPromise = null;
      });
    }
    return this.ensureDefaultUploadFolderPromise;
  }

  private async promptForDefaultUploadFolder(): Promise<string | null> {
    // Offer shared drives alongside My Drive (best-effort — a fetch failure just means the picker
    // starts from My Drive only, same as the panel before its roots load).
    const roots: DrivePanelLocation[] = [{ ...MY_DRIVE_ROOT }];
    try {
      const sharedDrives = await this.metadata.listSharedDriveRoots();
      roots.push(...sharedDrives.map((root) => ({ id: root.id, name: root.name })));
    } catch {
      // ignore — My Drive root alone still works
    }

    return new Promise<string | null>((resolve) => {
      new PanelFolderPickerModal(this.app, {
        title: "Choose your upload folder",
        detail: "Pick where uploads from your notes will land — you can change this anytime in settings.",
        actionLabel: "Use this folder",
        metadata: this.metadata,
        roots,
        initialPath: [{ ...MY_DRIVE_ROOT }],
        createFolder: (name, parent) => this.upload.createFolder(name, parent),
        allowLinkEntry: true,
        onChoose: (folder) => {
          void (async () => {
            this.settings.defaultUploadFolderId = folder.id;
            this.settings.defaultUploadFolderName = folder.name;
            await this.saveSettings();
            new Notice(`Default upload folder: ${folder.name} — change it anytime in Settings.`);
            resolve(folder.id);
          })();
        },
        onCancel: () => {
          resolve(null);
        },
      }).open();
    });
  }

  // Dedup must never block an upload (DONE-WHEN "Non-blocking + safe"): DriveDedupService already
  // swallows Drive-layer errors, and this wrapper covers everything else — any failure means
  // "no match found" and the upload proceeds exactly as before M5.5.
  private async findUploadDuplicate(md5: string, fileName: string): Promise<DriveDedupHit | null> {
    try {
      return await this.dedup.findDuplicate({
        md5,
        fileName,
      });
    } catch (error) {
      console.warn("[Drive Attachments] Upload dedup check failed; proceeding with upload.", error);
      return null;
    }
  }

  // After an insert that created/reused an asset note, key the note path to the uploaded/matched
  // content's md5 so a later drop of the same bytes hits the free vault layer without rescanning.
  // Inline-link mode creates no asset note, so there is nothing to remember.
  private seedDedupFromInsertedAssetNote(md5: string, driveId: string): void {
    const path = this.insert.getAssetNotePathForDriveId(driveId);
    if (path) {
      this.dedup.rememberVaultAssetNote(md5, path);
    }
  }

  // The active/target note's Drive file id, or null when the note isn't a Drive-link note. Drives
  // both the delete command's availability and the file-menu entry, so they stay in sync.
  private readActiveNoteDriveId(file: unknown): string | null {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return null;
    }
    const driveId: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.drive_id;
    return typeof driveId === "string" && driveId.trim().length > 0 ? driveId.trim() : null;
  }

  private async openDrivePanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DRIVE_PANEL_VIEW_TYPE)[0];
    if (existing) {
      void this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open the Drive panel.");
      return;
    }

    await leaf.setViewState({ type: DRIVE_PANEL_VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  // Re-render the drive-preview blocks in open notes so a settings change (e.g. the image→note
  // affordance toggles) takes effect immediately, without reloading the plugin. Reading view
  // re-renders fully; a note in edit/Live-Preview applies on its next render (scroll/refocus).
  refreshDrivePreviews(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        view.previewMode?.rerender(true);
      }
    });
  }

  // Stronger refresh for after a delete: reading view re-renders, but Live Preview code blocks are
  // CM6-managed and `rerender` doesn't touch them, so rebuild those views to re-run the processors
  // (which now re-fetch against the deleted file → the "unavailable" card). Rebuild resets scroll, so
  // this is reserved for the deliberate delete action, not routine settings changes.
  forceRefreshDrivePreviews(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        return;
      }
      if (view.getMode() === "preview") {
        view.previewMode?.rerender(true);
      } else {
        // rebuildView is not in the public typings but exists; a no-op (reopen needed) if absent.
        (leaf as unknown as { rebuildView?: () => void }).rebuildView?.();
      }
    });
  }

  private openSettingsTab(): void {
    const setting = (this.app as AppWithSettings).setting;
    if (!setting) {
      new Notice("Open Drive Attachments settings to enable Drive browsing.");
      return;
    }
    setting.openTabById(this.manifest.id);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<GoogleDriveAttachmentBridgeSettings>);
    // Retired settings — their toggles were removed from the UI, so pin the behavior for every
    // install (new and existing, whatever the saved value): in-Obsidian search is always on, the
    // redundant server-only command stays hidden, a plain row click selects, folders open on
    // double-click.
    this.settings.enableDriveSearch = true;
    this.settings.showServerOnlySearchCommand = false;
    this.settings.panelRowClick = "select";
    this.settings.panelOpenFolder = "double";
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async reloadCustomIconPack(): Promise<void> {
    await this.customIconPack.reload();
    this.refreshFileIconViews();
  }

  // Custom icons are <img> from user files, so a CSS var (not inline width/height) drives their box.
  // Applied on load + whenever the "Custom icon size" setting changes; one var resizes every context.
  applyCustomIconSize(): void {
    document.body.style.setProperty("--gdab-custom-icon-size", `${this.settings.customIconSize}px`);
  }

  refreshDrivePanelThemes(): void {
    this.app.workspace.getLeavesOfType(DRIVE_PANEL_VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof DrivePanelView) {
        view.refreshTheme();
      }
    });
  }

  refreshDrivePanelAvailability(): void {
    this.app.workspace.getLeavesOfType(DRIVE_PANEL_VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof DrivePanelView) {
        view.refreshAvailability();
      }
    });
  }

  // Pack file I/O, invoked by the Settings buttons (and shareable from anywhere). Each shows a Notice.
  async exportIconPackToJson(): Promise<void> {
    try {
      const result = await this.customIconPack.exportToJson();
      const sizeNote = result.skippedTooLarge > 0 ? ` ${result.skippedTooLarge} oversized icon(s) (>100 KB) were left out.` : "";
      new Notice(
        `Icon pack exported → ${result.path} (in your vault): ${result.iconCount} icon(s), ${result.mapCount} mapping(s).${sizeNote}`,
        10000,
      );
    } catch (error) {
      new Notice(`Export icon pack failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async importCredentialsJson(): Promise<boolean> {
    const file = await chooseLocalFile(".json,application/json");
    if (!file) {
      return false;
    }
    let raw: string;
    try {
      raw = await file.text();
    } catch (error) {
      new Notice(`Couldn't read that file: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    return this.applyCredentialsJson(raw);
  }

  // Store the Client ID + secret parsed from an OAuth-client JSON string — a downloaded file's contents
  // or text pasted into the settings modal. App ID needs no entry (it's derived from the Client ID) so
  // any stale override is cleared. Returns false (with a Notice) when the text isn't a valid client JSON.
  async applyCredentialsJson(raw: string): Promise<boolean> {
    const creds = parseOAuthClientJson(raw);
    if (!creds) {
      new Notice("That isn't a Google OAuth client JSON (no client_id / client_secret found).");
      return false;
    }
    this.settings.clientId = creds.clientId;
    this.settings.clientSecret = creds.clientSecret;
    this.settings.pickerAppId = "";
    await this.saveSettings();
    new Notice("Credentials imported from JSON.");
    return true;
  }

  async importIconPackFromJson(): Promise<void> {
    try {
      const result = await this.customIconPack.importFromJson();
      await this.reloadCustomIconPack();
      const skippedNote = result.skipped > 0 ? ` (skipped ${result.skipped} invalid)` : "";
      new Notice(
        `Imported ${result.iconCount} icon(s) and ${result.mapCount} mapping(s) into ${result.folderPath}${skippedNote}.`,
      );
    } catch (error) {
      new Notice(`Import icon pack failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Re-paint everything that draws file-type icons so a custom icon pack (re)load shows immediately:
  // preview cards (force-refresh, because Live-Preview code blocks are CM6-managed and a light
  // rerender doesn't touch them) + any open Drive panel (repaints from cached folder data, no Drive
  // refetch). The search modal reads the pack live on its next open, so it needs no refresh here.
  refreshFileIconViews(): void {
    this.forceRefreshDrivePreviews();
    this.app.workspace.getLeavesOfType(DRIVE_PANEL_VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof DrivePanelView) {
        view.refreshIcons();
      }
    });
  }
}

function chooseLocalFile(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = createEl("input", {
      cls: "gdab-hidden-file-input",
      attr: accept ? { type: "file", accept } : { type: "file" },
    });
    const finish = (file: File | null): void => {
      resolve(file);
      input.remove();
    };
    input.onchange = () => {
      finish(input.files?.item(0) ?? null);
    };
    input.oncancel = () => {
      finish(null);
    };
    document.body.appendChild(input);
    input.click();
  });
}
