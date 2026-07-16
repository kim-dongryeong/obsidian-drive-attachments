// The Drive panel's location model: a breadcrumb segment ({id, name}), the My Drive root, and the
// panel-only virtual collection roots (Shared with me / Starred / Recent / Trash) with their helper
// predicates. Extracted from drivePanelView.ts (T-011 P4). Virtual ids deliberately cannot be
// mistaken for Drive file ids and must never be passed as upload parents or move sources.

export interface DrivePanelLocation {
  id: string;
  name: string;
}

export const MY_DRIVE_ROOT: DrivePanelLocation = { id: "root", name: "My Drive" };
// Virtual collection ids deliberately cannot be mistaken for Drive file ids. They are panel-only
// locations and must never be passed as upload parents or move sources.
export const SHARED_WITH_ME_ROOT: DrivePanelLocation = { id: "gdab:sharedwithme", name: "Shared with me" };
export const STARRED_ROOT: DrivePanelLocation = { id: "gdab:starred", name: "Starred" };
export const RECENT_ROOT: DrivePanelLocation = { id: "gdab:recent", name: "Recent" };
export const TRASH_ROOT: DrivePanelLocation = { id: "gdab:trash", name: "Trash" };
export const VIRTUAL_ROOT_IDS: ReadonlySet<string> = new Set([
  SHARED_WITH_ME_ROOT.id,
  STARRED_ROOT.id,
  RECENT_ROOT.id,
  TRASH_ROOT.id,
]);

// True for the panel-only collection roots (Shared with me / Starred / Recent / Trash), which are
// query-backed rather than real Drive folders and must never be passed as a parent id or move source.
export function isVirtualRootId(id: string | undefined): boolean {
  return id !== undefined && VIRTUAL_ROOT_IDS.has(id);
}

// Display name for a virtual collection id, used in read-only Notices and state copy.
export function virtualRootName(id: string | undefined): string {
  if (id === SHARED_WITH_ME_ROOT.id) {
    return "Shared with me";
  }
  if (id === RECENT_ROOT.id) {
    return "Recent";
  }
  if (id === STARRED_ROOT.id) {
    return "Starred";
  }
  if (id === TRASH_ROOT.id) {
    return "Trash";
  }
  return "This collection";
}

// drive.google.com-style glyph for each entry in the ROOT breadcrumb menu, shown as a TITLE PREFIX.
// MenuItem.setIcon() renders nothing in this menu (kdr saw no icons even after removing setChecked), so
// an emoji in the title is used instead — it always renders. My Drive / a shared drive / the virtual
// collections / Trash.
export function rootBreadcrumbGlyph(id: string): string {
  if (id === SHARED_WITH_ME_ROOT.id) {
    return "🤝";
  }
  if (id === RECENT_ROOT.id) {
    return "🕘";
  }
  if (id === STARRED_ROOT.id) {
    return "⭐";
  }
  if (id === TRASH_ROOT.id) {
    return "🗑️";
  }
  if (id === MY_DRIVE_ROOT.id) {
    return "🗂️";
  }
  return "👥"; // a shared (team) drive — a real Drive id, not a virtual collection
}
