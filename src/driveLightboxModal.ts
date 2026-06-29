import { App, Modal } from "obsidian";
import { DrivePreviewService } from "./drivePreviewService";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
// Wheel delta → zoom factor: exp(-deltaY * STEP). Small so a notch is a gentle step and a trackpad
// pinch (large deltas) still tops out sanely against MAX_SCALE.
const WHEEL_ZOOM_STEP = 0.0015;

// A Picasa-style lightbox for Quick preview: a dark full-bleed overlay with the media centered.
// Images get cursor-anchored wheel zoom + drag-to-pan when zoomed in; double-click resets to fit.
// PDF/video render centered (no zoom). Click the empty backdrop or press Esc to close (Esc is handled
// by Obsidian's Modal; the backdrop click is wired below). Media bytes come through the preview
// service's existing data-URL/blob caches, so it reuses anything an inline embed already fetched.
export class DriveLightboxModal extends Modal {
  private scale = MIN_SCALE;
  private tx = 0;
  private ty = 0;
  private image: HTMLImageElement | null = null;
  private dragging = false;
  private startX = 0;
  private startY = 0;

  constructor(
    app: App,
    private readonly preview: DrivePreviewService,
    private readonly item: { id: string; name: string },
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("gdab-lightbox-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gdab-lightbox-content");

    const viewport = contentEl.createDiv({ cls: "gdab-lightbox-viewport" });
    contentEl.createDiv({ cls: "gdab-lightbox-caption", text: this.item.name });

    // Clicking the empty backdrop (the viewport itself, not the media) closes — the lightbox idiom.
    viewport.addEventListener("click", (event) => {
      if (event.target === viewport) {
        this.close();
      }
    });

    void this.load(viewport);
  }

  private async load(viewport: HTMLElement): Promise<void> {
    const status = viewport.createDiv({ cls: "gdab-lightbox-status", text: "Loading preview…" });
    let media: HTMLElement | null = null;
    try {
      media = await this.preview.renderLightbox(this.item.id, viewport);
    } catch (error) {
      viewport.createDiv({
        cls: "gdab-lightbox-status",
        text: `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    status.remove();
    if (media instanceof HTMLImageElement) {
      this.enableImageZoom(viewport, media);
    }
  }

  private enableImageZoom(viewport: HTMLElement, image: HTMLImageElement): void {
    this.image = image;
    image.addClass("gdab-lightbox-zoomable");
    this.applyTransform();

    viewport.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        // Cursor position relative to the viewport centre — which is the image's at-rest centre, so
        // (transform-origin: center) makes the anchor maths below exact.
        const ux = event.clientX - rect.left - rect.width / 2;
        const uy = event.clientY - rect.top - rect.height / 2;
        // Zoom direction flipped from the original (+deltaY, not -deltaY): kdr wants scrolling up to
        // zoom IN on his setup. (The raw deltaY sign is device/natural-scroll dependent.)
        const next = clamp(this.scale * Math.exp(event.deltaY * WHEEL_ZOOM_STEP), MIN_SCALE, MAX_SCALE);
        // Keep the point under the cursor fixed across the zoom: t' = u - (u - t) * (next / scale).
        const ratio = next / this.scale;
        this.tx = ux - (ux - this.tx) * ratio;
        this.ty = uy - (uy - this.ty) * ratio;
        this.scale = next;
        if (this.scale === MIN_SCALE) {
          this.tx = 0;
          this.ty = 0;
        }
        this.applyTransform();
      },
      { passive: false },
    );

    image.addEventListener("dblclick", (event) => {
      event.preventDefault();
      this.scale = MIN_SCALE;
      this.tx = 0;
      this.ty = 0;
      this.applyTransform();
    });

    image.addEventListener("pointerdown", (event) => {
      if (this.scale <= MIN_SCALE) {
        return; // only pan when zoomed in
      }
      event.preventDefault();
      this.dragging = true;
      this.startX = event.clientX - this.tx;
      this.startY = event.clientY - this.ty;
      image.setPointerCapture(event.pointerId);
    });
    image.addEventListener("pointermove", (event) => {
      if (!this.dragging) {
        return;
      }
      this.tx = event.clientX - this.startX;
      this.ty = event.clientY - this.startY;
      this.applyTransform();
    });
    const endDrag = (event: PointerEvent): void => {
      if (!this.dragging) {
        return;
      }
      this.dragging = false;
      if (image.hasPointerCapture(event.pointerId)) {
        image.releasePointerCapture(event.pointerId);
      }
    };
    image.addEventListener("pointerup", endDrag);
    image.addEventListener("pointercancel", endDrag);
  }

  private applyTransform(): void {
    if (!this.image) {
      return;
    }
    this.image.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.image.toggleClass("gdab-lightbox-zoomed", this.scale > MIN_SCALE);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
