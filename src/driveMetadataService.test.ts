import { describe, expect, it } from "vitest";
import type { RequestUrlResponse } from "obsidian";
import { parseDriveBrowserPage } from "./driveMetadataService";

// parseDriveBrowserPage only reads `.text`, so a minimal fake response is enough.
function response(text: string): RequestUrlResponse {
  return { text } as RequestUrlResponse;
}

const FILE = { id: "f1", name: "report.pdf", mimeType: "application/pdf" };
const FOLDER = { id: "d1", name: "Projects", mimeType: "application/vnd.google-apps.folder" };

describe("parseDriveBrowserPage", () => {
  it("parses items and preserves nextPageToken", () => {
    const page = parseDriveBrowserPage(
      response(JSON.stringify({ files: [FILE, FOLDER], nextPageToken: "token-2" })),
    );
    expect(page.items.map((item) => item.id)).toEqual(["f1", "d1"]);
    expect(page.nextPageToken).toBe("token-2");
  });

  it("omits nextPageToken on the final page", () => {
    const page = parseDriveBrowserPage(response(JSON.stringify({ files: [FILE] })));
    expect(page.items).toHaveLength(1);
    expect(page.nextPageToken).toBeUndefined();
  });

  it("treats an empty or non-string token as absent", () => {
    expect(parseDriveBrowserPage(response(JSON.stringify({ files: [], nextPageToken: "" }))).nextPageToken)
      .toBeUndefined();
    expect(parseDriveBrowserPage(response(JSON.stringify({ files: [], nextPageToken: 42 }))).nextPageToken)
      .toBeUndefined();
  });

  it("drops malformed entries but keeps valid ones", () => {
    const page = parseDriveBrowserPage(
      response(JSON.stringify({ files: [FILE, { id: "broken" }, null, { ...FOLDER, name: "" }] })),
    );
    expect(page.items.map((item) => item.id)).toEqual(["f1"]);
  });

  it("returns an empty page for an empty body or missing files array", () => {
    expect(parseDriveBrowserPage(response(""))).toEqual({ items: [] });
    expect(parseDriveBrowserPage(response(JSON.stringify({}))).items).toEqual([]);
  });

  it("throws a readable error on malformed JSON", () => {
    expect(() => parseDriveBrowserPage(response("<!doctype html>oops"))).toThrow(/unreadable/);
  });
});
