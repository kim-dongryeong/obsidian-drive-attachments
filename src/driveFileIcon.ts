import { setIcon } from "obsidian";
import { setTrustedSvg } from "./svgUtil";
import { bundledIconForFile } from "./iconThemes";
import type { IconTheme } from "./settings";

export type CustomFileIconResolver = (mimeType: string, name: string) => string | null;

// Render the file-type icon into `el`: user pack image first, then the selected trusted bundled
// theme, then Obsidian's Lucide default. The default theme deliberately skips bundled artwork.
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
        // Eager, not lazy: these are tiny local (data:/app://) icons. Lazy-loading makes a freshly
        // created <img> start blank and then load — which, when a list re-renders (e.g. the search
        // modal repainting every 300ms while the index streams), blinks the icons on every pass.
        loading: "eager",
        decoding: "sync",
      },
    });
    // A pack icon that was deleted (or is unreadable) would otherwise render as a broken-image glyph.
    // Fall back to the built-in icon on load failure - covers the gap before the folder watcher
    // refreshes the (now stale) in-memory pack.
    img.addEventListener("error", () => {
      el.empty();
      renderBuiltinFileIcon(el, mimeType, name, lucideFallback, iconTheme);
    });
    return;
  }

  renderBuiltinFileIcon(el, mimeType, name, lucideFallback, iconTheme);
}

// The non-custom-pack icon path: selected bundled theme, then a plain Lucide fallback.
function renderBuiltinFileIcon(
  el: HTMLElement,
  mimeType: string,
  name: string,
  lucideFallback: string,
  iconTheme: IconTheme,
): void {
  const themed = bundledIconForFile(iconTheme, mimeType, name);
  if (themed && setTrustedSvg(el, themed)) {
    return; // trusted generated SVG constants, never user pack contents
  }

  setIcon(el, lucideFallback);
}
