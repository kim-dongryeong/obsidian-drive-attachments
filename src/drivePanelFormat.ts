// Pure sort / filter / format helpers for the Drive panel — sort comparators, the Type/Modified
// filter categories, owner options, and detail-bar formatting. Extracted from drivePanelView.ts
// (T-011 P2: behaviour-preserving move of pure functions out of the ~6k-line panel view).

import { DRIVE_FOLDER_MIME_TYPE } from "./driveTypes";
import { PanelSortDir, PanelSortKey, PanelViewMode } from "./settings";
import { DriveBrowserItem, DriveMetadata, DriveOwner } from "./driveMetadataService";
import { formatBytes } from "./byteFormat";

export function sortFolderFirst(items: DriveBrowserItem[]): DriveBrowserItem[] {
  return [...items].sort((left, right) => {
    const leftFolder = left.mimeType === DRIVE_FOLDER_MIME_TYPE;
    const rightFolder = right.mimeType === DRIVE_FOLDER_MIME_TYPE;
    if (leftFolder !== rightFolder) {
      return leftFolder ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

// Direction labels for the Sort menu, tracking the chosen key the way drive.google.com does:
// date keys read "New to old / Old to new", Size reads "Smallest / Largest first", and Name/Type
// read "A → Z / Z → A". The order returned is Drive's (primary direction first).
export function sortDirectionOptions(
  key: PanelSortKey,
): Array<{ dir: PanelSortDir; label: string; icon: string }> {
  if (key === "modified" || key === "modifiedByMe" || key === "viewedByMe") {
    return [
      { dir: "desc", label: "New to old", icon: "arrow-down-wide-narrow" },
      { dir: "asc", label: "Old to new", icon: "arrow-up-narrow-wide" },
    ];
  }
  if (key === "size") {
    return [
      { dir: "asc", label: "Smallest first", icon: "arrow-up-narrow-wide" },
      { dir: "desc", label: "Largest first", icon: "arrow-down-wide-narrow" },
    ];
  }
  return [
    { dir: "asc", label: "A → Z", icon: "arrow-up-narrow-wide" },
    { dir: "desc", label: "Z → A", icon: "arrow-down-wide-narrow" },
  ];
}

// User-chosen sort for the panel listing (Drive's Name/Date-modified/Date-modified-by-me/
// Date-opened-by-me keys, plus Size/Type extras, asc/desc). Folders-first, when on, keeps
// directories grouped above files regardless of direction (Finder/Explorer behavior). Ties and
// folder-vs-folder always fall back to a numeric-aware name compare so the order is stable.
export function sortDriveItems(
  items: DriveBrowserItem[],
  key: PanelSortKey,
  dir: PanelSortDir,
  foldersFirst: boolean,
): DriveBrowserItem[] {
  const sign = dir === "desc" ? -1 : 1;
  const byName = (a: DriveBrowserItem, b: DriveBrowserItem): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  return [...items].sort((a, b) => {
    if (foldersFirst) {
      const fa = a.mimeType === DRIVE_FOLDER_MIME_TYPE;
      const fb = b.mimeType === DRIVE_FOLDER_MIME_TYPE;
      if (fa !== fb) {
        return fa ? -1 : 1; // folders stay on top regardless of sort direction
      }
    }
    const byTime = (field: "modifiedTime" | "modifiedByMeTime" | "viewedByMeTime"): number =>
      (Date.parse(a[field] ?? "") || 0) - (Date.parse(b[field] ?? "") || 0);
    let cmp = 0;
    switch (key) {
      case "modified":
        cmp = byTime("modifiedTime");
        break;
      case "modifiedByMe":
        cmp = byTime("modifiedByMeTime");
        break;
      case "viewedByMe":
        cmp = byTime("viewedByMeTime");
        break;
      case "size":
        cmp = (Number(a.size) || 0) - (Number(b.size) || 0);
        break;
      case "type":
        cmp = a.mimeType.localeCompare(b.mimeType, undefined, { sensitivity: "base" }) || byName(a, b);
        break;
      default:
        cmp = byName(a, b);
    }
    if (cmp === 0) {
      cmp = byName(a, b);
    }
    return cmp * sign;
  });
}

export function panelViewIcon(mode: PanelViewMode): string {
  return mode === "grid" ? "layout-grid" : mode === "compact" ? "menu" : "list";
}

export function formatItemDetails(item: DriveBrowserItem): string {
  const details: string[] = [];
  if (item.modifiedTime) {
    details.push(formatModifiedTime(item.modifiedTime));
  }
  if (item.size) {
    details.push(formatBytes(item.size));
  }
  return details.join(" | ");
}

export function formatModifiedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatPanelOwner(metadata: DriveMetadata, accountEmail: string | null | undefined): string | null {
  const owner = metadata.owners?.find((candidate) => candidate.displayName || candidate.emailAddress);
  if (owner) {
    if (owner.displayName && owner.emailAddress) {
      return `${owner.displayName} <${owner.emailAddress}>`;
    }
    return owner.displayName ?? owner.emailAddress ?? null;
  }

  if (metadata.driveId) {
    return formatAccountDomain(accountEmail);
  }

  return null;
}

export function formatAccountDomain(accountEmail: string | null | undefined): string | null {
  if (typeof accountEmail !== "string") {
    return null;
  }
  const atIndex = accountEmail.lastIndexOf("@");
  if (atIndex === -1 || atIndex === accountEmail.length - 1) {
    return null;
  }
  return accountEmail.slice(atIndex);
}

export function formatDetailMetadataError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bHTTP 401\b/.test(message)) {
    return "Reconnect Drive to load owner and thumbnail.";
  }
  if (/\bHTTP 403\b/.test(message)) {
    return /quota|rateLimit|userRateLimit/i.test(message)
      ? "Drive quota limited owner and thumbnail loading."
      : "No permission to load owner and thumbnail.";
  }
  if (/\bHTTP 404\b/.test(message)) {
    return "Drive item not found.";
  }
  return "Could not load owner and thumbnail.";
}

// Drive's "Type ▾" filter categories. Single-select (matches drive.google.com's Type chip), evaluated
// client-side over the loaded folder listing via `matchesTypeCategory`.
export type PanelTypeCategory =
  | "folder"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "archive";

export interface PanelTypeOption {
  key: PanelTypeCategory;
  label: string;
  icon: string;
}

export interface PanelOwnerOption {
  key: string;
  label: string;
  menuLabel: string;
}

export const PANEL_TYPE_OPTIONS: PanelTypeOption[] = [
  { key: "folder", label: "Folders", icon: "folder" },
  { key: "document", label: "Documents", icon: "file-text" },
  { key: "spreadsheet", label: "Spreadsheets", icon: "table" },
  { key: "presentation", label: "Presentations", icon: "presentation" },
  { key: "pdf", label: "PDFs", icon: "file-type-2" },
  { key: "image", label: "Photos & images", icon: "image" },
  { key: "video", label: "Videos", icon: "film" },
  { key: "audio", label: "Audio", icon: "music" },
  { key: "archive", label: "Archives", icon: "archive" },
];

export const DOCUMENT_MIME_TYPES = new Set([
  "application/vnd.google-apps.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
]);
export const SPREADSHEET_MIME_TYPES = new Set([
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
]);
export const PRESENTATION_MIME_TYPES = new Set([
  "application/vnd.google-apps.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.presentation",
]);
export const ARCHIVE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
]);

