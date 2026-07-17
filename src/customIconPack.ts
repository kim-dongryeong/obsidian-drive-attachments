import { DataAdapter, normalizePath } from "obsidian";
import { fileIconName } from "./fileIconName";
import { DEFAULT_CUSTOM_ICON_PACK_FOLDER } from "./settings";

interface ParsedIconMap {
  map: Record<string, string>;
}

export interface CustomIconPackExportResult {
  path: string;
  iconCount: number;
  mapCount: number;
  // Icons left out of the JSON because they exceed PACK_ICON_MAX_BYTES.
  skippedTooLarge: number;
}

export interface CustomIconPackImportResult {
  folderPath: string;
  iconCount: number;
  mapCount: number;
  skipped: number;
}

// icons.json format version. Bump when the export shape changes incompatibly; importFromJson must
// keep reading every schema <= CURRENT forever (old exports stay importable), and must REFUSE
// schema > CURRENT (a file from a newer plugin) with a clear "update the plugin" error instead of
// silently mis-importing.
export const ICON_PACK_SCHEMA = 1;

// Per-icon size cap, enforced at load, export, and import. Real icons are tiny — the bundled-style
// packs average 0.6-2 KB/icon and even 512px PNGs from icon sites or multi-resolution .ico files
// stay well under this — so 100 KB is a 20-200x margin that still catches actual mistakes (a photo
// or wallpaper dropped into the pack folder), which would otherwise slow every row paint and
// balloon icons.json via base64.
export const PACK_ICON_MAX_BYTES = 100 * 1024;

// Icon image formats the pack folder accepts, in PRIORITY order — when the same icon name exists
// in several formats, the earlier format wins (svg scales best).
const PACK_ICON_FORMATS = ["svg", "png", "webp", "gif", "ico"] as const;

export class CustomIconPackService {
  private iconFiles = new Map<string, string>();
  // The user's explicit map.json overrides ONLY — kept separate from the built-in extension table
  // so explicit user intent can outrank the mimeType while our built-in guesses stay below it.
  private userExtToIcon: Record<string, string> = {};
  private folderPath = "";

  constructor(
    private readonly adapter: DataAdapter,
    private readonly getFolderPath: () => string,
  ) {}

  // The effective (default-resolved) pack folder currently loaded, or "" before the first reload.
  // Used by the folder watcher to tell whether a changed path belongs to the pack.
  get folder(): string {
    return this.folderPath;
  }

  async reload(): Promise<void> {
    const folderPath = normalizePackFolderPath(this.getFolderPath());
    this.folderPath = folderPath;
    this.iconFiles = new Map();
    this.userExtToIcon = {};

    if (!folderPath) {
      return;
    }

    try {
      const listed = await this.adapter.list(folderPath);
      // name → {path, formatRank}; on a name collision the better (lower-rank) format wins.
      const picked = new Map<string, { path: string; rank: number }>();
      for (const filePath of listed.files) {
        const fileName = basename(filePath).toLowerCase();
        const dot = fileName.lastIndexOf(".");
        if (dot <= 0) {
          continue;
        }
        const rank = PACK_ICON_FORMATS.indexOf(fileName.slice(dot + 1) as (typeof PACK_ICON_FORMATS)[number]);
        if (rank === -1) {
          continue;
        }
        const iconName = fileName.slice(0, dot).trim();
        if (!iconName) {
          continue;
        }
        const stat = await this.adapter.stat(filePath);
        if (stat && stat.size > PACK_ICON_MAX_BYTES) {
          console.warn(
            `[Drive Attachments] Ignoring oversized icon (> ${Math.round(PACK_ICON_MAX_BYTES / 1024)} KB): ${filePath}`,
          );
          continue;
        }
        const existing = picked.get(iconName);
        if (!existing || rank < existing.rank) {
          picked.set(iconName, { path: filePath, rank });
        }
      }

      const mapPath = listed.files.find((filePath) => basename(filePath).toLowerCase() === "map.json");
      const userMap = mapPath ? await this.readMapJson(mapPath) : {};
      this.iconFiles = new Map([...picked.entries()].map(([name, entry]) => [name, entry.path]));
      this.userExtToIcon = userMap;
    } catch {
      this.iconFiles = new Map();
      this.userExtToIcon = {};
    }
  }

