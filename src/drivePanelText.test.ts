import { describe, expect, it } from "vitest";
import type { DriveBrowserItem } from "./driveMetadataService";
import {
  copyMenuTitle,
  deleteForeverMenuTitle,
  downloadMenuTitle,
  formatCopyCount,
  formatCopySummary,
  formatCount,
  formatDownloadSummary,
  formatMoveSummary,
  formatPermanentDeleteSummary,
  formatRestoreSummary,
  formatStarredSummary,
  formatTrashSummary,
  isDownloadableDriveFile,
  moveMenuTitle,
  restoreMenuTitle,
  sanitizeDownloadedFileName,
  starMenuTitle,
  trashMenuTitle,
} from "./drivePanelText";

const FOLDER = "application/vnd.google-apps.folder";
function items(n: number): DriveBrowserItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id${i}`, name: `f${i}`, mimeType: "application/pdf" }));
}

describe("formatCount / formatCopyCount", () => {
  it("pluralizes by count", () => {
    expect(formatCount(1, "item")).toBe("1 item");
    expect(formatCount(0, "item")).toBe("0 items");
    expect(formatCount(3, "file")).toBe("3 files");
    expect(formatCopyCount(1)).toBe("1 copy");
    expect(formatCopyCount(2)).toBe("2 copies");
  });
});

describe("menu titles (single vs bulk)", () => {
  it("uses the singular form for one target", () => {
    expect(trashMenuTitle(items(1))).toBe("Move to trash");
    expect(restoreMenuTitle(items(1))).toBe("Restore");
    expect(deleteForeverMenuTitle(items(1))).toBe("Delete forever");
    expect(moveMenuTitle(items(1))).toBe("Move to...");
    expect(copyMenuTitle(items(1))).toBe("Make a copy");
    expect(starMenuTitle(items(1), false)).toBe("Add to Starred");
    expect(starMenuTitle(items(1), true)).toBe("Remove from Starred");
    expect(downloadMenuTitle(items(1), 1)).toBe("Download to vault");
  });

  it("counts targets in the bulk form", () => {
    expect(trashMenuTitle(items(3))).toBe("Move 3 items to trash");
    expect(deleteForeverMenuTitle(items(2))).toBe("Delete 2 items forever");
    expect(moveMenuTitle(items(2))).toBe("Move 2 items...");
    expect(copyMenuTitle(items(2))).toBe("Make 2 copies");
    expect(starMenuTitle(items(2), false)).toBe("Add 2 items to Starred");
    expect(starMenuTitle(items(2), true)).toBe("Remove 2 items from Starred");
    expect(downloadMenuTitle(items(3), 2)).toBe("Download 2 files...");
    expect(downloadMenuTitle(items(3), 0)).toBe("Download unavailable");
  });
});

describe("operation summaries", () => {
  it("reads cleanly with no failures", () => {
    expect(formatTrashSummary(3, [])).toBe("3 items moved to Drive trash.");
    expect(formatRestoreSummary(1, [])).toBe("1 item restored from Drive trash.");
    expect(formatPermanentDeleteSummary(2, [])).toBe("2 items permanently deleted from Drive.");
    expect(formatMoveSummary(2, [], "Work")).toBe("2 items moved to Work.");
    expect(formatStarredSummary(2, [], true)).toBe("2 items added to Starred.");
    expect(formatStarredSummary(1, [], false)).toBe("1 item removed from Starred.");
    expect(formatCopySummary(2, [], "Work")).toBe("2 copies created in Work.");
  });

  it("appends the failure tail, truncating past three names", () => {
    expect(formatTrashSummary(1, ["a.pdf"])).toBe("1 item moved to Drive trash; 1 item failed (a.pdf).");
    expect(formatMoveSummary(2, ["a", "b", "c", "d"], "Work")).toBe(
      "2 items moved to Work; 4 items failed (a, b, c, +1 more).",
    );
  });

  it("formats downloads (single-file fast path + multi-part)", () => {
    expect(formatDownloadSummary(["Attachments/a.pdf"], [], 0)).toBe("Downloaded to Attachments/a.pdf.");
    expect(formatDownloadSummary(["a", "b"], ["c"], 1)).toBe(
      "2 files downloaded to the vault; 1 unsupported item skipped; 1 file failed (c).",
    );
  });
});

describe("isDownloadableDriveFile", () => {
  it("excludes folders and Google-native files", () => {
    expect(isDownloadableDriveFile({ id: "1", name: "a", mimeType: "application/pdf" })).toBe(true);
    expect(isDownloadableDriveFile({ id: "2", name: "d", mimeType: FOLDER })).toBe(false);
    expect(isDownloadableDriveFile({ id: "3", name: "doc", mimeType: "application/vnd.google-apps.document" })).toBe(false);
  });
});

describe("sanitizeDownloadedFileName", () => {
  it("replaces filesystem-illegal and control characters", () => {
    expect(sanitizeDownloadedFileName('a/b:c*?"<>|d')).toBe("a-b-c------d");
    expect(sanitizeDownloadedFileName("tab\there")).toBe("tab-here");
    expect(sanitizeDownloadedFileName("  spaced   name  ")).toBe("spaced name");
  });

  it("falls back for empty / dot-only names", () => {
    expect(sanitizeDownloadedFileName("...")).toBe("Downloaded Drive file");
    expect(sanitizeDownloadedFileName("   ")).toBe("Downloaded Drive file");
  });
});
