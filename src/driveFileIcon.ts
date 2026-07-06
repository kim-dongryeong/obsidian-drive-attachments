import { setIcon } from "obsidian";
import { bundledIconForFile } from "./iconThemes";
import type { IconTheme } from "./settings";

export type CustomFileIconResolver = (mimeType: string, name: string) => string | null;

// Branded file-type icons — the actual Google Drive / Microsoft product SVGs (PDF, Google Docs &
// Sheets, Microsoft Word, Excel & PowerPoint). Single source of truth so the preview card, search
// results, and the sidebar panel all render the same icon.
//
// PRE-PUBLISH (docs/roadmap.md → Pre-publish decisions): these are Google's / Microsoft's product
// icons (their IP). Replace with original artwork before shipping to the community store. Personal
// use only until then. (`<title>`/`class`/`mask-id` stripped from the originals; sizing is via CSS.)

// PDF — single-fill (driven by currentColor); tinted Google Drive red.
export const GOOGLE_PDF_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">' +
  '<path fill-rule="evenodd" clip-rule="evenodd" d="M1.778 0h12.444C15.2 0 16 .8 16 1.778v12.444C16 ' +
  "15.2 15.2 16 14.222 16H1.778C.8 16 0 15.2 0 14.222V1.778C0 .8.8 0 1.778 0zm2.666 7.556h-.888v-.89h" +
  ".888v.89zm1.334 0c0 .737-.596 1.333-1.334 1.333h-.888v1.778H2.222V5.333h2.222c.738 0 1.334.596 " +
  "1.334 1.334v.889zm6.666-.89h2.223V5.334H11.11v5.334h1.333V8.889h1.334V7.556h-1.334v-.89zm-2.222 " +
  "2.667c0 .738-.595 1.334-1.333 1.334H6.667V5.333h2.222c.738 0 1.333.596 1.333 1.334v2.666zm-1.333 " +
  '0H8V6.667h.889v2.666z"></path></svg>';

// PowerPoint — full color (fills baked in); the wrapper color is ignored.
export const POWERPOINT_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><g>' +
  '<path d="M5.5 15h9c.275 0 .5-.225.5-.5V5h-1.5c-.827 0-1.5-.673-1.5-1.5V1H5.5c-.275 0-.5.225-.5.5v13c0 .275.225.5.5.5z" fill="#fff"></path>' +
  '<path d="M15 4v-.086a.496.496 0 0 0-.146-.353L13 1.707V3.5c0 .275.225.5.5.5H15z" fill="#fff"></path>' +
  '<path opacity=".67" fill-rule="evenodd" clip-rule="evenodd" d="M15.56 2.853 13.146.44a1.51 1.51 0 0 0-1.06-.44H5.5C4.673 0 4 .673 4 1.5v13c0 .827.673 1.5 1.5 1.5h9c.827 0 1.5-.673 1.5-1.5V3.914c0-.4-.156-.777-.44-1.06v-.001zm-.707.708c.095.094.147.22.147.353V4h-1.5a.501.501 0 0 1-.5-.5V1.707l1.854 1.854h-.001zM5.5 15h9c.275 0 .5-.225.5-.5V5h-1.5c-.827 0-1.5-.673-1.5-1.5V1H5.5c-.275 0-.5.225-.5.5v13c0 .276.224.5.5.5z" fill="#605E5C"></path>' +
  '<path d="M12.95 9H11l-.5-1-.5 1v2.95A2.5 2.5 0 0 0 12.95 9z" fill="#ED6C47"></path>' +
  '<path d="M10.5 7c-.172 0-.338.021-.5.055V9h1V7.05a2.51 2.51 0 0 0-.5-.05z" fill="#FF8F6B"></path>' +
  '<path d="M12 8h2a2.567 2.567 0 0 0-2-2v2z" fill="#FFC7B5"></path>' +
  '<path d="M1 13h7a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H1a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1z" fill="#C43E1C"></path>' +
  '<path fill-rule="evenodd" clip-rule="evenodd" d="M5 6H4v1h1V6zm0 2H4v1h1V8z" fill="#fff"></path>' +
  '<path d="M3.5 11V6" stroke="#fff"></path>' +
  '<path d="M4.5 6.5H5c.382 0 .624.278.624.83 0 .54-.024 1.17-.507 1.17H4.5" stroke="#fff" stroke-linecap="round" stroke-linejoin="bevel"></path>' +
  '<path fill-rule="evenodd" clip-rule="evenodd" d="M5 7h.159v1h-.16V7z" fill="#fff"></path>' +
  "</g></svg>";