  // Resolution order — explicit user intent first, Google's judgment second, our guesses last:
  //   ① an icon file NAMED after the extension ("mp3.svg" → every .mp3) — zero-config per-ext packs
  //   ② the user's map.json entry for the extension (aliases: {"aac": "mp3"})
  //   ③ fileIconName(): Drive's specific mimeType → built-in extension table → generic mime rules,
  //      resolved to a category-named icon file ("audio.svg").
  customIconImgSrc(mimeType: string, name: string): string | null {
    if (!this.folderPath) {
      return null;
    }

    if (mimeType === "application/vnd.google-apps.folder") {
      return this.iconSrcFor("folder");
    }

    const ext = getFileExtension(name);
    if (ext) {
      const direct = this.iconSrcFor(ext);
      if (direct) {
        return direct;
      }
      const mappedName = this.userExtToIcon[ext];
      if (mappedName) {
        const mapped = this.iconSrcFor(mappedName);
        if (mapped) {
          return mapped;
        }
      }
    }

    const category = fileIconName(mimeType, name);
    return category ? this.iconSrcFor(category) : null;
  }

  private iconSrcFor(iconName: string): string | null {
    const iconPath = this.iconFiles.get(iconName.toLowerCase());
    return iconPath ? this.adapter.getResourcePath(iconPath) : null;
  }

  async exportToJson(): Promise<CustomIconPackExportResult> {
    const folderPath = normalizePackFolderPath(this.getFolderPath());
    if (!folderPath) {
      throw new Error("Set a custom icon pack folder before exporting.");
    }

    let listed: Awaited<ReturnType<DataAdapter["list"]>>;
    try {
      listed = await this.adapter.list(folderPath);
    } catch {
      throw new Error(`Custom icon pack folder not found: ${folderPath}.`);
    }

    // One JSON regardless of formats: svg values are the raw markup (compact, diffable), binary
    // formats (png/webp/gif/ico) become data: URIs — the URI's own mime tells import which
    // extension to restore. Same-name collisions keep the best format, like the loader.
    const icons: Record<string, string> = {};
    const iconRank: Record<string, number> = {};
    const iconPaths = listed.files
      .filter((filePath) => {
        const lower = basename(filePath).toLowerCase();
        const dot = lower.lastIndexOf(".");
        return dot > 0 && (PACK_ICON_FORMATS as readonly string[]).includes(lower.slice(dot + 1));
      })
      .sort((a, b) => a.localeCompare(b));

    let skippedTooLarge = 0;
    for (const filePath of iconPaths) {
      const lower = basename(filePath).toLowerCase();
      const dot = lower.lastIndexOf(".");
      const iconName = lower.slice(0, dot).trim();
      const format = lower.slice(dot + 1);
      const rank = (PACK_ICON_FORMATS as readonly string[]).indexOf(format);
      if (!iconName || (iconName in iconRank && iconRank[iconName] <= rank)) {
        continue;
      }
      const stat = await this.adapter.stat(filePath);
      if (stat && stat.size > PACK_ICON_MAX_BYTES) {
        skippedTooLarge++;
        continue;
      }
      iconRank[iconName] = rank;
      if (format === "svg") {
        icons[iconName] = await this.adapter.read(filePath);
      } else {
        const bytes = await this.adapter.readBinary(filePath);
        icons[iconName] = `data:${PACK_FORMAT_MIME[format]};base64,${arrayBufferToBase64(bytes)}`;
      }
    }

    const mapPath = listed.files.find((filePath) => basename(filePath).toLowerCase() === "map.json");
    const map = mapPath ? await this.readMapJson(mapPath) : {};
    const exportPath = joinVaultPath(folderPath, "icons.json");
    await this.adapter.write(
      exportPath,
      JSON.stringify({ schema: ICON_PACK_SCHEMA, name: basename(folderPath), icons, map }, null, 2) + "\n",
    );
    return { path: exportPath, iconCount: Object.keys(icons).length, mapCount: Object.keys(map).length, skippedTooLarge };
  }

