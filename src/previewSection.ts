// "## Preview" body section for image Drive-link notes. When the setting is on and a newly
// created/re-inserted asset note points at an image, we drop a `drive-preview` fenced block under a
// "## Preview" heading carrying the note's Drive file id. The id is immutable (a Drive *rename*
// changes drive_name, never drive_id), so embedding it keeps rendering after a rename — and it is
// REQUIRED: Obsidian does not invoke a code-block processor for an empty fenced block, so a bodyless
// `drive-preview` block silently renders nothing. Mirrors the in-place section replacement used by the
// path log and export links (additive, never duplicated).

import { PREVIEW_LANG } from "./codeBlockLang";

export const PREVIEW_HEADING = "## Preview";
const PREVIEW_FENCE_OPEN = "```" + PREVIEW_LANG;
const PREVIEW_FENCE_CLOSE = "```";

// The preview is image-only by design (PDF/other previews are best-effort fallbacks, not something
// to auto-embed in every note). Drive returns a concrete `image/*` mimeType for raster/vector images.
export function isPreviewableImageMime(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

// Option lines (`width:` / `height:`) inside a fence body that should survive a normalize, so a
// re-insert after a drag-resize doesn't reset the user's preview size.
function isPreviewOptionLine(line: string): boolean {
  return /^(width|height)\s*:/i.test(line.trim());
}

// The fence body: the Drive id as the first line, then any preserved option lines.
function previewFenceBody(driveId: string, optionLines: string[] = []): string[] {
  return [PREVIEW_FENCE_OPEN, driveId, ...optionLines, PREVIEW_FENCE_CLOSE];
}

export function formatPreviewSection(driveId: string): string {
  return [PREVIEW_HEADING, "", ...previewFenceBody(driveId)].join("\n");
}

// Add the "## Preview" + `drive-preview` block, or normalize the existing one in place when the
// heading is already present — before `insertBeforeHeading` (the path log) if given, else appended.
// Idempotent: running it again leaves a well-formed block unchanged (id refreshed, width/height
// preserved), so re-inserting a link never stacks duplicate previews and repairs legacy empty blocks.
export function upsertPreviewSection(content: string, driveId: string, insertBeforeHeading?: string): string {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === PREVIEW_HEADING);

  if (headingIndex !== -1) {
    // The first non-blank line under the heading should open the fence; replace through its close.
    let fenceStart = -1;
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed === "") {
        continue;
      }
      if (trimmed.startsWith("```")) {
        fenceStart = i;
      }
      break;
    }

    if (fenceStart !== -1) {
      for (let end = fenceStart + 1; end < lines.length; end += 1) {
        if (lines[end].trim().startsWith("```")) {
          // Preserve any width/height options from the existing body across the rewrite.
          const optionLines = lines.slice(fenceStart + 1, end).filter((line) => isPreviewOptionLine(line));
          lines.splice(headingIndex + 1, end - headingIndex, "", ...previewFenceBody(driveId, optionLines));
          return lines.join("\n");
        }
      }
    }

    // Heading present but no usable fenced block — drop a fresh one in.
    lines.splice(headingIndex + 1, 0, "", ...previewFenceBody(driveId));
    return lines.join("\n");
  }

  const section = [PREVIEW_HEADING, "", ...previewFenceBody(driveId)];

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
