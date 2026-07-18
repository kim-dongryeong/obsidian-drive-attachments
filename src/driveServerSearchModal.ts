import { App, Editor, Notice, setIcon, SuggestModal } from "obsidian";
import { DriveAuthService } from "./driveAuthService";
import { DriveMetadataService } from "./driveMetadataService";
import { DrivePreviewService } from "./drivePreviewService";
import { openDriveItemMenu } from "./driveRowActions";
import { renderDriveResultHint, renderSearchHighlights } from "./driveSearchModal";
import { DriveSearchResult, DriveSearchService } from "./driveSearchService";
import { InsertService } from "./insertService";
import { GoogleDriveAttachmentBridgeSettings } from "./settings";

const SEARCH_DEBOUNCE_MS = 250;

export class DriveServerSearchModal extends SuggestModal<DriveSearchResult> {
  private pendingTimer: number | null = null;
  private pendingResolve: ((results: DriveSearchResult[]) => void) | null = null;
  private searchGeneration = 0;
  private lastSearchErrorNotice: string | null = null;
  // Drive paths are resolved lazily per rendered row (an extra parents walk per hit) and cached for
  // the modal's lifetime so re-renders / repeated hits across queries never re-fetch. `resolvedPaths`
  // holds settled values (string path or null = no path); `pendingPaths` memoizes the in-flight walk
  // so concurrent renders of the same id share one request.
  private readonly resolvedPaths = new Map<string, string | null>();
  private readonly pendingPaths = new Map<string, Promise<string | null>>();

  constructor(
    app: App,
    private readonly editor: Editor,
    private readonly auth: DriveAuthService,
    private readonly search: DriveSearchService,
    private readonly metadata: DriveMetadataService,
    private readonly insert: InsertService,
    private readonly preview: DrivePreviewService,
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
  ) {
    super(app);
    this.limit = 50;
    this.setPlaceholder("Search Google Drive by name...");
    this.emptyStateText = "Type a file or folder name.";
  }