// Google Docs — single-fill (currentColor); Google blue.
export const GOOGLE_DOCS_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">' +
  '<path d="M14.222 0H1.778C.8 0 0 .8 0 1.778v12.444C0 15.2.8 16 1.778 16h12.444C15.2 16 16 15.2 ' +
  "16 14.222V1.778C16 .8 15.2 0 14.222 0zm-1.769 5.333H3.556V3.556h8.897v1.777zm0 3.556H3.556V7.11h8.897V8.89zm-2.666 " +
  '3.555H3.556v-1.777h6.23v1.777z"></path></svg>';

// Google Sheets — single-fill (currentColor); Google green.
export const GOOGLE_SHEETS_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">' +
  '<path d="M14.222 0H1.778C.8 0 .008.8.008 1.778L0 4.444v9.778C0 15.2.8 16 1.778 16h12.444C15.2 16 16 15.2 16 ' +
  '14.222V1.778C16 .8 15.2 0 14.222 0zm0 7.111h-7.11v7.111H5.332v-7.11H1.778V5.332h3.555V1.778h1.778v3.555h7.111v1.778z"></path></svg>';

// Microsoft Excel — full color (fills baked in); the wrapper color is ignored.
export const EXCEL_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><g>' +
  '<path d="M5.5 15h9c.275 0 .5-.225.5-.5V5h-1.5c-.827 0-1.5-.673-1.5-1.5V1H5.5c-.275 0-.5.225-.5.5v13c0 .275.225.5.5.5z" fill="#fff"></path>' +
  '<path d="M15 4v-.086a.496.496 0 0 0-.146-.353L13 1.707V3.5c0 .275.225.5.5.5H15z" fill="#fff"></path>' +
  '<path opacity=".67" fill-rule="evenodd" clip-rule="evenodd" d="M15.56 2.853 13.146.44a1.51 1.51 0 0 0-1.06-.44H5.5C4.673 0 4 .673 4 1.5v13c0 .827.673 1.5 1.5 1.5h9c.827 0 1.5-.673 1.5-1.5V3.914c0-.4-.156-.777-.44-1.06v-.001zm-.707.708c.095.094.147.22.147.353V4h-1.5a.501.501 0 0 1-.5-.5V1.707l1.854 1.854h-.001zM5.5 15h9c.275 0 .5-.225.5-.5V5h-1.5c-.827 0-1.5-.673-1.5-1.5V1H5.5c-.275 0-.5.225-.5.5v13c0 .276.224.5.5.5z" fill="#605E5C"></path>' +
  '<path d="M13.5 10h-3a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z" fill="#134A2C"></path>' +
  '<path d="M13.5 8h-3a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z" fill="#21A366"></path>' +
  '<path d="M13.5 6h-3a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z" fill="#33C481"></path>' +
  '<path d="M1 13h7a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H1a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1z" fill="#107C41"></path>' +
  '<path d="M5.413 11 2.766 6h.823l2.69 5h-.866z" fill="#fff"></path>' +
  '<path d="m3.632 11 2.647-5h-.823l-2.69 5h.866z" fill="#fff"></path>' +
  "</g></svg>";

// Microsoft Word — full color (fills baked in); the wrapper color is ignored.
export const WORD_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><g>' +
  '<path d="M5.5 15h9c.275 0 .5-.225.5-.5V5h-1.5c-.827 0-1.5-.673-1.5-1.5V1H5.5c-.275 0-.5.225-.5.5v13c0 .275.225.5.5.5z" fill="#fff"></path>' +
  '<path d="M15 4v-.086a.496.496 0 0 0-.146-.353L13 1.707V3.5c0 .275.225.5.5.5H15z" fill="#fff"></path>' +
  '<path opacity=".67" fill-rule="evenodd" clip-rule="evenodd" d="M15.56 2.853 13.146.44a1.51 1.51 0 0 0-1.06-.44H5.5C4.673 0 4 .673 4 1.5v13c0 .827.673 1.5 1.5 1.5h9c.827 0 1.5-.673 1.5-1.5V3.914c0-.4-.156-.777-.44-1.06v-.001zm-.707.708c.095.094.147.22.147.353V4h-1.5a.501.501 0 0 1-.5-.5V1.707l1.854 1.854h-.001zM5.5 15h9c.275 0 .5-.225.5-.5V5h-1.5c-.827 0-1.5-.673-1.5-1.5V1H5.5c-.275 0-.5.225-.5.5v13c0 .276.224.5.5.5z" fill="#605E5C"></path>' +
  '<path d="M13.5 10H10v1h3.5a.5.5 0 0 0 0-1z" fill="#185ABD"></path>' +
  '<path d="M13.5 8H10v1h3.5a.5.5 0 0 0 0-1z" fill="#2B7CD3"></path>' +
  '<path d="M13.5 6H10v1h3.5a.5.5 0 0 0 0-1z" fill="#41A5EE"></path>' +
  '<path d="M1 13h7a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H1a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1z" fill="#185ABD"></path>' +
  '<path d="M5.855 10.972h-.576l-.765-3.755-.82 3.773H3.22L2.006 6l.732.002.698 3.308L4.154 6h.706l.808 3.298.606-3.267.707.005-1.126 4.936z" fill="#fff"></path>' +
  "</g></svg>";