export function matchesTypeCategory(mimeType: string, category: PanelTypeCategory): boolean {
  switch (category) {
    case "folder":
      return mimeType === DRIVE_FOLDER_MIME_TYPE;
    case "image":
      return mimeType.startsWith("image/");
    case "video":
      return mimeType.startsWith("video/");
    case "audio":
      return mimeType.startsWith("audio/");
    case "pdf":
      return mimeType === "application/pdf";
    case "document":
      // Office/Docs/OpenDocument word-processing plus generic text, minus csv (a spreadsheet below).
      return DOCUMENT_MIME_TYPES.has(mimeType) || (mimeType.startsWith("text/") && mimeType !== "text/csv");
    case "spreadsheet":
      return SPREADSHEET_MIME_TYPES.has(mimeType);
    case "presentation":
      return PRESENTATION_MIME_TYPES.has(mimeType);
    case "archive":
      return ARCHIVE_MIME_TYPES.has(mimeType);
    default:
      return false;
  }
}

export function panelTypeLabel(category: PanelTypeCategory): string {
  return PANEL_TYPE_OPTIONS.find((option) => option.key === category)?.label ?? "Type";
}

export function panelTypeIcon(category: PanelTypeCategory): string {
  return PANEL_TYPE_OPTIONS.find((option) => option.key === category)?.icon ?? "shapes";
}

