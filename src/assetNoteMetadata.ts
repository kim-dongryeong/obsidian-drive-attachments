import { isDriveFolder, DrivePickerItem } from "./driveTypes";
import { DriveMetadata } from "./driveMetadataService";
import { formatBytes } from "./byteFormat";

export const ASSET_NOTE_METADATA_KEYS = [
  "drive_id",
  "drive_name",
  "drive_mime_type",
  "drive_web_view_link",
  "drive_owner",
  "drive_path",
  "drive_path_checked",
  "drive_size",
  "drive_size_human",
  "drive_modified_time",
  "drive_md5",
  "drive_thumbnail_link",
  "drive_download_link",
  "drive_preview_link",
  // Legacy — export links now render as an "Export links" body section (a raw JSON object is an
  // invalid Obsidian property). The key stays listed so metadata refresh deletes it from existing
  // notes and extra frontmatter can't reintroduce it.
  "drive_export_links",
  "googleDriveFolderUrl",
] as const;

type AssetNoteFrontmatterKey = typeof ASSET_NOTE_METADATA_KEYS[number];
type AssetNoteFrontmatter = Partial<Record<AssetNoteFrontmatterKey, unknown>>;

// How a Drive-link note came to exist. `uploaded` = the bytes were uploaded to Drive from Obsidian
// (drop / paste / upload command / migrate); `linked` = the note references a file that already
// existed in Drive, brought in via the picker or search. Stamped once at note creation.
export type DriveNoteOrigin = "uploaded" | "linked";

// Provenance key. Deliberately NOT in ASSET_NOTE_METADATA_KEYS: those keys are deleted and rewritten
// on every metadata refresh, whereas `drive_origin` is a write-once creation-time fact Drive can't
// report, so it must survive refreshes untouched. The extra-frontmatter parser reserves it too, so a
// user can't duplicate or override it from their own template.
export const DRIVE_ORIGIN_KEY = "drive_origin";

// Best-effort Drive folder path plus the time it was resolved. `path` is null when no ancestor
// folder was readable (common under `drive.file`); `checkedAt` is always stamped so the note
// records that a lookup happened. Resolved in the (async) service layer and threaded in here.
export interface DrivePathInfo {
  path: string | null;
  checkedAt: string;
}

export function formatAssetNoteFrontmatter(
  item: DrivePickerItem,
  metadata: DriveMetadata | null,
  pathInfo?: DrivePathInfo | null,
  accountEmail?: string | null,
): string[] {
  const frontmatter = getAssetNoteFrontmatter(item, metadata, pathInfo, accountEmail);
  return ASSET_NOTE_METADATA_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(frontmatter, key))
    .map((key) => `${key}: ${formatYamlValue(frontmatter[key])}`);
}

export function applyDriveMetadataToFrontmatter(
  frontmatter: Record<string, unknown>,
  metadata: DriveMetadata,
  pathInfo?: DrivePathInfo | null,
  accountEmail?: string | null,
): void {
  for (const key of ASSET_NOTE_METADATA_KEYS) {
    delete frontmatter[key];
  }

  Object.assign(frontmatter, getAssetNoteFrontmatter(metadata, metadata, pathInfo, accountEmail));
}

function getAssetNoteFrontmatter(
  item: DrivePickerItem,
  metadata: DriveMetadata | null,
  pathInfo?: DrivePathInfo | null,
  accountEmail?: string | null,
): AssetNoteFrontmatter {
  const isFolder = isDriveFolder(item);
  const id = metadata?.id ?? item.id;
  const name = metadata?.name ?? item.name;
  const mimeType = metadata?.mimeType ?? item.mimeType;
  const webViewLink = metadata?.webViewLink ?? item.webViewLink;
  const isGoogleNative = isGoogleNativeMimeType(mimeType);
  const frontmatter: AssetNoteFrontmatter = {
    drive_id: id,
    drive_name: name,
    drive_mime_type: mimeType,
    drive_web_view_link: webViewLink,
  };

  if (metadata?.size) {
    frontmatter.drive_size = formatSizeValue(metadata.size);
    frontmatter.drive_size_human = formatBytes(metadata.size);
  }

  const owner = metadata ? formatDriveOwner(metadata, accountEmail) : null;
  if (owner) {
    frontmatter.drive_owner = owner;
  }

  // Stamp `drive_path_checked` whenever a resolution was attempted (even if no path was readable),
  // so the note records when we last looked; only write `drive_path` when we actually resolved one.
  if (pathInfo) {
    if (pathInfo.path) {
      frontmatter.drive_path = pathInfo.path;
    }
    frontmatter.drive_path_checked = pathInfo.checkedAt;
  }

  if (metadata?.modifiedTime) {
    frontmatter.drive_modified_time = metadata.modifiedTime;
  }

  if (metadata?.md5Checksum && !isGoogleNative) {
    frontmatter.drive_md5 = metadata.md5Checksum;
  }

  if (metadata?.thumbnailLink) {
    frontmatter.drive_thumbnail_link = metadata.thumbnailLink;
  }

  if (metadata?.webContentLink && !isGoogleNative) {
    frontmatter.drive_download_link = metadata.webContentLink;
  }

  if (!isFolder) {
    frontmatter.drive_preview_link = formatDrivePreviewLink(id);
  }

  if (isFolder) {
    frontmatter.googleDriveFolderUrl = webViewLink;
  }

  return frontmatter;
}

function isGoogleNativeMimeType(mimeType: string): boolean {
  return mimeType.startsWith("application/vnd.google-apps.");
}

function formatDrivePreviewLink(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
}

function formatDriveOwner(
  metadata: DriveMetadata,
  accountEmail: string | null | undefined,
): string | null {
  const owner = metadata.owners?.find((candidate) => candidate.displayName || candidate.emailAddress);
  if (owner) {
    if (owner.displayName && owner.emailAddress) {
      return `${owner.displayName} <${owner.emailAddress}>`;
    }

    return owner.displayName ?? owner.emailAddress ?? null;
  }

  // Shared-drive files carry no `owners` — they belong to the org, not a person (kdr's choice:
  // record the connected account's domain instead). `driveId` gates this so a My-Drive item with a
  // merely-missing `owners` field stays blank rather than getting mislabeled.
  if (metadata.driveId) {
    return formatAccountDomain(accountEmail);
  }

  return null;
}

function formatAccountDomain(accountEmail: string | null | undefined): string | null {
  if (typeof accountEmail !== "string") {
    return null;
  }

  const atIndex = accountEmail.lastIndexOf("@");
  if (atIndex === -1 || atIndex === accountEmail.length - 1) {
    return null;
  }

  return accountEmail.slice(atIndex);
}

function formatSizeValue(value: string): number | string {
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : value;
}

function formatYamlValue(value: unknown): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}
