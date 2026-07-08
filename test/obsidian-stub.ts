// Minimal stand-in for Obsidian's runtime exports, so unit tests can import source modules that
// reference the (Electron-only, non-installable) `obsidian` package. Only the symbols actually used
// by tested modules need to exist here — extend as the suite grows.

export class Editor {}

export function normalizePath(path: string): string {
  return path;
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export function setIcon(el: { setAttribute?: (name: string, value: string) => void; icon?: string }, icon: string): void {
  if (typeof el.setAttribute === "function") {
    el.setAttribute("data-icon", icon);
    return;
  }
  el.icon = icon;
}
