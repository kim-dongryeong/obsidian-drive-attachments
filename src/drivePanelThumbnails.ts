import { DriveThumbnailService } from "./driveThumbnailService";

interface PanelThumbnailTarget {
  fileId: string;
  sourceUrl: string;
}

// The Drive panel's view-side thumbnail machinery (T-011 P5): lazy-loads grid thumbnails via an
// IntersectionObserver, remembers per-file failures so scrolling doesn't re-request known-bad
// links, and guards in-flight loads with a generation counter so a panel close/reset discards
// stale results. Wraps DriveThumbnailService (the header-authenticated fetch + data-URL cache);
// the view keeps only thin delegation calls.
export class DrivePanelThumbnails {
  private observer: IntersectionObserver | null = null;
  private readonly targets = new WeakMap<Element, PanelThumbnailTarget>();
  private readonly failures = new Set<string>();
  private generation = 0;

  constructor(
    private readonly service: DriveThumbnailService,
    // The panel's contentEl — the observer's scroll root and the repaint query scope. Read lazily:
    // the view's DOM mounts after construction.
    private readonly getRoot: () => HTMLElement,
  ) {}

  // Attach a thumbnail to a grid row icon: cached data URL immediately, known failure = keep the
  // type icon, otherwise lazy-load when the icon scrolls near the viewport.
  renderInto(icon: HTMLElement, fileId: string, sourceUrl: string): void {
    icon.addClass("has-thumbnail-source");
    icon.dataset.thumbnailId = fileId;
    this.targets.set(icon, { fileId, sourceUrl });

    const cached = this.service.getCached(fileId, sourceUrl);
    if (cached) {
      this.show(icon, cached);
      return;
    }
    if (this.failures.has(fileId)) {
      return;
    }

    this.getObserver().observe(icon);
  }

  // Stop observing before a list rebuild — the observed elements are about to be removed.
  disconnectObserver(): void {
    this.observer?.disconnect();
  }

  // The explicit retry path (folder refresh): forget previous failures so they get re-attempted.
  clearFailures(): void {
    this.failures.clear();
  }

  // Full teardown on panel close: drop the observer, invalidate in-flight loads, clear all caches.
  reset(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.generation += 1;
    this.failures.clear();
    this.service.clear();
  }

  private getObserver(): IntersectionObserver {
    if (this.observer) {
      return this.observer;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          this.observer?.unobserve(entry.target);
          const target = this.targets.get(entry.target);
          if (target) {
            void this.load(target.fileId, target.sourceUrl);
          }
        }
      },
      { root: this.getRoot(), rootMargin: "96px" },
    );
    return this.observer;
  }

  private async load(fileId: string, sourceUrl: string): Promise<void> {
    const generation = this.generation;
    try {
      const dataUrl = await this.service.getDataUrl(fileId, sourceUrl);
      if (generation !== this.generation) {
        return;
      }
      this.getRoot().querySelectorAll<HTMLElement>(".gdab-drive-panel-row-icon").forEach((element) => {
        const target = this.targets.get(element);
        if (target?.fileId === fileId && target.sourceUrl === sourceUrl) {
          this.show(element, dataUrl);
        }
      });
    } catch (error) {
      this.failures.add(fileId);
      console.warn("[Drive Attachments] Drive panel thumbnail failed; keeping the type icon.", error);
    }
  }

  private show(icon: HTMLElement, dataUrl: string): void {
    if (icon.querySelector(".gdab-drive-panel-row-thumbnail")) {
      return;
    }
    const image = icon.createEl("img", {
      cls: "gdab-drive-panel-row-thumbnail",
      attr: { alt: "", draggable: "false" },
    });
    image.addEventListener("load", () => icon.addClass("is-thumbnail-ready"), { once: true });
    image.addEventListener("error", () => {
      image.remove();
      icon.removeClass("is-thumbnail-ready");
      const target = this.targets.get(icon);
      if (target) {
        this.service.invalidate(target.fileId);
        this.failures.add(target.fileId);
      }
    }, { once: true });
    image.src = dataUrl;
  }
}
