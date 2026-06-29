import { requestUrl } from "obsidian";
import { DriveAuthService } from "./driveAuthService";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// Drive refused the mutation because the granted scope doesn't cover this file. `drive.file` only
// authorizes files THIS app created/opened, so a picked/searched file (created in Drive directly)
// returns 403. The command surfaces this distinctly — with "grant broader access" guidance — rather
// than as a raw HTTP error, because it's an expected, recoverable situation, not a bug.
export class DriveScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveScopeError";
  }
}

// Deletion of a Drive file by id. Two paths, both authenticated with the same bearer token the rest
// of the plugin uses: a recoverable trash move (default) and an irreversible permanent delete (gated
// behind an explicit second confirmation in the UI). What each can touch is decided by the granted
// OAuth scope — drive.file (uploads only) vs full drive (anything you own); the API enforces it.
export class DriveTrashService {
  constructor(private readonly auth: DriveAuthService) {}

  // Move a file to the Drive trash via `PATCH files/{id} {trashed:true}`. Recoverable from Drive's
  // trash for ~30 days, then auto-purged. This is the default destructive action.
  async trashFile(fileId: string): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
      throw: false,
    });

    this.assertOk(response.status, "trash");
  }

  // Permanently delete a file via `DELETE files/{id}` — skips the trash, NOT recoverable. Only ever
  // reached after a second explicit confirmation.
  async deleteFilePermanently(fileId: string): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    this.assertOk(response.status, "delete");
  }

  private assertOk(status: number, op: "trash" | "delete"): void {
    if (status >= 200 && status < 300) {
      return;
    }
    if (status === 403) {
      throw new DriveScopeError(
        "With the default access, this plugin can only delete files it uploaded itself. To delete a " +
          "file you picked or searched from your existing Drive, enable “Full Drive access” in this " +
          "plugin's settings and reconnect (and allow the scope on your Google Cloud consent screen).",
      );
    }
    if (status === 404) {
      throw new Error("That file no longer exists in Drive — it may already be deleted.");
    }
    if (status === 401) {
      throw new Error("Google Drive authentication expired. Reconnect in settings and try again.");
    }
    throw new Error(`Google Drive ${op} failed with HTTP ${status}.`);
  }
}
