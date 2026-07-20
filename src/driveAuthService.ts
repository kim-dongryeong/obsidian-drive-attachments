import { Notice, requestUrl } from "obsidian";
import { createServer, Server } from "http";
import { createHash, randomBytes } from "crypto";
import { GoogleDriveAttachmentBridgeSettings } from "./settings";
import { SecretStore } from "./secretStore";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_METADATA_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
// Full read/write/delete over the whole Drive. Restricted scope — only requested when the user opts
// in (enableFullDriveAccess), so the plugin can act on files it didn't upload (e.g. delete a
// picked/searched item). Supersedes drive.readonly, so we drop that one when this is requested.
export const DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const AUTH_TIMEOUT_MS = 120_000;

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  grantedScopes: string[];
}

interface RefreshResult {
  accessToken: string;
  expiresAt: number;
}

interface LoopbackCode {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export class DriveAuthService {
  private readonly secretStore = new SecretStore();

  constructor(
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
    private readonly saveSettings: () => Promise<void>,
  ) {}

  // The short-lived access token lives ONLY in memory (never written to data.json). The refresh
  // token is the durable credential; a fresh access token is minted per session/expiry. Keeps the
  // plaintext-secrets surface of data.json down to clientSecret + (legacy plain) refresh token.
  private cachedAccessToken: { token: string; expiresAt: number } | null = null;
  // Set while waitForLoopbackCode is pending; lets the UI cancel a connect that opened in the wrong
  // browser profile without waiting out the 120s timeout. Cleared as soon as the wait settles.
  private cancelLoopback: (() => void) | null = null;

  // Abort a connect() that's waiting for the browser consent (no-op if nothing is pending). Rejects
  // the pending connect with a "cancelled" error so the caller can re-enable its UI immediately.
  cancelConnect(): void {
    this.cancelLoopback?.();
  }

  get isConnected(): boolean {
    const settings = this.getSettings();
    return settings.encryptedRefreshToken !== null || settings.refreshToken !== null;
  }

  get hasDriveSearchScope(): boolean {
    // Any read-capable scope can serve search: drive.readonly is a superset of the legacy
    // drive.metadata.readonly grant, and full drive is a superset of drive.readonly.
    const granted = this.getSettings().grantedScopes;
    return (
      granted.includes(DRIVE_READONLY_SCOPE) ||
      granted.includes(DRIVE_METADATA_READONLY_SCOPE) ||
      granted.includes(DRIVE_FULL_SCOPE)
    );
  }

  // True with the full read scope — required for `drives.get` (real shared-drive names in paths).
  // kdr accepted the restricted drive.readonly scope for this on 2026-06-11 (D8 amendment); full
  // drive (the opt-in delete scope) also covers it.
  get hasDriveReadonlyScope(): boolean {
    const granted = this.getSettings().grantedScopes;
    return granted.includes(DRIVE_READONLY_SCOPE) || granted.includes(DRIVE_FULL_SCOPE);
  }

  // True once the user has both opted into and been granted full Drive access — the only state in
  // which the plugin can delete/edit files it didn't upload.
  get hasFullDriveScope(): boolean {
    return this.getSettings().grantedScopes.includes(DRIVE_FULL_SCOPE);
  }

  async connect(): Promise<string> {
    const settings = this.getSettings();
    if (!settings.clientId || !settings.clientSecret) {
      throw new Error("Please enter client ID and client secret first.");
    }

    const requestedScopes = this.getRequestedScopes();
    const { code, redirectUri, codeVerifier } = await this.waitForLoopbackCode(settings.clientId, requestedScopes);
    const tokens = await this.exchangeCode(code, settings.clientId, settings.clientSecret, redirectUri, codeVerifier);
    const email = await this.getAccountEmail(tokens.accessToken);

    this.cachedAccessToken = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    settings.accessToken = null; // memory-only; also scrubs a token persisted by older versions
    this.storeRefreshToken(settings, tokens.refreshToken);
    settings.tokenExpiry = tokens.expiresAt;
    settings.grantedScopes = getGrantedScopes(tokens.grantedScopes, settings.grantedScopes, requestedScopes);
    settings.accountEmail = email;
    await this.saveSettings();

    return email;
  }

  async disconnect(): Promise<void> {
    this.cachedAccessToken = null;
    const settings = this.getSettings();
    settings.accessToken = null;
    settings.refreshToken = null;
    settings.encryptedRefreshToken = null;
    settings.refreshTokenStorage = "plain";
    settings.tokenExpiry = null;
    settings.grantedScopes = [];
    settings.accountEmail = null;
    await this.saveSettings();
  }