  getSuggestions(query: string): Promise<DriveSearchResult[]> {
    // Cancel any in-flight/scheduled search first. Clearing or invalidating the query
    // (empty text, search disabled, missing scope) must also invalidate a previously
    // scheduled query — otherwise its debounce timer still fires and a stale result or
    // error Notice surfaces after the box has already been cleared.
    this.cancelPendingSearch();
    // Drop any "more matches" footer from the previous query so it never lingers over a
    // narrower/cleared search; the completed-search branch re-sets it when still relevant.
    this.setMoreResultsHint(false);

    if (!this.getSettings().enableDriveSearch) {
      this.emptyStateText = this.auth.isConnected
        ? "Enable in-Obsidian Drive search in settings."
        : "Enable in-Obsidian Drive search in settings, then connect Google Drive.";
      return Promise.resolve([]);
    }

    if (!this.auth.hasDriveSearchScope) {
      // `hasDriveSearchScope` reads false in two distinct states — never connected, or
      // connected with a legacy grant that lacks Drive read access. Split on `isConnected`
      // to point the user at the matching settings control.
      this.emptyStateText = this.auth.isConnected
        ? "Grant Drive read access in settings to use in-Obsidian search."
        : "Connect Google Drive in settings to use in-Obsidian search.";
      return Promise.resolve([]);
    }

    const trimmed = query.trim();
    if (!trimmed) {
      this.emptyStateText = "Type a file or folder name.";
      return Promise.resolve([]);
    }

    this.emptyStateText = "Searching Google Drive...";

    const generation = ++this.searchGeneration;
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.pendingTimer = window.setTimeout(() => {
        void (async () => {
        this.pendingTimer = null;
        this.pendingResolve = null;

        try {
          const response = await this.search.searchByName(trimmed);
          if (generation !== this.searchGeneration) {
            resolve([]);
            return;
          }
          this.lastSearchErrorNotice = null;
          const { matchedCount, results, hasMore } = response;
          // Only meaningful when the page actually rendered rows: if every match was filtered
          // out as unlinkable the empty-state below already explains it, so don't also claim
          // "more matches exist".
          this.setMoreResultsHint(hasMore && results.length > 0);
          // A completed search is no longer "in progress": only the empty result needs an
          // empty-state message, and it must say "No Drive files found." rather than reuse
          // the in-flight "Searching..." text (line 53) — leaving that on a finished search
          // would falsely imply a query is still running if the list ever renders empty.
          if (results.length === 0) {
            this.emptyStateText =
              matchedCount > 0
                ? "Drive found matches, but none have a usable link."
                : "No Drive files found.";
          }
          resolve(results);
        } catch (error) {
          if (generation === this.searchGeneration) {
            const message = error instanceof Error ? error.message : String(error);
            this.emptyStateText = message;
            if (message !== this.lastSearchErrorNotice) {
              this.lastSearchErrorNotice = message;
              new Notice(message);
            }
          }
          resolve([]);
        }
        })();
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  renderSuggestion(value: DriveSearchResult, el: HTMLElement): void {
    const container = el.createDiv({ cls: "gdab-drive-search-result" });
    const main = container.createDiv({ cls: "gdab-drive-search-result-main" });
    const nameEl = main.createDiv({ cls: "gdab-drive-search-result-name" });
    renderSearchHighlights(value.name, this.inputEl.value, nameEl);
    const settings = this.getSettings();
    renderDriveResultHint(value, main, settings.enableTypeIcons, undefined, settings.iconTheme);
    this.renderResultPath(value, main);
    this.renderActionButton(value, container);
  }

  private renderActionButton(item: DriveSearchResult, container: HTMLElement): void {
    const actions = container.createDiv({ cls: "gdab-drive-search-result-actions" });
    const moreButton = actions.createDiv({
      cls: "clickable-icon gdab-drive-search-result-action",
      attr: { "aria-label": `More actions for ${item.name}`, role: "button", tabindex: "0" },
    });
    setIcon(moreButton, "more-vertical");
    moreButton.addEventListener("click", (evt) => {
      evt.stopPropagation();
      openDriveItemMenu(evt, item, {
        app: this.app,
        insert: this.insert,
        preview: this.preview,
        resolveEditor: () => ({ editor: this.editor, file: this.app.workspace.getActiveFile() }),
      });
    });
  }

  // Show the Drive folder path under each hit's type. Resolution is async (walks the hit's parents)
  // and best-effort: a resolved path renders below the hint, a null/failed lookup renders nothing so
  // it never clutters or implies a fake location. The `.then` may run after a re-render detached this
  // row — `setText`/`remove` on an orphaned element is harmless.
  private renderResultPath(value: DriveSearchResult, container: HTMLElement): void {
    if (this.resolvedPaths.has(value.id)) {
      const cached = this.resolvedPaths.get(value.id) ?? null;
      if (cached) {
        const pathEl = container.createDiv({ cls: "gdab-drive-search-result-path" });
        this.renderPathContent(pathEl, cached);
      }
      return;
    }

    const pathEl = container.createDiv({ cls: "gdab-drive-search-result-path" });
    void this.resolveResultPath(value).then((path) => {
      if (path) {
        this.renderPathContent(pathEl, path);
      } else {
        pathEl.remove();
      }
    });
  }

  private renderPathContent(pathEl: HTMLElement, path: string): void {
    renderSearchHighlights(path, this.inputEl.value, pathEl);
  }

  private resolveResultPath(value: DriveSearchResult): Promise<string | null> {
    let pending = this.pendingPaths.get(value.id);
    if (!pending) {
      pending = this.metadata
        .resolveDrivePathByParents(value.parents)
        .catch(() => null)
        .then((path) => {
          this.resolvedPaths.set(value.id, path);
          return path;
        });
      this.pendingPaths.set(value.id, pending);
    }
    return pending;
  }

  onChooseSuggestion(item: DriveSearchResult): void {
    this.insert.insertDriveItemAtCursor(this.editor, item, this.app.workspace.getActiveFile()).catch((error) => {
      new Notice(`Insert Drive link failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  onClose(): void {
    this.cancelPendingSearch();
    super.onClose();
  }

  private setMoreResultsHint(show: boolean): void {
    // The modal renders at most `this.limit` rows and the service fetches a single page, so
    // when Drive reports further matches exist (nextPageToken) the extras are silently
    // dropped. Surface that in the instruction footer so the user narrows the query instead of
    // assuming these are all the matches. Passing `[]` clears the footer.
    this.setInstructions(
      show ? [{ command: "", purpose: "More matches exist — refine your search to narrow the results." }] : [],
    );
  }

  private cancelPendingSearch(): void {
    this.searchGeneration += 1;
    if (this.pendingTimer !== null) {
      window.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.pendingResolve) {
      this.pendingResolve([]);
      this.pendingResolve = null;
    }
  }
}
