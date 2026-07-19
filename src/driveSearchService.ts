import { requestUrl, type RequestUrlResponse } from "obsidian";
import { DriveAuthService } from "./driveAuthService";
import type { DriveOwner } from "./driveMetadataService";
import { assertValidDrivePickerItem, DrivePickerItem } from "./driveTypes";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_SEARCH_PAGE_SIZE = 50;

// The panel also consumes listing metadata so its Type / People / Modified chips can refine fresh
// server hits without a per-row lookup. All supplementary fields stay optional: the core picker-item
// validator remains the usability gate, and Drive may omit fields such as owners on shared-drive items.
export type DriveSearchResult = DrivePickerItem & {
  parents?: string[];
  iconLink?: string;
  thumbnailLink?: string;
  folderColorRgb?: string;
  starred?: boolean;
  shared?: boolean;
  ownedByMe?: boolean;
  modifiedTime?: string;
  modifiedByMeTime?: string;
  viewedByMeTime?: string;
  size?: string;
  owners?: DriveOwner[];
};

export type DriveSearchLocationQuery = "anywhere" | "my-drive" | "shared-with-me" | "starred" | "trashed";

export interface DriveSearchResponse {
  matchedCount: number;
  results: DriveSearchResult[];
  hasMore: boolean;
}

interface GoogleDriveErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{
      reason?: string;
      message?: string;
    }>;
  };
}

export class DriveSearchService {
  constructor(private readonly auth: DriveAuthService) {}

  async searchByName(query: string, location: DriveSearchLocationQuery = "anywhere"): Promise<DriveSearchResponse> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { matchedCount: 0, results: [], hasMore: false };
    }

    const accessToken = await this.auth.getAccessToken();
    const url = new URL(DRIVE_FILES_URL);
    url.searchParams.set("q", `${buildDriveNameContainsQuery(trimmed)} and ${buildDriveLocationQuery(location)}`);
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,webViewLink,parents,iconLink,thumbnailLink,folderColorRgb,starred,shared,ownedByMe,modifiedTime,modifiedByMeTime,viewedByMeTime,size,owners(displayName,emailAddress))",
    );
    url.searchParams.set("pageSize", String(DRIVE_SEARCH_PAGE_SIZE));
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(getDriveSearchErrorMessage(response));
    }

    const { files, hasMore } = parseDriveSearchBody(response);
    const results = files.filter((item) => {
      try {
        assertValidDrivePickerItem(item);
        return true;
      } catch {
        return false;
      }
    });

    return {
      matchedCount: files.length,
      results,
      hasMore,
    };
  }
}

function buildDriveLocationQuery(location: DriveSearchLocationQuery): string {
  switch (location) {
    case "my-drive":
      return "'me' in owners and trashed = false";
    case "shared-with-me":
      return "sharedWithMe = true and trashed = false";
    case "starred":
      return "starred = true and trashed = false";
    case "trashed":
      return "trashed = true";
    case "anywhere":
    default:
      return "trashed = false";
  }
}

interface ParsedDriveSearchBody {
  files: DriveSearchResult[];
  hasMore: boolean;
}

