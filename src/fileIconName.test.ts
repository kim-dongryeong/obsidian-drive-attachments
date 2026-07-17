import { describe, expect, it } from "vitest";
import { fileIconName } from "./fileIconName";

describe("fileIconName", () => {
  it("maps the ogg container family the way drive.google.com does", () => {
    // .ogg is almost always audio in practice — Drive shows the headphone icon (kdr QA:
    // the old "ogg": "video" entry beat the correct audio/ogg mimeType because the
    // extension map is consulted first).
    expect(fileIconName("audio/ogg", "sample.ogg")).toBe("audio");
    expect(fileIconName("audio/ogg", "sample.oga")).toBe("audio");
    expect(fileIconName("audio/opus", "sample.opus")).toBe("audio");
    expect(fileIconName("video/ogg", "sample.ogv")).toBe("video");
  });

  it("a specific mime (Google's judgment) outranks the extension table", () => {
    // Even if our table were wrong about an extension, a concrete audio/video/image mime wins.
    expect(fileIconName("audio/ogg", "weird.mkv")).toBe("audio");
    expect(fileIconName("application/vnd.google-apps.folder", "docs")).toBe("folder");
  });

  it("generic mimes defer to the extension table", () => {
    expect(fileIconName("application/octet-stream", "movie.mkv")).toBe("video");
    expect(fileIconName("text/x-python", "script.py")).toBe("code");
    expect(fileIconName("audio/mpeg", "no-extension")).toBe("audio");
  });
});
