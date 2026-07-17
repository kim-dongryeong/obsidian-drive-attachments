import { requestUrl, type RequestUrlResponse } from "obsidian";
import { DriveAuthService } from "./driveAuthService";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_DRIVES_URL = "https://www.googleapis.com/drive/v3/drives";
const DRIVE_ABOUT_URL = "https://www.googleapis.com/drive/v3/about";
const DRIVE_BROWSER_FIELDS =
  "nextPageToken,files(id,name,mimeType,iconLink,thumbnailLink,folderColorRgb,starred,shared,ownedByMe,modifiedTime,modifiedByMeTime,viewedByMeTime,trashedTime,size,webViewLink,owners(displayName,emailAddress))";
const DRIVE_METADATA_FIELDS = [
  "id",
  "name",
  "mimeType",
  "driveId",
  "size",
  "modifiedTime",
  "md5Checksum",
  "webViewLink",
  "webContentLink",
  "thumbnailLink",
  "exportLinks",
  "owners(displayName,emailAddress)",
  "shared",
  "parents",
].join(",");

export interface DriveOwner {
  displayName?: string;
  emailAddress?: string;
}

export interface DriveMetadata {
  id: string;
  name: string;
  mimeType: string;
  driveId?: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  webViewLink: string;
  webContentLink?: string;
  thumbnailLink?: string;
  exportLinks?: Record<string, string>;
  owners?: DriveOwner[];
  shared?: boolean;
  parents?: string[];
}

export interface DriveBrowserItem {
  id: string;
  name: string;
  mimeType: string;
  iconLink?: string;
  thumbnailLink?: string;
  // Drive's per-folder "Change color" value as a "#RRGGBB" hex string; absent on default-colored
  // folders and on non-folder items. Used to tint the folder icon to match drive.google.com.
  folderColorRgb?: string;
  // Drive's user-specific starred state. Requested with folder listings so the panel can show a
  // badge and offer Add to / Remove from Starred without an extra metadata request per row.
  starred?: boolean;
  // Drive's "is this file shared with anyone" flag and per-user ownership flag. Requested with the
  // listing so the panel can show shared / shared-with-me row badges (drive.google.com parity)
  // without a per-row metadata request. `ownedByMe` is not populated for shared-drive items (org
  // ownership), so an absent value means "ownership unknown" — the badge simply does not render.
  shared?: boolean;
  ownedByMe?: boolean;
  modifiedTime?: string;
  // Drive's "Date modified by me" / "Date opened by me" sort keys. Absent on items the
  // signed-in user has never touched, so the sort falls back to a name compare.
  modifiedByMeTime?: string;
  viewedByMeTime?: string;
  // When the item sits in the trash: the moment it was trashed. Drives the Trash view's default
  // "date trashed" ordering (drive.google.com parity) — not a valid server orderBy key, so the
  // panel sorts client-side.
  trashedTime?: string;
  size?: string;
  webViewLink?: string;
  // Shared-drive items commonly omit owners because they belong to the organization rather than
  // an individual. The panel's People filter treats an absent list as an unmatched owner.
  owners?: DriveOwner[];
  // Populated only on Drive-wide SEARCH result items (not plain folder listings): the parent folder
  // ids (server hits) and the index's precomputed parent-folder path (index hits). The panel reads
  // these to show each result's TRUE location in the detail bar, not the folder the search began in.
  parents?: string[];
  path?: string;
}

export interface SharedDriveRoot {
  id: string;
  name: string;
}

// One page of a Drive listing. `nextPageToken` present means Drive has more items — pass it back to
// the same list call to fetch the next page. Absent = the listing is complete. (Drive may return
// fewer than pageSize items per page even mid-listing, so only the token — never the item count —
// signals completion.)
export interface DriveBrowserPage {
  items: DriveBrowserItem[];
  nextPageToken?: string;
}

export class DriveMetadataService {
  // Cache folder name/parents by id for the service's lifetime. Path resolution across many search
  // results (and asset notes) repeatedly walks the same ancestor folders, so memoizing collapses
  // dozens of redundant `files.get` calls into one per folder. Caches `null` (unreadable/transient) too.
  private readonly folderCache = new Map<string, { name: string; parents?: string[]; driveId?: string } | null>();
  // Shared-drive names are independent of folder walks; cache both readable names and failed lookups
  // so a permissions gap never creates repeated `drives.get` calls while rendering many search rows.
  private readonly sharedDriveNameCache = new Map<string, string | null>();
  // Drive publishes the supported folder colors per account through about.get. Cache the validated
  // palette so reopening the color picker stays instant while still avoiding a hard-coded UI palette.
  private folderColorPalette: string[] | null = null;

