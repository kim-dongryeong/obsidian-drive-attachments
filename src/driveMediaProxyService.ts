import { randomBytes } from "crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { request as httpsRequest } from "https";
import { DriveAuthService } from "./driveAuthService";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const PROXY_UPSTREAM_TIMEOUT_MS = 30_000;

interface MediaProxyServer {
  baseUrl: string;
  token: string;
}

interface AllowedMedia {
  mimeType: string;
}

export class DriveMediaProxyService {
  private server: Server | null = null;
  private current: MediaProxyServer | null = null;
  // In-flight startup. Without this, two videos rendering before the first `listen` callback fires
  // would each see `current === null` and start a SECOND server, orphaning the first (still bound to
  // a port, never closed on unload). Concurrent callers must share one startup.
  private starting: Promise<MediaProxyServer> | null = null;
  private readonly allowedMedia = new Map<string, AllowedMedia>();

  constructor(private readonly auth: DriveAuthService) {}

  async getMediaUrl(file: { id: string; mimeType: string }): Promise<string> {
    this.allowedMedia.set(file.id, { mimeType: file.mimeType });
    const server = await this.getServer();
    return `${server.baseUrl}/media/${encodeURIComponent(file.id)}?token=${encodeURIComponent(server.token)}`;
  }

  // Drop a file from the allow-set so a re-stream is refused (e.g. after it's deleted from Drive).
  invalidate(id: string): void {
    this.allowedMedia.delete(id);
  }

  dispose(): void {
    this.current = null;
    this.starting = null;
    this.allowedMedia.clear();
    this.server?.close();
    this.server = null;
  }

  private async getServer(): Promise<MediaProxyServer> {
    if (this.current) {
      return this.current;
    }
    // Share a single in-flight startup across concurrent callers so we never bind two servers.
    if (!this.starting) {
      this.starting = this.startServer();
    }
    try {
      return await this.starting;
    } finally {
      // Clear on settle: on success `current` short-circuits future calls; on failure a later call retries.
      this.starting = null;
    }
  }

  private startServer(): Promise<MediaProxyServer> {
    const token = randomBytes(32).toString("hex");
    return new Promise<MediaProxyServer>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response, token);
      });

      server.on("error", (error) => {
        server.close();
        reject(error);
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        this.server = server;
        this.current = {
          baseUrl: `http://127.0.0.1:${port}`,
          token,
        };
        resolve(this.current);
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== token) {
      sendText(response, 403, "forbidden");
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: "GET, HEAD",
      });
      response.end("method not allowed");
      return;
    }

    const id = parseMediaId(url.pathname);
    const allowed = id ? this.allowedMedia.get(id) : null;
    if (!id || !allowed) {
      sendText(response, 404, "not found");
      return;
    }

    try {
      const accessToken = await this.auth.getAccessToken();
      await this.proxyDriveMedia(request, response, id, allowed, accessToken);
    } catch (error) {
      if (!response.headersSent) {
        sendText(response, 502, error instanceof Error ? error.message : String(error));
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private proxyDriveMedia(
    clientRequest: IncomingMessage,
    clientResponse: ServerResponse,
    id: string,
    allowed: AllowedMedia,
    accessToken: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const driveUrl = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(id)}`);
      driveUrl.searchParams.set("alt", "media");
      driveUrl.searchParams.set("supportsAllDrives", "true");

      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
      };
      const range = clientRequest.headers.range;
      if (typeof range === "string") {
        headers.Range = range;
      }

      const upstreamRequest = httpsRequest(
        driveUrl,
        {
          method: clientRequest.method === "HEAD" ? "HEAD" : "GET",
          headers,
          timeout: PROXY_UPSTREAM_TIMEOUT_MS,
        },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502;
          const responseHeaders = makeProxyHeaders(upstreamResponse, allowed.mimeType);
          clientResponse.writeHead(status, responseHeaders);

          if (clientRequest.method === "HEAD") {
            upstreamResponse.resume();
            clientResponse.end();
            resolve();
            return;
          }

          upstreamResponse.pipe(clientResponse);
          upstreamResponse.on("end", resolve);
          upstreamResponse.on("error", reject);
        },
      );

      upstreamRequest.on("timeout", () => {
        upstreamRequest.destroy(new Error("Google Drive media request timed out."));
      });
      upstreamRequest.on("error", reject);

      clientRequest.on("aborted", () => {
        upstreamRequest.destroy();
      });
      clientResponse.on("close", () => {
        if (!clientResponse.writableEnded) {
          upstreamRequest.destroy();
        }
      });

      upstreamRequest.end();
    });
  }
}

function parseMediaId(pathname: string): string | null {
  const match = pathname.match(/^\/media\/([^/]+)$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function makeProxyHeaders(upstreamResponse: IncomingMessage, fallbackMimeType: string): Record<string, string | number | string[]> {
  const headers: Record<string, string | number | string[]> = {
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "Content-Type": getHeader(upstreamResponse, "content-type") ?? fallbackMimeType,
  };

  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = getHeader(upstreamResponse, name);
    if (value !== null) {
      headers[name] = value;
    }
  }

  return headers;
}

function getHeader(response: IncomingMessage, name: string): string | string[] | null {
  const value = response.headers[name];
  if (typeof value === "string" || Array.isArray(value)) {
    return value;
  }
  return null;
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}
