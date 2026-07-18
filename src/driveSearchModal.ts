import { App, Editor, FuzzyMatch, FuzzySuggestModal, Notice, setIcon } from "obsidian";
import { CustomFileIconResolver, renderFileIcon } from "./driveFileIcon";
import { DriveAuthService } from "./driveAuthService";
import { DriveIndexItem, DriveIndexProgress, DriveIndexService } from "./driveIndexService";
import { DriveMetadataService } from "./driveMetadataService";
import { DrivePreviewService } from "./drivePreviewService";
import { openDriveItemMenu } from "./driveRowActions";
import { DriveSearchResult, DriveSearchService } from "./driveSearchService";
import { DRIVE_FOLDER_MIME_TYPE } from "./driveTypes";
import { InsertService } from "./insertService";
import { GoogleDriveAttachmentBridgeSettings } from "./settings";

// Hybrid server search: render the instant in-memory (index) search synchronously, then also run a
// one-page server `name contains` search and merge any new hits into the list, so files beyond the
// index page cap — or added to Drive since the last index — are still findable.
// Best-effort + non-blocking: the in-memory matches render instantly; server hits fill in async.
const SERVER_FALLBACK_DEBOUNCE_MS = 400;
const SERVER_FALLBACK_MIN_QUERY_LENGTH = 2;
const MAX_HIGHLIGHT_SCAN_LENGTH = 5_000;

// Path search (Everything-style), used only when path search is ON. Non-letter/number chars are
// stripped before matching, so punctuation and separators (`/`, `-`, `_`, `.`, `(`, `)`, space, ...)
// are treated as equivalent ignorable boundaries. The query is split on whitespace into tokens and
// EACH token must be a substring of the stripped "name + path"; matching is therefore
// ORDER-INDEPENDENT and crosses the name↔path boundary, unlike the base in-order fuzzy subsequence
// match.
const PATH_SEARCH_SEPARATORS = /[^\p{L}\p{N}]+/gu;

function normalizePathSearchText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(PATH_SEARCH_SEPARATORS, "");
}

function tokenizePathSearchQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .map((token) => normalizePathSearchText(token))
    .filter((token) => token.length > 0);
}

export class DriveSearchModal extends FuzzySuggestModal<DriveIndexItem> {
  private loadGeneration = 0;
  private refreshTimer: number | null = null;
  // Item count at the last streaming repaint — skip a re-render when a poll tick brought no new items.
  private lastRefreshItemCount = 0;
  private lastIndexErrorNotice: string | null = null;
  private serverGeneration = 0;
  private serverFallbackTimer: number | null = null;
  private serverFallbackInFlight = false;
  // The term the pending debounce timer / in-flight request is for — same-term re-renders (index
  // streaming refresh) keep it instead of resetting the debounce. See maybeQueueServerFallback.
  private pendingServerTerm: string | null = null;
  private indexCapped = false;
  private indexProgressText: string | null = null;
  // Extra hits merged from the server fallback, kept for the modal's lifetime. `getItems()` unions
  // these with the live index (deduped by id) so they become fuzzy-matchable alongside index items.
  private readonly serverItems: DriveIndexItem[] = [];
  // Query terms already sent to the server this session. Re-querying the same term is wasteful and,
  // because a successful merge re-renders (re-entering `getSuggestions`), would otherwise loop on it.
  private readonly serverQueriedTerms = new Set<string>();
  // Drive paths are resolved lazily per rendered row (an extra parents walk per hit) and cached for
  // the modal's lifetime so re-renders / repeated hits across queries never re-fetch. `resolvedPaths`
  // holds settled values (string path or null = no path); `pendingPaths` memoizes the in-flight walk
  // so concurrent renders of the same id share one request.
  private readonly resolvedPaths = new Map<string, string | null>();
  private readonly pendingPaths = new Map<string, Promise<string | null>>();
  // True while the user is walking the list with ↑/↓. Streaming-index ticks re-render via
  // `refreshSuggestions()`, and a re-render resets the keyboard selection to the top — which made
  // ArrowDown "bounce" during indexing (kdr's live find). While navigating, hold those programmatic
  // re-renders; typing (a real query change) resets the flag and resumes them.
  private userNavigated = false;
  private lastQuery: string | null = null;