  constructor(private readonly auth: DriveAuthService) {}

  async listSharedDriveRoots(): Promise<SharedDriveRoot[]> {
    const accessToken = await this.auth.getAccessToken();
    const drives: SharedDriveRoot[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(DRIVE_DRIVES_URL);
      url.searchParams.set("fields", "nextPageToken,drives(id,name)");
      url.searchParams.set("pageSize", "100");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }

      const response = await requestUrl({
        url: url.toString(),
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Google Drive shared-drive listing failed with HTTP ${response.status}.`);
      }

      const parsed = parseSharedDriveRoots(response);
      drives.push(...parsed.drives);
      pageToken = parsed.nextPageToken;
    } while (pageToken);

    return drives.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  }

  // Shared core for the browser listings (folder / Starred / Shared with me / Recent / Trash): one
  // files.list page per call. Callers pass the previous page's nextPageToken to continue; a missing
  // token in the result means the listing is complete.
  private async listBrowserPage(
    q: string,
    orderBy: string,
    errorLabel: string,
    pageToken?: string,
  ): Promise<DriveBrowserPage> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(DRIVE_FILES_URL);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", DRIVE_BROWSER_FIELDS);
    url.searchParams.set("orderBy", orderBy);
    url.searchParams.set("pageSize", "200");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await requestUrl({
      url: url.toString(),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google Drive ${errorLabel} failed with HTTP ${response.status}.`);
    }

    return parseDriveBrowserPage(response);
  }

  async listFolderPage(folderId: string, pageToken?: string): Promise<DriveBrowserPage> {
    return this.listBrowserPage(
      `'${escapeDriveQueryString(folderId)}' in parents and trashed = false`,
      "folder,name",
      "folder listing",
      pageToken,
    );
  }

  async listStarredPage(pageToken?: string): Promise<DriveBrowserPage> {
    return this.listBrowserPage("starred = true and trashed = false", "folder,name", "Starred listing", pageToken);
  }

  async listSharedWithMePage(pageToken?: string): Promise<DriveBrowserPage> {
    return this.listBrowserPage(
      "sharedWithMe = true and trashed = false",
      "folder,name",
      "Shared with me listing",
      pageToken,
    );
  }

  // Drive's "Recent" view: non-trashed files (folders excluded, as on drive.google.com),
  // most-recently opened first, falling back to last-modified for never-opened items.
  async listRecentPage(pageToken?: string): Promise<DriveBrowserPage> {
    return this.listBrowserPage(
      "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      "viewedByMeTime desc,modifiedTime desc",
      "Recent listing",
      pageToken,
    );
  }

  // Drive's "Trash" view: every trashed item, files and folders alike (as on drive.google.com).
  // `trashedTime` is not a valid Drive `orderBy` key, so we sort folders-first by name and let the
  // panel's persisted client-side sort take over for display.
  async listTrashedPage(pageToken?: string): Promise<DriveBrowserPage> {
    return this.listBrowserPage("trashed = true", "folder,name", "Trash listing", pageToken);
  }

  async getFolderColorPalette(): Promise<string[]> {
    if (this.folderColorPalette) {
      return [...this.folderColorPalette];
    }

    const accessToken = await this.auth.getAccessToken();
    const url = new URL(DRIVE_ABOUT_URL);
    url.searchParams.set("fields", "folderColorPalette");
    const response = await requestUrl({
      url: url.toString(),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google Drive folder-color palette failed with HTTP ${response.status}.`);
    }

    const palette = parseFolderColorPalette(response);
    if (palette.length === 0) {
      throw new Error("Google Drive returned no supported folder colors.");
    }
    this.folderColorPalette = palette;
    return [...palette];
  }

  async getFileMetadata(fileId: string): Promise<DriveMetadata> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", DRIVE_METADATA_FIELDS);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google Drive metadata lookup failed with HTTP ${response.status}.`);
    }

    return parseDriveMetadata(response);
  }

  // Resolve the Drive folder path for a file/folder from its full metadata. Thin wrapper over
  // `resolveDrivePathByParents` so asset-note creation/refresh and the search modal share one walk.
  async resolveDrivePath(metadata: DriveMetadata): Promise<string | null> {
    return this.resolveDrivePathByParents(metadata.parents, metadata.driveId);
  }

