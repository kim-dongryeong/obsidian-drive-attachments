import { FILE_EXTENSION_ICON_NAMES } from "./fileIconMap";

// Categories that Drive's own per-file mimeType decides unambiguously. Consulted BEFORE our
// extension table: the mimeType is Google's classification of the actual file, while the extension
// table is this plugin's guess — when both speak, Google wins (the ogg incident: our table said
// "video" while Drive correctly reported audio/ogg). Deliberately narrow: generic/ambiguous mimes
// (application/octet-stream, text/plain, application/x-…) return null so the extension table can
// still be MORE specific for them (.py under text/x-python stays "code", not a text icon).
export function mimeSpecificIconName(mimeType: string): string | null {
  const mime = mimeType.toLowerCase();
  if (!mime) return null;
  if (mime === "application/vnd.google-apps.folder") return "folder";
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
  return null;
}

// Resolve the shared icon-pack category for a Drive item. Order: Drive's own mimeType when it is
// specific (Google's judgment), then our extension table (the plugin's guess — fills in files whose
// mime is missing or generic), then the remaining loose mime heuristics. Bundled themes and user
// packs both consume this classification so their coverage cannot drift apart.
export function fileIconName(mimeType: string, name: string): string | null {
  const specific = mimeSpecificIconName(mimeType);
  if (specific) return specific;

  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).trim().toLowerCase() : "";
  const mapped = FILE_EXTENSION_ICON_NAMES[ext];
  if (mapped) return mapped;

  const mime = mimeType.toLowerCase();
  if (!mime) return null;
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
