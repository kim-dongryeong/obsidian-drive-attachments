import { Notice } from "obsidian";
import { createServer, Server } from "http";
import { DrivePickerItem } from "./driveTypes";
import { GoogleDriveAttachmentBridgeSettings } from "./settings";

const PICKER_TIMEOUT_MS = 5 * 60_000;
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface PickOptions {
  foldersOnly?: boolean;
}

/**
 * System-browser Picker (Spike 1 fallback).
 *
 * The Google Picker cannot run inside Obsidian's `app://obsidian.md` renderer:
 * it browses Drive with the user's Google *session cookies*, which the Electron
 * partition does not have (it 401s and demands sign-in). So we run the Picker in
 * the user's real, already-logged-in browser, served from a localhost loopback
 * server, and the browser POSTs the chosen item back — the loopback pattern
 * proven by the OAuth flow in DriveAuthService.
 */
export class DrivePickerService {
  private abortActive: (() => void) | null = null;

  constructor(
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
  ) {}

  async pickFileOrFolder(accessToken: string, options?: PickOptions): Promise<DrivePickerItem | null> {
    const settings = this.getSettings();
    if (!settings.pickerApiKey || !settings.pickerAppId) {
      throw new Error("Enter the Google Picker API key and project number (App ID) in settings first.");
    }

    // Supersede any earlier pick still waiting — e.g. the user closed the browser
    // tab without choosing, which would otherwise leave the request hanging (and
    // the picker "in progress") until the timeout.
    if (this.abortActive) {
      this.abortActive();
    }

    const foldersOnly = options?.foldersOnly === true;

    return new Promise<DrivePickerItem | null>((resolve, reject) => {
      let settled = false;
      let timeoutId: number | null = null;

      const finish = (done: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        if (this.abortActive === abort) {
          this.abortActive = null;
        }
        server.close();
        done();
      };

      const abort = (): void => finish(() => resolve(null));

      const server: Server = createServer((request, response) => {
        const url = request.url ?? "/";

        if (request.method === "GET" && (url === "/" || url.startsWith("/?"))) {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end(renderPickerPage(accessToken, settings.pickerApiKey, settings.pickerAppId, foldersOnly));
          return;
        }

        if (request.method === "POST" && url === "/picked") {
          let body = "";
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            response.writeHead(200, { "Content-Type": "text/plain" });
            response.end("ok");
            try {
              const payload = JSON.parse(body || "{}") as {
                cancelled?: boolean;
                id?: string;
                name?: string;
                mimeType?: string;
                url?: string;
              };
              if (payload.cancelled) {
                finish(() => resolve(null));
              } else if (payload.id && payload.url) {
                finish(() =>
                  resolve({
                    id: String(payload.id),
                    name: String(payload.name ?? "Untitled"),
                    mimeType: String(payload.mimeType ?? ""),
                    webViewLink: String(payload.url),
                  }),
                );
              } else {
                finish(() => reject(new Error("Picker returned an unexpected payload.")));
              }
            } catch (error) {
              finish(() => reject(error instanceof Error ? error : new Error(String(error))));
            }
          });
          return;
        }

        response.writeHead(404);
        response.end();
      });

      this.abortActive = abort;
      server.on("error", (error) => finish(() => reject(error)));

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const pickerUrl = `http://127.0.0.1:${port}/`;
        window.open(pickerUrl);
        new Notice(
          `Opened the Drive picker in your browser. If it opened the wrong browser/profile, paste this URL into the browser signed in to Drive: ${pickerUrl}`,
          8000,
        );
      });

      timeoutId = window.setTimeout(() => {
        finish(() => {
          console.warn("Drive picker timed out after 5 minutes; treating it as a silent cancel.");
          resolve(null);
        });
      }, PICKER_TIMEOUT_MS);
    });
  }
}

