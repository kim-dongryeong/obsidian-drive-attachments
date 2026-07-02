// Fenced code-block languages this plugin renders.
//
// We EMIT the namespaced (unique) languages so they can't collide with another plugin's generic
// `drive-preview` / `drive-actions` — `registerMarkdownCodeBlockProcessor` allows only ONE processor
// per language across all plugins (last one loaded wins), so a generic name is a real conflict risk.
//
// We still REGISTER and DETECT the legacy generic languages for READ-COMPAT, so notes written before
// the rename keep rendering. New inserts only ever use the namespaced language; re-inserting/normalizing
// an old block rewrites it to the new language.
export const PREVIEW_LANG = "drive-attachments-preview";
export const ACTIONS_LANG = "drive-attachments-actions";
const LEGACY_PREVIEW_LANG = "drive-preview";
const LEGACY_ACTIONS_LANG = "drive-actions";

// Accepted (registered + detected) languages — namespaced first, legacy second. All lowercase, so a
// `toLowerCase()`'d fence opener can be tested against them directly.
export const PREVIEW_LANGS = [PREVIEW_LANG, LEGACY_PREVIEW_LANG];
export const ACTIONS_LANGS = [ACTIONS_LANG, LEGACY_ACTIONS_LANG];
