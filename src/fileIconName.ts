import { ONEDRIVE_EXT_TO_ICON } from "./oneDriveIcons";

// Resolve the shared icon-pack name for a Drive item. Extensions follow the established OneDrive
// map; mime is the fallback for extensionless Drive-native files. Bundled themes and user packs both
// consume this classification so their coverage cannot drift apart.
export function fileIconName(mimeType: string, name: string): string | null {
  const mime = mimeType.toLowerCase();
  if (mime === "application/vnd.google-apps.folder") {
    return "folder";
  }

  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).trim().toLowerCase() : "";
  const mapped = ONEDRIVE_EXT_TO_ICON[ext];
  if (mapped) return mapped;

  if (!mime) return null;
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("google-apps.document") || mime.includes("wordprocessing") || mime.includes("msword")) return "docx";
  if (mime.includes("google-apps.spreadsheet")) return "spreadsheet";
  if (mime.includes("spreadsheet") || mime.includes("ms-excel") || mime.includes("excel")) return "xlsx";
  if (mime.includes("google-apps.presentation")) return "presentation";
  if (mime.includes("presentation") || mime.includes("powerpoint")) return "pptx";
  if (mime.includes("svg")) return "vector";
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("font/") || mime.includes("font-")) return "font";
  if (mime === "text/html" || mime.includes("xhtml")) return "html";
  if (mime === "text/csv") return "csv";
  if (mime.includes("xml")) return "xml";
  if (mime.includes("zip")) return "zip";
  if (mime.includes("tar") || mime.includes("gzip") || mime.includes("compressed") || mime.includes("x-7z") || mime.includes("x-rar")) return "archive";
  if (mime.includes("rfc822") || mime.startsWith("message/")) return "email";
  if (mime.includes("json") || mime.includes("javascript") || mime.includes("x-sh") || mime.includes("x-python")) return "code";
  if (mime === "text/plain") return "txt";
  return null;
}
