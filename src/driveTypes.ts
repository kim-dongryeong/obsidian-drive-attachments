export const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

// Custom DataTransfer MIME carrying the full item descriptors for a panel drag-out. The panel stamps
// it at `dragstart`; the editor-drop handler reads it on drop and chooses the insert format from that
// event's modifiers. Separate from the panel-local move/copy marker, which carries IDs only.
export const DRIVE_PANEL_DRAG_MIME = "application/x-gdab-drive-note-items";

export interface DrivePickerItem {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
}

// Serialize the items needed to recreate Drive-link notes on drop. Items without a usable Drive link
// are dropped (they can't be linked); returns "" when nothing is serializable so the caller can skip
// stamping the MIME entirely.
export function serializeDrivePanelDragItems(items: ReadonlyArray<Partial<DrivePickerItem>>): string {
  const usable = items
    .filter(
      (item) =>
        isNonEmptyString(item.id) &&
        isNonEmptyString(item.name) &&
        isNonEmptyString(item.mimeType) &&
        isHttpUrl(item.webViewLink),
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      webViewLink: item.webViewLink,
    }));
  return usable.length > 0 ? JSON.stringify(usable) : "";
}

// Parse + validate a `DRIVE_PANEL_DRAG_MIME` payload. Defensive: any malformed JSON, non-array, or
// entry missing a valid id/name/mimeType/webViewLink yields a (possibly empty) clean list, never a
// throw — the drop handler must not crash on a hostile or stale dataTransfer.
export function parseDrivePanelDragItems(raw: string): DrivePickerItem[] {
  if (!isNonEmptyString(raw)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const items: DrivePickerItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (
      isNonEmptyString(candidate.id) &&
      isNonEmptyString(candidate.name) &&
      isNonEmptyString(candidate.mimeType) &&
      isNonEmptyString(candidate.webViewLink) &&
      isHttpUrl(candidate.webViewLink)
    ) {
      items.push({
        id: candidate.id,
        name: candidate.name,
        mimeType: candidate.mimeType,
        webViewLink: candidate.webViewLink,
      });
    }
  }
  return items;
}

export function assertValidDrivePickerItem(item: DrivePickerItem): void {
  if (!isNonEmptyString(item.id)) {
    throw new Error("Google Picker returned an item without a file ID.");
  }

  if (!isNonEmptyString(item.name)) {
    throw new Error("Google Picker returned an item without a name.");
  }

  if (!isNonEmptyString(item.mimeType)) {
    throw new Error("Google Picker returned an item without a MIME type.");
  }

  if (!isHttpUrl(item.webViewLink)) {
    throw new Error("Google Picker returned an item without a usable Drive link.");
  }
}

export function isDriveFolder(item: DrivePickerItem): boolean {
  return item.mimeType === DRIVE_FOLDER_MIME_TYPE;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: unknown): boolean {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
