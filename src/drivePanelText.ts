// Pure text helpers for the Drive panel — context-menu titles, bulk-operation result summaries, and
// small formatting utilities. Extracted from drivePanelView.ts (T-011: shrink the 6k-line panel by
// moving pure functions out first, where they can be unit-tested without the Obsidian runtime).

import { DRIVE_FOLDER_MIME_TYPE } from "./driveTypes";
import { DriveBrowserItem } from "./driveMetadataService";

// "1 item" / "3 items" — pluralize by appending "s" unless the count is one.
export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function formatCopyCount(count: number): string {
  return `${count} ${count === 1 ? "copy" : "copies"}`;
}

export function trashMenuTitle(targets: DriveBrowserItem[]): string {
  if (targets.length > 1) {
    return `Move ${formatCount(targets.length, "item")} to trash`;
  }
  return "Move to trash";
}

export function restoreMenuTitle(targets: DriveBrowserItem[]): string {
  return targets.length > 1 ? `Restore ${formatCount(targets.length, "item")}` : "Restore";
}

export function deleteForeverMenuTitle(targets: DriveBrowserItem[]): string {
  return targets.length > 1 ? `Delete ${formatCount(targets.length, "item")} forever` : "Delete forever";
}

export function moveMenuTitle(targets: DriveBrowserItem[]): string {
  return targets.length > 1 ? `Move ${formatCount(targets.length, "item")}...` : "Move to...";
}

export function starMenuTitle(targets: DriveBrowserItem[], remove: boolean): string {
  if (targets.length === 1) {
    return remove ? "Remove from Starred" : "Add to Starred";
  }
  return `${remove ? "Remove" : "Add"} ${formatCount(targets.length, "item")} ${remove ? "from" : "to"} Starred`;
}

export function copyMenuTitle(targets: DriveBrowserItem[]): string {
  return targets.length > 1 ? `Make ${formatCopyCount(targets.length)}` : "Make a copy";
}

export function downloadMenuTitle(targets: DriveBrowserItem[], downloadableCount: number): string {
  if (downloadableCount === 0) {
    return "Download unavailable";
  }
  return targets.length > 1 ? `Download ${formatCount(downloadableCount, "file")}...` : "Download to vault";
}

// Shared "N done; M failed (a, b, c, +k more)." shape used by every bulk-operation result Notice.
function withFailures(lead: string, failedNames: string[]): string {
  const parts = [lead];
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "item")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

export function formatTrashSummary(trashed: number, failedNames: string[]): string {
  return withFailures(`${formatCount(trashed, "item")} moved to Drive trash`, failedNames);
}

export function formatRestoreSummary(restored: number, failedNames: string[]): string {
  return withFailures(`${formatCount(restored, "item")} restored from Drive trash`, failedNames);
}

export function formatPermanentDeleteSummary(deleted: number, failedNames: string[]): string {
  return withFailures(`${formatCount(deleted, "item")} permanently deleted from Drive`, failedNames);
}

export function formatMoveSummary(moved: number, failedNames: string[], targetName: string): string {
  return withFailures(`${formatCount(moved, "item")} moved to ${targetName}`, failedNames);
}

export function formatStarredSummary(updated: number, failedNames: string[], starred: boolean): string {
  return withFailures(`${formatCount(updated, "item")} ${starred ? "added to" : "removed from"} Starred`, failedNames);
}

export function formatCopySummary(copied: number, failedNames: string[], targetName: string): string {
  return withFailures(`${formatCopyCount(copied)} created in ${targetName}`, failedNames);
}

export function formatDownloadSummary(savedPaths: string[], failedNames: string[], skippedUnsupported: number): string {
  if (savedPaths.length === 1 && failedNames.length === 0 && skippedUnsupported === 0) {
    return `Downloaded to ${savedPaths[0]}.`;
  }

  const parts = [`${formatCount(savedPaths.length, "file")} downloaded to the vault`];
  if (skippedUnsupported > 0) {
    parts.push(`${formatCount(skippedUnsupported, "unsupported item")} skipped`);
  }
  if (failedNames.length > 0) {
    const shown = failedNames.slice(0, 3).join(", ");
    const extra = failedNames.length > 3 ? `, +${failedNames.length - 3} more` : "";
    parts.push(`${formatCount(failedNames.length, "file")} failed (${shown}${extra})`);
  }
  return `${parts.join("; ")}.`;
}

export function isDownloadableDriveFile(item: DriveBrowserItem): boolean {
  return item.mimeType !== DRIVE_FOLDER_MIME_TYPE && !item.mimeType.startsWith("application/vnd.google-apps.");
}

export function sanitizeDownloadedFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "")
    .trim();
  return sanitized.length > 0 ? sanitized : "Downloaded Drive file";
}