export function panelOwnerOption(owner: DriveOwner): PanelOwnerOption | null {
  const displayName = owner.displayName?.trim() ?? "";
  const emailAddress = owner.emailAddress?.trim() ?? "";
  if (!displayName && !emailAddress) {
    return null;
  }
  return {
    key: emailAddress ? `email:${emailAddress.toLowerCase()}` : `name:${displayName.toLowerCase()}`,
    label: displayName || emailAddress,
    menuLabel: displayName && emailAddress ? `${displayName} (${emailAddress})` : displayName || emailAddress,
  };
}

export function panelOwnerOptions(items: DriveBrowserItem[]): PanelOwnerOption[] {
  const byKey = new Map<string, PanelOwnerOption>();
  for (const item of items) {
    for (const owner of item.owners ?? []) {
      const option = panelOwnerOption(owner);
      if (option && !byKey.has(option.key)) {
        byKey.set(option.key, option);
      }
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.menuLabel.localeCompare(right.menuLabel, undefined, { sensitivity: "base" }),
  );
}

export function itemHasOwner(item: DriveBrowserItem, ownerKey: string): boolean {
  return item.owners?.some((owner) => panelOwnerOption(owner)?.key === ownerKey) ?? false;
}

// First resolvable owner display name/email for a row badge tooltip; null when the listing omits owners
// (common on shared-drive items, which Drive owns at the organization level).
export function panelPrimaryOwnerLabel(item: DriveBrowserItem): string | null {
  for (const owner of item.owners ?? []) {
    const option = panelOwnerOption(owner);
    if (option) {
      return option.label;
    }
  }
  return null;
}

// Drive's "Modified ▾" filter windows. Single-select (matches drive.google.com's Modified chip),
// evaluated client-side over the loaded folder listing's `modifiedTime`.
export type PanelModifiedRange = "today" | "last7" | "last30" | "thisYear";

export interface PanelModifiedOption {
  key: PanelModifiedRange;
  label: string;
  icon: string;
}

export const PANEL_MODIFIED_OPTIONS: PanelModifiedOption[] = [
  { key: "today", label: "Today", icon: "calendar-check" },
  { key: "last7", label: "Last 7 days", icon: "calendar-days" },
  { key: "last30", label: "Last 30 days", icon: "calendar-range" },
  { key: "thisYear", label: "This year", icon: "calendar-clock" },
];

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Lower-bound timestamp (ms) for a Modified range, computed from `now`. Items modified at or after
// this instant match. "Today" and "This year" anchor to the local calendar's start-of-period; the
// rolling windows subtract whole days from now.
export function modifiedRangeCutoff(range: PanelModifiedRange, now: number): number {
  const ref = new Date(now);
  switch (range) {
    case "today":
      return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
    case "last7":
      return now - 7 * ONE_DAY_MS;
    case "last30":
      return now - 30 * ONE_DAY_MS;
    case "thisYear":
      return new Date(ref.getFullYear(), 0, 1).getTime();
    default:
      return now;
  }
}

export function itemModifiedSince(item: DriveBrowserItem, cutoff: number): boolean {
  if (!item.modifiedTime) {
    return false;
  }
  const ts = Date.parse(item.modifiedTime);
  return !Number.isNaN(ts) && ts >= cutoff;
}

export function panelModifiedLabel(range: PanelModifiedRange): string {
  return PANEL_MODIFIED_OPTIONS.find((option) => option.key === range)?.label ?? "Modified";
}

export function panelModifiedIcon(range: PanelModifiedRange): string {
  return PANEL_MODIFIED_OPTIONS.find((option) => option.key === range)?.icon ?? "calendar";
}

// Reads naturally after "No loaded items were modified …" in the filtered-empty state.
export function panelModifiedPhrase(range: PanelModifiedRange): string {
  switch (range) {
    case "today":
      return "today";
    case "last7":
      return "in the last 7 days";
    case "last30":
      return "in the last 30 days";
    case "thisYear":
      return "this year";
    default:
      return "in that range";
  }
}

export const FRIENDLY_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.folder": "Folder",
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.script": "Apps Script",
  "application/pdf": "PDF",
  "application/zip": "ZIP archive",
  "application/x-zip-compressed": "ZIP archive",
  "application/json": "JSON",
  "application/msword": "Word document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/vnd.ms-excel": "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel spreadsheet",
  "application/vnd.ms-powerpoint": "PowerPoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
};

