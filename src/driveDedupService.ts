import { createHash } from "crypto";
import { App, requestUrl, TFile, type RequestUrlResponse } from "obsidian";
import { DriveAuthService } from "./driveAuthService";
import { DriveIndexService } from "./driveIndexService";
import { assertValidDrivePickerItem, DrivePickerItem } from "./driveTypes";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_DEDUP_FIELDS = "nextPageToken,files(id,name,mimeType,webViewLink,md5Checksum,size,parents)";
const DRIVE_ALL_DRIVES_CORPUS = "allDrives";
// Caps the name-lookup paging: `name contains '<base>'` with a short base name token-prefix-matches
// a large slice of Drive, and dedup is best-effort — dozens of sequential page fetches (and their
// quota) while an upload waits is worse than missing a duplicate the index layer can still catch.
const DRIVE_DEDUP_MAX_QUERY_PAGES = 5;
// Bounds how long dedup waits for the Drive index. A cold index means a full crawl (up to 50
// pages), and the upload command shows no feedback while dedup runs. After the bound, the lookup
// scans whatever has landed and falls through to the name layer; the load itself keeps running
// (ensureLoaded coalesces), so the next upload sees a warm index.
const DRIVE_DEDUP_INDEX_WAIT_MS = 10_000;

export type DriveDedupSource = "vault-asset-note" | "drive-index" | "drive-name";

export interface DriveDedupHit {
  source: DriveDedupSource;
  item: DrivePickerItem;
  uploadingFileName: string;
  matchedMd5: string;
  size?: string;
  parents?: string[];
  drivePath?: string;
  assetNote?: TFile;
}

export interface DriveDedupLookupInput {
  md5: string;
  fileName: string;
}

export function computeMd5Hex(data: ArrayBuffer): string {
  return createHash("md5").update(Buffer.from(data)).digest("hex");
}

export class DriveDedupService {
  private readonly assetNotePathsByMd5 = new Map<string, string>();

  constructor(
    private readonly app: App,
    private readonly auth: DriveAuthService,
    private readonly index: DriveIndexService,
  ) {}

  async findDuplicate(input: DriveDedupLookupInput): Promise<DriveDedupHit | null> {
    // An empty hash must mean "no lookup": a note WITHOUT drive_md5 also normalizes to "", so an
    // empty input would equal it and return an arbitrary asset note as a false duplicate.
    if (!normalizeMd5(input.md5)) {
      return null;
    }

    const localHit = this.findVaultAssetNoteByMd5(input);
    if (localHit) {
      logDedupLayer("vault-asset-note", input.fileName, "hit");
      return localHit;
    }
    logDedupLayer("vault-asset-note", input.fileName, "miss");

    const indexHit = await this.findDriveFileByIndex(input);
    if (indexHit) {
      logDedupLayer("drive-index", input.fileName, "hit");
      return indexHit;
    }
    logDedupLayer("drive-index", input.fileName, "miss");

    const nameHit = await this.findDriveFileByName(input);
    logDedupLayer("drive-name", input.fileName, nameHit ? "hit" : "miss");
    return nameHit;
  }

  rememberVaultAssetNote(md5: string, path: string): void {
    this.assetNotePathsByMd5.set(normalizeMd5(md5), path);
  }

  private findVaultAssetNoteByMd5(input: DriveDedupLookupInput): DriveDedupHit | null {
    const normalizedMd5 = normalizeMd5(input.md5);
    const cached = this.getRememberedAssetNote(normalizedMd5);
    if (cached) {
      // Unlike the drive_id session map, this map's key is a CONTENT property that can drift from
      // the note: replace the Drive file's content and refresh metadata, and the note's drive_md5
      // changes while the map still keys the old hash to it. Recheck before trusting the cache, or
      // a re-drop of the old content would reuse a link that now serves different bytes.
      const frontmatter = this.app.metadataCache.getFileCache(cached)?.frontmatter;
      if (normalizeMd5(frontmatter?.drive_md5) === normalizedMd5) {
        const item = getDriveItemFromFrontmatter(frontmatter);
        if (item) {
          return this.buildHit(input, "vault-asset-note", item, {
            assetNote: cached,
            drivePath: getDrivePathFromFrontmatter(frontmatter),
            size: getDriveSizeFromFrontmatter(frontmatter),
          });
        }
      } else {
        this.assetNotePathsByMd5.delete(normalizedMd5);
      }
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (normalizeMd5(frontmatter?.drive_md5) !== normalizedMd5) {
        continue;
      }

      const item = getDriveItemFromFrontmatter(frontmatter);
      if (item) {
        this.rememberVaultAssetNote(normalizedMd5, file.path);
        return this.buildHit(input, "vault-asset-note", item, {
          assetNote: file,
          drivePath: getDrivePathFromFrontmatter(frontmatter),
          size: getDriveSizeFromFrontmatter(frontmatter),
        });
      }
    }

    return null;
  }

