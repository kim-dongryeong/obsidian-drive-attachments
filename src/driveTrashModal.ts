import { App, ButtonComponent, Modal } from "obsidian";

export type DriveTrashChoice = "trash" | "delete";

export interface DriveTrashTargetInfo {
  name: string;
  path?: string | null;
  sizeHuman?: string | null;
}

// Confirm deleting a Drive file. Resolves "trash" (recoverable move), "delete" (permanent, behind a
// second confirmation step), or null on cancel/dismiss. Display fields come from the note's own
// frontmatter, so opening the dialog costs no API call — the network request happens only on confirm.
export function askDriveTrashAction(app: App, info: DriveTrashTargetInfo): Promise<DriveTrashChoice | null> {
  return new Promise((resolve) => {
    new DriveTrashModal(app, info, resolve).open();
  });
}

class DriveTrashModal extends Modal {
  private resolved = false;
  // Permanent delete is irreversible, so the first click only arms it; a second, separate click
  // (a freshly rendered button the cursor must travel to) commits — no accidental one-click wipe.
  private armingPermanent = false;

  constructor(
    app: App,
    private readonly info: DriveTrashTargetInfo,
    private readonly resolve: (choice: DriveTrashChoice | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Delete Drive file");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveOnce(null);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const details = contentEl.createDiv({ cls: "gdab-trash-details" });
    details.createDiv({ text: this.info.name, cls: "gdab-trash-name" });
    if (this.info.path) {
      details.createDiv({ text: `Drive path: ${this.info.path}`, cls: "setting-item-description" });
    }
    if (this.info.sizeHuman) {
      details.createDiv({ text: `Size: ${this.info.sizeHuman}`, cls: "setting-item-description" });
    }

    if (this.armingPermanent) {
      this.renderPermanentConfirm(contentEl);
      return;
    }

    contentEl.createEl("p", {
      text:
        "Move to Drive trash is recoverable from Google Drive for about 30 days. " +
        "Permanent delete cannot be undone.",
      cls: "setting-item-description",
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const trashButton = new ButtonComponent(buttons)
      .setButtonText("Move to Drive trash")
      .setCta()
      .onClick(() => this.choose("trash"));

    new ButtonComponent(buttons)
      .setButtonText("Delete permanently…")
      .setWarning()
      .onClick(() => {
        this.armingPermanent = true;
        this.render();
      });

    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());

    trashButton.buttonEl.focus();
  }

  private renderPermanentConfirm(contentEl: HTMLElement): void {
    contentEl.createEl("p", {
      text: "Permanently delete this file from Google Drive? It skips the trash and cannot be recovered.",
      cls: ["setting-item-description", "gdab-trash-warning"],
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons)
      .setButtonText("Permanently delete")
      .setWarning()
      .onClick(() => this.choose("delete"));

    const backButton = new ButtonComponent(buttons)
      .setButtonText("Back")
      .onClick(() => {
        this.armingPermanent = false;
        this.render();
      });

    backButton.buttonEl.focus();
  }

  private choose(choice: DriveTrashChoice): void {
    this.resolveOnce(choice);
    this.close();
  }

  private resolveOnce(choice: DriveTrashChoice | null): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.resolve(choice);
  }
}