  constructor(
    app: App,
    private readonly editor: Editor,
    private readonly auth: DriveAuthService,
    private readonly index: DriveIndexService,
    private readonly search: DriveSearchService,
    private readonly metadata: DriveMetadataService,
    private readonly insert: InsertService,
    private readonly preview: DrivePreviewService,
    private readonly getSettings: () => GoogleDriveAttachmentBridgeSettings,
    private readonly customIconSrc?: CustomFileIconResolver,
  ) {
    super(app);
    this.limit = 200;
    this.setPlaceholder("Search Google Drive...");
    this.emptyStateText = "Indexing Drive...";
    // Track ↑/↓ navigation: while the user is walking the list, programmatic re-renders
    // (streaming index ticks) must not reset the keyboard selection back to the top.
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        this.userNavigated = true;
      }
    });
  }

  onOpen(): void {
    void super.onOpen();
    this.startIndexLoad();
  }

  getItems(): DriveIndexItem[] {
    if (!this.getSettings().enableDriveSearch) {
      this.emptyStateText = this.auth.isConnected
        ? "Enable in-Obsidian Drive search in settings."
        : "Enable in-Obsidian Drive search in settings, then connect Google Drive.";
      return [];
    }

    if (!this.auth.hasDriveSearchScope) {
      // `hasDriveSearchScope` reads false in two distinct states — never connected, or
      // connected with a legacy grant that lacks Drive read access. Split on `isConnected`
      // to point the user at the matching settings control.
      this.emptyStateText = this.auth.isConnected
        ? "Grant Drive read access in settings to use in-Obsidian search."
        : "Connect Google Drive in settings to use in-Obsidian search.";
      return [];
    }

    const state = this.index.getState();
    const progress = this.index.getProgress();
    this.setIndexProgress(progress);
    if (state.lastError) {
      this.emptyStateText = state.lastError;
    } else if (state.isLoading) {
      this.emptyStateText = formatDriveIndexProgress(progress);
    } else if (state.lastLoadedAt !== null) {
      this.emptyStateText = `No Drive files found. ${formatDriveIndexProgress(progress)}`;
    } else {
      this.emptyStateText = formatDriveIndexProgress(progress);
    }

    return this.mergeServerItems(state.items);
  }

  // Union the live index with server-fallback hits, dropping any server hit whose id is already in
  // the index (it may have been built/refreshed since the hit was merged). Index items come first so
  // the fast in-memory results keep their order; server-only hits append.
  private mergeServerItems(indexItems: DriveIndexItem[]): DriveIndexItem[] {
    if (this.serverItems.length === 0) {
      return indexItems;
    }
    const indexIds = new Set(indexItems.map((item) => item.id));
    const extras = this.serverItems.filter((item) => !indexIds.has(item.id));
    return extras.length > 0 ? [...indexItems, ...extras] : indexItems;
  }

  getItemText(item: DriveIndexItem): string {
    // Path search (Everything's Ctrl+U): include the index-precomputed folder path in the fuzzy-
    // matched text so a query can hit folder segments ("굿모닝 624" → …/굿모닝/수업스냅/DSC00624.JPG).
    // Items without a path (server-fallback hits, rows streamed mid-crawl, unresolvable chains)
    // match name-only; toggle off is exactly today's name-only behavior.
    if (this.getSettings().enablePathSearch && item.path) {
      return `${item.name} ${item.path}`.normalize("NFC");
    }
    return item.name.normalize("NFC");
  }

  getSuggestions(query: string): FuzzyMatch<DriveIndexItem>[] {
    // A real query change (typing) ends a ↑/↓ navigation hold; a same-query programmatic
    // re-render (streaming tick) does not.
    if (query !== this.lastQuery) {
      this.lastQuery = query;
      this.userNavigated = false;
    }
    // Keep the live-verified instant path untouched: render the in-memory matches synchronously,
    // then (best-effort, async) top up with a server query. Path search ON swaps the base in-order
    // fuzzy match for an order-independent token-AND substring match over "name + path"; OFF keeps
    // the live-verified name-only fuzzy behavior.
    const matches = this.getSettings().enablePathSearch
      ? this.getPathSearchSuggestions(query)
      // `getItemText` NFC-normalizes the haystack; normalize the query to match so the comparison is
      // symmetric (a query and a Drive name that differ only by NFC/NFD still hit). No-op for ASCII.
      : super.getSuggestions(query.normalize("NFC"));
    this.maybeQueueServerFallback(query);
    return matches;
  }

  // Everything-style matcher (path search ON only): split the query on whitespace and require EACH
  // token to be a separator-agnostic substring of the item's searchable text. `getItemText` returns
  // "name + path" while path search is ON, so a token can match a folder segment, the name, or span
  // both — and in any order. This is what lets `받았음 monthly lease`, `받았음 pdf`, and `받았음 .pdf`
  // all hit `…/받았음/…/monthly-lease-contract-Kevin.pdf`, which the in-order subsequence match (which
  // needs the query in document order) could not. Items with no resolved path (server-fallback hits,
  // rows streamed mid-crawl) match name-only via `getItemText`. Results keep the index order
  // (modifiedTime desc — newest first) and are capped at `this.limit`.
  private getPathSearchSuggestions(query: string): FuzzyMatch<DriveIndexItem>[] {
    const tokens = tokenizePathSearchQuery(query);
    const results: FuzzyMatch<DriveIndexItem>[] = [];
    for (const item of this.getItems()) {
      if (results.length >= this.limit) {
        break;
      }
      const haystack = normalizePathSearchText(this.getItemText(item));
      if (tokens.every((token) => haystack.includes(token))) {
        // Synthetic empty match: `renderSuggestion` renders name/path/hint itself and never reads
        // `match`, so no highlight ranges are needed.
        results.push({ item, match: { score: 0, matches: [] } });
      }
    }
    return results;
  }

  private maybeQueueServerFallback(query: string): void {
    const trimmed = query.trim();
    // A re-render with the SAME term must keep the pending debounce timer / in-flight request —
    // the index's 300ms streaming refresh re-enters here, and resetting the 400ms debounce each
    // time would mean the fallback never fires during a long cold crawl. Only a changed term
    // supersedes the pending one.
    if (
      trimmed === this.pendingServerTerm &&
      (this.serverFallbackTimer !== null || this.serverFallbackInFlight)
    ) {
      return;
    }

    // Any new query supersedes a pending server search (incl. clearing the box).
    this.cancelServerFallback();

    if (!this.getSettings().enableDriveSearch || !this.auth.hasDriveSearchScope) {
      return;
    }

    if (trimmed.length < SERVER_FALLBACK_MIN_QUERY_LENGTH) {
      return;
    }

    // Already fetched server hits for this exact term; they're in the pool, so don't re-query (this
    // is also what stops the merge → re-render → getSuggestions cycle from looping on one term).
    if (this.serverQueriedTerms.has(trimmed)) {
      return;
    }

    // Deliberately DO run while the index is still streaming (cold index): the server search is the
    // only source of complete results until the crawl settles, so waiting made the modal look empty
    // or stale right after startup. The index's 300ms refresh re-enters getSuggestions and resets the
    // debounce below, and serverQueriedTerms keeps one term to one server query, so streaming
    // refreshes can't stack duplicate requests.

    this.pendingServerTerm = trimmed;
    const generation = ++this.serverGeneration;
    this.serverFallbackTimer = window.setTimeout(() => {
      this.serverFallbackTimer = null;
      void this.runServerFallback(trimmed, generation);
    }, SERVER_FALLBACK_DEBOUNCE_MS);
  }

  private async runServerFallback(query: string, generation: number): Promise<void> {
    this.serverFallbackInFlight = true;
    this.renderFooterInstructions();

    let results: DriveSearchResult[];
    try {
      results = (await this.search.searchByName(query)).results;
    } catch {
      // Best-effort top-up: the in-memory matches are already shown, and the separate "server,
      // exact" command surfaces its own errors, so a failed fallback stays silent rather than
      // clobbering the instant results or stacking a Notice. A later keystroke can retry.
      if (generation === this.serverGeneration) {
        this.serverFallbackInFlight = false;
        this.renderFooterInstructions();
      }
      return;
    }

    if (generation !== this.serverGeneration) {
      return;
    }

    this.serverFallbackInFlight = false;
    this.renderFooterInstructions();

    // Mark the term fetched even when it returns nothing, so an empty term isn't re-queried.
    this.serverQueriedTerms.add(query);

    const knownServerIds = new Set(this.serverItems.map((item) => item.id));
    let added = false;
    for (const result of results) {
      if (!knownServerIds.has(result.id)) {
        this.serverItems.push(result);
        knownServerIds.add(result.id);
        added = true;
      }
    }

    if (added) {
      this.refreshSuggestions();
    }
  }

  private cancelServerFallback(): void {
    this.pendingServerTerm = null;
    this.serverGeneration += 1;
    if (this.serverFallbackTimer !== null) {
      window.clearTimeout(this.serverFallbackTimer);
      this.serverFallbackTimer = null;
    }
    if (this.serverFallbackInFlight) {
      this.serverFallbackInFlight = false;
      this.renderFooterInstructions();
    }
  }

  renderSuggestion(value: FuzzyMatch<DriveIndexItem>, el: HTMLElement): void {
    const item = value.item;
    const settings = this.getSettings();
    const container = el.createDiv({ cls: "gdab-drive-search-result" });

    // The type icon belongs next to the FILE NAME (drive.google.com / Finder style), not tucked
    // beside the "Google Sheet" / "Image" type label — it's a fixed 16px so it aligns cleanly.
    if (settings.enableTypeIcons) {
      const iconEl = container.createSpan({
        cls: "gdab-drive-search-result-icon gdab-drive-search-result-name-icon",
        attr: { "aria-hidden": "true" },
      });
      renderFileIcon(iconEl, item.mimeType, item.name, getDriveResultIcon(item), this.customIconSrc, settings.iconTheme);
    }

    const main = container.createDiv({ cls: "gdab-drive-search-result-main" });
    const nameEl = main.createDiv({ cls: "gdab-drive-search-result-name" });
    renderSearchHighlights(item.name, this.inputEl.value, nameEl);
    // The hint keeps just the type label now that the icon moved up to the name.
    renderDriveResultHint(item, main, false);
    this.renderResultPath(item, main);
    this.renderActionButton(item, container);
  }

  private renderActionButton(item: DriveIndexItem, container: HTMLElement): void {
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

  // Show the Drive folder path under each hit's type. Index hits carry a precomputed `path`
  // (computeItemPaths) — render it synchronously with zero network. Only pathless hits (server
  // fallback, rows streamed mid-crawl) fall to the async parent walk, which is best-effort: a
  // resolved path renders below the hint, a null/failed lookup renders nothing so it never clutters
  // or implies a fake location. The `.then` may run after a re-render detached this row —
  // `setText`/`remove` on an orphaned element is harmless.
  private renderResultPath(value: DriveIndexItem, container: HTMLElement): void {
    if (value.path) {
      const pathEl = container.createDiv({ cls: "gdab-drive-search-result-path" });
      this.renderPathContent(pathEl, value.path);
      return;
    }

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

  // Render the folder path with the same DOM-built helper as the name (injection-safe, no innerHTML).
  // The literal whitespace-token highlighter is the agreed minimum for the separator-agnostic matcher:
  // it marks tokens that literally appear; a token that only matched after separator-stripping (e.g.
  // "monthlylease" vs "monthly-lease") simply highlights nothing rather than guessing a span.
  private renderPathContent(pathEl: HTMLElement, path: string): void {
    renderSearchHighlights(path, this.inputEl.value, pathEl);
  }

  private resolveResultPath(value: DriveIndexItem): Promise<string | null> {
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

  onChooseItem(item: DriveIndexItem): void {
    const sourceFile = this.app.workspace.getActiveFile();
    // Previewable files (image/video/pdf) embed inline by default; everything else follows the
    // configured link format (asset-note wikilink / inline link).
    const embed = isEmbeddablePreviewMime(item.mimeType ?? "");
    const inserted = embed
      ? this.insert.insertDriveItemAsEmbedAtCursor(this.editor, item, sourceFile)
      : this.insert.insertDriveItemAtCursor(this.editor, item, sourceFile);
    inserted.catch((error) => {
      new Notice(`Insert Drive ${embed ? "embed" : "link"} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  onClose(): void {
    this.loadGeneration += 1;
    this.stopRefreshTimer();
    this.cancelServerFallback();
    super.onClose();
  }

  private setCappedHint(show: boolean): void {
    this.indexCapped = show;
    this.renderFooterInstructions();
  }

  private setIndexProgress(progress: DriveIndexProgress): void {
    this.indexProgressText = formatDriveIndexProgress(progress);
    this.setCappedHint(progress.capped);
  }

  private renderFooterInstructions(): void {
    const instructions: { command: string; purpose: string }[] = [];
    if (this.indexProgressText) {
      instructions.push({ command: "", purpose: this.indexProgressText });
    }
    if (this.serverFallbackInFlight) {
      instructions.push({ command: "", purpose: "Searching Drive..." });
    }
    if (this.indexCapped) {
      instructions.push({ command: "", purpose: "Index page cap reached — older files aren't indexed. Raise the index page limit in settings." });
    }
    this.setInstructions(instructions);
  }

  private startIndexLoad(): void {
    if (!this.getSettings().enableDriveSearch || !this.auth.hasDriveSearchScope) {
      return;
    }

    const generation = ++this.loadGeneration;
    this.startRefreshTimer();
    this.index.ensureLoaded()
      .then(() => {
        if (generation === this.loadGeneration) {
          this.lastIndexErrorNotice = null;
          this.stopRefreshTimer();
          this.refreshSuggestions();
        }
      })
      .catch((error: unknown) => {
        if (generation !== this.loadGeneration) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.emptyStateText = message;
        this.stopRefreshTimer();
        if (message !== this.lastIndexErrorNotice) {
          this.lastIndexErrorNotice = message;
          new Notice(message);
        }
        this.refreshSuggestions();
      });
  }

  private refreshSuggestions(): void {
    // Hold programmatic re-renders while the user is arrow-key navigating: re-rendering resets the
    // selection to the top. New items appear on the next keystroke (or the next open).
    if (this.userNavigated) {
      return;
    }
    // Belt-and-suspenders: even when a re-render does run, restore the previous keyboard selection
    // afterwards (clamped), so no re-render path — present or future — can bounce it back to row 1.
    const chooser = (
      this as unknown as {
        chooser?: { selectedItem?: number; suggestions?: unknown[]; setSelectedItem?: (i: number) => void };
      }
    ).chooser;
    const previous = typeof chooser?.selectedItem === "number" ? chooser.selectedItem : 0;
    // A re-render also rebuilds the scrollable results container from scratch, snapping it back to
    // the top — infuriating when the user has mouse-scrolled partway down while the index streams.
    // Capture the scroll offset and put it back after the repaint (the arrow-key path is already
    // covered by userNavigated above; this covers passive scroll-and-read).
    const prevScrollTop = this.resultContainerEl?.scrollTop ?? 0;
    this.inputEl.dispatchEvent(new Event("input"));
    if (previous > 0 && chooser?.setSelectedItem && Array.isArray(chooser.suggestions) && chooser.suggestions.length > 0) {
      chooser.setSelectedItem(Math.min(previous, chooser.suggestions.length - 1));
    }
    if (prevScrollTop > 0 && this.resultContainerEl) {
      this.resultContainerEl.scrollTop = prevScrollTop;
    }
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer();
    this.lastRefreshItemCount = this.index.getProgress().itemCount;
    this.refreshTimer = window.setInterval(() => {
      const progress = this.index.getProgress();
      this.setIndexProgress(progress);
      const finished = !progress.isLoading;
      if (finished) {
        this.stopRefreshTimer();
      }
      // Only repaint the list when the index actually grew (or the crawl just finished): a full
      // re-render on every tick with no new items just blinks the existing rows for nothing.
      if (progress.itemCount !== this.lastRefreshItemCount || finished) {
        this.lastRefreshItemCount = progress.itemCount;
        this.refreshSuggestions();
      }
    }, 300);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

function formatDriveIndexProgress(progress: DriveIndexProgress): string {
  const itemLabel = `${progress.itemCount.toLocaleString()} ${progress.itemCount === 1 ? "item" : "items"}`;
  const pageLabel = `${progress.loadedPages.toLocaleString()} ${progress.loadedPages === 1 ? "page" : "pages"}`;

  if (progress.lastError) {
    return progress.lastError;
  }

  if (progress.isLoading) {
    return `Indexing Drive... ${itemLabel} across ${pageLabel}.`;
  }

  if (progress.lastLoadedAt !== null) {
    const capHint = progress.capped ? " Page cap reached — raise the index page limit in settings for older files." : "";
    return `Indexed ${itemLabel} ${formatFreshness(progress.lastLoadedAt)}.${capHint}`;
  }

  return "Indexing Drive... waiting for the first page.";
}

function formatFreshness(timestamp: number): string {
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  if (elapsedMs < 60_000) {
    return "just now";
  }
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} hr ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} d ago`;
}

export function renderSearchHighlights(text: string, query: string, container: HTMLElement): void {
  const normalizedText = text.normalize("NFC");
  const ranges = getSearchHighlightRanges(normalizedText, query);
  if (ranges.length === 0) {
    container.setText(normalizedText);
    return;
  }

  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      container.appendText(normalizedText.slice(cursor, range.start));
    }
    container.createSpan({
      cls: `gdab-search-hl gdab-search-hl-${range.colorIndex % SEARCH_HIGHLIGHT_PALETTE_SIZE}`,
      text: normalizedText.slice(range.start, range.end),
    });
    cursor = range.end;
  }
  if (cursor < normalizedText.length) {
    container.appendText(normalizedText.slice(cursor));
  }
}

const SEARCH_HIGHLIGHT_PALETTE_SIZE = 6;

type SearchHighlightRange = { start: number; end: number; colorIndex: number };

function getSearchHighlightRanges(text: string, query: string): SearchHighlightRange[] {
  const scanText = text.slice(0, MAX_HIGHLIGHT_SCAN_LENGTH);
  const lowerText = scanText.toLowerCase();
  const tokens = getSearchHighlightTokens(query);
  const ranges: SearchHighlightRange[] = [];

  tokens.forEach((token, colorIndex) => {
    let start = 0;
    while (start < lowerText.length) {
      const index = lowerText.indexOf(token, start);
      if (index === -1) {
        break;
      }
      ranges.push({ start: index, end: index + token.length, colorIndex });
      start = index + token.length;
    }
  });

  return getNonOverlappingHighlightRanges(ranges);
}

function getSearchHighlightTokens(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of query.trim().split(/\s+/)) {
    const normalized = token.normalize("NFC").toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      tokens.push(normalized);
    }
  }
  return tokens;
}

function getNonOverlappingHighlightRanges(ranges: SearchHighlightRange[]): SearchHighlightRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start));
  const selected: SearchHighlightRange[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start >= cursor) {
      selected.push(range);
      cursor = range.end;
    }
  }
  return selected;
}