// Human-friendly label for a Drive mimeType, used in the details bar. Known types map directly;
// everything else falls back to a "<SUBTYPE> image/video/.../file" shape, with opaque subtypes
// (vnd.*, x-*, octet-stream) collapsed to a plain category word.
export function friendlyMimeType(mimeType: string): string {
  const known = FRIENDLY_MIME_TYPES[mimeType];
  if (known) {
    return known;
  }

  const slash = mimeType.indexOf("/");
  const type = slash >= 0 ? mimeType.slice(0, slash) : mimeType;
  const subtype = slash >= 0 ? mimeType.slice(slash + 1) : "";
  const shortSub = subtype.split(/[.+]/)[0].toUpperCase();
  const opaque =
    shortSub === "" || shortSub === "VND" || shortSub === "X" || shortSub === "OCTET-STREAM";

  switch (type) {
    case "image":
      return opaque ? "Image" : `${shortSub} image`;
    case "video":
      return opaque ? "Video" : `${shortSub} video`;
    case "audio":
      return opaque ? "Audio" : `${shortSub} audio`;
    case "text":
      return opaque ? "Text" : `${shortSub} text`;
    default:
      return opaque ? "File" : `${shortSub} file`;
  }
}

// The Trash view's default order — most recently trashed first, drive.google.com's "Date trashed".
// trashedTime is not a valid server orderBy key, so this runs client-side. Folders-first (when on)
// still groups directories; missing/unparsable timestamps sink to the bottom via the name tiebreak.
export function sortDriveItemsByTrashedTime(items: DriveBrowserItem[], foldersFirst: boolean): DriveBrowserItem[] {
  const byName = (a: DriveBrowserItem, b: DriveBrowserItem): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  return [...items].sort((a, b) => {
    if (foldersFirst) {
      const fa = a.mimeType === DRIVE_FOLDER_MIME_TYPE;
      const fb = b.mimeType === DRIVE_FOLDER_MIME_TYPE;
      if (fa !== fb) {
        return fa ? -1 : 1;
      }
    }
    const ta = Date.parse(a.trashedTime ?? "") || 0;
    const tb = Date.parse(b.trashedTime ?? "") || 0;
    return tb - ta || byName(a, b);
  });
}

// Drive returns folderColorRgb as a "#RRGGBB" hex string from its fixed palette. Validate before
// tinting so a malformed/unexpected value can't reach the inline style; an invalid or absent color
// leaves the folder its default muted tint.
export function folderColorHex(rgb: string | undefined): string | null {
  if (!rgb) {
    return null;
  }
  const trimmed = rgb.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : null;
}

