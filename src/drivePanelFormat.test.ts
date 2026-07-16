import { describe, expect, it } from "vitest";
import type { DriveBrowserItem } from "./driveMetadataService";
import { DRIVE_FOLDER_MIME_TYPE } from "./driveTypes";
import {
  folderColorHex,
  formatAccountDomain,
  formatDetailMetadataError,
  formatPanelOwner,
  friendlyMimeType,
  itemHasOwner,
  itemModifiedSince,
  matchesTypeCategory,
  modifiedRangeCutoff,
  ONE_DAY_MS,
  panelModifiedPhrase,
  panelOwnerOption,
  panelOwnerOptions,
  panelPrimaryOwnerLabel,
  panelTypeIcon,
  panelTypeLabel,
  sortDirectionOptions,
  sortDriveItems,
  sortDriveItemsByTrashedTime,
  sortFolderFirst,
} from "./drivePanelFormat";

function item(overrides: Partial<DriveBrowserItem> & { name: string; id?: string }): DriveBrowserItem {
  return {
    id: overrides.id ?? overrides.name,
    mimeType: "application/octet-stream",
    ...overrides,
  };
}

const folder = (name: string, id?: string) =>
  item({ name, id, mimeType: DRIVE_FOLDER_MIME_TYPE });

describe("sortFolderFirst", () => {
  it("groups folders ahead of files, each name-sorted case-insensitively", () => {
    const out = sortFolderFirst([
      item({ name: "banana" }),
      folder("Zeta"),
      item({ name: "Apple" }),
      folder("alpha"),
    ]);
    expect(out.map((i) => i.name)).toEqual(["alpha", "Zeta", "Apple", "banana"]);
  });

  it("does not mutate the input array", () => {
    const input = [item({ name: "b" }), item({ name: "a" })];
    sortFolderFirst(input);
    expect(input.map((i) => i.name)).toEqual(["b", "a"]);
  });
});

describe("sortDriveItems", () => {
  it("name asc uses numeric-aware compare", () => {
    const out = sortDriveItems(
      [item({ name: "file10" }), item({ name: "file2" }), item({ name: "file1" })],
      "name",
      "asc",
      false,
    );
    expect(out.map((i) => i.name)).toEqual(["file1", "file2", "file10"]);
  });

  it("modified desc puts newest first", () => {
    const out = sortDriveItems(
      [
        item({ name: "old", modifiedTime: "2020-01-01T00:00:00Z" }),
        item({ name: "new", modifiedTime: "2024-01-01T00:00:00Z" }),
      ],
      "modified",
      "desc",
      false,
    );
    expect(out.map((i) => i.name)).toEqual(["new", "old"]);
  });

  it("foldersFirst keeps folders on top even when direction is desc", () => {
    const out = sortDriveItems(
      [item({ name: "aaa" }), folder("zzz"), item({ name: "bbb" })],
      "name",
      "desc",
      true,
    );
    expect(out[0].name).toBe("zzz");
    expect(out.slice(1).map((i) => i.name)).toEqual(["bbb", "aaa"]);
  });

  it("size sort treats missing size as 0", () => {
    const out = sortDriveItems(
      [item({ name: "big", size: "1000" }), item({ name: "none" }), item({ name: "small", size: "10" })],
      "size",
      "asc",
      false,
    );
    expect(out.map((i) => i.name)).toEqual(["none", "small", "big"]);
  });
});

describe("sortDirectionOptions", () => {
  it("date keys read new/old", () => {
    expect(sortDirectionOptions("modified").map((o) => o.label)).toEqual(["New to old", "Old to new"]);
  });
  it("size reads smallest/largest", () => {
    expect(sortDirectionOptions("size").map((o) => o.label)).toEqual(["Smallest first", "Largest first"]);
  });
  it("name reads A→Z / Z→A", () => {
    expect(sortDirectionOptions("name").map((o) => o.label)).toEqual(["A → Z", "Z → A"]);
  });
});