  // Inverse of exportToJson: read `<folder>/icons.json` and materialize the same folder layout
  // Milestone A loads (`<name>.svg` files + a `map.json`). Bad icon/map entries are skipped, never
  // fatal. We only ever WRITE the svg strings to disk; rendering still goes through the file-based
  // `<img getResourcePath>` path, so no untrusted svg is injected inline.
  async importFromJson(): Promise<CustomIconPackImportResult> {
    const folderPath = normalizePackFolderPath(this.getFolderPath());
    if (!folderPath) {
      throw new Error("Set a custom icon pack folder before importing.");
    }

    const jsonPath = joinVaultPath(folderPath, "icons.json");
    let rawJson: string;
    try {
      rawJson = await this.adapter.read(jsonPath);
    } catch {
      throw new Error(`No icons.json found in ${folderPath}.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error("icons.json is not valid JSON.");
    }
    if (!isRecord(parsed)) {
      throw new Error("icons.json must be a JSON object.");
    }
    const root = parsed as Record<string, unknown>;

    // Schema gate: legacy exports carry no schema (treated as 1). A HIGHER schema means the file
    // came from a newer plugin whose format this build doesn't understand — refuse loudly rather
    // than import a subset that looks complete.
    const schema = typeof root.schema === "number" ? root.schema : 1;
    if (schema > ICON_PACK_SCHEMA) {
      throw new Error(
        `This icons.json uses format v${schema}, newer than this plugin understands (v${ICON_PACK_SCHEMA}). Update Drive Attachments, then import again.`,
      );
    }

    const icons = isRecord(root.icons) ? (root.icons as Record<string, unknown>) : {};
    let iconCount = 0;
    let skipped = 0;
    for (const [rawName, rawValue] of Object.entries(icons)) {
      const iconName = sanitizeIconName(rawName);
      if (!iconName || typeof rawValue !== "string" || !rawValue.trim()) {
        skipped++;
        continue;
      }
      if (rawValue.length > PACK_ICON_MAX_BYTES * 1.4) {
        // base64 is ~1.33x the bytes; anything past the cap (with margin) is skipped like reload does.
        skipped++;
        continue;
      }
      const dataUri = parseIconDataUri(rawValue);
      if (dataUri) {
        await this.adapter.writeBinary(joinVaultPath(folderPath, `${iconName}.${dataUri.ext}`), dataUri.bytes);
      } else {
        await this.adapter.write(joinVaultPath(folderPath, `${iconName}.svg`), rawValue);
      }
      iconCount++;
    }

    const map = isRecord(root.map) ? normalizeIconMap(root.map as Record<string, unknown>) : {};
    const mapCount = Object.keys(map).length;
    if (mapCount > 0) {
      await this.adapter.write(
        joinVaultPath(folderPath, "map.json"),
        JSON.stringify({ map }, null, 2) + "\n",
      );
    }

    return { folderPath, iconCount, mapCount, skipped };
  }

  private async readMapJson(path: string): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await this.adapter.read(path)) as unknown;
      const map = isRecord(parsed) && isRecord(parsed.map) ? parsed.map : parsed;
      if (!isRecord(map)) {
        return {};
      }
      return normalizeIconMap(map);
    } catch {
      return {};
    }
  }
}

function normalizePackFolderPath(path: string): string {
  // Empty field → use the default folder (Obsidian placeholder-is-default convention). Icons present
  // there override the selected theme per-icon; anything missing falls back to the theme.
  const trimmed = path.trim() || DEFAULT_CUSTOM_ICON_PACK_FOLDER;
  return normalizePath(trimmed.replace(/^\/+/, "").replace(/\/+$/, ""));
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

const PACK_FORMAT_MIME: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
};

const PACK_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// icons.json binary values: "data:image/png;base64,...." → bytes + restore extension. Non-data
// values are treated as raw svg markup (the original export format — stays importable).
function parseIconDataUri(value: string): { ext: string; bytes: ArrayBuffer } | null {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const ext = PACK_MIME_EXT[match[1].toLowerCase()];
  if (!ext) {
    return null;
  }
  try {
    const binary = atob(match[2].replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { ext, bytes: bytes.buffer };
  } catch {
    return null;
  }
}

// Turn an icons.json key into a safe `<name>.svg` filename. Reject path separators / parent refs so
// a malicious pack cannot write outside the configured folder; empty after trimming → skip.
function sanitizeIconName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return "";
  }
  return name;
}

function normalizeIconMap(map: Record<string, unknown> | ParsedIconMap): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawExt, rawIconName] of Object.entries(map)) {
    if (typeof rawIconName !== "string") {
      continue;
    }
    const ext = normalizeExtension(rawExt);
    const iconName = rawIconName.trim().toLowerCase();
    if (ext && iconName) {
      normalized[ext] = iconName;
    }
  }
  return normalized;
}

function joinVaultPath(folderPath: string, childPath: string): string {
  return normalizePath(folderPath ? `${folderPath}/${childPath}` : childPath);
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? normalizeExtension(name.slice(dot + 1)) : "";
}

function normalizeExtension(ext: string): string {
  return ext.trim().replace(/^\.+/, "").toLowerCase();
}


function isRecord(value: unknown): value is ParsedIconMap | Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