  async getAccessToken(): Promise<string> {
    const settings = this.getSettings();
    const refreshToken = this.readRefreshToken(settings);
    if (!refreshToken) {
      throw new Error("Not authenticated. Please connect to Google Drive.");
    }

    if (settings.refreshToken !== null && settings.encryptedRefreshToken === null) {
      this.storeRefreshToken(settings, refreshToken);
      await this.saveSettings();
    }

    if (this.cachedAccessToken && Date.now() < this.cachedAccessToken.expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.cachedAccessToken.token;
    }

    // Migration: older versions persisted the access token in data.json. Use a still-valid one to
    // seed the memory cache, and scrub it from disk on the next save either way.
    if (settings.accessToken) {
      const legacyToken = settings.accessToken;
      settings.accessToken = null;
      if (settings.tokenExpiry && Date.now() < settings.tokenExpiry - TOKEN_REFRESH_SKEW_MS) {
        this.cachedAccessToken = { token: legacyToken, expiresAt: settings.tokenExpiry };
        await this.saveSettings();
        return legacyToken;
      }
    }

    if (!settings.clientId || !settings.clientSecret) {
      throw new Error("Missing Google OAuth client settings.");
    }

    const refreshed = await this.refreshAccessToken(
      refreshToken,
      settings.clientId,
      settings.clientSecret,
    );
    this.cachedAccessToken = { token: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    settings.tokenExpiry = refreshed.expiresAt;
    await this.saveSettings();

    return refreshed.accessToken;
  }

  private storeRefreshToken(settings: GoogleDriveAttachmentBridgeSettings, refreshToken: string): void {
    const stored = this.secretStore.store(refreshToken);
    settings.encryptedRefreshToken = stored.encryptedValue;
    settings.refreshToken = stored.plainValue;
    settings.refreshTokenStorage = stored.storage;
  }

  private readRefreshToken(settings: GoogleDriveAttachmentBridgeSettings): string | null {
    return this.secretStore.read(settings.encryptedRefreshToken, settings.refreshToken);
  }

  private getRequestedScopes(): string[] {
    // Opt-in full Drive access (delete/edit files the app didn't upload) supersedes drive.readonly,
    // so request [drive.file, drive] and drop the now-redundant readonly scope for a cleaner consent.
    if (this.getSettings().enableFullDriveAccess) {
      return [DRIVE_FILE_SCOPE, DRIVE_FULL_SCOPE];
    }
    // Always request the full Phase-1 scope set on connect. The search setting is now a
    // feature switch only; one consent covers Picker grants, uploads, search, and shared-drive paths.
    return [DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE];
  }

  private waitForLoopbackCode(clientId: string, scopes: string[]): Promise<LoopbackCode> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId: number | null = null;
      const state = randomToken();
      const codeVerifier = randomToken(64);
      const codeChallenge = pkceChallenge(codeVerifier);

      const server = createServer((request, response) => {
        const requestUrl = new URL(request.url ?? "", "http://127.0.0.1");
        const code = requestUrl.searchParams.get("code");
        const error = requestUrl.searchParams.get("error");

        if (error) {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end("<html><body><h2>Authorization failed.</h2><p>You can close this tab.</p></body></html>");
          finish(server, () => reject(new Error(`Auth error: ${error}`)));
          return;
        }

        if (code && requestUrl.searchParams.get("state") !== state) {
          response.writeHead(400, { "Content-Type": "text/html" });
          response.end("<html><body><h2>Authorization failed.</h2><p>State mismatch. You can close this tab.</p></body></html>");
          finish(server, () => reject(new Error("OAuth state mismatch (possible CSRF) — please try connecting again.")));
          return;
        }

        if (code) {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end("<html><body><h2>Authorization successful.</h2><p>You can close this tab and return to Obsidian.</p></body></html>");
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          finish(server, () => resolve({ code, redirectUri: `http://127.0.0.1:${port}`, codeVerifier }));
          return;
        }

        response.writeHead(404);
        response.end();
      });

      const finish = (targetServer: Server, done: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        this.cancelLoopback = null;
        targetServer.close();
        done();
      };

      // Expose a cancel hook for the settings UI's Cancel button (wrong-profile / changed-my-mind).
      this.cancelLoopback = () => finish(server, () => reject(new Error("Connect cancelled.")));

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const redirectUri = `http://127.0.0.1:${port}`;
        const authUrl = new URL(AUTH_URL);
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", scopes.join(" "));
        authUrl.searchParams.set("access_type", "offline");
        // select_account reliably shows the account chooser (so users can switch Google accounts, not
        // just silently re-consent the active one); consent forces the refresh-token-granting screen.
        authUrl.searchParams.set("prompt", "select_account consent");
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        const authUrlString = authUrl.toString();
        window.open(authUrlString);
        new Notice(
          `Opened Google Drive authorization in your browser. If it opened the wrong profile, paste this URL into the browser signed in to Drive: ${authUrlString}`,
          15000,
        );
      });

      timeoutId = window.setTimeout(() => {
        finish(server, () => reject(new Error("Auth timed out after 120 seconds.")));
      }, AUTH_TIMEOUT_MS);
    });
  }

  private async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<TokenSet> {
    const response = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }).toString(),
    });

    const json = response.json as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    if (!json.access_token || !json.refresh_token || !json.expires_in) {
      throw new Error("Google OAuth response did not include usable tokens.");
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
      grantedScopes: json.scope?.split(/\s+/).filter(Boolean) ?? [],
    };
  }

  private async refreshAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<RefreshResult> {
    const response = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    });

    const json = response.json as {
      access_token?: string;
      expires_in?: number;
    };

    if (!json.access_token || !json.expires_in) {
      throw new Error("Google OAuth refresh response did not include a usable access token.");
    }

    return {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
  }

  private async getAccountEmail(accessToken: string): Promise<string> {
    const response = await requestUrl({
      url: `${ABOUT_URL}?fields=user`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const json = response.json as {
      user?: { emailAddress?: string };
    };

    return json.user?.emailAddress ?? "unknown";
  }
}

function getGrantedScopes(explicitScopes: string[], previousScopes: string[], requestedScopes: string[]): string[] {
  if (explicitScopes.length > 0) {
    return explicitScopes;
  }

  const requested = new Set(requestedScopes);
  return previousScopes.filter((scope) => requested.has(scope));
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
