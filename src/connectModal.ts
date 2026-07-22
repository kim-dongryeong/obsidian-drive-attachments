import { App, Modal, Notice } from "obsidian";
import type GoogleDriveAttachmentBridgePlugin from "./main";

// Paste-the-JSON alternative to the file picker: someone who was messaged the OAuth-client JSON can
// paste its contents directly, no file to save/locate. onSubmit gets the raw text (trimmed non-empty).
export class PasteJsonCredentialsModal extends Modal {
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

// Same connect prompt as the settings tab's first-run option, shown wherever a Drive-requiring command
// is invoked while not connected — instead of failing with a raw error, opening a Finder dialog, or
// opening an unrelated flow.
export class ConnectModal extends Modal {
  constructor(app: App, private readonly plugin: GoogleDriveAttachmentBridgePlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Connect Google Drive" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "One-step setup: select the OAuth client JSON you downloaded from Google Cloud (its “Download " +
        "JSON” button), or paste its contents. It's kept on your computer — nothing is uploaded — " +
        "and then the Google sign-in opens automatically.",
    });

    const buttons = contentEl.createDiv({ cls: "gdab-connect-modal-buttons" });
    const hasCredentials = Boolean(this.plugin.settings.clientId && this.plugin.settings.clientSecret);

    if (hasCredentials) {
      buttons.createEl("button", { text: "Connect", cls: "mod-cta" }).addEventListener("click", () => {
        this.close();
        void this.plugin.connectAndNotify();
      });
    } else {
      buttons.createEl("button", { text: "Select .json file", cls: "mod-cta" }).addEventListener("click", () => {
        void (async () => {
          if (await this.plugin.importCredentialsJson()) {
            this.close();
            await this.plugin.connectAndNotify();
          }
        })();
      });
      buttons.createEl("button", { text: "Paste JSON" }).addEventListener("click", () => {
        new PasteJsonCredentialsModal(this.app, async (raw) => {
          if (await this.plugin.applyCredentialsJson(raw)) {
            this.close();
            await this.plugin.connectAndNotify();
          }
        }).open();
      });
    }

    const hint = contentEl.createEl("p", { cls: "setting-item-description" });
    hint.appendText("New to this? ");
    hint.createEl("a", {
      text: "See the setup guide",
      href: "https://github.com/kim-dongryeong/obsidian-drive-attachments#setup",
      attr: { target: "_blank", rel: "noopener" },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
