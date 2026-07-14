export type LinkFormat = "inline" | "asset-note";

// What happens when an image (e.g. a screenshot) is pasted into the editor. "vault" = leave
// Obsidian's default untouched (saved into the attachments folder); "ask" = the same Save/Upload
// modal as a drop; "drive" = upload to Drive straight away with no prompt.
export type PastedImageDestination = "vault" | "ask" | "drive";

export function isPastedImageDestination(value: string): value is PastedImageDestination {
  return value === "vault" || value === "ask" || value === "drive";
}

// How local files/folders dropped onto the Drive sidebar panel are handled. "confirm" is the
// safer default because the target is a Drive folder, not the current note.
export type PanelDropUploadMode = "off" | "direct" | "confirm";

export function isPanelDropUploadMode(value: string): value is PanelDropUploadMode {
  return value === "off" || value === "direct" || value === "confirm";
}

export type PanelRowClickAction = "preview" | "select" | "open";

export function isPanelRowClickAction(value: string): value is PanelRowClickAction {
  return value === "preview" || value === "select" || value === "open";
}

export type PanelOpenFolderAction = "single" | "double";

export function isPanelOpenFolderAction(value: string): value is PanelOpenFolderAction {
  return value === "single" || value === "double";
}

// What dragging a Drive panel row (or selection) OUT onto a note editor inserts. "link" = an inline
// Markdown link, "embed" = a `drive-preview` block for files (folders fall back to a link), "note" =
// a wikilink to the Drive *asset note* (created on drop), "off" = drag-out disabled (in-panel
// move/copy still works). The configured mode supplies the text/plain fallback for non-editor drops;
// the editor-drop handler reads a JSON item payload and lets Cmd/Ctrl, Option/Alt, or Shift override
// that default at drop time. "note" is async because it creates a vault asset note.
export type PanelDragOutMode = "link" | "embed" | "note" | "off";

// Sort keys, Google-Drive-led. The first four mirror drive.google.com's "Sort by" menu
// (Name · Date modified · Date modified by me · Date opened by me); Size/Type stay as extras.
export type PanelSortKey = "name" | "modified" | "modifiedByMe" | "viewedByMe" | "size" | "type";
export type PanelSortDir = "asc" | "desc";
export type PanelViewMode = "list" | "compact" | "grid";
export type PanelTheme =
  | "default" | "notion" | "drive" | "macos" | "luxe" | "editorial"
  | "dracula" | "nord" | "tokyonight" | "gruvbox" | "solarized" | "catppuccin";
export type IconTheme = "default" | "flat" | "line" | "duo" | "refined" | "noir" | "bold" | "pastel" | "terminal";

export const PANEL_THEME_OPTIONS: ReadonlyArray<{ value: PanelTheme; label: string }> = [
  { value: "default", label: "Obsidian (default)" },
  { value: "notion", label: "Notion" },
  { value: "drive", label: "Google Drive" },
  { value: "macos", label: "macOS" },
  { value: "luxe", label: "Luxe" },
  { value: "editorial", label: "Editorial" },
  { value: "dracula", label: "Dracula" },
  { value: "nord", label: "Nord" },
  { value: "tokyonight", label: "Tokyo Night" },
  { value: "gruvbox", label: "Gruvbox" },
  { value: "solarized", label: "Solarized" },
  { value: "catppuccin", label: "Catppuccin" },
];

export function isPanelTheme(value: string): value is PanelTheme {
  return PANEL_THEME_OPTIONS.some((option) => option.value === value);
}

export const ICON_THEME_OPTIONS: ReadonlyArray<{ value: IconTheme; label: string }> = [
  { value: "default", label: "Default" },
  { value: "flat", label: "Flat color" },
  { value: "line", label: "Line" },
  { value: "duo", label: "Duotone" },
  { value: "refined", label: "Refined" },
  { value: "noir", label: "Noir (ink + gold)" },
  { value: "bold", label: "Bold" },
  { value: "pastel", label: "Pastel" },
  { value: "terminal", label: "Terminal" },
];

export function isIconTheme(value: string): value is IconTheme {
  return ICON_THEME_OPTIONS.some((option) => option.value === value);
}

export function isPanelDragOutMode(value: string): value is PanelDragOutMode {
  return value === "link" || value === "embed" || value === "note" || value === "off";
}

// Layout of the hover action toolbar on an embed. "icons" = all five action icons in a row;
// "menu" = a delete icon plus a "more" (…) icon whose menu holds the other four. A/B-testable.
export type EmbedActionToolbarStyle = "icons" | "menu";

export function isEmbedActionToolbarStyle(value: string): value is EmbedActionToolbarStyle {
  return value === "icons" || value === "menu";
}


