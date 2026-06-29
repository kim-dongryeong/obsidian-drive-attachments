import { arrayBufferToBase64, requestUrl } from "obsidian";
import { DriveAuthService } from "./driveAuthService";

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_CHARS = 24 * 1024 * 1024;

interface CachedThumbnail {
  sourceUrl: string;
  dataUrl: string;
}

interface PendingThumbnail {
  sourceUrl: string;
  promise: Promise<string>;
}

// Fetches Drive thumbnail bytes with an Authorization header, then converts them to image data URLs
// that <img> can render without leaking the OAuth token into the DOM. The bounded FIFO cache avoids
// re-fetching rows across panel re-renders without letting a long browsing session grow unbounded.
export class DriveThumbnailService {
  private readonly cache = new Map<string, CachedThumbnail>();
  private readonly pending = new Map<string, PendingThumbnail>();
  private cacheChars = 0;
  private generation = 0;

  constructor(private readonly auth: DriveAuthService) {}

  getCached(fileId: string, sourceUrl: string): string | null {
    const cached = this.cache.get(fileId);
    return cached?.sourceUrl === sourceUrl ? cached.dataUrl : null;
  }

  async getDataUrl(fileId: string, sourceUrl: string): Promise<string> {
    const cached = this.getCached(fileId, sourceUrl);
    if (cached) {
      return cached;
    }

    const existing = this.pending.get(fileId);
    if (existing?.sourceUrl === sourceUrl) {
      return existing.promise;
    }

    this.evict(fileId);
    const generation = this.generation;
    const promise = this.fetchDataUrl(sourceUrl);
    this.pending.set(fileId, { sourceUrl, promise });

    try {
      const dataUrl = await promise;
      const current = this.pending.get(fileId);
      if (generation === this.generation && current?.promise === promise) {
        this.cache.set(fileId, { sourceUrl, dataUrl });
        this.cacheChars += dataUrl.length;
        this.trimCache();
      }
      return dataUrl;
    } finally {
      if (this.pending.get(fileId)?.promise === promise) {
        this.pending.delete(fileId);
      }
    }
  }

  clear(): void {
    this.generation += 1;
    this.cache.clear();
    this.pending.clear();
    this.cacheChars = 0;
  }

  invalidate(fileId: string): void {
    this.evict(fileId);
  }

  private async fetchDataUrl(sourceUrl: string): Promise<string> {
    const accessToken = await this.auth.getAccessToken();
    const response = await requestUrl({
      url: sourceUrl,
      headers: { Authorization: `Bearer ${accessToken}` },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google Drive thumbnail request failed with HTTP ${response.status}.`);
    }
    if (response.arrayBuffer.byteLength === 0) {
      throw new Error("Google Drive returned an empty thumbnail.");
    }
    if (response.arrayBuffer.byteLength > MAX_THUMBNAIL_BYTES) {
      throw new Error("Google Drive returned an unexpectedly large thumbnail.");
    }

    const contentType = readHeader(response.headers, "content-type")?.split(";", 1)[0].trim() || "image/jpeg";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error("Google Drive returned a non-image thumbnail.");
    }
    return `data:${contentType};base64,${arrayBufferToBase64(response.arrayBuffer)}`;
  }

  private evict(fileId: string): void {
    const cached = this.cache.get(fileId);
    if (!cached) {
      return;
    }
    this.cache.delete(fileId);
    this.cacheChars -= cached.dataUrl.length;
  }

  private trimCache(): void {
    while (this.cacheChars > MAX_CACHE_CHARS && this.cache.size > 1) {
      const oldestId = this.cache.keys().next().value as string | undefined;
      if (!oldestId) {
        break;
      }
      this.evict(oldestId);
    }
  }
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}
