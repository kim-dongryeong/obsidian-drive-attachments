import { App, ButtonComponent, Modal } from "obsidian";
import { DriveDedupHit } from "./driveDedupService";
import { DriveMetadataService } from "./driveMetadataService";
import { formatBytes } from "./byteFormat";

export type DriveDedupAction = "use-existing" | "upload-anyway";

export function askDriveDedupAction(
  app: App,
  hit: DriveDedupHit,
  metadata: DriveMetadataService,
): Promise<DriveDedupAction | null> {
  return new Promise((resolve) => {
    new DriveDedupModal(app, hit, metadata, resolve).open();
  });
}

class DriveDedupModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly hit: DriveDedupHit,
    private readonly metadata: DriveMetadataService,
    private readonly resolve: (action: DriveDedupAction | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText("Duplicate file found");
    contentEl.empty();

    contentEl.createEl("p", {
      text: "A file with matching content already exists in Google Drive.",
      cls: "setting-item-description",
    });

    // Label/value grid: both names left-aligned in the same monospace column so a reader
    // can compare them character-by-character; a verdict line states same-vs-different.
    const names = contentEl.createDiv({ cls: "gdab-dedup-names" });
    names.createDiv({ text: "Uploading", cls: "gdab-dedup-name-label" });
    names.createDiv({ text: this.hit.uploadingFileName, cls: "gdab-dedup-name-value" });
    names.createDiv({ text: "Existing in Drive", cls: "gdab-dedup-name-label" });
    names.createDiv({ text: this.hit.item.name, cls: "gdab-dedup-name-value" });
    const sameName = !namesDiffer(this.hit.uploadingFileName, this.hit.item.name);
    names.createDiv({
      text: sameName ? "✓ same name" : "⚠ different name",
      cls: ["gdab-dedup-verdict", "gdab-dedup-name-verdict", sameName ? "is-same" : "is-different"],
    });

    const details = contentEl.createDiv({ cls: "gdab-dedup-details" });
    // A hit only exists because the md5 matched, so this verdict is always the green "same"
    // state — it is the "identical content" proof the user should weigh, with the raw hash
    // kept visible beside it.
    const md5Row = details.createDiv({ cls: ["gdab-dedup-verdict", "gdab-dedup-md5-verdict", "is-same"] });
    md5Row.createSpan({ text: "✓ same md5" });
    md5Row.createSpan({ text: this.hit.matchedMd5, cls: "gdab-dedup-md5-hash" });
    details.createDiv({ text: `Match: ${formatHitSource(this.hit)}`, cls: "setting-item-description" });

    this.renderDrivePath(details);

    if (this.hit.size) {
      details.createDiv({
        text: `Size: ${formatBytes(this.hit.size)}`,
        cls: "setting-item-description",
      });
    }

    if (this.hit.assetNote) {
      details.createDiv({
        text: `Vault note: ${this.hit.assetNote.path}`,
        cls: "setting-item-description",
      });
    }

    const buttonRow = contentEl.createDiv({ cls: "gdab-dedup-buttons" });

    const useExistingButton = new ButtonComponent(buttonRow)
      .setButtonText("Use existing link")
      .setCta()
      .onClick(() => {
        this.choose("use-existing");
      });

    new ButtonComponent(buttonRow)
      .setButtonText("Upload anyway")
      .onClick(() => {
        this.choose("upload-anyway");
      });

    new ButtonComponent(buttonRow)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });

    this.scope.register([], "Enter", (evt) => {
      // Obsidian scopes see keydown before the focused element does, and returning false
      // preventDefaults it — so without this guard, Enter on a tabbed-to "Upload anyway"/"Cancel"
      // button would insert the existing link instead. Only act as the modal-wide default.
      if (evt.target instanceof HTMLButtonElement && evt.target !== useExistingButton.buttonEl) {
        return;
      }
      this.choose("use-existing");
      return false;
    });
    useExistingButton.buttonEl.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveOnce(null);
  }

  private choose(action: DriveDedupAction): void {
    this.resolveOnce(action);
    this.close();
  }

  private resolveOnce(action: DriveDedupAction | null): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.resolve(action);
  }

  private renderDrivePath(details: HTMLElement): void {
    if (this.hit.drivePath) {
      details.createDiv({
        text: `Drive path: ${this.hit.drivePath}`,
        cls: "setting-item-description",
      });
      return;
    }

    if (!this.hit.parents || this.hit.parents.length === 0) {
      return;
    }

    const pathEl = details.createDiv({
      text: "Drive path: resolving...",
      cls: "setting-item-description",
    });
    this.metadata
      .resolveDrivePathByParents(this.hit.parents)
      .catch(() => null)
      .then((path) => {
        pathEl.setText(path ? `Drive path: ${path}` : "Drive path unavailable");
      });
  }
}

function formatHitSource(hit: DriveDedupHit): string {
  switch (hit.source) {
    case "vault-asset-note":
      return "Drive-link note in vault";
    case "drive-index":
      return "Google Drive index";
    case "drive-name":
      return "Google Drive name search";
  }
}

function namesDiffer(left: string, right: string): boolean {
  return left.trim().normalize("NFC") !== right.trim().normalize("NFC");
}