// Where newly created Drive-link (asset) notes are placed — mirrors Obsidian's own
// "Default location for new attachments" options (kdr's M7 ask).
export type AssetNoteLocation = "vault-root" | "current-folder" | "subfolder" | "specified-folder";

export function isAssetNoteLocation(value: string): value is AssetNoteLocation {
  return value === "vault-root" || value === "current-folder" || value === "subfolder" || value === "specified-folder";
}

// Shared between the settings default and the InsertService fallback for templates missing {{name}}.
export const DEFAULT_ASSET_NOTE_NAME_TEMPLATE = "Drive - {{name}}";
export const DEFAULT_ASSET_NOTE_EXTRA_FRONTMATTER = "";
export const ASSET_NOTE_EXTRA_FRONTMATTER_EXAMPLE = 'categories:\n  - "[[Drive-link note]]"\ntags:\n  - drive';

// Placeholder defaults (Obsidian convention): the stored setting stays "" so the input shows the
// greyed placeholder, and an empty value means these defaults are actually used (kdr's M7.1 ask).
// Shared between the settings-tab placeholders and the InsertService folder resolution.
export const DEFAULT_ASSET_NOTE_SUBFOLDER_NAME = "Drive links";
export const DEFAULT_ASSET_NOTE_FOLDER_PATH = "Attachments/Drive links";
// Same convention for the custom icon pack: empty field → this folder is actually used (icons found
// there override the theme per-icon; missing ones fall back to it), matching Obsidian's own
// "attachment folder path" behaviour where the greyed placeholder is the effective default.
export const DEFAULT_CUSTOM_ICON_PACK_FOLDER = ".obsidian/icon pack";

export interface GoogleDriveAttachmentBridgeSettings {
  clientId: string;
  clientSecret: string;
  // Always null on save since the access token became memory-only (DriveAuthService.cachedAccessToken);
  // the field remains so a token persisted by an older version can seed the cache once, then be scrubbed.
  accessToken: string | null;
  refreshToken: string | null;
  encryptedRefreshToken: string | null;
  refreshTokenStorage: "safeStorage" | "plain";
  tokenExpiry: number | null;
  grantedScopes: string[];
  accountEmail: string | null;
  linkFormat: LinkFormat;
  assetNoteLocation: AssetNoteLocation;
  assetNoteSubfolderName: string;
  assetNoteFolderPath: string;
  assetNoteNameTemplate: string;
  assetNoteExtraFrontmatter: string;
  // Stamp a write-once `drive_origin: uploaded | linked` property on each NEW Drive-link note, so
  // notes born from an Obsidian upload (drop/paste/upload command/migrate) are distinguishable from
  // ones created by linking a file that already existed in Drive (picker/search). Unlike the `drive_*`
  // metadata keys it is set once at creation and NOT rewritten by a metadata refresh (provenance is a
  // creation-time fact Drive can't report). Asset-note mode only.
  recordDriveOrigin: boolean;
  addPreviewBlockToNewNotes: boolean;
  // Add an "## Actions" block (Open in Drive / Open folder / Delete file buttons) to new Drive-link
  // notes, and onto existing ones when re-linked. Applies to all file types, not just images.
  addActionsBlockToNewNotes: boolean;
  // In the actions block, also list every other note in the vault that embeds this Drive file —
  // "manual backlinks" for embeds, which Obsidian's own backlinks miss (rendered code blocks aren't
  // tracked links). Costs a vault scan when the note renders; turn off on very large vaults.
  showEmbedBacklinks: boolean;
  // Vault slimming (M11): when migrating a note's local attachments to Drive, also remove the local
  // copy. Default OFF — relink-only — and deletion (when on) goes to the recoverable trash, never a
  // hard unlink, and only after a fully successful per-file migration. See the M11 safety doctrine.
  deleteLocalAfterMigrate: boolean;
  enableDriveSearch: boolean;
  enablePathSearch: boolean;
  enableTypeIcons: boolean;
  customIconPackFolder: string;
  customIconSize: number;
  // Bundled file-type artwork used in search, panel, and preview cards. A configured user icon
  // folder still wins for any icon it provides; "default" uses Obsidian's Lucide icons.
  iconTheme: IconTheme;
  showServerOnlySearchCommand: boolean;
  // Advanced: request the full `drive` OAuth scope on connect so deletion (and edits) reach files the
  // app did NOT upload — i.e. items picked/searched from the user's existing Drive. Default OFF keeps
  // the minimal drive.file scope. Takes effect on the next reconnect, and the user must also allow the
  // scope on their own Google Cloud consent screen. Full Drive = read/write/delete the entire Drive.
  enableFullDriveAccess: boolean;
  // Routing for pasted images (screenshots etc.). Default "vault" keeps Obsidian's behavior exactly.
  pastedImageDestination: PastedImageDestination;
  // Routing for local files/folders dropped onto the Drive sidebar panel. Drops target the panel's
  // current Drive folder, not the default upload folder used by editor drops/pastes.
  panelDropUpload: PanelDropUploadMode;
  // File-manager A/B controls for kdr: the default is Finder-like selection, but the older preview
  // behavior and a direct-open mode stay available while the panel interaction model settles.
  panelRowClick: PanelRowClickAction;
  panelOpenFolder: PanelOpenFolderAction;
  // P4 organize: what a Drive row dragged OUT of the panel and dropped on a note editor inserts
  // (inline link / drive-preview embed / off). Distinct from the in-panel folder-row drop (move/copy).
  panelDragOut: PanelDragOutMode;
  // P4 details: a read-only details bar pinned to the bottom of the Drive panel summarizing the
  // current selection (name, type, size, modified, location; aggregate for multi-select). The
  // bottom-bar placement is the first of three planned options — a side pane and a popover are
  // still TODO, at which point this boolean becomes a placement enum.
  panelDetailBar: boolean;
  // P2 sort: order the current folder's listing (applied live on top of the fetched list, no refetch).
  // Folders-first keeps directories grouped above files regardless of direction (Finder-like).
  panelSortKey: PanelSortKey;
  panelSortDir: PanelSortDir;
  panelFoldersFirst: boolean;
  // P2 view mode: list (default) / compact (denser, no meta line) / grid (centered icon cards).
  panelViewMode: PanelViewMode;
  // Visual skin for the Drive panel. Themes are applied by one root class and remain CSS-only;
  // "default" preserves the existing Obsidian-native appearance.
  panelTheme: PanelTheme;
  // P5 polish: color-code panel row icons by file type (folders gold, images teal, video red, audio
  // amber, PDF/Docs/Sheets accents...), mirroring the search results + drive.google.com. Off falls
  // back to a uniform muted icon. Thumbnail/custom icons and a folder's own Drive color always win.
  panelTypeIconAccents: boolean;
  // Ways an embedded Drive image offers a path into its Drive-link (metadata) note — each toggled
  // independently, so they can be combined or all turned off. Photo stays clean either way.
  imageEmbedNoteHoverIcon: boolean;
  imageEmbedNoteModifierClick: boolean;
  imageEmbedNoteHoverCaption: boolean;
  // When the hover toolbar is on, how to lay out the five actions (open note / convert / delete /
  // open in Drive / open folder): all icons, or delete + a "more" menu. A/B for kdr.
  embedActionToolbarStyle: EmbedActionToolbarStyle;
  // Max pages (×1000 items, though Drive often returns fewer per page) the in-memory index crawls,
  // newest-modified first. Higher = older files get indexed (so path search can find them) but the
  // index takes longer to build. A small Drive finishes before the cap regardless.
  indexPageLimit: number;
  pickerApiKey: string;
  pickerAppId: string;
  defaultUploadFolderId: string;
  defaultUploadFolderName: string;
}