describe("matchesTypeCategory", () => {
  it("folder / image / video / audio / pdf by mime shape", () => {
    expect(matchesTypeCategory(DRIVE_FOLDER_MIME_TYPE, "folder")).toBe(true);
    expect(matchesTypeCategory("image/png", "image")).toBe(true);
    expect(matchesTypeCategory("video/mp4", "video")).toBe(true);
    expect(matchesTypeCategory("audio/mpeg", "audio")).toBe(true);
    expect(matchesTypeCategory("application/pdf", "pdf")).toBe(true);
  });

  it("document includes text/* but excludes csv (a spreadsheet)", () => {
    expect(matchesTypeCategory("text/plain", "document")).toBe(true);
    expect(matchesTypeCategory("text/csv", "document")).toBe(false);
    expect(matchesTypeCategory("text/csv", "spreadsheet")).toBe(true);
  });

  it("archive membership by set", () => {
    expect(matchesTypeCategory("application/zip", "archive")).toBe(true);
    expect(matchesTypeCategory("application/pdf", "archive")).toBe(false);
  });
});

describe("panelTypeLabel / panelTypeIcon", () => {
  it("known category resolves; unknown falls back", () => {
    expect(panelTypeLabel("folder")).toBe("Folders");
    expect(panelTypeIcon("folder")).toBe("folder");
    expect(panelTypeLabel("nope" as never)).toBe("Type");
    expect(panelTypeIcon("nope" as never)).toBe("shapes");
  });
});

describe("owner helpers", () => {
  it("panelOwnerOption keys by email when present, else name", () => {
    expect(panelOwnerOption({ displayName: "Ann", emailAddress: "A@x.com" })).toEqual({
      key: "email:a@x.com",
      label: "Ann",
      menuLabel: "Ann (A@x.com)",
    });
    expect(panelOwnerOption({ displayName: "Bo" })?.key).toBe("name:bo");
    expect(panelOwnerOption({})).toBeNull();
  });

  it("panelOwnerOptions dedupes and sorts by menuLabel", () => {
    const opts = panelOwnerOptions([
      item({ name: "1", owners: [{ displayName: "Zed", emailAddress: "z@x.com" }] }),
      item({ name: "2", owners: [{ displayName: "Ann", emailAddress: "a@x.com" }] }),
      item({ name: "3", owners: [{ displayName: "Ann", emailAddress: "a@x.com" }] }),
    ]);
    expect(opts.map((o) => o.label)).toEqual(["Ann", "Zed"]);
  });

  it("itemHasOwner / panelPrimaryOwnerLabel", () => {
    const it0 = item({ name: "x", owners: [{ displayName: "Ann", emailAddress: "a@x.com" }] });
    expect(itemHasOwner(it0, "email:a@x.com")).toBe(true);
    expect(itemHasOwner(it0, "email:none@x.com")).toBe(false);
    expect(panelPrimaryOwnerLabel(it0)).toBe("Ann");
    expect(panelPrimaryOwnerLabel(item({ name: "y" }))).toBeNull();
  });

  it("formatPanelOwner prefers name<email>, falls back to domain for shared drives", () => {
    expect(
      formatPanelOwner({ id: "i", name: "n", mimeType: "x", owners: [{ displayName: "Ann", emailAddress: "a@x.com" }] } as never, "me@x.com"),
    ).toBe("Ann <a@x.com>");
    expect(formatPanelOwner({ id: "i", name: "n", mimeType: "x", driveId: "D" } as never, "me@corp.com")).toBe("@corp.com");
    expect(formatPanelOwner({ id: "i", name: "n", mimeType: "x" } as never, "me@x.com")).toBeNull();
  });
});

describe("formatAccountDomain", () => {
  it("returns @domain, null on missing/trailing-@", () => {
    expect(formatAccountDomain("me@corp.com")).toBe("@corp.com");
    expect(formatAccountDomain("me@")).toBeNull();
    expect(formatAccountDomain("noat")).toBeNull();
    expect(formatAccountDomain(null)).toBeNull();
  });
});