  // Resolve a Drive folder path from a `parents` id list by walking the chain upward, best-effort.
  // Under `drive.file` a parent folder is often unreadable (403) for picked/uploaded items — in that
  // case we stop and keep the readable tail rather than throw. Returns the path as ancestor folder
  // names joined by "/" (root → leaf, excluding the item's own name), or null when no ancestor is
  // readable / there are no parents. The search modal calls this directly with a result's `parents`
  // so it can show each hit's location without a full `files.get`.
  async resolveDrivePathByParents(
    parents: string[] | undefined,
    metadataDriveId?: string,
  ): Promise<string | null> {
    if (!parents || parents.length === 0) {
      return null;
    }

    const accessToken = await this.auth.getAccessToken();
    const names: string[] = [];
    const visited = new Set<string>();
    let chain: string[] | undefined = parents;
    let sharedDriveId = isNonEmptyString(metadataDriveId) ? metadataDriveId : undefined;
    // Cap the walk so a pathological chain (or an unexpected cycle) can never loop forever; real
    // Drive hierarchies are far shallower than this.
    for (let depth = 0; depth < 50 && chain && chain.length > 0; depth += 1) {
      const parentId = chain[0];
      if (visited.has(parentId)) {
        break;
      }
      visited.add(parentId);

      const folder = await this.getFolderForPath(parentId, accessToken);
      if (!folder) {
        break;
      }
      if (isNonEmptyString(folder.driveId)) {
        sharedDriveId = folder.driveId;
      }
      names.unshift(folder.name);
      chain = folder.parents;
    }

    if (sharedDriveId) {
      const sharedDriveName = await this.getSharedDriveName(sharedDriveId, accessToken);
      if (sharedDriveName) {
        const readableTail = names[0] === "Drive" ? names.slice(1) : names;
        return ["Shared drives", sharedDriveName, ...readableTail].join("/");
      }
    }

    return names.length > 0 ? names.join("/") : null;
  }

  // Fetch a single folder's name + parents for path resolution. Never throws and never surfaces a
  // Notice: a non-readable/transient folder simply ends the walk (caller keeps the readable tail).
  private async getFolderForPath(
    folderId: string,
    accessToken: string,
  ): Promise<{ name: string; parents?: string[]; driveId?: string } | null> {
    const cached = this.folderCache.get(folderId);
    if (cached !== undefined) {
      return cached;
    }
    const result = await this.fetchFolderForPath(folderId, accessToken);
    this.folderCache.set(folderId, result);
    return result;
  }