export function getDriveResultHint(value: Pick<DriveIndexItem, "mimeType">): string {
  if (value.mimeType === DRIVE_FOLDER_MIME_TYPE) {
    return "Google Drive folder";
  }

  const googleWorkspaceType = GOOGLE_WORKSPACE_MIME_HINTS[value.mimeType];
  if (googleWorkspaceType) {
    return googleWorkspaceType;
  }

  if (value.mimeType === "application/pdf") {
    return "PDF";
  }

  const [category] = value.mimeType.split("/");
  if (category === "image") {
    return "Image";
  }
  if (category === "audio") {
    return "Audio";
  }
  if (category === "video") {
    return "Video";
  }

  return "Google Drive file";
}

export function getDriveResultTypeClass(value: Pick<DriveIndexItem, "mimeType">): string {
  if (value.mimeType === DRIVE_FOLDER_MIME_TYPE) {
    return "gdab-type-folder";
  }

  const googleWorkspaceType = GOOGLE_WORKSPACE_TYPE_CLASSES[value.mimeType];
  if (googleWorkspaceType) {
    return googleWorkspaceType;
  }

  if (value.mimeType === "application/pdf") {
    return "gdab-type-pdf";
  }

  const [category] = value.mimeType.split("/");
  if (category === "image") {
    return "gdab-type-image";
  }
  if (category === "audio") {
    return "gdab-type-audio";
  }
  if (category === "video") {
    return "gdab-type-video";
  }

  return "gdab-type-file";
}

