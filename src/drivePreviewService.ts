import { App, arrayBufferToBase64, MarkdownPostProcessorContext, MarkdownView, Menu, Notice, requestUrl, setIcon, TFile } from "obsidian";
import { DriveAuthService } from "./driveAuthService";
import { DriveMediaProxyService } from "./driveMediaProxyService";
import { DriveMetadata, DriveMetadataService } from "./driveMetadataService";
import { brandedFileIcon, type CustomFileIconResolver } from "./driveFileIcon";
import { bundledIconForFile } from "./iconThemes";
import { DriveNoteActionsService } from "./driveNoteActionsService";
import { DrivePickerItem } from "./driveTypes";
import { PREVIEW_LANGS } from "./codeBlockLang";
import { InsertService } from "./insertService";
import { GoogleDriveAttachmentBridgeSettings } from "./settings";

interface EmbedAction {
  icon: string;
  label: string;
  warning?: boolean;
  // Rotate the rendered SVG 90° — used to turn the reliably-rendering horizontal ellipsis into a
  // vertical kebab without depending on the "more-vertical"/"ellipsis-vertical" icon-name (which
  // varies across Obsidian's bundled Lucide versions and on some renders the wrong way).
  rotate?: boolean;
  run: (event: MouseEvent) => void;
}

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
// Parse a drive-preview fence body: the first non-option line is the explicit Drive file id (optional —
// it falls back to the host note's drive_id frontmatter), and `width:` / `height:` lines size the
// preview. So a block can be just an id, just options (id from frontmatter), or both.
function parsePreviewBlock(source: string): { id: string; width?: number; height?: number; caption: boolean } {
  let id = "";
  let width: number | undefined;
  let height: number | undefined;
  let caption = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const widthMatch = line.match(/^width\s*:\s*(\d+)\s*(?:px)?$/i);
    if (widthMatch) {
      const value = Number(widthMatch[1]);
      if (Number.isFinite(value) && value > 0) {
        width = value;
      }
      continue;
    }
    const heightMatch = line.match(/^height\s*:\s*(\d+)\s*(?:px)?$/i);
    if (heightMatch) {
      const value = Number(heightMatch[1]);
      if (Number.isFinite(value) && value > 0) {
        height = value;
      }
      continue;
    }
    // `caption:` directive — "view mode 2": show a type-icon + filename label under the media.
    const captionMatch = line.match(/^caption\s*:\s*(\w+)?$/i);
    if (captionMatch) {
      caption = !/^(off|false|no|0)$/i.test(captionMatch[1] ?? "on");
      continue;
    }
    if (!id) {
      id = line;
    }
  }
  return { id, width, height, caption };
}

// Rewrite (or insert) size lines inside one drive-preview fence, identified by the section's line
// range from ctx.getSectionInfo. Guards against stale offsets — if the start line isn't a drive-preview
// fence, the text is returned untouched so unrelated content is never corrupted.
function rewriteFenceSize(
  text: string,
  lineStart: number,
  lineEnd: number,
  size: { width: number; height?: number },
): string {
  const lines = text.split("\n");
  if (lineStart < 0 || lineEnd >= lines.length || lineStart >= lineEnd) {
    return text;
  }
  const opener = lines[lineStart].trimStart().toLowerCase();
  if (!PREVIEW_LANGS.some((lang) => opener.startsWith("```" + lang))) {
    return text;
  }
  if (size.height !== undefined) {
    rewriteFenceNumberOption(lines, lineStart, lineEnd, "height", size.height);
  }
  rewriteFenceNumberOption(lines, lineStart, lineEnd, "width", size.width);
  return lines.join("\n");
}

// Chromium (Obsidian's renderer) can't decode HEIC/HEIF — an <img> just fails — so treat those as
// non-inline and fall back to the Drive-rendered thumbnail (a JPEG) instead of a broken image.
function isBrowserDecodableImage(mimeType: string): boolean {
  return mimeType.startsWith("image/") && !/^image\/hei[cf]/i.test(mimeType);
}

const MAX_INLINE_BYTES = 25 * 1024 * 1024;
// Cap the inline-preview data-URL cache (~96 MiB) so a long browsing session with many large
// images/PDFs can't grow the heap unbounded; oldest entries are evicted first.
const MAX_CACHE_BYTES = 96 * 1024 * 1024;
// PDF previews go through blob URLs (better memory than a base64 data URL). Video uses the loopback
// Range proxy so every video can stream/seek without a whole-file buffer.
const PDF_MAX_BYTES = 50 * 1024 * 1024;
const MIN_PREVIEW_WIDTH = 120;
const MIN_PREVIEW_HEIGHT = 160;
// Keep a few PDF blob URLs alive so a re-render (e.g. after a resize rewrites the note) reuses them
// instead of re-downloading; evict oldest beyond this. Small because each holds a whole file.
const MAX_BLOB_ENTRIES = 6;

interface PreviewFrontmatter {
  drive_id?: unknown;
  drive_mime_type?: unknown;
  drive_size?: unknown;
  drive_name?: unknown;
  drive_web_view_link?: unknown;
  drive_thumbnail_link?: unknown;
  drive_trashed?: unknown;
  drive_deleted?: unknown;
}

interface PreviewTarget {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  webViewLink: string | null;
  thumbnailLink: string | null;
}

export class DrivePreviewService {
  private readonly dataUrlCache = new Map<string, string>();
  private cacheBytes = 0;
  private readonly targetCache = new Map<string, PreviewTarget>();
  // Blob URLs minted for PDF previews. Revoked en masse on plugin unload (session-bounded) —
  // we don't revoke per-render because a blob may still back a visible iframe/playing video.
  private readonly blobUrls = new Set<string>();
  // Reuse a blob URL across re-renders of the same file (keyed by id:mime), capped at MAX_BLOB_ENTRIES.
  private readonly blobUrlByKey = new Map<string, string>();

  constructor(
    private readonly app: App,
    private readonly auth: DriveAuthService,
    private readonly metadata: DriveMetadataService,
    private readonly mediaProxy: DriveMediaProxyService,
    private readonly insert: InsertService,
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
    private readonly getNoteActions: () => DriveNoteActionsService,
    private readonly customIconSrc?: CustomFileIconResolver,
  ) {}

  // Called from the plugin's onunload to release blob URLs (and let the byte buffers be GC'd).
  dispose(): void {
    for (const url of this.blobUrls) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();
    this.blobUrlByKey.clear();
    this.dataUrlCache.clear();
    this.targetCache.clear();
    this.cacheBytes = 0;
    this.mediaProxy.dispose();
  }