  private getRememberedAssetNote(md5: string): TFile | null {
    const path = this.assetNotePathsByMd5.get(md5);
    if (!path) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return file;
    }

    this.assetNotePathsByMd5.delete(md5);
    return null;
  }

  private async findDriveFileByIndex(input: DriveDedupLookupInput): Promise<DriveDedupHit | null> {
    // Wait for the index (the M5.7 fix: a fire-and-forget load made cold indexes miss Drive-only
    // duplicates) — but bounded. Whatever the outcome, scan the items present: a partially crawled
    // or stale index can still hit, and an md5 match is correct regardless of index completeness.
    const outcome = await this.waitForIndexLoad();
    if (outcome === "timeout") {
      console.warn(
        `[Drive Attachment Bridge] Drive index not ready within ${DRIVE_DEDUP_INDEX_WAIT_MS / 1000}s; upload dedup scans the partial index and falls through to the name lookup. The index load continues for the next upload.`,
      );
    }

    const normalizedMd5 = normalizeMd5(input.md5);
    const item = this.index.getItems().find((candidate) => normalizeMd5(candidate.md5Checksum) === normalizedMd5);
    return item ? this.buildHit(input, "drive-index", item) : null;
  }

  private async waitForIndexLoad(): Promise<"loaded" | "failed" | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), DRIVE_DEDUP_INDEX_WAIT_MS);
    });

    try {
      // Both race arms resolve (the load's rejection is handled here), so losing the race can
      // never surface later as an unhandled rejection.
      return await Promise.race([
        this.index.ensureLoaded().then(
          () => "loaded" as const,
          (error: unknown) => {
            console.warn(
              "[Drive Attachment Bridge] Upload dedup index load failed; scanning whatever is cached.",
              error,
            );
            return "failed" as const;
          },
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async findDriveFileByName(input: DriveDedupLookupInput): Promise<DriveDedupHit | null> {
    try {
      const accessToken = await this.auth.getAccessToken();
      const exact = await this.findDriveFileByQuery(accessToken, buildExactNameQuery(input.fileName), input.md5);
      if (exact) {
        return this.buildHit(input, "drive-name", exact);
      }

      const baseName = getBaseName(input.fileName);
      if (!baseName) {
        return null;
      }

      const contains = await this.findDriveFileByQuery(accessToken, buildContainsNameQuery(baseName), input.md5);
      return contains ? this.buildHit(input, "drive-name", contains) : null;
    } catch (error) {
      console.warn("[Drive Attachment Bridge] Upload dedup name lookup failed; proceeding without this layer.", error);
      return null;
    }
  }

  private async findDriveFileByQuery(accessToken: string, query: string, md5: string): Promise<DriveDedupCandidateItem | null> {
    let pageToken: string | null = null;

    for (let page = 0; page < DRIVE_DEDUP_MAX_QUERY_PAGES; page += 1) {
      const response = await requestUrl({
        url: buildDriveNameSearchUrl(query, pageToken),
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        console.warn(
          `[Drive Attachment Bridge] Upload dedup name lookup failed with HTTP ${response.status}; proceeding without this layer.`,
        );
        return null;
      }

      const parsed = parseDriveDedupItemsWithMd5(response, md5);
      if (parsed.item) {
        return parsed.item;
      }

      pageToken = parsed.nextPageToken;
      if (!pageToken) {
        return null;
      }
    }

    console.warn(
      `[Drive Attachment Bridge] Upload dedup name lookup stopped after ${DRIVE_DEDUP_MAX_QUERY_PAGES} pages without an md5 match; proceeding as no duplicate.`,
    );
    return null;
  }

  private buildHit(
    input: DriveDedupLookupInput,
    source: DriveDedupSource,
    item: DriveDedupCandidateItem,
    extras: { assetNote?: TFile; drivePath?: string | null; size?: string | null } = {},
  ): DriveDedupHit {
    const hit: DriveDedupHit = {
      source,
      item,
      uploadingFileName: input.fileName,
      matchedMd5: normalizeMd5(input.md5),
    };

    if (extras.assetNote) {
      hit.assetNote = extras.assetNote;
    }

    if (extras.drivePath) {
      hit.drivePath = extras.drivePath;
    }

    const size = extras.size ?? item.size;
    if (typeof size === "string" && size.length > 0) {
      hit.size = size;
    }

    if (item.parents && item.parents.length > 0) {
      hit.parents = item.parents;
    }

    return hit;
  }
}

type DriveDedupCandidateItem = DrivePickerItem & {
  size?: string;
  parents?: string[];
};

function buildDriveNameSearchUrl(query: string, pageToken: string | null): string {
  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", DRIVE_DEDUP_FIELDS);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("corpora", DRIVE_ALL_DRIVES_CORPUS);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  return url.toString();
}

function buildExactNameQuery(fileName: string): string {
  return `name = '${escapeDriveQueryString(fileName)}' and trashed = false`;
}

function buildContainsNameQuery(baseName: string): string {
  return `name contains '${escapeDriveQueryString(baseName)}' and trashed = false`;
}

function parseDriveDedupItemsWithMd5(
  response: RequestUrlResponse,
  md5: string,
): { item: DrivePickerItem | null; nextPageToken: string | null } {
  if (!response.text) {
    return { item: null, nextPageToken: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return { item: null, nextPageToken: null };
  }

  const body = parsed as { files?: unknown; nextPageToken?: unknown } | null;
  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return {
      item: null,
      nextPageToken: typeof body?.nextPageToken === "string" && body.nextPageToken.length > 0 ? body.nextPageToken : null,
    };
  }

  const normalizedMd5 = normalizeMd5(md5);
  const matchingFile = files.find((file) => normalizeMd5((file as { md5Checksum?: unknown }).md5Checksum) === normalizedMd5);
  return {
    item: matchingFile ? getValidDriveItem(matchingFile) : null,
    nextPageToken: typeof body?.nextPageToken === "string" && body.nextPageToken.length > 0 ? body.nextPageToken : null,
  };
}

function getDriveItemFromFrontmatter(frontmatter: Record<string, unknown> | undefined): DrivePickerItem | null {
  if (!frontmatter) {
    return null;
  }

  return getValidDriveItem({
    id: frontmatter.drive_id,
    name: frontmatter.drive_name,
    mimeType: frontmatter.drive_mime_type,
    webViewLink: frontmatter.drive_web_view_link ?? frontmatter.googleDriveFolderUrl,
  });
}

function getDrivePathFromFrontmatter(frontmatter: Record<string, unknown> | undefined): string | null {
  const drivePath = frontmatter?.drive_path;
  return typeof drivePath === "string" && drivePath.trim().length > 0 ? drivePath : null;
}

function getDriveSizeFromFrontmatter(frontmatter: Record<string, unknown> | undefined): string | null {
  const driveSize = frontmatter?.drive_size;
  if (typeof driveSize === "number" && Number.isSafeInteger(driveSize) && driveSize >= 0) {
    return String(driveSize);
  }
  if (typeof driveSize === "string" && driveSize.trim().length > 0) {
    return driveSize.trim();
  }
  return null;
}

function getValidDriveItem(value: unknown): DriveDedupCandidateItem | null {
  const candidate = value as DrivePickerItem;
  try {
    assertValidDrivePickerItem(candidate);
    const result: DriveDedupCandidateItem = candidate;
    const size = (value as { size?: unknown }).size;
    if (typeof size === "string" && size.length > 0) {
      result.size = size;
    }
    const parents = (value as { parents?: unknown }).parents;
    if (Array.isArray(parents) && parents.every((parent) => typeof parent === "string")) {
      result.parents = parents;
    }
    return result;
  } catch {
    return null;
  }
}

function normalizeMd5(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getBaseName(fileName: string): string {
  const trimmed = fileName.trim();
  const extensionIndex = trimmed.lastIndexOf(".");
  return extensionIndex > 0 ? trimmed.slice(0, extensionIndex).trim() : trimmed;
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function logDedupLayer(layer: DriveDedupSource, fileName: string, result: "hit" | "miss"): void {
  console.debug(`[Drive Attachment Bridge] Upload dedup ${layer} ${result}: ${fileName}`);
}
