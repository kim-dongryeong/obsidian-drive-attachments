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

  it("extension wins over mime, mime fills the gaps", () => {
    expect(fileIconName("application/octet-stream", "movie.mkv")).toBe("video");
    expect(fileIconName("audio/mpeg", "no-extension")).toBe("audio");
    expect(fileIconName("application/vnd.google-apps.folder", "docs")).toBe("folder");
  });
});
