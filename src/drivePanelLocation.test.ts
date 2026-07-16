import { describe, expect, it } from "vitest";
import {
  isVirtualRootId,
  MY_DRIVE_ROOT,
  RECENT_ROOT,
  rootBreadcrumbGlyph,
  SHARED_WITH_ME_ROOT,
  STARRED_ROOT,
  TRASH_ROOT,
  virtualRootName,
} from "./drivePanelLocation";

describe("isVirtualRootId", () => {
  it("true only for the four panel-only collection roots", () => {
    expect(isVirtualRootId(SHARED_WITH_ME_ROOT.id)).toBe(true);
    expect(isVirtualRootId(STARRED_ROOT.id)).toBe(true);
    expect(isVirtualRootId(RECENT_ROOT.id)).toBe(true);
    expect(isVirtualRootId(TRASH_ROOT.id)).toBe(true);
    expect(isVirtualRootId(MY_DRIVE_ROOT.id)).toBe(false);
    expect(isVirtualRootId("1AbCdEf")).toBe(false);
    expect(isVirtualRootId(undefined)).toBe(false);
  });
});

describe("virtualRootName", () => {
  it("names each collection, falls back generically", () => {
    expect(virtualRootName(RECENT_ROOT.id)).toBe("Recent");
    expect(virtualRootName(TRASH_ROOT.id)).toBe("Trash");
    expect(virtualRootName("1AbCdEf")).toBe("This collection");
  });
});

describe("rootBreadcrumbGlyph", () => {
  it("maps known roots, defaults to the shared-drive glyph", () => {
    expect(rootBreadcrumbGlyph(MY_DRIVE_ROOT.id)).toBe("🗂️");
    expect(rootBreadcrumbGlyph(STARRED_ROOT.id)).toBe("⭐");
    expect(rootBreadcrumbGlyph("1AbCdEf")).toBe("👥");
  });
});