  // Drop everything cached for one Drive file so the next render re-fetches instead of showing stale
  // bytes — used after the file is deleted from Drive. A permanently-deleted file then falls back to
  // the "unavailable" card; a trashed one (still downloadable ~30 days) re-renders with a badge.
  invalidate(driveId: string): void {
    const dataUrl = this.dataUrlCache.get(driveId);
    if (dataUrl !== undefined) {
      this.dataUrlCache.delete(driveId);
      this.cacheBytes = Math.max(0, this.cacheBytes - dataUrl.length);
    }
    this.targetCache.delete(driveId);
    for (const [key, url] of [...this.blobUrlByKey.entries()]) {
      if (key.startsWith(`${driveId}:`)) {
        URL.revokeObjectURL(url);
        this.blobUrls.delete(url);
        this.blobUrlByKey.delete(key);
      }
    }
    this.mediaProxy.invalidate(driveId);
  }

  async render(source: string, el: HTMLElement, ctx?: MarkdownPostProcessorContext): Promise<void> {
    el.empty();
    el.addClass("gdab-drive-preview");
    el.removeClass("gdab-drive-preview-has-media");

    // The fence body is an optional explicit id plus optional options (e.g. `width: 600`). A width
    // caps the rendered preview via a CSS var; without one the stylesheet default (480px) applies.
    const { id, width, height } = parsePreviewBlock(source);
    if (width !== undefined) {
      el.style.setProperty("--gdab-preview-max-width", `${width}px`);
    } else {
      el.style.removeProperty("--gdab-preview-max-width");
    }
    if (height !== undefined) {
      el.style.setProperty("--gdab-preview-height", `${height}px`);
    } else {
      el.style.removeProperty("--gdab-preview-height");
    }

    const syncTarget = this.resolveTargetFromCache(id, ctx);
    if (syncTarget && this.renderCachedMedia(syncTarget, el, ctx)) {
      return;
    }

    el.createDiv({ cls: "gdab-drive-preview-status", text: "Loading Drive preview..." });

    // Only target *resolution* (id lookup / metadata fetch) can leave us with nothing to show.
    // Keep that in its own try so a lookup failure shows the "how to use it" card.
    let resolved: PreviewTarget | null;
    try {
      resolved = await this.resolveTarget(id, ctx);
    } catch (error) {
      console.warn("[Drive Attachments] Drive preview target lookup failed.", error);
      el.empty();
      this.renderCard(el, {
        title: "Drive preview unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
      // Even when the file is gone from Drive (e.g. permanently deleted → 404), its Drive-link note may
      // still exist — surface a link so the note (and its metadata) is reachable.
      this.appendAssetNoteLink(el, this.resolveEffectiveId(id, ctx));
      return;
    }

    if (!resolved) {
      el.empty();
      this.renderCard(el, {
        title: "Drive preview unavailable",
        detail: "Add a Drive file id to the code block, or use it in a Drive-link note with drive_id frontmatter.",
      });
      this.appendAssetNoteLink(el, this.resolveEffectiveId(id, ctx));
      return;
    }

    // Once a target resolves, EVERY failure below routes through the fallback ladder
    // (thumbnail → "Open in Drive" card) so the reading view never shows a bare error string and
    // the file is always reachable — non-image, oversized, fetch failure, or render failure alike.
    const target = resolved;
    this.targetCache.set(target.id, target);

    if (target.mimeType === "application/pdf") {
      await this.renderPdf(target, el, ctx);
      return;
    }

    if (target.mimeType.startsWith("video/")) {
      await this.renderVideo(target, el, ctx);
      return;
    }

    if (!isBrowserDecodableImage(target.mimeType)) {
      // No detail line — the type icon + filename + actions speak for themselves (HEIC shows a Drive
      // thumbnail, others a card). Saying "no inline preview" is obvious noise.
      await this.renderFallback(el, target, "", ctx);
      return;
    }

    if (target.size !== null && target.size > MAX_INLINE_BYTES) {
      await this.renderFallback(el, target, `Image is too large to preview inline (${formatBytes(target.size)}).`, ctx);
      return;
    }

    try {
      const dataUrl = await this.getMediaDataUrl(target, "Image");
      el.empty();
      const image = this.renderImageFrame(el, target, dataUrl, ctx);
      image.onerror = () => {
        void this.renderFallback(el, target, "Image preview failed to render.", ctx);
      };
    } catch (error) {
      // Auth error, HTTP 4xx/5xx, network failure, or an oversized file whose size we couldn't
      // know up front: fall back to thumbnail + "Open in Drive" rather than a dead-end error.
      console.warn("[Drive Attachments] Drive image fetch failed; using fallback.", error);
      await this.renderFallback(el, target, error instanceof Error ? error.message : String(error), ctx);
    }
  }

  // Render a Drive file's media BARE (no frame/handle/card chrome) into `host` for the Quick-preview
  // lightbox, reusing the same resolve + cached-fetch path as the inline preview (so a lightbox after
  // an embed — or vice versa — is instant). Returns the media element (img/iframe/video) so the caller
  // can wire zoom, or null when it fell back to a card.
  async renderLightbox(id: string, host: HTMLElement): Promise<HTMLElement | null> {
    let target: PreviewTarget | null;
    try {
      target = await this.resolveTarget(id);
    } catch (error) {
      this.renderCard(host, {
        title: "Drive preview unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!target) {
      this.renderCard(host, {
        title: "Drive preview unavailable",
        detail: "This Drive item could not be resolved.",
      });
      return null;
    }
    this.targetCache.set(target.id, target);

    try {
      if (isBrowserDecodableImage(target.mimeType)) {
        if (target.size !== null && target.size > MAX_INLINE_BYTES) {
          await this.renderFallback(host, target, `Image is too large to preview inline (${formatBytes(target.size)}).`);
          return null;
        }
        const dataUrl = await this.getMediaDataUrl(target, "Image");
        return host.createEl("img", { cls: "gdab-lightbox-image", attr: { src: dataUrl, alt: target.name } });
      }

      if (target.mimeType === "application/pdf") {
        if (target.size !== null && target.size > PDF_MAX_BYTES) {
          await this.renderFallback(host, target, `PDF is too large to preview inline (${formatBytes(target.size)}).`);
          return null;
        }
        const blobUrl = await this.getMediaBlobUrl(target, "PDF", PDF_MAX_BYTES, "application/pdf");
        return host.createEl("iframe", { cls: "gdab-lightbox-pdf", attr: { src: blobUrl, title: target.name } });
      }

      if (target.mimeType.startsWith("video/")) {
        const videoUrl = await this.mediaProxy.getMediaUrl({ id: target.id, mimeType: target.mimeType });
        return host.createEl("video", {
          cls: "gdab-lightbox-video",
          attr: { src: videoUrl, controls: "", preload: "metadata" },
        });
      }

      await this.renderFallback(host, target, "");
      return null;
    } catch (error) {
      console.warn("[Drive Attachments] Drive lightbox fetch failed; using fallback.", error);
      await this.renderFallback(host, target, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async renderPdf(target: PreviewTarget, el: HTMLElement, ctx?: MarkdownPostProcessorContext): Promise<void> {
    if (target.size !== null && target.size > PDF_MAX_BYTES) {
      await this.renderFallback(el, target, `PDF is too large to preview inline (${formatBytes(target.size)}).`, ctx);
      return;
    }

    try {
      const blobUrl = await this.getMediaBlobUrl(target, "PDF", PDF_MAX_BYTES, "application/pdf");
      el.empty();
      const iframe = this.renderPdfFrame(el, target, blobUrl, ctx);
      iframe.onerror = () => {
        void this.renderFallback(el, target, "PDF preview failed to render.", ctx);
      };
      // No card under the PDF — the iframe IS the preview, and the hover toolbar already has
      // "Open in Drive" (matches the image/video embed: media + hover affordances, no chrome).
    } catch (error) {
      console.warn("[Drive Attachments] Drive PDF fetch failed; using fallback.", error);
      await this.renderFallback(el, target, error instanceof Error ? error.message : String(error), ctx);
    }
  }

  private async renderVideo(target: PreviewTarget, el: HTMLElement, ctx?: MarkdownPostProcessorContext): Promise<void> {
    try {
      const videoUrl = await this.mediaProxy.getMediaUrl({ id: target.id, mimeType: target.mimeType });
      el.empty();
      const video = this.renderVideoFrame(el, target, videoUrl, ctx);
      video.onerror = () => {
        void this.renderFallback(el, target, "Video preview failed to render.", ctx);
      };
    } catch (error) {
      console.warn("[Drive Attachments] Drive video fetch failed; using fallback.", error);
      await this.renderFallback(el, target, error instanceof Error ? error.message : String(error), ctx);
    }
  }

  private renderCachedMedia(target: PreviewTarget, el: HTMLElement, ctx?: MarkdownPostProcessorContext): boolean {
    if (target.mimeType === "application/pdf") {
      const blobUrl = this.getCachedBlobUrl(target.id, "application/pdf");
      if (!blobUrl) {
        return false;
      }
      this.renderPdfFrame(el, target, blobUrl, ctx);
      return true;
    }

    if (target.mimeType.startsWith("video/")) {
      return false;
    }

    if (!isBrowserDecodableImage(target.mimeType)) {
      return false;
    }

    const dataUrl = this.dataUrlCache.get(target.id);
    if (!dataUrl) {
      return false;
    }
    this.renderImageFrame(el, target, dataUrl, ctx);
    return true;
  }

  private renderImageFrame(
    el: HTMLElement,
    target: PreviewTarget,
    dataUrl: string,
    ctx?: MarkdownPostProcessorContext,
  ): HTMLImageElement {
    const frame = this.createMediaFrame(el);
    const image = frame.createEl("img", {
      cls: "gdab-drive-preview-image",
      attr: {
        src: dataUrl,
        alt: target.name,
        loading: "lazy",
      },
    });
    this.attachNoteAffordance(el, frame, image, target, ctx);
    this.attachResizeHandle(frame, el, ctx, false);
    this.attachDeletionBadge(frame, target, ctx, true);
    return image;
  }

  // Give an embedded image/video quiet paths into its Drive-link (metadata) note, keeping the media
  // itself clean. Each style is an independent toggle and they can combine: a hover corner group (an
  // "open note" icon plus a "convert this embed to a wikilink" icon), ⌘/Ctrl+click, and/or a hover
  // caption (the file name). Skipped when there's no host note (transient panel render) or when the
  // embed already lives in its own asset note (frontmatter drive_id matches — you're already there).
  private attachNoteAffordance(
    el: HTMLElement,
    frame: HTMLElement,
    media: HTMLElement,
    target: PreviewTarget,
    ctx?: MarkdownPostProcessorContext,
  ): void {
    if (!ctx || this.getSourceFrontmatter(ctx)?.drive_id === target.id) {
      return; // no host note (transient panel), or we're inside the file's own asset note
    }

    // View mode 2: a persisted `caption:` directive shows a type-icon + filename label under the media
    // (independent of the hover affordances below; toggled via the toolbar's caption action).
    const caption = this.readCaptionDirective(el, ctx);
    if (caption) {
      this.appendFilenameLabel(el, target);
    }

    const settings = this.getSettings();
    if (!settings.imageEmbedNoteHoverIcon && !settings.imageEmbedNoteModifierClick && !settings.imageEmbedNoteHoverCaption) {
      return;
    }

    if (settings.imageEmbedNoteHoverIcon) {
      const corner = frame.createDiv({ cls: "gdab-drive-preview-note-actions" });
      this.renderActionToolbar(corner, el, target, ctx, caption);
    }

    if (settings.imageEmbedNoteModifierClick) {
      media.addClass("gdab-drive-preview-modifier-link");
      media.setAttribute("title", "⌘/Ctrl+click to open the Drive-link note");
      media.addEventListener("click", (event) => {
        if (!event.metaKey && !event.ctrlKey) {
          return;
        }
        event.preventDefault();
        void this.openAssetNoteForTarget(target, ctx);
      });
    }

    if (settings.imageEmbedNoteHoverCaption && !caption) {
      // Overlay the caption INSIDE the frame (absolute), not in the document flow — otherwise it
      // would push the note's following content down by a line whenever it appears on hover. For
      // video, anchor it at the TOP so it doesn't cover the playback controls at the bottom.
      // Skipped when the persistent filename label (view mode 2) is already showing — that's the name.
      const isVideo = target.mimeType.startsWith("video/");
      const caption = frame.createDiv({
        cls: ["gdab-drive-preview-note-caption", ...(isVideo ? ["is-top"] : [])],
      });
      // The file name doubles as the link label — it tells you what the media is AND opens its note.
      const link = caption.createEl("a", { text: target.name, attr: { href: "#" } });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void this.openAssetNoteForTarget(target, ctx);
      });
    }
  }

  // Read the `caption:` directive from this embed's fence (via the section's line range).
  private readCaptionDirective(el: HTMLElement, ctx: MarkdownPostProcessorContext): boolean {
    const info = ctx.getSectionInfo(el);
    if (!info) {
      return false;
    }
    const body = info.text.split("\n").slice(info.lineStart + 1, info.lineEnd).join("\n");
    return parsePreviewBlock(body).caption;
  }

  // View mode 2: a type-icon + filename label under the media (mirrors the non-preview card's title).
  private appendFilenameLabel(el: HTMLElement, target: PreviewTarget): void {
    const icon = cardTypeIcon(target.mimeType, target.name, this.customIconSrc, this.getSettings().iconTheme);
    const row = el.createDiv({ cls: "gdab-drive-preview-filename" });
    const iconEl = row.createSpan({ cls: "gdab-drive-preview-card-icon" });
    if (icon.imgSrc) {
      iconEl.createEl("img", {
        cls: "gdab-custom-file-icon-img",
        attr: {
          src: icon.imgSrc,
          alt: "",
          width: "16",
          height: "16",
          loading: "lazy",
        },
      });
    } else if (icon.svg) {
      iconEl.innerHTML = icon.svg;
    } else if (icon.lucide) {
      setIcon(iconEl, icon.lucide);
    }
    iconEl.style.color = icon.color;
    row.createSpan({ text: target.name });
  }

  // Toggle the `caption:` directive in this embed's fence (persists view mode 1 ⇄ 2); the rewrite
  // triggers a re-render that shows/hides the filename label.
  private async toggleCaption(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    try {
      const info = ctx.getSectionInfo(el);
      const host = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!info || !(host instanceof TFile)) {
        return;
      }
      await this.app.vault.process(host, (content) => {
        const lines = content.split("\n");
        if (info.lineStart < 0 || info.lineEnd >= lines.length) {
          return content;
        }
        let captionLine = -1;
        for (let i = info.lineStart + 1; i < info.lineEnd; i += 1) {
          if (/^\s*caption\s*:/i.test(lines[i])) {
            captionLine = i;
            break;
          }
        }
        if (captionLine !== -1) {
          lines.splice(captionLine, 1); // turn off
        } else {
          lines.splice(info.lineEnd, 0, "caption: on"); // turn on (before the closing fence)
        }
        return lines.join("\n");
      });
    } catch (error) {
      new Notice(`Could not toggle the filename label: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Resolve (or create on first use) the Drive-link note for this media and open it in a new tab, so
  // the user keeps their place. Creation is best-effort: a metadata/auth failure surfaces a Notice.
  private async openAssetNoteForTarget(target: PreviewTarget, ctx?: MarkdownPostProcessorContext): Promise<void> {
    try {
      const host = ctx ? this.app.vault.getAbstractFileByPath(ctx.sourcePath) : null;
      const file = await this.insert.openOrCreateAssetNoteFile(this.targetToItem(target), host instanceof TFile ? host : null);
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (error) {
      new Notice(`Could not open the Drive-link note: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The five embed actions, in toolbar order. Open/convert act on the embed + its host; the other
  // three reach Drive through DriveNoteActionsService (resolved lazily — it's built after this service).
  private buildEmbedActions(el: HTMLElement, target: PreviewTarget, ctx: MarkdownPostProcessorContext): EmbedAction[] {
    // First action reflects whether the Drive-link note already exists: "open" it, or "create" it.
    const noteExists = this.insert.findAssetNoteFileByDriveId(target.id) !== null;
    const noteAction: EmbedAction = noteExists
      ? { icon: "file-symlink", label: "Open Drive-link note", run: () => void this.openAssetNoteForTarget(target, ctx) }
      : { icon: "plus", label: "Create Drive-link note", run: () => void this.openAssetNoteForTarget(target, ctx) };
    return [
      noteAction,
      { icon: "link", label: "Convert embed to wikilink", run: () => void this.convertEmbedToWikilink(el, target, ctx) },
      { icon: "external-link", label: "Open in Drive", run: () => this.getNoteActions().openInDrive(target.id, target.webViewLink) },
      { icon: "folder", label: "Open Drive folder", run: () => void this.getNoteActions().openContainingFolder(target.id) },
      { icon: "trash", label: "Delete from Drive…", warning: true, run: () => void this.deleteEmbedTarget(target, ctx) },
    ];
  }

  // Render the action toolbar into `host` per the chosen layout (all icons, or delete + a "⋮" overflow
  // menu). Shared by the hover overlay (image/video/PDF) and the fallback card (pptx/HEIC/oversized).
  // `captionState` is passed only for previewable embeds (the frame overlay) — it adds the view-mode
  // toggle action; the fallback card omits it (the filename is always shown there).
  private renderActionToolbar(
    host: HTMLElement,
    el: HTMLElement,
    target: PreviewTarget,
    ctx: MarkdownPostProcessorContext,
    captionState?: boolean,
  ): void {
    const actions = this.buildEmbedActions(el, target, ctx);
    if (captionState !== undefined) {
      actions.push({
        icon: "tag",
        label: captionState ? "Hide filename label" : "Show filename label",
        run: () => void this.toggleCaption(el, ctx),
      });
    }
    if (this.getSettings().embedActionToolbarStyle === "menu") {
      const destructive = actions.find((action) => action.warning);
      const rest = actions.filter((action) => !action.warning);
      if (destructive) {
        this.renderToolbarIcon(host, destructive);
      }
      this.renderToolbarIcon(host, {
        icon: "more-horizontal",
        label: "More actions",
        rotate: true, // horizontal ellipsis rotated 90° = a reliable vertical kebab
        run: (event) => this.openMoreMenu(event, rest),
      });
    } else {
      for (const action of actions) {
        this.renderToolbarIcon(host, action);
      }
    }
  }

  // Whether to show the action toolbar for this embed: needs a host note (not the transient panel),
  // the hover-toolbar setting on, and the embed not already living in its own asset note.
  private toolbarEligible(target: PreviewTarget, ctx?: MarkdownPostProcessorContext): ctx is MarkdownPostProcessorContext {
    return (
      !!ctx &&
      this.getSettings().imageEmbedNoteHoverIcon &&
      this.getSourceFrontmatter(ctx)?.drive_id !== target.id
    );
  }

  private renderToolbarIcon(corner: HTMLElement, action: EmbedAction): HTMLElement {
    const button = corner.createEl("a", {
      cls: [
        "gdab-drive-preview-note-icon",
        ...(action.warning ? ["is-warning"] : []),
        ...(action.rotate ? ["gdab-rotate-90"] : []),
      ],
      attr: { "aria-label": action.label, href: "#" },
    });
    setIcon(button, action.icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action.run(event);
    });
    return button;
  }

  private openMoreMenu(event: MouseEvent, actions: EmbedAction[]): void {
    const menu = new Menu();
    for (const action of actions) {
      menu.addItem((item) => item.setTitle(action.label).setIcon(action.icon).onClick(() => action.run(event)));
    }
    menu.showAtMouseEvent(event);
  }

  // Delete the embed's Drive file. Resolves (creating if needed) the Drive-link note so the deletion
  // is recorded on it, then runs the shared confirm + trash/permanent flow.
  private async deleteEmbedTarget(target: PreviewTarget, ctx?: MarkdownPostProcessorContext): Promise<void> {
    try {
      const host = ctx ? this.app.vault.getAbstractFileByPath(ctx.sourcePath) : null;
      const noteFile = await this.insert.openOrCreateAssetNoteFile(this.targetToItem(target), host instanceof TFile ? host : null);
      await this.getNoteActions().deleteDriveFile(noteFile, target.id);
    } catch (error) {
      new Notice(`Delete Drive file failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Replace this `drive-preview` block with a `[[wikilink]]` to its Drive-link note, so the note gains
  // a real backlink instead of being orphaned by an embed (Obsidian doesn't track links from rendered
  // code blocks). Uses the active editor when possible (undoable); else writes the file. The note is
  // created first if it doesn't exist yet.
  private async convertEmbedToWikilink(el: HTMLElement, target: PreviewTarget, ctx: MarkdownPostProcessorContext): Promise<void> {
    try {
      const info = ctx.getSectionInfo(el);
      const host = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!info || !(host instanceof TFile)) {
        new Notice("Couldn't locate this embed to convert.");
        return;
      }

      const noteFile = await this.insert.openOrCreateAssetNoteFile(this.targetToItem(target), host);
      const linktext = this.app.metadataCache.fileToLinktext(noteFile, host.path);
      const wikilink = `[[${linktext}]]`;

      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.file?.path === host.path && view.editor) {
        const editor = view.editor;
        editor.replaceRange(
          wikilink,
          { line: info.lineStart, ch: 0 },
          { line: info.lineEnd, ch: editor.getLine(info.lineEnd).length },
        );
      } else {
        await this.app.vault.process(host, (content) => {
          const lines = content.split("\n");
          lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, wikilink);
          return lines.join("\n");
        });
      }
      new Notice(`Converted embed to wikilink: ${wikilink}`);
    } catch (error) {
      new Notice(`Could not convert to wikilink: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private targetToItem(target: PreviewTarget): DrivePickerItem {
    return {
      id: target.id,
      name: target.name,
      mimeType: target.mimeType,
      webViewLink: target.webViewLink ?? "",
    };
  }

  // If this file has been trashed/deleted from Drive (recorded on its Drive-link note's frontmatter),
  // overlay a small badge so the preview reflects that — a trashed file still loads for ~30 days, so
  // without this it looks identical to a live one.
  private attachDeletionBadge(
    container: HTMLElement,
    target: PreviewTarget,
    ctx?: MarkdownPostProcessorContext,
    overlay = false,
  ): void {
    const state = this.resolveDeletionState(target, ctx);
    if (!state) {
      return;
    }
    const badge = container.createDiv({
      cls: [
        "gdab-drive-preview-deleted-badge",
        state === "deleted" ? "is-deleted" : "is-trashed",
        ...(overlay ? ["is-overlay"] : []),
      ],
    });
    badge.setText(state === "deleted" ? "🗑 Deleted from Drive" : "🗑 In Drive trash");
    if (!overlay) {
      container.prepend(badge);
    }
  }

  // The Drive id this block resolves to: the explicit body id, else the host note's drive_id.
  private resolveEffectiveId(id: string, ctx?: MarkdownPostProcessorContext): string {
    const explicit = id.trim();
    if (explicit) {
      return explicit;
    }
    const fm = ctx ? this.getSourceFrontmatter(ctx) : null;
    return typeof fm?.drive_id === "string" ? fm.drive_id : "";
  }

  // On an "unavailable" card, add a link to the file's Drive-link note when one exists — so the note
  // stays reachable even after the Drive file (and thus the preview) is gone.
  private appendAssetNoteLink(el: HTMLElement, driveId: string): void {
    if (!driveId) {
      return;
    }
    const noteFile = this.insert.findAssetNoteFileByDriveId(driveId);
    if (!noteFile) {
      return;
    }
    const row = el.createDiv({ cls: "gdab-drive-preview-card-detail" });
    const link = row.createEl("a", {
      cls: "internal-link",
      text: `Open Drive-link note: ${noteFile.basename}`,
      attr: { href: noteFile.path },
    });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void this.app.workspace.openLinkText(noteFile.path, "");
    });
  }

  // Deletion state for this file: from the host note's own frontmatter when the embed lives in the
  // asset note, else from the asset note resolved by drive_id (covers embeds in other notes).
  private resolveDeletionState(target: PreviewTarget, ctx?: MarkdownPostProcessorContext): "trashed" | "deleted" | null {
    const hostFrontmatter = ctx ? this.getSourceFrontmatter(ctx) : null;
    if (hostFrontmatter && hostFrontmatter.drive_id === target.id) {
      // The embed lives in its own asset note, so the host frontmatter IS the record — no scan needed.
      return readDeletionFlags(hostFrontmatter);
    }
    // Embed in some other note: look up the asset note by drive_id and read its state.
    const noteFile = this.insert.findAssetNoteFileByDriveId(target.id);
    if (noteFile) {
      return readDeletionFlags(this.app.metadataCache.getFileCache(noteFile)?.frontmatter);
    }
    return null;
  }

  private renderPdfFrame(
    el: HTMLElement,
    target: PreviewTarget,
    blobUrl: string,
    ctx?: MarkdownPostProcessorContext,
  ): HTMLIFrameElement {
    const frame = this.createMediaFrame(el);
    const iframe = frame.createEl("iframe", {
      cls: "gdab-drive-preview-pdf",
      attr: {
        src: blobUrl,
        title: target.name,
      },
    });
    this.attachNoteAffordance(el, frame, iframe, target, ctx);
    this.attachResizeHandle(frame, el, ctx, true);
    this.attachDeletionBadge(frame, target, ctx, true);
    return iframe;
  }

  private renderVideoFrame(el: HTMLElement, target: PreviewTarget, videoUrl: string, ctx?: MarkdownPostProcessorContext): HTMLVideoElement {
    const frame = this.createMediaFrame(el);
    const video = frame.createEl("video", {
      cls: "gdab-drive-preview-video",
      attr: { src: videoUrl, controls: "", preload: "metadata" },
    });
    this.attachNoteAffordance(el, frame, video, target, ctx);
    this.attachResizeHandle(frame, el, ctx, false);
    this.attachDeletionBadge(frame, target, ctx, true);
    return video;
  }

  private createMediaFrame(el: HTMLElement): HTMLElement {
    el.addClass("gdab-drive-preview-has-media");
    return el.createDiv({ cls: "gdab-drive-preview-frame" });
  }

  // Fetch raw media bytes (shared by PDF + video). No cache — these are large and one-shot; the blob
  // URL holds the bytes for the element's lifetime, revoked on dispose().
  private async getMediaBytes(target: PreviewTarget, label: string, maxBytes: number): Promise<ArrayBuffer> {
    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(target.id)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google Drive media download failed with HTTP ${response.status}.`);
    }
    if (response.arrayBuffer.byteLength > maxBytes) {
      throw new Error(`${label} is too large to preview inline (${formatBytes(response.arrayBuffer.byteLength)}).`);
    }
    return response.arrayBuffer;
  }

  private createBlobUrl(bytes: ArrayBuffer, mimeType: string): string {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    this.blobUrls.add(url);
    return url;
  }

  private getCachedBlobUrl(id: string, blobMime: string): string | null {
    return this.blobUrlByKey.get(`${id}:${blobMime}`) ?? null;
  }

  // Cached blob URL by id:mime so a re-render reuses it (no re-download). Evicts the oldest beyond
  // MAX_BLOB_ENTRIES (never the one just created, even if it pushes over the cap).
  private async getMediaBlobUrl(target: PreviewTarget, label: string, maxBytes: number, blobMime: string): Promise<string> {
    const key = `${target.id}:${blobMime}`;
    const cached = this.blobUrlByKey.get(key);
    if (cached) {
      return cached;
    }

    const url = this.createBlobUrl(await this.getMediaBytes(target, label, maxBytes), blobMime);
    this.blobUrlByKey.set(key, url);
    while (this.blobUrlByKey.size > MAX_BLOB_ENTRIES) {
      const oldestKey = this.blobUrlByKey.keys().next().value as string | undefined;
      if (oldestKey === undefined || oldestKey === key) {
        break;
      }
      const oldestUrl = this.blobUrlByKey.get(oldestKey);
      this.blobUrlByKey.delete(oldestKey);
      if (oldestUrl) {
        URL.revokeObjectURL(oldestUrl);
        this.blobUrls.delete(oldestUrl);
      }
    }
    return url;
  }

  // A drag handle at the media's bottom-right. Dragging updates the container's size vars live; on
  // release the new width (and PDF height) is persisted back into the fence when a ctx exists (i.e. a
  // real note, not the transient panel modal) so it survives re-render.
  private attachResizeHandle(
    frame: HTMLElement,
    container: HTMLElement,
    ctx: MarkdownPostProcessorContext | undefined,
    resizeHeight: boolean,
  ): void {
    const handle = frame.createDiv({ cls: "gdab-drive-preview-handle", attr: { "aria-label": "Drag to resize" } });
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    const onMove = (event: PointerEvent): void => {
      const nextWidth = Math.max(MIN_PREVIEW_WIDTH, Math.round(startWidth + (event.clientX - startX)));
      container.style.setProperty("--gdab-preview-max-width", `${nextWidth}px`);
      if (resizeHeight) {
        const nextHeight = Math.max(MIN_PREVIEW_HEIGHT, Math.round(startHeight + (event.clientY - startY)));
        container.style.setProperty("--gdab-preview-height", `${nextHeight}px`);
      }
    };
    const onUp = (event: PointerEvent): void => {
      handle.removeEventListener("pointermove", onMove);
      frame.removeClass("gdab-resizing");
      const width = Math.max(MIN_PREVIEW_WIDTH, Math.round(startWidth + (event.clientX - startX)));
      const height = resizeHeight
        ? Math.max(MIN_PREVIEW_HEIGHT, Math.round(startHeight + (event.clientY - startY)))
        : undefined;
      void this.persistSize(ctx, container, { width, height });
    };

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startX = event.clientX;
      startY = event.clientY;
      startWidth = frame.getBoundingClientRect().width;
      startHeight = frame.getBoundingClientRect().height;
      // Capture the pointer to the handle so dragging OVER the PDF iframe / video still delivers
      // pointermove/up here — otherwise the iframe swallows the events and the drag dies mid-resize.
      handle.setPointerCapture(event.pointerId);
      frame.addClass("gdab-resizing");
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp, { once: true });
    });
  }

  private async persistSize(
    ctx: MarkdownPostProcessorContext | undefined,
    container: HTMLElement,
    size: { width: number; height?: number },
  ): Promise<void> {
    if (!ctx) {
      return; // transient render (panel modal) — visual only
    }
    const info = ctx.getSectionInfo(container);
    if (!info) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) {
      return;
    }
    try {
      await this.app.vault.process(file, (text) => rewriteFenceSize(text, info.lineStart, info.lineEnd, size));
    } catch (error) {
      console.warn("[Drive Attachments] Could not persist preview size.", error);
    }
  }

  private async resolveTarget(source: string, ctx?: MarkdownPostProcessorContext): Promise<PreviewTarget | null> {
    const explicitId = source.trim();
    if (explicitId) {
      return metadataToTarget(await this.metadata.getFileMetadata(explicitId));
    }

    if (!ctx) {
      return null;
    }

    const frontmatter = this.getSourceFrontmatter(ctx);
    const frontmatterTarget = frontmatter ? frontmatterToTarget(frontmatter) : null;
    if (!frontmatterTarget) {
      return null;
    }

    if (frontmatterTarget.mimeType && frontmatterTarget.webViewLink) {
      return {
        id: frontmatterTarget.id,
        name: frontmatterTarget.name ?? frontmatterTarget.id,
        mimeType: frontmatterTarget.mimeType,
        size: frontmatterTarget.size ?? null,
        webViewLink: frontmatterTarget.webViewLink,
        thumbnailLink: frontmatterTarget.thumbnailLink ?? null,
      };
    }

    return metadataToTarget(await this.metadata.getFileMetadata(frontmatterTarget.id));
  }

  private resolveTargetFromCache(source: string, ctx?: MarkdownPostProcessorContext): PreviewTarget | null {
    const explicitId = source.trim();
    if (explicitId) {
      return this.targetCache.get(explicitId) ?? null;
    }

    if (!ctx) {
      return null;
    }

    const frontmatter = this.getSourceFrontmatter(ctx);
    const frontmatterTarget = frontmatter ? frontmatterToTarget(frontmatter) : null;
    if (!frontmatterTarget) {
      return null;
    }

    if (frontmatterTarget.mimeType && frontmatterTarget.webViewLink) {
      return {
        id: frontmatterTarget.id,
        name: frontmatterTarget.name ?? frontmatterTarget.id,
        mimeType: frontmatterTarget.mimeType,
        size: frontmatterTarget.size ?? null,
        webViewLink: frontmatterTarget.webViewLink,
        thumbnailLink: frontmatterTarget.thumbnailLink ?? null,
      };
    }

    return this.targetCache.get(frontmatterTarget.id) ?? null;
  }

  private getSourceFrontmatter(ctx: MarkdownPostProcessorContext): PreviewFrontmatter | null {
    if (ctx.frontmatter && typeof ctx.frontmatter === "object") {
      return ctx.frontmatter as PreviewFrontmatter;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(sourceFile instanceof TFile)) {
      return null;
    }

    return this.app.metadataCache.getFileCache(sourceFile)?.frontmatter ?? null;
  }

  private async getMediaDataUrl(target: PreviewTarget, label: string): Promise<string> {
    const cached = this.dataUrlCache.get(target.id);
    if (cached) {
      return cached;
    }

    const accessToken = await this.auth.getAccessToken();
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(target.id)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");

    const response = await requestUrl({
      url: url.toString(),
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google Drive media download failed with HTTP ${response.status}.`);
    }

    if (response.arrayBuffer.byteLength > MAX_INLINE_BYTES) {
      throw new Error(`${label} is too large to preview inline (${formatBytes(response.arrayBuffer.byteLength)}).`);
    }

    const dataUrl = `data:${target.mimeType};base64,${arrayBufferToBase64(response.arrayBuffer)}`;
    this.cacheDataUrl(target.id, dataUrl);
    return dataUrl;
  }

  // Bounded FIFO cache. Each previewed image/PDF can be up to MAX_INLINE_BYTES, so without a cap a long
  // browsing session would grow the heap unbounded. Evict oldest entries until under the byte cap (but
  // always keep the just-inserted one, even if it alone exceeds the cap — it's needed for this render).
  private cacheDataUrl(id: string, dataUrl: string): void {
    if (this.dataUrlCache.has(id)) {
      return;
    }
    this.dataUrlCache.set(id, dataUrl);
    this.cacheBytes += dataUrl.length;
    while (this.cacheBytes > MAX_CACHE_BYTES && this.dataUrlCache.size > 1) {
      const oldest = this.dataUrlCache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      const evicted = this.dataUrlCache.get(oldest);
      this.dataUrlCache.delete(oldest);
      this.cacheBytes -= evicted ? evicted.length : 0;
    }
  }

  private async renderFallback(el: HTMLElement, target: PreviewTarget, detail: string, ctx?: MarkdownPostProcessorContext): Promise<void> {
    // Best-effort thumbnail: minting the token can fail (expired refresh token, offline). If it does,
    // drop to the card-only fallback instead of throwing out of the reading-view render.
    let thumbnailLink: string | null = null;
    if (target.thumbnailLink) {
      try {
        thumbnailLink = await this.fetchThumbnailDataUrl(target.thumbnailLink);
      } catch (error) {
        console.warn("[Drive Attachments] Drive thumbnail load failed; showing card only.", error);
        thumbnailLink = null;
      }
    }
    el.empty();

    if (thumbnailLink) {
      const link = el.createEl("a", {
        cls: "gdab-drive-preview-thumbnail-link",
        attr: {
          href: target.webViewLink ?? thumbnailLink,
          target: "_blank",
          rel: "noopener",
        },
      });
      link.createEl("img", {
        cls: "gdab-drive-preview-thumbnail",
        attr: {
          src: thumbnailLink,
          alt: target.name,
          loading: "lazy",
        },
      });
    }

    // When the action toolbar will show (it has its own "Open in Drive"), drop the redundant text
    // "Open in Drive" link from the card — keep it only as the sole opener when there's no toolbar.
    const showToolbar = this.toolbarEligible(target, ctx);
    const card = this.renderCard(el, {
      title: target.name,
      detail,
      url: showToolbar ? null : target.webViewLink,
      icon: cardTypeIcon(target.mimeType, target.name, this.customIconSrc, this.getSettings().iconTheme),
    });
    if (showToolbar) {
      const row = card.createDiv({ cls: "gdab-drive-preview-fallback-actions" });
      this.renderActionToolbar(row, el, target, ctx);
    }
    this.attachDeletionBadge(el, target);
  }

  // Fetch a Drive thumbnail with the OAuth token in the Authorization header, then inline it as a
  // data URL — the token never lands in the DOM/URL (unlike a `?access_token=` query param).
  private async fetchThumbnailDataUrl(url: string): Promise<string> {
    const accessToken = await this.auth.getAccessToken();
    const response = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const contentType = response.headers["content-type"] ?? "image/jpeg";
    return `data:${contentType};base64,${arrayBufferToBase64(response.arrayBuffer)}`;
  }

  private renderCard(
    el: HTMLElement,
    options: { title: string; detail: string; url?: string | null; mimeType?: string; icon?: CardIcon },
  ): HTMLElement {
    const card = el.createDiv({ cls: "gdab-drive-preview-card" });
    const title = card.createDiv({ cls: "gdab-drive-preview-card-title" });
    if (options.icon) {
      const iconEl = title.createSpan({ cls: "gdab-drive-preview-card-icon" });
      if (options.icon.imgSrc) {
        iconEl.createEl("img", {
          cls: "gdab-custom-file-icon-img",
          attr: {
            src: options.icon.imgSrc,
            alt: "",
            width: "16",
            height: "16",
            loading: "lazy",
          },
        });
      } else if (options.icon.svg) {
        // Trusted constant SVG (our own / Google's filetype badge), not user input — safe to inline.
        iconEl.innerHTML = options.icon.svg;
      } else if (options.icon.lucide) {
        setIcon(iconEl, options.icon.lucide);
      }
      iconEl.style.color = options.icon.color;
    }
    title.createSpan({ text: options.title });
    // (Raw mimeType is intentionally not shown — it's noise like "application/vnd.google-apps.spreadsheet".)
    if (options.detail) {
      card.createDiv({ cls: "gdab-drive-preview-card-detail", text: options.detail });
    }
    if (options.url) {
      card.createEl("a", {
        text: "Open in Drive",
        attr: {
          href: options.url,
          target: "_blank",
          rel: "noopener",
        },
      });
    }
    return card;
  }
}

function metadataToTarget(metadata: DriveMetadata): PreviewTarget {
  return {
    id: metadata.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    size: parseSize(metadata.size),
    webViewLink: metadata.webViewLink,
    thumbnailLink: metadata.thumbnailLink ?? null,
  };
}

interface CardIcon {
  // Either a custom pack image, an inline SVG (bundled/trusted badges), or a Lucide icon name; plus a color.
  imgSrc?: string;
  svg?: string;
  lucide?: string;
  color: string;
}

// A colored file-type icon for the non-preview card, by mimeType/extension. Branded types (PDF,
// PowerPoint) use the real Google/Microsoft SVG (see driveFileIcon.ts); the rest use Lucide shapes
// tinted to each brand/category color.
function cardTypeIcon(
  mimeType: string,
  name: string,
  customIconSrc: CustomFileIconResolver | undefined,
  iconTheme: GoogleDriveAttachmentBridgeSettings["iconTheme"],
): CardIcon {
  const customSrc = customIconSrc?.(mimeType, name);
  if (customSrc) {
    return { imgSrc: customSrc, color: "" };
  }

  const themed = bundledIconForFile(iconTheme, mimeType, name);
  if (themed) {
    return { svg: themed, color: "" };
  }

  const branded = brandedFileIcon(mimeType, name);
  if (branded) {
    return { svg: branded.svg, color: branded.color ?? "" };
  }
  const mime = mimeType.toLowerCase();
  const ext = (name.includes(".") ? name.split(".").pop() ?? "" : "").toLowerCase();
  const has = (...keys: string[]): boolean => keys.some((key) => mime.includes(key));
  // A Drive folder embedded as a `drive-preview` block renders the fallback card — give it the folder
  // shape, not the generic "file" default. (Custom packs/themes already resolve folder via fileIconName.)
  if (mime === "application/vnd.google-apps.folder") {
    return { lucide: "folder", color: "var(--text-muted)" };
  }
  if (has("spreadsheet", "excel") || ["xls", "xlsx", "xlsm", "csv", "numbers"].includes(ext)) {
    return { lucide: "table", color: "var(--color-green)" };
  }
  if (mime === "application/vnd.google-apps.presentation") {
    return { lucide: "presentation", color: "#f9ab00" }; // Google Slides yellow
  }
  if (has("presentation") || ext === "key") {
    return { lucide: "presentation", color: "var(--color-orange)" }; // other presentations (Keynote, …)
  }
  if (has("wordprocessing", "msword", "google-apps.document", "hwp") || ["doc", "docx", "hwp", "hwpx", "pages", "rtf"].includes(ext)) {
    return { lucide: "file-text", color: "var(--color-blue)" };
  }
  const category = mime.split("/")[0];
  if (category === "image") {
    return { lucide: "image", color: "var(--color-purple)" };
  }
  if (category === "video") {
    return { lucide: "film", color: "var(--color-pink)" };
  }
  if (category === "audio") {
    return { lucide: "file-audio", color: "var(--color-cyan)" };
  }
  if (has("zip", "compressed", "x-tar", "x-7z", "x-rar") || ["zip", "rar", "7z", "tar", "gz", "tgz"].includes(ext)) {
    return { lucide: "file-archive", color: "var(--color-yellow)" };
  }
  return { lucide: "file", color: "var(--text-muted)" };
}

function readDeletionFlags(
  frontmatter: { drive_trashed?: unknown; drive_deleted?: unknown } | null | undefined,
): "trashed" | "deleted" | null {
  if (!frontmatter) {
    return null;
  }
  if (frontmatter.drive_deleted === true) {
    return "deleted";
  }
  if (frontmatter.drive_trashed === true) {
    return "trashed";
  }
  return null;
}

function frontmatterToTarget(frontmatter: PreviewFrontmatter): Partial<PreviewTarget> & { id: string } | null {
  if (typeof frontmatter.drive_id !== "string" || frontmatter.drive_id.trim().length === 0) {
    return null;
  }

  return {
    id: frontmatter.drive_id.trim(),
    name: typeof frontmatter.drive_name === "string" && frontmatter.drive_name.trim().length > 0
      ? frontmatter.drive_name
      : undefined,
    mimeType: typeof frontmatter.drive_mime_type === "string" && frontmatter.drive_mime_type.trim().length > 0
      ? frontmatter.drive_mime_type
      : undefined,
    size: parseSize(frontmatter.drive_size),
    webViewLink: typeof frontmatter.drive_web_view_link === "string" && frontmatter.drive_web_view_link.length > 0
      ? frontmatter.drive_web_view_link
      : undefined,
    thumbnailLink: typeof frontmatter.drive_thumbnail_link === "string" && frontmatter.drive_thumbnail_link.length > 0
      ? frontmatter.drive_thumbnail_link
      : undefined,
  };
}

function parseSize(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }

  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
}

function rewriteFenceNumberOption(
  lines: string[],
  lineStart: number,
  lineEnd: number,
  key: "width" | "height",
  value: number,
): void {
  const optionPattern = new RegExp(`^\\s*${key}\\s*:`, "i");
  for (let i = lineStart + 1; i < lineEnd; i++) {
    if (optionPattern.test(lines[i])) {
      lines[i] = `${key}: ${value}`;
      return;
    }
  }
  lines.splice(lineEnd, 0, `${key}: ${value}`);
}