export interface BrandedFileIcon {
  svg: string;
  // For single-fill SVGs (PDF), the currentColor tint. Omitted for full-color SVGs (PowerPoint).
  color?: string;
}

// The branded SVG for a Drive file, or null when there's no branded icon (caller falls back to Lucide).
export function brandedFileIcon(mimeType: string, name: string): BrandedFileIcon | null {
  const mime = mimeType.toLowerCase();
  const ext = (name.includes(".") ? name.split(".").pop() ?? "" : "").toLowerCase();
  // PDF — Drive red.
  if (mime === "application/pdf" || ext === "pdf") {
    return { svg: GOOGLE_PDF_ICON, color: "rgb(234, 67, 53)" };
  }
  // Google native editors — single-fill, brand colors. (Exact mime match; these carry no extension.)
  if (mime === "application/vnd.google-apps.document") {
    return { svg: GOOGLE_DOCS_ICON, color: "rgb(66, 133, 244)" };
  }
  if (mime === "application/vnd.google-apps.spreadsheet") {
    return { svg: GOOGLE_SHEETS_ICON, color: "rgb(52, 168, 83)" };
  }
  // Microsoft Office — full-color icons. (Google Slides keeps its own yellow icon: its mime is
  // "…google-apps.presentation", which matches none of the substrings below.)
  if (mime.includes("wordprocessingml") || mime.includes("msword") || ["doc", "docx"].includes(ext)) {
    return { svg: WORD_ICON };
  }
  if (mime.includes("spreadsheetml") || mime.includes("ms-excel") || ["xls", "xlsx", "xlsm"].includes(ext)) {
    return { svg: EXCEL_ICON };
  }
  if (mime.includes("powerpoint") || mime.includes("presentationml") || ["ppt", "pptx"].includes(ext)) {
    return { svg: POWERPOINT_ICON };
  }
  return null;
}

// Render the file-type icon into `el`: user pack image first, then the selected trusted bundled
// theme, then today's branded/Lucide default. The default theme deliberately skips the new branch.
export function renderFileIcon(
  el: HTMLElement,
  mimeType: string,
  name: string,
  lucideFallback: string,
  customIconSrc?: CustomFileIconResolver,
  iconTheme: IconTheme = "default",
): void {
  const customSrc = customIconSrc?.(mimeType, name);
  if (customSrc) {
    el.empty();
    const img = el.createEl("img", {
      cls: "gdab-custom-file-icon-img",
      attr: {
        src: customSrc,
        alt: "",
        width: "16",
        height: "16",
        loading: "lazy",
      },
    });
    // A pack icon that was deleted (or is unreadable) would otherwise render as a broken-image glyph.
    // Fall back to the built-in icon on load failure — covers the gap before the folder watcher
    // refreshes the (now stale) in-memory pack.
    img.addEventListener("error", () => {
      el.empty();
      renderBuiltinFileIcon(el, mimeType, name, lucideFallback, iconTheme);
    });
    return;
  }

  renderBuiltinFileIcon(el, mimeType, name, lucideFallback, iconTheme);
}

// The non-custom-pack icon path: selected bundled theme → today's branded/Lucide default.
function renderBuiltinFileIcon(
  el: HTMLElement,
  mimeType: string,
  name: string,
  lucideFallback: string,
  iconTheme: IconTheme,
): void {
  const themed = bundledIconForFile(iconTheme, mimeType, name);
  if (themed) {
    el.innerHTML = themed; // trusted generated SVG constants, never user pack contents
    return;
  }

  const branded = brandedFileIcon(mimeType, name);
  if (branded) {
    el.innerHTML = branded.svg; // trusted constant SVG (our bundled assets), not user input
    if (branded.color) {
      el.style.color = branded.color;
    }
    return;
  }
  setIcon(el, lucideFallback);
}