export const DEFAULT_SETTINGS: GoogleDriveAttachmentBridgeSettings = {
  clientId: "",
  clientSecret: "",
  accessToken: null,
  refreshToken: null,
  encryptedRefreshToken: null,
  refreshTokenStorage: "plain",
  tokenExpiry: null,
  grantedScopes: [],
  accountEmail: null,
  linkFormat: "asset-note",
  assetNoteLocation: "specified-folder",
  assetNoteSubfolderName: "",
  assetNoteFolderPath: "",
  assetNoteNameTemplate: DEFAULT_ASSET_NOTE_NAME_TEMPLATE,
  assetNoteExtraFrontmatter: DEFAULT_ASSET_NOTE_EXTRA_FRONTMATTER,
  recordDriveOrigin: true,
  addPreviewBlockToNewNotes: true,
  addActionsBlockToNewNotes: true,
  showEmbedBacklinks: true,
  deleteLocalAfterMigrate: false,
  enableDriveSearch: true,
  enablePathSearch: true,
  enableTypeIcons: true,
  customIconPackFolder: "",
  customIconSize: 20,
  iconTheme: "default",
  showServerOnlySearchCommand: false,
  enableFullDriveAccess: false,
  pastedImageDestination: "ask",
  panelDropUpload: "confirm",
  panelRowClick: "select",
  panelOpenFolder: "double",
  panelDragOut: "embed",
  panelDetailBar: true,
  panelSortKey: "name",
  panelSortDir: "asc",
  panelFoldersFirst: true,
  panelViewMode: "list",
  panelTheme: "default",
  panelTypeIconAccents: true,
  imageEmbedNoteHoverIcon: true,
  imageEmbedNoteModifierClick: false,
  imageEmbedNoteHoverCaption: false,
  embedActionToolbarStyle: "icons",
  indexPageLimit: 150,
  pickerApiKey: "",
  pickerAppId: "",
  defaultUploadFolderId: "",
  defaultUploadFolderName: "",
};
