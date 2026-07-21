import { App, debounce, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { PanelFolderPickerModal } from "./drivePanelModals";
import { MY_DRIVE_ROOT, type DrivePanelLocation } from "./drivePanelLocation";
import {
  ASSET_NOTE_EXTRA_FRONTMATTER_EXAMPLE,
  DEFAULT_ASSET_NOTE_FOLDER_PATH,
  DEFAULT_ASSET_NOTE_NAME_TEMPLATE,
  DEFAULT_ASSET_NOTE_SUBFOLDER_NAME,
  ICON_THEME_OPTIONS,
  isAssetNoteLocation,
  isEmbedActionToolbarStyle,
  isIconTheme,
  isLinkFormat,
  isPanelDragOutMode,
  isPanelDropUploadMode,
  isPastedImageDestination,
  isPanelTheme,
  PANEL_THEME_OPTIONS,
} from "./settings";
import GoogleDriveAttachmentBridgePlugin from "./main";

// Hard cap on an automatic re-consent so a stalled token exchange can't lock the settings tab forever.
// connect()'s own 120s timeout only covers the browser/loopback step, not the later token/email calls.
const RECONNECT_TIMEOUT_MS = 150_000;

// Paste-the-JSON alternative to the file picker: someone who was messaged the OAuth-client JSON can
// paste its contents directly, no file to save/locate. onSubmit gets the raw text (trimmed non-empty).
class PasteJsonCredentialsModal extends Modal {
  private raw = "";

  constructor(app: App, private readonly onSubmit: (raw: string) => void | Promise<void>) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Paste Google credentials JSON" });
    contentEl.createEl("p", {
      text:
        "Paste the full contents of the OAuth client JSON you downloaded from Google Cloud (or that " +
        "someone shared with you). It's kept only in this vault — nothing is uploaded.",
    });
    const textarea = contentEl.createEl("textarea", { cls: "gdab-paste-json" });
    textarea.rows = 10;
    textarea.placeholder = '{ "installed": { "client_id": "…", "client_secret": "…" } }';
    textarea.addEventListener("input", () => {
      this.raw = textarea.value;
    });
    const buttons = contentEl.createDiv({ cls: "gdab-paste-json-buttons" });
    buttons.createEl("button", { text: "Import & connect", cls: "mod-cta" }).addEventListener("click", () => {
      const value = this.raw.trim();
      if (!value) {
        new Notice("Paste the JSON first.");
        return;
      }
      this.close();
      void this.onSubmit(value);
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    textarea.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class GoogleDriveAttachmentBridgeSettingTab extends PluginSettingTab {
  private readonly uploadFolderPathCache = new Map<string, string>();
  // Everything the basic list doesn't need is hidden behind the "Advanced options" expander.
  private showAdvanced = false;
  // While an automatic re-consent is running, holds a short action label; the whole tab renders a
  // single "working" status instead of the editable settings — including on a closed+reopened tab,
  // since a live connect() is still in flight and a second concurrent one must not be allowed to start.
  private connectBusy: string | null = null;

  constructor(app: App, private readonly plugin: GoogleDriveAttachmentBridgePlugin) {
    super(app, plugin);
  }

  // Run the OAuth consent (initial connect, reconnect, account switch, or a scope change) for the user
  // with a paused "working" UI — no manual Disconnect → Connect dance. connect() reuses the stored
  // Client ID/secret, forces prompt=consent, and overwrites the tokens on success; on failure/timeout
  // it throws with the previous connection left intact. `busyLabel` is what the status row shows.
  private async connectWithStatus(busyLabel: string): Promise<void> {
    // Guard against a second concurrent consent — a rapid double-toggle, or reopening Settings while
    // the first connect() is still in flight.
    if (this.connectBusy) {
      return;
    }
    this.connectBusy = busyLabel;
    let timer: number | undefined;
    try {
      this.display();
      const connectPromise = this.plugin.auth.connect();
      // A late rejection (after our hard timeout already fired) must not surface as unhandled.
      void connectPromise.catch(() => undefined);
      const email = await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("Timed out — please try again.")), RECONNECT_TIMEOUT_MS);
        }),
      ]);
      this.plugin.refreshDrivePanelAvailability();
      new Notice(`✅ Connected as ${email}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Connect cancelled.") {
        new Notice("Connect cancelled — nothing changed.");
      } else {
        new Notice(`❌ ${busyLabel} didn't finish: ${message}. Nothing changed — try again.`, 8000);
      }
    } finally {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      this.connectBusy = null;
      this.display();
    }
  }

  // Open the paste-JSON modal; on a valid paste, store the credentials, sign out of any existing
  // connection (parse/store first — a bad paste must leave the current connection untouched), and
  // connect automatically.
  private openPasteJsonModal(): void {
    new PasteJsonCredentialsModal(this.app, async (raw) => {
      if (await this.plugin.applyCredentialsJson(raw)) {
        if (this.plugin.auth.isConnected) {
          await this.plugin.auth.disconnect();
        }
        await this.connectWithStatus("Connecting to Google Drive");
      }
    }).open();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Paused state during an automatic re-consent: show only a status row (with Cancel) so no other
    // setting can be touched until the browser consent finishes, is cancelled, or times out.
    if (this.connectBusy) {
      new Setting(containerEl).setName("Google Drive connection").setHeading();
      const busy = new Setting(containerEl)
        .setName(`🔄 ${this.connectBusy}…`)
        .setDesc(
          "Approve the Google sign-in that opened in your browser. Opened in the wrong Chrome profile, " +
            "or changed your mind? Click Cancel and try again — no need to wait. (It also times out on " +
            "its own after 2 minutes.)",
        )
        .addButton((button) => {
          button
            .setButtonText("Cancel")
            .onClick(() => {
              this.plugin.auth.cancelConnect();
            });
        });
      busy.settingEl.addClass("gdab-setting-busy");
      return;
    }

    // Grey a whole setting out (visible opacity from the class, not setDisabled alone).
    const greyOut = (setting: Setting, disabled: boolean): void => {
      if (disabled) {
        setting.setDisabled(true);
        setting.settingEl.addClass("gdab-setting-disabled");
      }
    };

    // ===================================================================================
    // BASIC — always visible
    // ===================================================================================

    new Setting(containerEl).setName("Google Drive connection").setHeading();

    const hasCredentials = Boolean(this.plugin.settings.clientId && this.plugin.settings.clientSecret);

    if (this.plugin.auth.isConnected) {
      new Setting(containerEl)
        .setName("Status")
        .setDesc(`Connected as ${this.plugin.settings.accountEmail ?? "unknown"}.`)
        .addButton((button) => {
          button
            .setButtonText("Switch account")
            .onClick(async () => {
              await this.connectWithStatus("Switching Google account");
            });
        });
    } else if (hasCredentials) {
      // Credentials already stored (imported earlier, or kept after Disconnect). Reconnect with one
      // click — no re-selecting the JSON. Covers the wrong-profile/cancelled retry and account switch.
      new Setting(containerEl)
        .setName("Connect")
        .setDesc(
          "Your Google credentials are ready. Click Connect to sign in — the Google consent page opens " +
            "in your browser. Signing in with a different Google account switches the connected account.",
        )
        .addButton((button) => {
          button
            .setButtonText("Connect")
            .setCta()
            .onClick(async () => {
              await this.connectWithStatus("Connecting to Google Drive");
            });
        });
    } else {
      // First run, no credentials yet: import the JSON (file or paste), then connect automatically.
      new Setting(containerEl)
        .setName("Connect Google Drive")
        .setDesc(
          "One-step setup: select the OAuth client JSON you downloaded from Google Cloud (its “Download " +
            "JSON” button), or paste its contents. It's kept on your computer — nothing is uploaded — " +
            "and then the Google sign-in opens automatically.",
        )
        .addButton((button) => {
          button
            .setButtonText("Select .json file")
            .setCta()
            .onClick(async () => {
              if (await this.plugin.importCredentialsJson()) {
                await this.connectWithStatus("Connecting to Google Drive");
              }
            });
        })
        .addButton((button) => {
          button.setButtonText("Paste JSON").onClick(() => this.openPasteJsonModal());
        });
    }

    const fullDriveStatus = !this.plugin.settings.enableFullDriveAccess
      ? ""
      : this.plugin.auth.hasFullDriveScope
        ? " ✓ Full Drive access is currently granted."
        : this.plugin.auth.isConnected
          ? " ⚠ Enabled but not yet granted — toggle it off and on to retry the reconnect."
          : " ⚠ Enabled — it applies next time you connect.";
    new Setting(containerEl)
      .setName("Full Drive access (delete files it didn’t upload)")
      .setDesc(
        "Off by default — the plugin can only delete files it uploaded itself. Turn this on to also " +
          "delete files it didn’t upload; this gives the plugin read/write/delete over your entire " +
          "Drive. Changing this asks you to sign in to Google again." +
          fullDriveStatus,
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableFullDriveAccess)
          .onChange(async (value) => {
            this.plugin.settings.enableFullDriveAccess = value;
            await this.plugin.saveSettings();
            if (this.plugin.auth.isConnected) {
              // The scope change only takes effect after a fresh consent — do it automatically.
              await this.connectWithStatus(value ? "Applying full Drive access" : "Applying standard access");
            } else {
              this.display();
            }
          });
      });

    // Legacy connections made before Connect requested the read scope need a one-time grant.
    if (this.plugin.auth.isConnected && !this.plugin.auth.hasDriveReadonlyScope) {
      new Setting(containerEl)
        .setName("One more step: grant read access for search")
        .setDesc(
          "This legacy connection can upload and insert links, but it lacks the read permission now " +
            "requested during Connect for search and real shared-drive names. Click “Grant access” and " +
            "approve it. Nothing changes if you cancel.",
        )
        .addButton((button) => {
          button
            .setButtonText("Grant access")
            .setCta()
            .onClick(async () => {
              await this.connectWithStatus("Granting read access for search");
            });
        });
    }

    new Setting(containerEl).setName("Google Picker (optional)").setHeading();

    new Setting(containerEl)
      .setName("Picker API key")
      .setDesc(
        "Optional — only for Google's own file-picker popup. You can already browse and insert Drive " +
          "files from the search command and the Drive panel without it, so leave this blank to skip " +
          "the Picker. To enable it, paste a Google Cloud API key with the Picker API turned on.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("API key (optional)")
          .setValue(this.plugin.settings.pickerApiKey)
          .onChange(async (value) => {
            this.plugin.settings.pickerApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Icons & appearance").setHeading();

    new Setting(containerEl)
      .setName("Custom icon pack folder")
      .setDesc(
        `Vault-relative folder with icon files (svg/png/webp/gif/ico) and optional map.json. Name a file after an extension (mp3.svg) to target that extension, or after a category (audio.svg) as the fallback. Left empty it uses ${this.app.vault.configDir}/icon pack — ` +
          "drop icons there and each overrides the selected theme for that file type; types you don't provide fall back to the theme.",
      )
      .addText((text) => {
        // The folder value applies in-memory per keystroke (cheap), but persisting + reloading the
        // pack + force-refreshing previews is debounced: a force-refresh re-runs the (uncached)
        // metadata fetch per preview block, so doing it on every character would spam the Drive API.
        const applyPackChange = debounce(async () => {
          await this.plugin.saveSettings();
          await this.plugin.reloadCustomIconPack();
        }, 600, true);
        text
          .setPlaceholder(`${this.app.vault.configDir}/icon pack`)
          .setValue(this.plugin.settings.customIconPackFolder)
          .onChange((value) => {
            this.plugin.settings.customIconPackFolder = value.trim();
            applyPackChange();
          });
      });

    new Setting(containerEl)
      .setName("Custom icon size")
      .setDesc("Pixel size of custom-pack file-type icons in search, the Drive panel, and preview cards.")
      .addSlider((slider) =>
        slider
          .setLimits(12, 48, 1)
          .setValue(this.plugin.settings.customIconSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.customIconSize = value;
            await this.plugin.saveSettings();
            this.plugin.applyCustomIconSize();
          }),
      );

    new Setting(containerEl)
      .setName("Custom icon pack file")
      .setDesc("Share the pack as one icons.json (written into the folder; binary formats travel as data URIs), or rebuild the folder's icon files from an icons.json.")
      .addButton((button) =>
        button.setButtonText("Export → JSON").onClick(() => this.plugin.exportIconPackToJson()),
      )
      .addButton((button) =>
        button.setButtonText("Import from JSON").onClick(() => this.plugin.importIconPackFromJson()),
      );

    new Setting(containerEl)
      .setName("File icon theme")
      .setDesc(
        "Choose bundled file-type artwork across Drive search, the panel, and preview cards. " +
          "A configured custom icon pack still overrides the selected theme.",
      )
      .addDropdown((dropdown) => {
        for (const option of ICON_THEME_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown
          .setValue(this.plugin.settings.iconTheme)
          .onChange(async (value) => {
            this.plugin.settings.iconTheme = isIconTheme(value) ? value : "default";
            await this.plugin.saveSettings();
            this.plugin.refreshFileIconViews();
          });
      });

    new Setting(containerEl)
      .setName("Theme")
      .setDesc("Choose the visual skin for the Drive panel. You can also switch themes from the palette button in the panel toolbar.")
      .addDropdown((dropdown) => {
        for (const option of PANEL_THEME_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown
          .setValue(this.plugin.settings.panelTheme)
          .onChange(async (value) => {
            this.plugin.settings.panelTheme = isPanelTheme(value) ? value : "default";
            await this.plugin.saveSettings();
            this.plugin.refreshDrivePanelThemes();
          });
      });

    new Setting(containerEl).setName("Drive uploads").setHeading();

    new Setting(containerEl)
      .setName("Pasted images")
      .setDesc(
        "What to do when you paste an image (e.g. a screenshot). “Save to vault” keeps Obsidian's " +
          "default. “Ask each time” shows the Save/Upload prompt. “Upload to Drive” uploads every " +
          "pasted image straight to Drive with no prompt.",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("vault", "Save to vault")
          .addOption("ask", "Ask each time (default)")
          .addOption("drive", "Upload to Drive")
          .setValue(this.plugin.settings.pastedImageDestination)
          .onChange(async (value) => {
            this.plugin.settings.pastedImageDestination = isPastedImageDestination(value) ? value : "ask";
            await this.plugin.saveSettings();
          });
      });

    const uploadFolderSetting = new Setting(containerEl)
      .setName("Default upload folder")
      .setDesc(
        (this.plugin.settings.defaultUploadFolderId
          ? `Uploads go to: ${this.plugin.settings.defaultUploadFolderName || this.plugin.settings.defaultUploadFolderId}.`
          : "Uploads go to your Google Drive root.") +
          " Pick a folder with the folder button, or paste a folder's link (or ID) from drive.google.com — " +
          "the ID is extracted automatically. Leave empty for Drive root.",
      )
      .addButton((button) => {
        button
          .setIcon("folder-open")
          .setTooltip("Browse Drive folders")
          .onClick(async () => {
            if (!this.plugin.auth.isConnected) {
              new Notice("Connect Google Drive first to browse folders.");
              return;
            }

            // Offer shared drives alongside My Drive (best-effort — a fetch failure just means the
            // picker starts from My Drive only, same as the panel before its roots load).
            const roots: DrivePanelLocation[] = [{ ...MY_DRIVE_ROOT }];
            try {
              const sharedDrives = await this.plugin.metadata.listSharedDriveRoots();
              roots.push(...sharedDrives.map((root) => ({ id: root.id, name: root.name })));
            } catch {
              // ignore — My Drive root alone still works
            }
            new PanelFolderPickerModal(this.app, {
              title: "Default upload folder",
              detail: "Uploads from your notes will land in this folder.",
              actionLabel: "Use this folder",
              metadata: this.plugin.metadata,
              roots,
              initialPath: [{ ...MY_DRIVE_ROOT }],
              onChoose: (folder) => {
                void (async () => {
                  this.uploadFolderPathCache.delete(this.plugin.settings.defaultUploadFolderId);
                  this.plugin.settings.defaultUploadFolderId = folder.id;
                  this.plugin.settings.defaultUploadFolderName = folder.name;
                  await this.plugin.saveSettings();
                  new Notice(`Default upload folder: ${folder.name}`);
                  this.redisplayPreservingScroll();
                })();
              },
            }).open();
          });
      })
      .addText((text) => {
        text
          .setPlaceholder("Folder link or ID — empty = Drive root")
          .setValue(this.plugin.settings.defaultUploadFolderId)
          .onChange(async (value) => {
            const folderId = normalizeDriveFolderId(value);
            // If the user pasted a folder URL, reflect the extracted ID back into the field so they
            // can see what was actually stored (setValue does not re-fire onChange, so no recursion).
            if (folderId !== value.trim()) {
              text.setValue(folderId);
            }
            this.uploadFolderPathCache.delete(this.plugin.settings.defaultUploadFolderId);
            this.plugin.settings.defaultUploadFolderId = folderId;
            this.plugin.settings.defaultUploadFolderName = "";
            await this.plugin.saveSettings();
          });
      });
    this.appendUploadFolderPath(uploadFolderSetting.descEl);

    // ===================================================================================
    // ADVANCED — behind the expander
    // ===================================================================================

    // Visual break so "Advanced options" reads as its own group, not a trailing part of the section above.
    containerEl.createEl("hr", { cls: "gdab-settings-sep" });

    new Setting(containerEl)
      .setName("Advanced options")
      .setDesc(
        this.showAdvanced
          ? ""
          : "Insert format, Drive-link note options, search tuning, extra panel toggles, embed hover actions, and vault slimming.",
      )
      .addButton((button) => {
        button
          .setButtonText(this.showAdvanced ? "Hide" : "Show")
          .onClick(() => {
            this.showAdvanced = !this.showAdvanced;
            this.redisplayPreservingScroll();
          });
      });

    if (!this.showAdvanced) {
      return;
    }

    new Setting(containerEl).setName("Credentials").setHeading();

    new Setting(containerEl)
      .setName("Use different credentials")
      .setDesc(
        "Switch to a different Google Cloud project — import that project's OAuth client JSON. " +
          "Replacing credentials signs you out first, then reconnects with the new ones automatically.",
      )
      .addButton((button) => {
        button
          .setButtonText("Re-import .json file")
          .onClick(async () => {
            if (await this.plugin.importCredentialsJson()) {
              if (this.plugin.auth.isConnected) {
                await this.plugin.auth.disconnect();
              }
              await this.connectWithStatus("Connecting to Google Drive");
            }
          });
      })
      .addButton((button) => {
        button.setButtonText("Paste JSON").onClick(() => this.openPasteJsonModal());
      });

    new Setting(containerEl).setName("Link insertion").setHeading();

    new Setting(containerEl)
      .setName("Inserted format")
      .setDesc(
        "What the insert flows (Picker/search/upload commands and file drops onto a note) put into the " +
          "note. “Embed preview” (the default) inserts an inline preview block and creates no extra note. " +
          "“Inline Markdown link” inserts just a [text](url) link. “Drive-link note wikilink” creates a " +
          "dedicated note for the file — holding its metadata, preview, and action buttons — and inserts " +
          "a [[wikilink]] to it. The Drive-link note settings below apply whenever such a note is created, " +
          "regardless of this choice.",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("embed", "Embed preview (default)")
          .addOption("inline", "Inline Markdown link")
          .addOption("asset-note", "Drive-link note wikilink")
          .setValue(this.plugin.settings.linkFormat)
          .onChange(async (value) => {
            this.plugin.settings.linkFormat = isLinkFormat(value) ? value : "embed";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Drive-link notes").setHeading();

    new Setting(containerEl)
      .setName("Default location for new Drive-link note")
      .setDesc("Where newly created Drive-link notes are placed.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("vault-root", "Vault folder")
          .addOption("current-folder", "Same folder as current file")
          .addOption("subfolder", "In subfolder under current folder")
          .addOption("specified-folder", "In the folder specified below")
          .setValue(this.plugin.settings.assetNoteLocation)
          .onChange(async (value) => {
            this.plugin.settings.assetNoteLocation = isAssetNoteLocation(value) ? value : "vault-root";
            await this.plugin.saveSettings();
            // Reveal/hide the matching sub-setting below.
            this.redisplayPreservingScroll();
          });
      });

    if (this.plugin.settings.assetNoteLocation === "subfolder") {
      new Setting(containerEl)
        .setName("Subfolder name")
        .setDesc(
          "New Drive-link notes go in this subfolder under the current file's folder, created if missing. " +
            `Empty means "${DEFAULT_ASSET_NOTE_SUBFOLDER_NAME}".`,
        )
        .addText((text) => {
          text
            .setPlaceholder(DEFAULT_ASSET_NOTE_SUBFOLDER_NAME)
            .setValue(this.plugin.settings.assetNoteSubfolderName)
            .onChange(async (value) => {
              this.plugin.settings.assetNoteSubfolderName = value.trim();
              await this.plugin.saveSettings();
            });
        });
    }

    if (this.plugin.settings.assetNoteLocation === "specified-folder") {
      new Setting(containerEl)
        .setName("Drive-link note folder path")
        .setDesc(
          "Vault folder path where new Drive-link notes are placed, created if missing. " +
            `Empty means "${DEFAULT_ASSET_NOTE_FOLDER_PATH}".`,
        )
        .addText((text) => {
          text
            .setPlaceholder(DEFAULT_ASSET_NOTE_FOLDER_PATH)
            .setValue(this.plugin.settings.assetNoteFolderPath)
            .onChange(async (value) => {
              this.plugin.settings.assetNoteFolderPath = value.trim();
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName("Drive-link note name")
      .setDesc(
        "Filename template for Drive-link notes — {{name}} becomes the Drive file's name. Applied " +
          `when a note is created and when a Drive rename updates it. A template without {{name}} falls back to "${DEFAULT_ASSET_NOTE_NAME_TEMPLATE}".`,
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_ASSET_NOTE_NAME_TEMPLATE)
          .setValue(this.plugin.settings.assetNoteNameTemplate)
          .onChange(async (value) => {
            this.plugin.settings.assetNoteNameTemplate = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Extra frontmatter for new Drive-link notes")
      .setDesc(createExtraFrontmatterDescription(""))
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.assetNoteExtraFrontmatter)
          .onChange(async (value) => {
            this.plugin.settings.assetNoteExtraFrontmatter = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.addClass("gdab-extra-frontmatter-textarea");
      });

    new Setting(containerEl).setName("Search").setHeading();

    new Setting(containerEl)
      .setName("Enable path search")
      .setDesc("Match instant-index search queries against resolved Drive folder paths as well as file names.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enablePathSearch)
          .onChange(async (value) => {
            this.plugin.settings.enablePathSearch = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show type icons")
      .setDesc("Prefix Drive search result type labels with a small best-effort icon for the file type.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableTypeIcons)
          .onChange(async (value) => {
            this.plugin.settings.enableTypeIcons = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Index page limit")
      .setDesc(
        "How many pages (×1000 items, newest first) to index. If a known file isn't found — especially " +
          "an older one — its page cap was reached; raise this to index more (slower to build). " +
          "0 = unlimited (index the whole Drive; slowest on huge Drives, but always finishes). A small " +
          "Drive finishes early regardless. After changing, run “Refresh Drive index”.",
      )
      .addText((text) => {
        // 0 = unlimited; a real number clamps to [10, 2000]; anything else → the 150 default. Store the
        // canonical value so the field matches what's actually used (the index also clamps, but the
        // setting shouldn't display 20000 while really meaning 2000). Normalize the field on blur so
        // typing isn't interrupted mid-keystroke.
        const normalize = (raw: string): number => {
          const parsed = Number.parseInt(raw, 10);
          if (parsed === 0) {
            return 0;
          }
          return Number.isFinite(parsed) ? Math.max(10, Math.min(2000, parsed)) : 150;
        };
        text
          .setPlaceholder("150 (0 = unlimited)")
          .setValue(String(this.plugin.settings.indexPageLimit))
          .onChange(async (value) => {
            this.plugin.settings.indexPageLimit = normalize(value);
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener("blur", () => {
          text.setValue(String(this.plugin.settings.indexPageLimit));
        });
      });

    new Setting(containerEl).setName("Panel extras").setHeading();

    new Setting(containerEl)
      .setName("Local file drops")
      .setDesc(
        "What to do when you drop local files or folders onto the Drive sidebar panel. Confirm shows the target folder first; Direct uploads immediately; Off disables panel drops.",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("confirm", "Confirm before uploading")
          .addOption("direct", "Upload immediately (default)")
          .addOption("off", "Off")
          .setValue(this.plugin.settings.panelDropUpload)
          .onChange(async (value) => {
            this.plugin.settings.panelDropUpload = isPanelDropUploadMode(value) ? value : "confirm";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Drag-out format")
      .setDesc(
        "What dragging a Drive panel row (or selection) out onto a note inserts at the drop point. " +
          "“Embed preview” (the default) inserts a preview embed block — folders render as a folder " +
          "card; “Inline link” inserts a Markdown link; “Drive-link note” creates the asset note and " +
          "inserts a wikilink to it. Hold a modifier AT THE DROP to override per-drag — ⌘/Ctrl → Drive-link note · " +
          "⌥/Alt → embed preview · ⇧ Shift → inline link. (In-panel drag onto a folder still moves/copies.)",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("embed", "Embed preview (default)")
          .addOption("link", "Inline link")
          .addOption("note", "Drive-link note")
          .addOption("off", "Off")
          .setValue(this.plugin.settings.panelDragOut)
          .onChange(async (value) => {
            this.plugin.settings.panelDragOut = isPanelDragOutMode(value) ? value : "embed";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Details bar")
      .setDesc(
        "Show a read-only details bar at the bottom of the Drive panel describing the selected " +
          "item — its type, size, modified date, and location (an aggregate when several are selected).",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.panelDetailBar)
          .onChange(async (value) => {
            this.plugin.settings.panelDetailBar = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Type icon colors")
      .setDesc(
        "Color-code Drive panel row icons by file type (folders, images, videos, audio, PDFs, Docs, " +
          "Sheets…), matching the search results and drive.google.com. Turn off for a uniform muted " +
          "icon color. A folder’s own Drive color, custom icons, and thumbnails always take precedence. " +
          "Takes effect the next time the panel re-renders.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.panelTypeIconAccents)
          .onChange(async (value) => {
            this.plugin.settings.panelTypeIconAccents = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Drive-link note blocks").setHeading();

    new Setting(containerEl)
      .setName("Record how each Drive-link note was created")
      .setDesc(
        "Stamp a write-once “drive_origin” property on each new Drive-link note: “uploaded” when the " +
          "file was uploaded from Obsidian (drop · paste · upload command · migrate), “linked” when " +
          "it was brought in from an existing Drive file (picker · search). A metadata refresh never changes it.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.recordDriveOrigin)
          .onChange(async (value) => {
            this.plugin.settings.recordDriveOrigin = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Add a preview block to new Drive-link notes")
      .setDesc(
        "When a new Drive-link note is created (or re-linked) for an image, add a “## Preview” " +
          "section with a preview block that embeds the image inline. Images only — other " +
          "file types are unaffected, and existing notes change only when re-linked.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.addPreviewBlockToNewNotes)
          .onChange(async (value) => {
            this.plugin.settings.addPreviewBlockToNewNotes = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Add an actions block to new Drive-link notes")
      .setDesc(
        "Add an “## Actions” block with buttons (Open in Drive · Open folder · Delete file) to new " +
          "Drive-link notes, and onto existing ones when re-linked. All file types.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.addActionsBlockToNewNotes)
          .onChange(async (value) => {
            this.plugin.settings.addActionsBlockToNewNotes = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show embed backlinks in the actions block")
      .setDesc(
        "In a Drive-link note's actions block, list every other note that embeds the same Drive file — " +
          "the “backlinks” Obsidian can't build for embeds. Costs a vault scan on render; turn off on " +
          "very large vaults.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showEmbedBacklinks)
          .onChange(async (value) => {
            this.plugin.settings.showEmbedBacklinks = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDrivePreviews();
          });
      });

    new Setting(containerEl)
      .setName("Embedded image/video → Drive-link note")
      .setDesc(
        "Ways an embedded Drive image or video lets you reach its Drive-link note (where the metadata " +
          "lives), keeping the media itself clean. Each is independent — combine them or turn all off. " +
          "The note is created on first use if it doesn't exist yet. Changes apply to open notes immediately.",
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Hover action icons (corner)")
      .setDesc(
        "On hover, show an action toolbar over any embed (image, video, PDF): open the Drive-link " +
          "note, convert to a [[wikilink]], open in Drive, open the Drive folder, and delete from Drive.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.imageEmbedNoteHoverIcon)
          .onChange(async (value) => {
            this.plugin.settings.imageEmbedNoteHoverIcon = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDrivePreviews();
            // Re-render so the dependent "Toolbar layout" enables/disables — preserving scroll position.
            this.redisplayPreservingScroll();
          });
      });

    const toolbarLayoutSetting = new Setting(containerEl)
      .setName("Toolbar layout")
      .setDesc(
        "How the hover toolbar lays out the five actions. “All icons”: every action as its own icon. " +
          "“Delete + more menu”: a delete icon plus a “⋮” menu holding the other four. (A/B as you like.)",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("icons", "All icons")
          .addOption("menu", "Delete + more menu (⋮)")
          .setValue(this.plugin.settings.embedActionToolbarStyle)
          .setDisabled(!this.plugin.settings.imageEmbedNoteHoverIcon)
          .onChange(async (value) => {
            this.plugin.settings.embedActionToolbarStyle = isEmbedActionToolbarStyle(value) ? value : "icons";
            await this.plugin.saveSettings();
            this.plugin.refreshDrivePreviews();
          });
      });
    // Only meaningful when the hover toolbar is on — grey it out otherwise.
    greyOut(toolbarLayoutSetting, !this.plugin.settings.imageEmbedNoteHoverIcon);

    new Setting(containerEl)
      .setName("⌘/Ctrl + click the image")
      .setDesc("Hold ⌘ (Mac) / Ctrl (Windows) and click the image to open its Drive-link note.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.imageEmbedNoteModifierClick)
          .onChange(async (value) => {
            this.plugin.settings.imageEmbedNoteModifierClick = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDrivePreviews();
          });
      });

    new Setting(containerEl)
      .setName("Hover caption (file name)")
      .setDesc("Show the file name as a small link below the image on hover; click it to open the Drive-link note.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.imageEmbedNoteHoverCaption)
          .onChange(async (value) => {
            this.plugin.settings.imageEmbedNoteHoverCaption = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDrivePreviews();
          });
      });

    new Setting(containerEl).setName("Vault slimming (migrate to Drive)").setHeading();

    new Setting(containerEl)
      .setName("Delete local file after migrating")
      .setDesc(
        "Off (recommended): migrating a note's attachments uploads them to Drive and relinks the " +
          "note, but keeps the local files. On: after a file is fully migrated (uploaded, Drive-link " +
          "note created, all references rewritten), move the local copy to the system/Obsidian trash " +
          "— recoverable, never a hard delete. A file is never deleted on any failure, and you always " +
          "confirm a per-file preview first.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.deleteLocalAfterMigrate)
          .onChange(async (value) => {
            this.plugin.settings.deleteLocalAfterMigrate = value;
            await this.plugin.saveSettings();
          });
      });
  }

  // Best-effort: show the chosen upload folder's resolved Drive path (e.g. `My Drive/Work/link`)
  // under its description, so same-named folders are distinguishable. Resolved async so the tab
  // renders instantly; the line is only created once a full path resolves — an unreadable folder
  // or ancestor chain (drive.file 403, offline, deleted folder) simply shows nothing.
  private appendUploadFolderPath(descEl: HTMLElement): void {
    const folderId = this.plugin.settings.defaultUploadFolderId;
    if (!folderId || !this.plugin.auth.isConnected) {
      return;
    }

    const cachedPath = this.uploadFolderPathCache.get(folderId);
    if (cachedPath) {
      descEl.createDiv({ cls: "gdab-upload-folder-path", text: cachedPath });
      return;
    }

    void (async () => {
      try {
        const metadata = await this.plugin.metadata.getFileMetadata(folderId);
        const ancestorPath = await this.plugin.metadata.resolveDrivePath(metadata);
        // Without readable ancestors the "path" is just the folder name, which the description
        // already shows — omit rather than duplicate.
        if (!ancestorPath) {
          return;
        }
        // The tab may have re-rendered or the folder changed while resolving — drop stale results.
        if (!descEl.isConnected || this.plugin.settings.defaultUploadFolderId !== folderId) {
          return;
        }
        const folderPath = `${ancestorPath}/${metadata.name}`;
        this.uploadFolderPathCache.set(folderId, folderPath);
        descEl.createDiv({ cls: "gdab-upload-folder-path", text: folderPath });
      } catch {
        // Best-effort only — leave the description as-is when the lookup fails.
      }
    })();
  }

  private redisplayPreservingScroll(): void {
    const scrollEl = findScrollContainer(this.containerEl);
    const scrollTop = scrollEl.scrollTop;
    this.display();
    window.requestAnimationFrame(() => {
      scrollEl.scrollTop = scrollTop;
    });
  }
}

function createExtraFrontmatterDescription(assetNoteOnlyHint: string): DocumentFragment {
  const fragment = createFragment();
  fragment.appendText(
    "YAML mapping added only when a new Drive-link note is created. Blank adds nothing. Lists are supported; " +
      `Drive-managed keys are ignored. Quote YAML values when needed.${assetNoteOnlyHint} Example:`,
  );
  fragment.createEl("pre", { text: ASSET_NOTE_EXTRA_FRONTMATTER_EXAMPLE });
  return fragment;
}

// Users naturally paste a Drive folder URL copied from the browser address bar into the manual
// folder-ID field rather than the bare ID. Stored verbatim, that URL becomes an invalid `parents[]`
// value and every upload fails with a confusing non-permission error — so not even the folder-write
// root fallback (which only fires on `insufficientFilePermissions` 403s) kicks in. Extract the ID
// from the common Drive folder-URL shapes; pass a bare ID — or anything we don't recognize — through
// unchanged so the field still accepts a raw folder ID.
function normalizeDriveFolderId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  // https://drive.google.com/drive/folders/<ID>  (also /drive/u/0/folders/<ID>, optional ?usp=…)
  const folderMatch = value.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (folderMatch) {
    return folderMatch[1];
  }
  // https://drive.google.com/open?id=<ID>  (or any …?id=/&id= form)
  const idParamMatch = value.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (idParamMatch) {
    return idParamMatch[1];
  }
  return value;
}

function findScrollContainer(start: HTMLElement): HTMLElement {
  let current: HTMLElement | null = start;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return start.closest<HTMLElement>(".vertical-tab-content") ?? start;
}