describe("formatDetailMetadataError", () => {
  it("maps HTTP status codes to friendly copy", () => {
    expect(formatDetailMetadataError(new Error("HTTP 401 unauthorized"))).toBe(
      "Reconnect Drive to load owner and thumbnail.",
    );
    expect(formatDetailMetadataError(new Error("HTTP 403 userRateLimitExceeded"))).toBe(
      "Drive quota limited owner and thumbnail loading.",
    );
    expect(formatDetailMetadataError(new Error("HTTP 403 insufficientPermissions"))).toBe(
      "No permission to load owner and thumbnail.",
    );
    expect(formatDetailMetadataError(new Error("HTTP 404 not found"))).toBe("Drive item not found.");
    expect(formatDetailMetadataError("boom")).toBe("Could not load owner and thumbnail.");
  });
});

describe("modified-range helpers", () => {
  const now = Date.parse("2026-07-15T12:00:00Z");

  it("rolling windows subtract whole days", () => {
    expect(modifiedRangeCutoff("last7", now)).toBe(now - 7 * ONE_DAY_MS);
    expect(modifiedRangeCutoff("last30", now)).toBe(now - 30 * ONE_DAY_MS);
  });

  it("itemModifiedSince respects the cutoff", () => {
    const cutoff = now - ONE_DAY_MS;
    expect(itemModifiedSince(item({ name: "a", modifiedTime: "2026-07-15T00:00:00Z" }), cutoff)).toBe(true);
    expect(itemModifiedSince(item({ name: "b", modifiedTime: "2020-01-01T00:00:00Z" }), cutoff)).toBe(false);
    expect(itemModifiedSince(item({ name: "c" }), cutoff)).toBe(false);
  });

  it("panelModifiedPhrase reads naturally", () => {
    expect(panelModifiedPhrase("today")).toBe("today");
    expect(panelModifiedPhrase("last7")).toBe("in the last 7 days");
  });
});

describe("sortDriveItemsByTrashedTime", () => {
  it("newest trashed first, missing timestamps last (name tiebreak)", () => {
    const out = sortDriveItemsByTrashedTime(
      [
        item({ name: "old", trashedTime: "2026-01-01T00:00:00Z" }),
        item({ name: "none" }),
        item({ name: "new", trashedTime: "2026-07-01T00:00:00Z" }),
      ],
      false,
    );
    expect(out.map((i) => i.name)).toEqual(["new", "old", "none"]);
  });

  it("foldersFirst keeps folders grouped on top", () => {
    const out = sortDriveItemsByTrashedTime(
      [
        item({ name: "file", trashedTime: "2026-07-01T00:00:00Z" }),
        folder("dir"),
      ],
      true,
    );
    expect(out.map((i) => i.name)).toEqual(["dir", "file"]);
  });
});

describe("folderColorHex", () => {
  it("accepts a #RRGGBB palette value (trimmed), rejects anything else", () => {
    expect(folderColorHex("#8f8f8f")).toBe("#8f8f8f");
    expect(folderColorHex(" #FAD165 ")).toBe("#FAD165");
    expect(folderColorHex("#fff")).toBeNull();
    expect(folderColorHex("red")).toBeNull();
    expect(folderColorHex(undefined)).toBeNull();
  });
});

describe("friendlyMimeType", () => {
  it("known types map directly", () => {
    expect(friendlyMimeType("application/vnd.google-apps.document")).toBe("Google Doc");
    expect(friendlyMimeType("application/pdf")).toBe("PDF");
  });

  it("unknown types fall back to <SUBTYPE> category, opaque subtypes collapse", () => {
    expect(friendlyMimeType("image/heic")).toBe("HEIC image");
    expect(friendlyMimeType("image/vnd.foo")).toBe("Image");
    expect(friendlyMimeType("application/octet-stream")).toBe("File");
    expect(friendlyMimeType("application/vnd.foo")).toBe("File");
    expect(friendlyMimeType("audio/x-wav")).toBe("X-WAV audio");
  });
});
