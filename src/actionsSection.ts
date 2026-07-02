// "## Actions" section for Drive-link notes — a `drive-actions` fenced block carrying the note's
// Drive file id, rendered by DriveNoteActionsService as a row of buttons (Open in Drive / Open folder
// / Delete file). The id is written into the body (not left empty) because Obsidian does not run a
// code-block processor for an empty fence. Mirrors the additive, never-duplicated upsert used by the
// preview block and the path log.

import { ACTIONS_LANG } from "./codeBlockLang";

export const ACTIONS_HEADING = "## Actions";
const ACTIONS_FENCE_OPEN = "```" + ACTIONS_LANG;
const ACTIONS_FENCE_CLOSE = "```";

function actionsFenceBody(driveId: string): string[] {
  return [ACTIONS_FENCE_OPEN, driveId, ACTIONS_FENCE_CLOSE];
}

export function formatActionsSection(driveId: string): string {
  return [ACTIONS_HEADING, "", ...actionsFenceBody(driveId)].join("\n");
}

// Add the "## Actions" + `drive-actions` block, or normalize the existing one in place — before
// `insertBeforeHeading` if given, else appended. Idempotent: re-running refreshes the id and never
// stacks duplicates, so re-linking a note repairs/keeps a single block.
export function upsertActionsSection(content: string, driveId: string, insertBeforeHeading?: string): string {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === ACTIONS_HEADING);

  if (headingIndex !== -1) {
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
          lines.splice(headingIndex + 1, end - headingIndex, "", ...actionsFenceBody(driveId));
          return lines.join("\n");
        }
      }
    }

    lines.splice(headingIndex + 1, 0, "", ...actionsFenceBody(driveId));
    return lines.join("\n");
  }

  const section = [ACTIONS_HEADING, "", ...actionsFenceBody(driveId)];

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