// Files that render a real inline preview (so search→insert embeds them by default). HEIC is an
// image MIME but Obsidian can't decode it inline, so it's excluded (it'd only show a thumbnail card).
export function isEmbeddablePreviewMime(mimeType: string): boolean {
  if (mimeType.startsWith("image/")) {
    return !/^image\/hei[cf]/i.test(mimeType);
  }
  return mimeType.startsWith("video/") || mimeType === "application/pdf";
}

export function getDriveResultIcon(value: Pick<DriveIndexItem, "mimeType" | "name">): string {
  if (value.mimeType === DRIVE_FOLDER_MIME_TYPE) {
    return "folder";
  }

  const googleWorkspaceIcon = GOOGLE_WORKSPACE_TYPE_ICONS[value.mimeType];
  if (googleWorkspaceIcon) {
    return googleWorkspaceIcon;
  }

  // Casing varies across upload paths (the registered Excel-macro type spells it
  // ".macroEnabled.12" while Drive usually reports lowercase), so look up case-insensitively.
  const knownBinaryIcon = KNOWN_BINARY_TYPE_ICONS[value.mimeType.toLowerCase()];
  if (knownBinaryIcon) {
    return knownBinaryIcon;
  }

  if (value.mimeType === "application/pdf") {
    return "file-type";
  }

  const [category] = value.mimeType.split("/");
  if (category === "image") {
    return "image";
  }
  if (category === "audio") {
    return "file-audio";
  }
  if (category === "video") {
    return "film";
  }

  return getGenericFileIconByExtension(value.name);
}