  private async fetchFolderForPath(
    folderId: string,
    accessToken: string,
  ): Promise<{ name: string; parents?: string[]; driveId?: string } | null> {
    try {
      const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(folderId)}`);
      url.searchParams.set("fields", "id,name,parents,driveId");
      url.searchParams.set("supportsAllDrives", "true");

      const response = await requestUrl({
        url: url.toString(),
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });

      if (response.status < 200 || response.status >= 300 || !response.text) {
        return null;
      }

      const parsed: unknown = JSON.parse(response.text);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const name = (parsed as { name?: unknown }).name;
      if (typeof name !== "string" || name.trim().length === 0) {
        return null;
      }

      const rawParents = (parsed as { parents?: unknown }).parents;
      const folderParents =
        Array.isArray(rawParents) && rawParents.every((entry) => typeof entry === "string")
          ? rawParents
          : undefined;

      const rawDriveId = (parsed as { driveId?: unknown }).driveId;
      const driveId = typeof rawDriveId === "string" && rawDriveId.trim().length > 0 ? rawDriveId : undefined;

      return { name, parents: folderParents, driveId };
    } catch {
      return null;
    }
  }

  private async getSharedDriveName(driveId: string, accessToken: string): Promise<string | null> {
    const cached = this.sharedDriveNameCache.get(driveId);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.fetchSharedDriveName(driveId, accessToken);
    this.sharedDriveNameCache.set(driveId, result);
    return result;
  }

  private async fetchSharedDriveName(driveId: string, accessToken: string): Promise<string | null> {
    try {
      const url = new URL(`${DRIVE_DRIVES_URL}/${encodeURIComponent(driveId)}`);
      url.searchParams.set("fields", "id,name");

      const response = await requestUrl({
        url: url.toString(),
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });

      if (response.status < 200 || response.status >= 300 || !response.text) {
        return null;
      }

      const parsed: unknown = JSON.parse(response.text);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const name = (parsed as { name?: unknown }).name;
      return typeof name === "string" && name.trim().length > 0 ? name : null;
    } catch {
      return null;
    }
  }
}

function parseDriveMetadata(response: RequestUrlResponse): DriveMetadata {
  if (!response.text) {
    throw new Error("Google Drive returned an empty metadata response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Google Drive returned an unreadable metadata response.");
  }

  if (!isDriveMetadata(parsed)) {
    throw new Error("Google Drive metadata response was missing required fields.");
  }

  return parsed;
}

// Exported for unit tests (pure: RequestUrlResponse text → page).
export function parseDriveBrowserPage(response: RequestUrlResponse): DriveBrowserPage {
  if (!response.text) {
    return { items: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Google Drive returned an unreadable folder listing.");
  }

  const body = parsed as { files?: unknown; nextPageToken?: unknown } | null;
  const files = body?.files;
  const items = Array.isArray(files) ? files.filter(isDriveBrowserItem) : [];
  const nextPageToken =
    typeof body?.nextPageToken === "string" && body.nextPageToken.length > 0 ? body.nextPageToken : undefined;
  return { items, nextPageToken };
}

function parseSharedDriveRoots(response: RequestUrlResponse): { drives: SharedDriveRoot[]; nextPageToken?: string } {
  if (!response.text) {
    return { drives: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Google Drive returned an unreadable shared-drive listing.");
  }

  const body = parsed as { drives?: unknown; nextPageToken?: unknown } | null;
  const drives = Array.isArray(body?.drives) ? body.drives.filter(isSharedDriveRoot) : [];
  const nextPageToken = typeof body?.nextPageToken === "string" && body.nextPageToken.length > 0
    ? body.nextPageToken
    : undefined;

  return { drives, nextPageToken };
}

function parseFolderColorPalette(response: RequestUrlResponse): string[] {
  if (!response.text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Google Drive returned an unreadable folder-color palette.");
  }

  const rawPalette = (parsed as { folderColorPalette?: unknown } | null)?.folderColorPalette;
  if (!Array.isArray(rawPalette)) {
    return [];
  }

  const colors = rawPalette.filter(
    (color): color is string => typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color.trim()),
  );
  return [...new Set(colors.map((color) => color.trim().toUpperCase()))];
}

function isDriveBrowserItem(value: unknown): value is DriveBrowserItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DriveBrowserItem>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.name) &&
    isNonEmptyString(candidate.mimeType) &&
    isOptionalString(candidate.iconLink) &&
    isOptionalString(candidate.thumbnailLink) &&
    isOptionalString(candidate.folderColorRgb) &&
    isOptionalBoolean(candidate.starred) &&
    isOptionalBoolean(candidate.shared) &&
    isOptionalBoolean(candidate.ownedByMe) &&
    isOptionalString(candidate.modifiedTime) &&
    isOptionalString(candidate.modifiedByMeTime) &&
    isOptionalString(candidate.viewedByMeTime) &&
    isOptionalString(candidate.trashedTime) &&
    isOptionalString(candidate.size) &&
    isOptionalString(candidate.webViewLink) &&
    isOptionalDriveOwners(candidate.owners)
  );
}

function isSharedDriveRoot(value: unknown): value is SharedDriveRoot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SharedDriveRoot>;
  return isNonEmptyString(candidate.id) && isNonEmptyString(candidate.name);
}

function isDriveMetadata(value: unknown): value is DriveMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DriveMetadata>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.name) &&
    isNonEmptyString(candidate.mimeType) &&
    isNonEmptyString(candidate.webViewLink) &&
    isOptionalString(candidate.driveId) &&
    isOptionalString(candidate.size) &&
    isOptionalString(candidate.modifiedTime) &&
    isOptionalString(candidate.md5Checksum) &&
    isOptionalString(candidate.webContentLink) &&
    isOptionalString(candidate.thumbnailLink) &&
    isOptionalStringMap(candidate.exportLinks) &&
    isOptionalDriveOwners(candidate.owners) &&
    isOptionalBoolean(candidate.shared) &&
    isOptionalStringArray(candidate.parents)
  );
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  if (value === undefined) {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalStringMap(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) {
    return true;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.entries(value).every(([key, entry]) => key.length > 0 && typeof entry === "string");
}

function isOptionalDriveOwners(value: unknown): value is DriveOwner[] | undefined {
  if (value === undefined) {
    return true;
  }

  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }

    const owner = entry as Partial<DriveOwner>;
    return isOptionalString(owner.displayName) && isOptionalString(owner.emailAddress);
  });
}
