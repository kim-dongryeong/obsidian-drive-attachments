import { DataAdapter, normalizePath } from "obsidian";
import { fileIconName } from "./fileIconName";
import { ONEDRIVE_EXT_TO_ICON } from "./oneDriveIcons";

interface ParsedIconMap {
  map: Record<string, string>;
}

export interface CustomIconPackExportResult {
  path: string;
  iconCount: number;
  mapCount: number;
}

export interface CustomIconPackImportResult {
  folderPath: string;
  iconCount: number;
  mapCount: number;
  skipped: number;
}

export class CustomIconPackService {
  private iconFiles = new Map<string, string>();
  private extToIcon: Record<string, string> = { ...ONEDRIVE_EXT_TO_ICON };
  private folderPath = "";

  constructor(
    private readonly adapter: DataAdapter,
    private readonly getFolderPath: () => string,
  ) {}

  async reload(): Promise<void> {
    const folderPath = normalizePackFolderPath(this.getFolderPath());
    this.folderPath = folderPath;
    this.iconFiles = new Map();
    this.extToIcon = { ...ONEDRIVE_EXT_TO_ICON };

    if (!folderPath) {
      return;
    }

    try {
      const listed = await this.adapter.list(folderPath);
      const iconFiles = new Map<string, string>();
      for (const filePath of listed.files) {
        const fileName = basename(filePath);
        if (!fileName.toLowerCase().endsWith(".svg")) {
          continue;
        }
        const iconName = fileName.slice(0, -4).trim().toLowerCase();
        if (iconName) {
          iconFiles.set(iconName, filePath);
        }
      }

      const mapPath = listed.files.find((filePath) => basename(filePath).toLowerCase() === "map.json");
      const userMap = mapPath ? await this.readMapJson(mapPath) : {};
      this.iconFiles = iconFiles;
      this.extToIcon = { ...ONEDRIVE_EXT_TO_ICON, ...userMap };
    } catch {
      this.iconFiles = new Map();
      this.extToIcon = { ...ONEDRIVE_EXT_TO_ICON };
    }
  }

  customIconImgSrc(mimeType: string, name: string): string | null {
    if (!this.folderPath) {
      return null;
    }

    // Extension first (so a user `map.json` override applies); fall back to the mimeType for files
    // whose NAME has no usable extension — Drive often stores PDFs/Office docs extensionless, and the
    // built-in icons detect those by mime, so the custom pack must too (else they'd skip the pack).
    const iconName = mimeType === "application/vnd.google-apps.folder"
      ? "folder"
      : this.extToIcon[getFileExtension(name)] ?? fileIconName(mimeType, name);
    if (!iconName) {
      return null;
    }

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

    const icons: Record<string, string> = {};
    const svgPaths = listed.files
      .filter((filePath) => basename(filePath).toLowerCase().endsWith(".svg"))
      .sort((a, b) => a.localeCompare(b));

    for (const filePath of svgPaths) {
      const iconName = iconNameFromSvgPath(filePath);
      if (iconName) {
        icons[iconName] = await this.adapter.read(filePath);
      }
    }

    const mapPath = listed.files.find((filePath) => basename(filePath).toLowerCase() === "map.json");
    const map = mapPath ? await this.readMapJson(mapPath) : {};
    const exportPath = joinVaultPath(folderPath, "icons.json");
    await this.adapter.write(exportPath, JSON.stringify({ name: basename(folderPath), icons, map }, null, 2) + "\n");
    return { path: exportPath, iconCount: Object.keys(icons).length, mapCount: Object.keys(map).length };
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

    const icons = isRecord(root.icons) ? (root.icons as Record<string, unknown>) : {};
    let iconCount = 0;
    let skipped = 0;
    for (const [rawName, rawSvg] of Object.entries(icons)) {
      const iconName = sanitizeIconName(rawName);
      if (!iconName || typeof rawSvg !== "string" || !rawSvg.trim()) {
        skipped++;
        continue;
      }
      await this.adapter.write(joinVaultPath(folderPath, `${iconName}.svg`), rawSvg);
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
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  return normalizePath(trimmed.replace(/^\/+/, "").replace(/\/+$/, ""));
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function iconNameFromSvgPath(path: string): string {
  return basename(path).slice(0, -4).trim().toLowerCase();
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