export function renderDriveResultHint(
  value: Pick<DriveIndexItem, "mimeType" | "name">,
  container: HTMLElement,
  enableTypeIcons: boolean,
  customIconSrc?: CustomFileIconResolver,
  iconTheme: GoogleDriveAttachmentBridgeSettings["iconTheme"] = "default",
): void {
  const hintEl = container.createDiv({
    cls: `gdab-drive-search-result-hint ${getDriveResultTypeClass(value)}${enableTypeIcons ? " has-icon" : ""}`,
  });

  if (!enableTypeIcons) {
    hintEl.setText(getDriveResultHint(value));
    return;
  }

  const iconEl = hintEl.createSpan({
    cls: "gdab-drive-search-result-icon",
    attr: { "aria-hidden": "true" },
  });
  renderFileIcon(
    iconEl,
    value.mimeType,
    value.name,
    getDriveResultIcon(value),
    customIconSrc,
    iconTheme,
  );
  hintEl.createSpan({ text: getDriveResultHint(value) });
}

function getGenericFileIconByExtension(fileName: string): string {
  const extension = getFileExtension(fileName);
  const knownBinaryIcon = KNOWN_BINARY_EXTENSION_ICONS[extension];
  if (knownBinaryIcon) {
    return knownBinaryIcon;
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return "file-archive";
  }
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    return "package";
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return "file-code";
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return "file-text";
  }
  if (FONT_EXTENSIONS.has(extension)) {
    return "type";
  }
  return "file";
}

