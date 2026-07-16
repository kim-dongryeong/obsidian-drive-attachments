// Drag-and-drop plumbing for the Drive panel: reading DataTransfer entries, walking dropped folder
// trees into a flat upload plan, junk-file filtering, and the progress/summary strings. Extracted
// from drivePanelView.ts (T-011 P3: behaviour-preserving move of the drop helpers).

import { formatCount } from "./drivePanelText";

export interface PanelDropUploadStats {
  uploaded: number;
  skippedDuplicates: number;
  skippedJunk: number;
  failed: number;
  failedNames: string[];
}

export interface FolderUploadPlan {
  // Files to upload, each tagged with its relative directory chain ([] = directly under the target).
  files: Array<{ file: File; dir: string[] }>;
  // Every directory path seen while walking — drives folder recreation (so empty folders appear too).
  dirs: string[][];
  skippedJunk: number;
}

// Synchronously turn a drop's items into FileSystemEntry handles via webkitGetAsEntry(). MUST run
// inside the drop handler before any await: the DataTransfer items are live only for that tick.
export function captureDropEntries(dataTransfer: DataTransfer | null): FileSystemEntry[] {
  if (!dataTransfer || !dataTransfer.items) {
    return [];
  }
  const entries: FileSystemEntry[] = [];
  for (let index = 0; index < dataTransfer.items.length; index += 1) {
    const item = dataTransfer.items[index];
    if (item.kind !== "file") {
      continue;
    }
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

export function isDirectoryEntry(entry: FileSystemEntry): boolean {
  return entry.isDirectory;
}

// Walk the captured entry tree (async — this is the part that runs after the synchronous capture)
// into a flat plan of files + directories, skipping OS junk files along the way.
export async function walkDropEntries(entries: FileSystemEntry[]): Promise<FolderUploadPlan> {
  const plan: FolderUploadPlan = { files: [], dirs: [], skippedJunk: 0 };
  for (const entry of entries) {
    await visitDropEntry(entry, [], plan);
  }
  return plan;
}

async function visitDropEntry(entry: FileSystemEntry, dir: string[], plan: FolderUploadPlan): Promise<void> {
  if (entry.isFile) {
    const file = await entryToFile(entry as FileSystemFileEntry);
    if (file.name.trim().length === 0) {
      return;
    }
    if (isJunkFileName(file.name)) {
      plan.skippedJunk += 1;
      return;
    }
    plan.files.push({ file, dir });
    return;
  }

  if (entry.isDirectory) {
    const childDir = [...dir, entry.name];
    plan.dirs.push(childDir);
    const children = await readAllDirectoryEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) {
      await visitDropEntry(child, childDir, plan);
    }
  }
}

export function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

// readEntries() is paginated: each call yields a batch (browsers cap it, often at 100) and an empty
// array signals the end. Loop until drained so large folders aren't silently truncated.
export function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

export function sortDirsByDepth(dirs: string[][]): string[][] {
  return [...dirs].sort((left, right) => left.length - right.length);
}

export function describePanelDropItems(
  entries: FileSystemEntry[],
  files: File[],
): Array<{ name: string; kind: "File" | "Folder" }> {
  if (entries.length > 0) {
    return entries
      .filter((entry) => entry.name.trim().length > 0)
      .map((entry) => ({ name: entry.name, kind: entry.isDirectory ? "Folder" : "File" }));
  }

  return files.map((file) => ({ name: file.name, kind: "File" }));
}

export function formatTreeUploadProgress(
  current: number,
  total: number,
  targetName: string,
  displayPath: string,
  foldersCreated: number,
  stats: PanelDropUploadStats,
): string {
  const status = [
    `${stats.uploaded} uploaded`,
    `${formatCount(foldersCreated, "folder")}`,
    `${stats.failed} failed`,
  ].join(", ");
  return `Uploading ${current}/${total} to ${targetName}: ${displayPath} (${status})`;
}

export function formatTreeUploadSummary(targetName: string, foldersCreated: number, stats: PanelDropUploadStats): string {
  const parts = [
    `${formatCount(stats.uploaded, "file")} uploaded to ${targetName}`,
    `${formatCount(foldersCreated, "folder")} created`,
  ];
  // OS sidecar files (.DS_Store / Thumbs.db) are skipped SILENTLY — drive.google.com never
  // mentions them either, and the note just confused kdr ("1 junk file?"). skippedJunk stays in
  // the stats for internal accounting only.
  if (stats.failed > 0) {
    const failedNames = stats.failedNames.slice(0, 3).join(", ");
    const extra = stats.failedNames.length > 3 ? `, +${stats.failedNames.length - 3} more` : "";
    parts.push(`${formatCount(stats.failed, "file")} failed (${failedNames}${extra})`);
  }
  return `Drive panel folder upload complete: ${parts.join("; ")}.`;
}

export function hasLocalFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }
  return Array.from(dataTransfer.types).includes("Files") || dataTransfer.files.length > 0;
}

export function extractPanelDropFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.files).filter((file) => file.name.trim().length > 0);
}

export function isJunkFileName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === ".ds_store" || normalized === "thumbs.db";
}

export function formatPanelUploadProgress(
  current: number,
  total: number,
  targetName: string,
  stats: PanelDropUploadStats,
  fileName?: string,
): string {
  const status = [
    `${stats.uploaded} uploaded`,
    `${stats.skippedDuplicates} duplicate`,
    `${stats.failed} failed`,
  ].join(", ");
  const activeFile = fileName ? `: ${fileName}` : "";
  return `Uploading ${current}/${total} to ${targetName}${activeFile} (${status})`;
}

export function formatPanelUploadSummary(targetName: string, stats: PanelDropUploadStats): string {
  const parts = [`${formatCount(stats.uploaded, "file")} uploaded to ${targetName}`];
  if (stats.skippedDuplicates > 0) {
    parts.push(`${formatCount(stats.skippedDuplicates, "duplicate")} skipped`);
  }
  // Junk sidecars (.DS_Store / Thumbs.db) skip silently — see formatTreeUploadSummary.
  if (stats.failed > 0) {
    const failedNames = stats.failedNames.slice(0, 3).join(", ");
    const extra = stats.failedNames.length > 3 ? `, +${stats.failedNames.length - 3} more` : "";
    parts.push(`${formatCount(stats.failed, "file")} failed (${failedNames}${extra})`);
  }
  return `Drive panel upload complete: ${parts.join("; ")}.`;
}
