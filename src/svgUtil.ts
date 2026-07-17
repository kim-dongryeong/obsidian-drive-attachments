// Render a TRUSTED, plugin-authored SVG string into `el` as real DOM nodes — never via innerHTML.
//
// This is only ever called with the bundled icon-theme constants defined in this repo
// (iconThemes.ts); it is NEVER given user, icon-pack, or remote content, so there is no injection
// surface. DOMParser is used purely to satisfy Obsidian's review guideline that forbids assigning
// to innerHTML/outerHTML. Nodes are imported into the target's own document so the result is
// cross-window (popout) safe.
export function setTrustedSvg(el: HTMLElement, svg: string): boolean {
  el.empty();
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgEl = parsed.documentElement;
  if (!svgEl || svgEl.tagName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) {
    return false;
  }
  el.appendChild(el.ownerDocument.importNode(svgEl, true));
  return true;
}