function getFileExtension(fileName: string): string {
  const trimmed = fileName.trim().toLowerCase();
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
    return "";
  }
  return trimmed.slice(dotIndex + 1);
}

const ARCHIVE_EXTENSIONS = new Set(["zip", "7z", "rar", "dmg", "tar", "gz"]);
const EXECUTABLE_EXTENSIONS = new Set(["exe", "app", "pkg", "msi"]);
const CODE_EXTENSIONS = new Set(["html", "css", "js", "ts", "json", "xml", "yml"]);
const TEXT_EXTENSIONS = new Set(["md", "txt", "csv"]);
const FONT_EXTENSIONS = new Set(["ttf", "otf", "woff2"]);

// Office/Hancom/Illustrator/Android binaries Drive stores as-is. Keys are lowercase (the
// lookup lowercases too). The extension map is the safety net for files whose mimeType
// arrives generic (application/octet-stream) or vendor-quirky — .ai in particular usually
// surfaces as application/postscript, which stays unmapped so .ps/.eps aren't mislabeled.
const KNOWN_BINARY_TYPE_ICONS: Record<string, string> = {
  "application/msword": "file-text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "file-text",
  "application/vnd.ms-powerpoint": "presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation",
  "application/vnd.ms-excel": "table",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "table",
  "application/vnd.ms-excel.sheet.macroenabled.12": "table",
  "application/x-hwp": "file-text",
  "application/haansofthwp": "file-text",
  "application/vnd.hancom.hwp": "file-text",
  "application/vnd.hancom.hwpx": "file-text",
  "application/illustrator": "pen-tool",
  "application/vnd.android.package-archive": "smartphone",
};

