import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { CustomIconPackService } from "./customIconPack";

// Minimal fake DataAdapter: a flat file map. getResourcePath returns "res:<path>" so assertions
// can tell exactly which icon file was chosen.
function fakeAdapter(files: Record<string, string>): DataAdapter {
  return {
    list: async (folder: string) => ({
      files: Object.keys(files).filter((p) => p.startsWith(`${folder}/`)),
      folders: [],
    }),
    read: async (path: string) => {
      if (!(path in files)) throw new Error("missing");
      return files[path];
    },
    getResourcePath: (path: string) => `res:${path}`,
  } as unknown as DataAdapter;
}

async function loadPack(files: Record<string, string>): Promise<CustomIconPackService> {
  const pack = new CustomIconPackService(fakeAdapter(files), () => "icons");
  await pack.reload();
  return pack;
}

describe("CustomIconPackService resolution order", () => {
  it("an extension-named icon file beats everything (zero-config per-ext packs)", async () => {
    const pack = await loadPack({
      "icons/mp3.svg": "<svg/>",
      "icons/audio.svg": "<svg/>",
    });
    expect(pack.customIconImgSrc("audio/mpeg", "song.mp3")).toBe("res:icons/mp3.svg");
    // other audio still falls to the category icon
    expect(pack.customIconImgSrc("audio/ogg", "song.ogg")).toBe("res:icons/audio.svg");
  });

  it("map.json aliases an extension to another icon name", async () => {
    const pack = await loadPack({
      "icons/mp3.svg": "<svg/>",
      "icons/map.json": JSON.stringify({ map: { aac: "mp3" } }),
    });
    expect(pack.customIconImgSrc("audio/aac", "song.aac")).toBe("res:icons/mp3.svg");
  });

  it("Drive's specific mime decides the category when no ext file/map matches", async () => {
    const pack = await loadPack({ "icons/audio.svg": "<svg/>" });
    // .flac reports application/x-flac (not audio/*) — the built-in ext table catches it;
    // .ogg reports audio/ogg — the mime rule catches it. Both land on audio.svg.
    expect(pack.customIconImgSrc("audio/ogg", "a.ogg")).toBe("res:icons/audio.svg");
    expect(pack.customIconImgSrc("application/x-flac", "a.flac")).toBe("res:icons/audio.svg");
  });

  it("accepts png/webp/gif/ico, svg winning name collisions", async () => {
    const pack = await loadPack({
      "icons/video.png": "PNG",
      "icons/audio.png": "PNG",
      "icons/audio.svg": "<svg/>",
    });
    expect(pack.customIconImgSrc("video/mp4", "clip.mp4")).toBe("res:icons/video.png");
    expect(pack.customIconImgSrc("audio/mpeg", "song.mp3")).toBe("res:icons/audio.svg");
  });

  it("folders use the folder icon; unknown types return null", async () => {
    const pack = await loadPack({ "icons/folder.svg": "<svg/>" });
    expect(pack.customIconImgSrc("application/vnd.google-apps.folder", "docs")).toBe("res:icons/folder.svg");
    expect(pack.customIconImgSrc("application/x-mystery", "blob.zzz")).toBeNull();
  });
});
