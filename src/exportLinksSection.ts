// "Export links" body section for Google-native asset notes. Drive's exportLinks map
// (mimeType → download URL) used to be written into `drive_export_links` frontmatter, but a raw
// JSON object renders as an invalid Obsidian property (kdr: "잘못된 값") — so it now lives in the
// note body as a bulleted [format-label](url) list, replaced in place on metadata refresh.

export const EXPORT_LINKS_HEADING = "## Export links";

// Friendly labels for the export mimeTypes Google Docs/Sheets/Slides/Drawings offer. Drive spells
// the .ods export with the legacy "x-vnd" prefix, so both spellings are covered. Unknown types
// fall back to the raw mimeType, which still renders a usable link.
const EXPORT_FORMAT_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (.docx)",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel (.xlsx)",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint (.pptx)",
  "application/vnd.oasis.opendocument.text": "OpenDocument text (.odt)",
  "application/vnd.oasis.opendocument.spreadsheet": "OpenDocument spreadsheet (.ods)",
  "application/x-vnd.oasis.opendocument.spreadsheet": "OpenDocument spreadsheet (.ods)",
  "application/vnd.oasis.opendocument.presentation": "OpenDocument presentation (.odp)",
  "application/rtf": "Rich text (.rtf)",
  "application/zip": "Web page (.zip)",
  "application/epub+zip": "EPUB",
  "application/vnd.google-apps.script+json": "Apps Script (.json)",
  "text/plain": "Plain text (.txt)",
  "text/csv": "CSV",
  "text/tab-separated-values": "TSV",
  "text/html": "HTML",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/svg+xml": "SVG",
};

export function formatExportLinksSection(
  exportLinks: Record<string, string> | null | undefined,
): string | null {
  const bullets = formatExportLinkBullets(exportLinks);
  return bullets.length > 0 ? [EXPORT_LINKS_HEADING, "", ...bullets].join("\n") : null;
}

// Replace the section's bulleted list in place, or insert the whole section when missing —
// before `insertBeforeHeading` (the path log) if present, else appended at the end. Without
// export links the content is returned untouched: this section is additive like the path log,
// never a reason to delete body content.
export function upsertExportLinksSection(
  content: string,
  exportLinks: Record<string, string> | null | undefined,
  insertBeforeHeading?: string,
): string {
  const bullets = formatExportLinkBullets(exportLinks);
  if (bullets.length === 0) {
    return content;
  }

  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === EXPORT_LINKS_HEADING);

  if (headingIndex !== -1) {
    // Replace only the machine-generated part under the heading (blank lines and `- ` bullets);
    // any prose a user wrote below the list survives.
    let end = headingIndex + 1;
    while (end < lines.length && (lines[end].trim() === "" || lines[end].trim().startsWith("- "))) {
      end += 1;
    }
    lines.splice(headingIndex + 1, end - (headingIndex + 1), "", ...bullets, "");
    return lines.join("\n");
  }

  const section = [EXPORT_LINKS_HEADING, "", ...bullets];

  if (insertBeforeHeading) {
    const anchorIndex = lines.findIndex((line) => line.trim() === insertBeforeHeading);
    if (anchorIndex !== -1) {
      const before = lines.slice(0, anchorIndex);
      while (before.length > 0 && before[before.length - 1].trim() === "") {
        before.pop();
      }
      const prefix = before.length > 0 ? [...before, ""] : [];
      return [...prefix, ...section, "", ...lines.slice(anchorIndex)].join("\n");
    }
  }

  const trimmedEnd = content.replace(/\s+$/, "");
  const prefix = trimmedEnd.length > 0 ? `${trimmedEnd}\n\n` : "";
  return `${prefix}${section.join("\n")}\n`;
}

function formatExportLinkBullets(exportLinks: Record<string, string> | null | undefined): string[] {
  if (!exportLinks) {
    return [];
  }

  return Object.entries(exportLinks)
    .filter(([, url]) => typeof url === "string" && url.length > 0)
    .map(([mimeType, url]) => ({ label: EXPORT_FORMAT_LABELS[mimeType] ?? mimeType, url }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ label, url }) => `- [${label}](<${escapeLinkDestination(url)}>)`);
}

function escapeLinkDestination(value: string): string {
  return value.replace(/[\r\n]+/g, "").replace(/</g, "%3C").replace(/>/g, "%3E");
}