const KNOWN_BINARY_EXTENSION_ICONS: Record<string, string> = {
  doc: "file-text",
  docx: "file-text",
  ppt: "presentation",
  pptx: "presentation",
  xls: "table",
  xlsx: "table",
  xlsm: "table",
  hwp: "file-text",
  hwpx: "file-text",
  ai: "pen-tool",
  apk: "smartphone",
};

const GOOGLE_WORKSPACE_MIME_HINTS: Record<string, string> = {
  "application/vnd.google-apps.audio": "Google Drive audio",
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.file": "Google Drive file",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.fusiontable": "Google Fusion Table",
  "application/vnd.google-apps.jam": "Google Jam",
  "application/vnd.google-apps.map": "Google My Maps",
  "application/vnd.google-apps.photo": "Google Drive photo",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.script": "Google Apps Script",
  "application/vnd.google-apps.shortcut": "Google Drive shortcut",
  "application/vnd.google-apps.site": "Google Site",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.unknown": "Google Drive file",
  "application/vnd.google-apps.video": "Google Drive video",
};

const GOOGLE_WORKSPACE_TYPE_ICONS: Record<string, string> = {
  "application/vnd.google-apps.audio": "file-audio",
  "application/vnd.google-apps.document": "file-text",
  "application/vnd.google-apps.drawing": "image",
  "application/vnd.google-apps.file": "file",
  "application/vnd.google-apps.form": "list-checks",
  "application/vnd.google-apps.fusiontable": "table",
  "application/vnd.google-apps.jam": "file",
  "application/vnd.google-apps.map": "map",
  "application/vnd.google-apps.photo": "image",
  "application/vnd.google-apps.presentation": "presentation",
  "application/vnd.google-apps.script": "file-code",
  "application/vnd.google-apps.shortcut": "file-symlink",
  "application/vnd.google-apps.site": "globe",
  "application/vnd.google-apps.spreadsheet": "table",
  "application/vnd.google-apps.unknown": "file",
  "application/vnd.google-apps.video": "film",
};

const GOOGLE_WORKSPACE_TYPE_CLASSES: Record<string, string> = {
  "application/vnd.google-apps.audio": "gdab-type-audio",
  "application/vnd.google-apps.document": "gdab-type-doc",
  "application/vnd.google-apps.drawing": "gdab-type-image",
  "application/vnd.google-apps.file": "gdab-type-file",
  "application/vnd.google-apps.form": "gdab-type-form",
  "application/vnd.google-apps.fusiontable": "gdab-type-sheet",
  "application/vnd.google-apps.jam": "gdab-type-file",
  "application/vnd.google-apps.map": "gdab-type-file",
  "application/vnd.google-apps.photo": "gdab-type-image",
  "application/vnd.google-apps.presentation": "gdab-type-slides",
  "application/vnd.google-apps.script": "gdab-type-file",
  "application/vnd.google-apps.shortcut": "gdab-type-file",
  "application/vnd.google-apps.site": "gdab-type-file",
  "application/vnd.google-apps.spreadsheet": "gdab-type-sheet",
  "application/vnd.google-apps.unknown": "gdab-type-file",
  "application/vnd.google-apps.video": "gdab-type-video",
};
