import { describe, expect, it } from "vitest";
import type { PanelDropUploadStats } from "./drivePanelDropUtil";
import {
  describePanelDropItems,
  formatPanelUploadProgress,
  formatPanelUploadSummary,
  formatTreeUploadProgress,
  formatTreeUploadSummary,
  isJunkFileName,
  sortDirsByDepth,
} from "./drivePanelDropUtil";

const stats = (overrides: Partial<PanelDropUploadStats>): PanelDropUploadStats => ({
  uploaded: 0,
  skippedDuplicates: 0,
  skippedJunk: 0,
  failed: 0,
  failedNames: [],
  ...overrides,
});

describe("isJunkFileName", () => {
  it("matches macOS/Windows sidecar files, case- and whitespace-insensitively", () => {
    expect(isJunkFileName(".DS_Store")).toBe(true);
    expect(isJunkFileName(" Thumbs.db ")).toBe(true);
    expect(isJunkFileName("photo.jpg")).toBe(false);
  });
});

describe("sortDirsByDepth", () => {
  it("orders by path length ascending, stably", () => {
    expect(
      sortDirsByDepth([
        ["a", "b", "c"],
        ["a"],
        ["a", "b"],
      ]),
    ).toEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
  });
});

describe("formatTreeUploadProgress", () => {
  it("reports count, folders, and failures", () => {
    expect(
      formatTreeUploadProgress(2, 10, "Work", "sub/a.pdf", 1, stats({ uploaded: 1, failed: 0 })),
    ).toBe("Uploading 2/10 to Work: sub/a.pdf (1 uploaded, 1 folder, 0 failed)");
  });
});

describe("formatTreeUploadSummary", () => {
  it("includes junk-skipped when present", () => {
    expect(formatTreeUploadSummary("Work", 2, stats({ uploaded: 5, skippedJunk: 1 }))).toBe(
      "Drive panel folder upload complete: 5 files uploaded to Work; 2 folders created; 1 junk file skipped.",
    );
  });

  it("truncates the failed-name list to 3 + more", () => {
    expect(
      formatTreeUploadSummary("Work", 1, stats({ uploaded: 3, failed: 4, failedNames: ["a", "b", "c", "d"] })),
    ).toBe(
      "Drive panel folder upload complete: 3 files uploaded to Work; 1 folder created; 4 files failed (a, b, c, +1 more).",
    );
  });
});

describe("formatPanelUploadProgress", () => {
  it("with a file name", () => {
    expect(
      formatPanelUploadProgress(2, 10, "Work", stats({ uploaded: 1 }), "a.pdf"),
    ).toBe("Uploading 2/10 to Work: a.pdf (1 uploaded, 0 duplicate, 0 failed)");
  });

  it("without a file name", () => {
    expect(formatPanelUploadProgress(2, 10, "Work", stats({ uploaded: 1 }))).toBe(
      "Uploading 2/10 to Work (1 uploaded, 0 duplicate, 0 failed)",
    );
  });
});

describe("formatPanelUploadSummary", () => {
  it("reports uploaded and duplicates skipped", () => {
    expect(formatPanelUploadSummary("Work", stats({ uploaded: 2, skippedDuplicates: 1 }))).toBe(
      "Drive panel upload complete: 2 files uploaded to Work; 1 duplicate skipped.",
    );
  });
});

describe("describePanelDropItems", () => {
  it("prefers entries (folder/file kind), reading only name+isDirectory", () => {
    const entries = [
      { name: "d", isDirectory: true },
      { name: "f", isDirectory: false },
    ] as unknown as FileSystemEntry[];
    expect(describePanelDropItems(entries, [])).toEqual([
      { name: "d", kind: "Folder" },
      { name: "f", kind: "File" },
    ]);
  });

  it("falls back to plain files when there are no entries", () => {
    const files = [{ name: "x.png" }] as unknown as File[];
    expect(describePanelDropItems([], files)).toEqual([{ name: "x.png", kind: "File" }]);
  });
});