function parseDriveSearchBody(response: RequestUrlResponse): ParsedDriveSearchBody {
  // Read the success body via `response.text`, never `response.json`: Obsidian's `json`
  // getter runs JSON.parse lazily and THROWS on a non-JSON 2xx body — e.g. a captive-portal
  // or transparent-proxy HTML page served with status 200. That raw "Unexpected token <"
  // SyntaxError would escape searchByName and reach the user as the modal message + Notice
  // instead of an actionable one — the same trap parseErrorBody already guards on the failure
  // path (see Turn 14). An empty 2xx body degrades to "no results" rather than throwing.
  if (!response.text) {
    return { files: [], hasMore: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error(
      "Google Drive returned an unreadable search response. Retry in a moment; reconnect if it keeps failing.",
    );
  }

  const body = parsed as { files?: unknown; nextPageToken?: unknown } | null;
  const files = Array.isArray(body?.files) ? (body?.files as DriveSearchResult[]) : [];
  // Drive returns `nextPageToken` only when more matches exist beyond this page, so it is the
  // authoritative "there are more results" signal — more reliable than treating a full page
  // (results.length === pageSize) as "more", which over-reports when the total is exactly one
  // page.
  const hasMore = typeof body?.nextPageToken === "string" && body.nextPageToken.length > 0;
  return { files, hasMore };
}

function getDriveSearchErrorMessage(response: RequestUrlResponse): string {
  const details = parseGoogleDriveError(response);
  const reason = details.reason.toLowerCase();
  const message = details.message.toLowerCase();

  if (response.status === 401) {
    return "Google Drive search needs reconnecting. Connect to Google Drive again, then retry.";
  }

  if (response.status === 403 && (reason.includes("insufficient") || message.includes("insufficient permission"))) {
    return "Google Drive search is missing Drive read permission. Grant Drive read access in settings, then retry.";
  }

  if (response.status === 429 || (response.status === 403 && isQuotaOrRateLimitError(reason, message))) {
    return "Google Drive search is temporarily rate-limited or over quota. Wait a bit, then retry.";
  }

  if (response.status === 403) {
    return "Google Drive denied the search request. Check Drive access, reconnect if needed, then retry.";
  }

  return `Google Drive search failed with HTTP ${response.status}. Retry in a moment; reconnect if it keeps failing.`;
}

function parseGoogleDriveError(response: RequestUrlResponse): { reason: string; message: string } {
  const body = parseErrorBody(response);
  const firstError = body?.error?.errors?.[0];
  return {
    reason: firstError?.reason ?? "",
    message: firstError?.message ?? body?.error?.message ?? "",
  };
}

function parseErrorBody(response: RequestUrlResponse): GoogleDriveErrorBody | null {
  // Parse from `response.text`, never `response.json`: Obsidian's `json` getter runs
  // `JSON.parse` lazily and THROWS on a non-JSON body (an HTML 502/504 from a proxy, a
  // captive-portal page, an empty body). That throw would escape getDriveSearchErrorMessage
  // and replace our mapped message with a raw "Unexpected token <" SyntaxError shown to the
  // user. Going through text keeps the JSON.parse inside this try/catch.
  if (!response.text) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(response.text);
    return isGoogleDriveErrorBody(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isGoogleDriveErrorBody(value: unknown): value is GoogleDriveErrorBody {
  if (!value || typeof value !== "object" || !("error" in value)) {
    return false;
  }

  const error = (value as GoogleDriveErrorBody).error;
  return !error || typeof error === "object";
}

function isQuotaOrRateLimitError(reason: string, message: string): boolean {
  // Drive's 403 quota/rate reasons: rateLimitExceeded, userRateLimitExceeded,
  // sharingRateLimitExceeded (all caught by "ratelimit"), quotaExceeded ("quota"),
  // and dailyLimitExceeded — which contains neither, so match "dailylimit" explicitly.
  return (
    reason.includes("ratelimit") ||
    reason.includes("quota") ||
    reason.includes("dailylimit") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("daily limit")
  );
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildDriveNameContainsQuery(query: string): string {
  // Split the query on whitespace and AND one `name contains` clause per token, so multi-word
  // queries match order-independently (".jpg mount" hits "mount-….jpg") instead of requiring the
  // whole query as one contiguous phrase. Each token still ORs its NFC/NFD normalization variants.
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  const clauses = (tokens.length > 0 ? tokens : [query]).map((token) => {
    const variants = uniqueSearchNormalizationVariants(token);
    if (variants.length === 1) {
      return `name contains '${escapeDriveQueryString(variants[0])}'`;
    }
    return `(${variants.map((variant) => `name contains '${escapeDriveQueryString(variant)}'`).join(" or ")})`;
  });
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" and ")})`;
}

function uniqueSearchNormalizationVariants(query: string): string[] {
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const variant of [query.normalize("NFC"), query.normalize("NFD")]) {
    if (!seen.has(variant)) {
      seen.add(variant);
      variants.push(variant);
    }
  }
  return variants;
}
