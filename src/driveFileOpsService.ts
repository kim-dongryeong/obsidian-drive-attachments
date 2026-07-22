import { requestUrl, type RequestUrlResponse } from "obsidian";
import { DriveAuthService } from "./driveAuthService";
import type { DriveBrowserItem } from "./driveMetadataService";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_COPY_FIELDS = "id,name,mimeType,iconLink,modifiedTime,size,webViewLink";

export class DriveFileOpsService {
  constructor(private readonly auth: DriveAuthService) {}

  async renameFile(fileId: string, name: string): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ name }),
      throw: false,
    });

    assertDriveWriteOk(response, "rename");
  }

  async setFolderColor(fileId: string, rgb: string | null): Promise<string | null> {
    const normalized = rgb === null ? null : rgb.trim().toUpperCase();
    if (normalized !== null && !/^#[0-9A-F]{6}$/.test(normalized)) {
      throw new Error("Choose a supported Google Drive folder color.");
    }

    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", "folderColorRgb");
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ folderColorRgb: normalized }),
      throw: false,
    });

    assertDriveWriteOk(response, "folder color");
    return parseAppliedFolderColor(response, normalized);
  }

  async setStarred(fileId: string, starred: boolean): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ starred }),
      throw: false,
    });

    assertDriveWriteOk(response, starred ? "star" : "unstar");
  }

  async trashFile(fileId: string): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ trashed: true }),
      throw: false,
    });

    assertDriveWriteOk(response, "trash");
  }

  async restoreFile(fileId: string): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ trashed: false }),
      throw: false,
    });

    assertDriveWriteOk(response, "restore");
  }

  async deleteForever(fileId: string): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    assertDriveWriteOk(response, "permanent delete");
  }

  async moveFile(fileId: string, addParentId: string, removeParentId: string): Promise<void> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("addParents", addParentId);
    url.searchParams.set("removeParents", removeParentId);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: "{}",
      throw: false,
    });

    assertDriveWriteOk(response, "move");
  }

  async copyFile(fileId: string, parentFolderId: string): Promise<DriveBrowserItem> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/copy`);
    url.searchParams.set("fields", DRIVE_COPY_FIELDS);
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ parents: [parentFolderId] }),
      throw: false,
    });

    assertDriveWriteOk(response, "copy");
    return parseDriveBrowserItemResponse(response, "copy");
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    assertDriveDownloadOk(response);
    return response.arrayBuffer;
  }
}

type DriveWriteOperation =
  | "rename"
  | "trash"
  | "restore"
  | "permanent delete"
  | "move"
  | "copy"
  | "folder color"
  | "star"
  | "unstar";

function assertDriveWriteOk(response: RequestUrlResponse, operation: DriveWriteOperation): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const { reason, message } = parseDriveError(response);
  const lowerReason = reason.toLowerCase();
  const lowerMessage = message.toLowerCase();

  if (response.status === 401) {
    throw new Error("Google Drive access expired. Reconnect in settings, then retry.");
  }

  if (response.status === 403 && isQuotaOrRateLimitError(lowerReason, lowerMessage)) {
    throw new Error("Google Drive is temporarily rate-limited or over quota. Wait a bit, then retry.");
  }

  if (response.status === 403) {
    throw new Error("Turn on Full Drive access in settings to modify files you didn't upload with this plugin.");
  }

  if (response.status === 404) {
    throw new Error("That Drive item no longer exists or is no longer visible to this plugin.");
  }

  throw new Error(`Google Drive ${operation} failed with HTTP ${response.status}. Retry in a moment; reconnect if it keeps failing.`);
}

function assertDriveDownloadOk(response: RequestUrlResponse): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const { reason, message } = parseDriveError(response);
  const lowerReason = reason.toLowerCase();
  const lowerMessage = message.toLowerCase();

  if (response.status === 401) {
    throw new Error("Google Drive access expired. Reconnect in settings, then retry.");
  }

  if (response.status === 403 && isQuotaOrRateLimitError(lowerReason, lowerMessage)) {
    throw new Error("Google Drive is temporarily rate-limited or over quota. Wait a bit, then retry.");
  }

  if (response.status === 403 && lowerReason.includes("filenotdownloadable")) {
    throw new Error("This Drive item cannot be downloaded as a raw file. Open it in Drive and export it instead.");
  }

  if (response.status === 403) {
    throw new Error("Reconnect Google Drive with read access, then retry downloading this file.");
  }

  if (response.status === 404) {
    throw new Error("That Drive item no longer exists or is no longer visible to this plugin.");
  }

  throw new Error(`Google Drive download failed with HTTP ${response.status}. Retry in a moment; reconnect if it keeps failing.`);
}

function parseDriveBrowserItemResponse(response: RequestUrlResponse, operation: DriveWriteOperation): DriveBrowserItem {
  if (!response.text) {
    throw new Error(`Google Drive ${operation} succeeded but returned no file metadata. Refresh the folder to see the result.`);
  }

  try {
    const parsed: unknown = JSON.parse(response.text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Response was not an object.");
    }

    const candidate = parsed as Partial<Record<keyof DriveBrowserItem, unknown>>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.mimeType !== "string"
    ) {
      throw new Error("Response was missing required fields.");
    }

    return {
      id: candidate.id,
      name: candidate.name,
      mimeType: candidate.mimeType,
      iconLink: optionalString(candidate.iconLink),
      modifiedTime: optionalString(candidate.modifiedTime),
      size: optionalString(candidate.size),
      webViewLink: optionalString(candidate.webViewLink),
    };
  } catch (error) {
    throw new Error(
      `Google Drive ${operation} succeeded but returned unreadable file metadata. Refresh the folder to see the result. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseAppliedFolderColor(response: RequestUrlResponse, requested: string | null): string | null {
  if (!response.text) {
    return requested;
  }

  try {
    const parsed: unknown = JSON.parse(response.text);
    if (!parsed || typeof parsed !== "object") {
      return requested;
    }
    const value = (parsed as { folderColorRgb?: unknown }).folderColorRgb;
    if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
      return value.trim().toUpperCase();
    }
    // Drive omits folderColorRgb after resetting to the default. If a successful response omits it
    // for a set operation too, retain the validated palette value the caller submitted.
    return requested;
  } catch {
    return requested;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseDriveError(response: RequestUrlResponse): { reason: string; message: string } {
  const body = parseDriveErrorBody(response);
  const firstError = body?.error?.errors?.[0];
  return {
    reason: firstError?.reason ?? "",
    message: firstError?.message ?? body?.error?.message ?? "",
  };
}

interface GoogleDriveErrorBody {
  error?: {
    message?: string;
    errors?: Array<{
      reason?: string;
      message?: string;
    }>;
  };
}

function parseDriveErrorBody(response: RequestUrlResponse): GoogleDriveErrorBody | null {
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
  return (
    reason.includes("ratelimit") ||
    reason.includes("quota") ||
    reason.includes("dailylimit") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("daily limit")
  );
}