function renderPickerPage(token: string, apiKey: string, appId: string, foldersOnly: boolean): string {
  const config = JSON.stringify({ token, apiKey, appId, foldersOnly, folderMime: FOLDER_MIME });
  const what = foldersOnly ? "folder" : "file";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Pick a Google Drive ${what}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem; color: #2b2b2b; }
    #status { color: #555; }
  </style>
</head>
<body>
  <h2 id="title">Opening Google Drive ${what} picker…</h2>
  <p id="status">If nothing appears, make sure this browser/profile is signed in to the same Google account.</p>
  <script src="https://apis.google.com/js/api.js"></script>
  <script>
    var CONFIG = ${config};
    function report(payload) {
      fetch('/picked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function () {
        document.getElementById('title').textContent = 'Done';
        document.getElementById('status').textContent =
          'Selection sent to Obsidian — you can close this tab.';
      });
    }
    gapi.load('picker', function () {
      try {
        var builder = new google.picker.PickerBuilder()
          .setOAuthToken(CONFIG.token)
          .setDeveloperKey(CONFIG.apiKey)
          .setAppId(CONFIG.appId);
        var setViewLabel = function (view, label) {
          try {
            if (typeof view.setLabel === 'function') {
              return view.setLabel(label);
            }
          } catch (labelErr) {
            // setLabel isn't supported in this Picker build — fall back to the unlabeled view (the
            // Picker shows its own default nav name); the tab still switches, which is what matters.
          }
          return view;
        };
        // Add each filter as its own top-level navigation tab via addView. Earlier this wrapped every
        // view in a single-child ViewGroup (a control meant for NESTING several views under one
        // expandable heading), which rendered the tabs but did not re-query when you clicked them —
        // the "Shared drives / Starred tabs do not change the files" bug. One addView per view is the
        // standard pattern and lets each view filter (parent / starred / shared) drive its own grid.
        var addLabeledView = function (builder, label, view) {
          builder.addView(setViewLabel(view, label));
        };
        if (CONFIG.foldersOnly) {
          // Use ViewId.DOCS (NOT FOLDERS) mime-restricted to folders. Multiple FOLDERS views share one
          // ViewId and the Picker won't re-query when you switch between them — kdr's live find: the
          // file picker's DOCS tabs switch, the folder picker's FOLDERS tabs didn't. A DOCS view pinned
          // with setParent('root') is still navigable (you click into subfolders), and setMimeTypes to
          // the folder type keeps it folders-only + selectable, matching the working file picker.
          // (setParent and setEnableDrives are mutually exclusive per view; the Picker API has no
          // Computers view.) Each view is added independently so one unsupported variant can't break
          // the whole picker.
          var folderView = function (configure) {
            var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
              .setIncludeFolders(true)
              .setSelectFolderEnabled(true)
              .setMimeTypes(CONFIG.folderMime);
            return configure(view);
          };
          var added = 0;
          [
            { label: 'My Drive', configure: function (v) { return v.setParent('root'); } },
            { label: 'Shared drives', configure: function (v) { return v.setEnableDrives(true); } },
            { label: 'Shared with me', configure: function (v) { return v.setOwnedByMe(false); } },
            { label: 'Starred', configure: function (v) { return v.setStarred(true); } },
          ].forEach(function (entry) {
            try {
              addLabeledView(builder, entry.label, folderView(entry.configure));
              added++;
            } catch (viewErr) {
              // Skip the unsupported view; the remaining tabs still work.
            }
          });
          if (added === 0) {
            throw new Error('No folder view could be created.');
          }
          builder.enableFeature(google.picker.Feature.SUPPORT_DRIVES);
        } else {
          // Same treatment as the folder picker: a single unpinned DOCS view dumps
          // everything in one flat recency-ordered list (kdr's live find). Pin one
          // view to the My Drive root for navigable hierarchy and add the standard
          // filter tabs; the plain recency view stays first as "Recent". (setParent
          // and setEnableDrives are mutually exclusive per view; the Picker API has
          // no Computers view.) Views are added independently so one unsupported
          // variant cannot break the whole picker.
          var fileView = function (configure) {
            var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
              .setIncludeFolders(true)
              .setSelectFolderEnabled(true);
            return configure(view);
          };
          var addedFileViews = 0;
          [
            { label: 'Recent', configure: function (v) { return v; } },
            { label: 'My Drive', configure: function (v) { return v.setParent('root'); } },
            { label: 'Shared drives', configure: function (v) { return v.setEnableDrives(true); } },
            { label: 'Shared with me', configure: function (v) { return v.setOwnedByMe(false); } },
            { label: 'Starred', configure: function (v) { return v.setStarred(true); } },
          ].forEach(function (entry) {
            try {
              addLabeledView(builder, entry.label, fileView(entry.configure));
              addedFileViews++;
            } catch (viewErr) {
              // Skip the unsupported view; the remaining tabs still work.
            }
          });
          if (addedFileViews === 0) {
            throw new Error('No file view could be created.');
          }
          builder.enableFeature(google.picker.Feature.SUPPORT_DRIVES);
        }
        var picker = builder
          .setCallback(function (data) {
            var action = data[google.picker.Response.ACTION];
            if (action === google.picker.Action.PICKED) {
              var doc = data[google.picker.Response.DOCUMENTS][0];
              report({
                id: doc[google.picker.Document.ID],
                name: doc[google.picker.Document.NAME],
                mimeType: doc[google.picker.Document.MIME_TYPE],
                url: doc[google.picker.Document.URL],
              });
            } else if (action === google.picker.Action.CANCEL) {
              report({ cancelled: true });
            }
          })
          .build();
        picker.setVisible(true);
      } catch (err) {
        document.getElementById('status').textContent = 'Picker error: ' + err;
      }
    });
  </script>
</body>
</html>`;
}
