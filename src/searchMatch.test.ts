import { describe, expect, it } from "vitest";
import { matchesAllSearchTokens, normalizePathSearchText, tokenizePathSearchQuery } from "./searchMatch";

describe("tokenizePathSearchQuery", () => {
  it("splits on whitespace and strips separators", () => {
    expect(tokenizePathSearchQuery(".jpg mount")).toEqual(["jpg", "mount"]);
  });

  it("drops tokens that are pure separators", () => {
    expect(tokenizePathSearchQuery(". - _")).toEqual([]);
  });
});

describe("matchesAllSearchTokens", () => {
  it("matches tokens order-independently across separators", () => {
    const tokens = tokenizePathSearchQuery(".jpg mount");
    expect(matchesAllSearchTokens(tokens, "mount-fuji-shot.JPG")).toBe(true);
  });

  it("requires every token to match", () => {
    const tokens = tokenizePathSearchQuery(".jpg mount");
    expect(matchesAllSearchTokens(tokens, "mount-fuji-shot.png")).toBe(false);
  });

  it("normalizes NFC/NFD so decomposed Hangul still matches", () => {
    expect(matchesAllSearchTokens(tokenizePathSearchQuery("굿모닝"), "굿모닝".normalize("NFD"))).toBe(true);
  });
});

describe("normalizePathSearchText", () => {
  it("lowercases and removes non-alphanumerics", () => {
    expect(normalizePathSearchText("Mount-Fuji_Shot.JPG")).toBe("mountfujishotjpg");
  });
});
