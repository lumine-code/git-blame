const { CompositeDisposable, Disposable } = require("lumine");
const { createBlameLine } = require("./blame-line");
const { RemoteRevision } = require("./remote-revision");
const { isUncommitted } = require("./format");

const GUTTER_NAME = "git-blame";
const OVERSCAN_ROWS = 24;
// A repository may name its own commit-URL template, which is how a
// self-hosted forge gets links without every user configuring the setting.
const GIT_CONFIG_URL_TEMPLATE = "git-blame.commitUrlTemplate";

// Settings that change what a line reads; a change to any of them re-renders.
// `columnWidth` is deliberately absent -- it is written continuously while the
// gutter is being dragged, and only ever moves the edge.
const DISPLAY_SETTINGS = [
  "git-blame.authorName",
  "git-blame.colorCommitAuthors",
  "git-blame.commitUrlTemplate",
  "git-blame.dateFormat",
  "git-blame.showHash",
];

class BlameGutter {
  constructor(editor) {
    this.editor = editor;
    this.destroyed = false;
    this.visible = false;
    this.visibilityRequested = false;
    this.visibilityGeneration = 0;
    this.markers = [];
    this.blocks = [];
    this.blocksByMarker = new Map();
    this.mountedBlocks = new Set();
    this.labelFrame = null;
    this.tooltips = new Map();
    // Guards against an older, slower blame landing on top of a newer one.
    this.renderToken = 0;
    this.renderAbortController = null;
    this.repository = null;
    this.repositorySubscription = null;
    this.layoutDrag = null;

    this.subscriptions = new CompositeDisposable();

    this.onClick = this.onClick.bind(this);
    this.onMouseOver = this.onMouseOver.bind(this);
    this.onMouseOut = this.onMouseOut.bind(this);
    this.onResizeStart = this.onResizeStart.bind(this);
    this.onResizeMove = this.onResizeMove.bind(this);
    this.onResizeEnd = this.onResizeEnd.bind(this);

    this.applyWidth(lumine.config.get("git-blame.columnWidth"));

    const element = lumine.views.getView(editor);
    this.attached = element.isConnected;
    element.addEventListener("click", this.onClick);
    element.addEventListener("mouseover", this.onMouseOver);
    element.addEventListener("mouseout", this.onMouseOut);
    element.addEventListener("mousedown", this.onResizeStart);
    this.subscriptions.add(
      element.onDidDetach(() => {
        this.attached = false;
        this.onResizeEnd();
        this.cancelLabelUpdate();
        this.releaseLabelObserver();
        this.viewport = null;
        for (const block of this.mountedBlocks) this.unmountBlock(block);
      }),
      element.onDidAttach(() => {
        this.attached = true;
        this.bindLabelObserver();
        this.syncMountedBlocks();
        this.scheduleLabelUpdate();
      }),
      new Disposable(() => {
        element.removeEventListener("click", this.onClick);
        element.removeEventListener("mouseover", this.onMouseOver);
        element.removeEventListener("mouseout", this.onMouseOut);
        element.removeEventListener("mousedown", this.onResizeStart);
      }),
      // Saved working-tree changes affect attribution immediately. History
      // changes are observed separately through the repository's HEAD below.
      editor.onDidSave(() => this.refresh()),
      editor.getBuffer().onDidReload(() => this.refresh()),
      lumine.repositories.observeForPath(
        () => editor.getPath(),
        (repository, { ready, error }) => {
          if (!this.visible || this.destroyed) return;
          this.clear();
          this.stopObservingRepository();
          if (error) this.warn("Unable to resolve this file's repository", error);
          if (!ready) return;
          if (repository) void this.render(repository);
          else void this.setVisible(false);
        },
        { onDidChangePath: (callback) => editor.onDidChangePath(callback), snapshots: "none" },
      ),
      editor.onDidChange(() => this.scheduleLabelUpdate()),
      element.onDidChangeScrollGeometry(() => this.scheduleLabelUpdate()),
      // The editor moves its gutter in the same animation frame as this event.
      // A separate rAF would leave the label one scroll step behind it.
      element.onDidChangeScrollTop(() => {
        this.syncMountedBlocks();
        this.updateLabelPositions();
      }),
      lumine.config.onDidChange("git-blame.columnWidth", ({ newValue }) =>
        this.applyWidth(newValue),
      ),
      lumine.config.onDidChange("git-blame.ignoreWhitespace", () => this.refresh()),
      ...DISPLAY_SETTINGS.map((key) =>
        lumine.config.onDidChange(key, () => this.refreshPresentation()),
      ),
    );
  }

  isVisible() {
    return this.visible;
  }

  toggle() {
    return this.setVisible(!this.visible);
  }

  async setVisible(visible) {
    if (this.destroyed) return false;
    if (visible && this.editor.getGrammar() === lumine.grammars.nullGrammar) return false;
    this.visibilityRequested = visible;
    const generation = ++this.visibilityGeneration;

    if (!visible) {
      this.visible = false;
      this.clear();
      this.stopObservingRepository();
      this.editor.gutterWithName(GUTTER_NAME)?.hide();
      return false;
    }
    if (this.visible) return true;

    // Render before showing, so a file with no blame to show never flashes an
    // empty gutter open and closed.
    const rendered = await this.render();
    if (generation !== this.visibilityGeneration) return false;
    if (!rendered || this.destroyed || !this.markers.length) {
      this.visibilityRequested = false;
      if (!this.visible && !this.renderAbortController) this.stopObservingRepository();
      return false;
    }

    this.visible = true;
    this.gutter().show();
    return true;
  }

  refresh() {
    if (this.visible) this.render();
  }

  observeRepository(repository) {
    if (this.repository === repository) return;
    this.stopObservingRepository();
    this.repository = repository;
    let headOid = repository.getStatusSnapshot?.().head?.oid ?? null;
    this.repositorySubscription = repository.onDidChangeStatusSnapshot?.(() => {
      const nextHeadOid = repository.getStatusSnapshot?.().head?.oid ?? null;
      if (nextHeadOid === headOid) return;
      headOid = nextHeadOid;
      // Index and unrelated worktree updates leave blame unchanged. Commits,
      // resets and checkouts change its history even when this file is not saved.
      this.refresh();
    });
  }

  stopObservingRepository() {
    this.repositorySubscription?.dispose();
    this.repositorySubscription = null;
    this.repository = null;
  }

  cancelRenderRequest() {
    this.renderAbortController?.abort();
    this.renderAbortController = null;
  }

  gutter() {
    return (
      this.editor.gutterWithName(GUTTER_NAME) ??
      this.editor.addGutter({ name: GUTTER_NAME, visible: false, priority: 100 })
    );
  }

  async readOriginURL(repository, signal) {
    if (typeof repository.readRemotes === "function") {
      try {
        const remotes = await repository.readRemotes({ signal });
        return remotes.find(({ name }) => name === "origin")?.fetchUrl ?? null;
      } catch {
        signal.throwIfAborted();
      }
    } else {
      await repository.ensureRefsSnapshot?.({ signal });
    }
    return repository.getOriginURL?.() ?? null;
  }

  // Resolves the blame and rebuilds every decoration. Returns whether anything
  // was drawn; the caller uses that to decide whether to open the gutter.
  async render(resolvedRepository) {
    if (this.destroyed || this.editor.getGrammar() === lumine.grammars.nullGrammar) return false;
    const token = ++this.renderToken;
    this.cancelRenderRequest();
    const filePath = this.editor.getPath();
    if (!filePath) {
      this.warn("Save this file before blaming it.");
      return false;
    }

    let repository;
    try {
      repository = resolvedRepository ?? (await lumine.repositories.resolveForPath(filePath));
    } catch (error) {
      if (token === this.renderToken && !this.destroyed) {
        this.warn("Unable to resolve this file's repository", error);
      }
      return false;
    }
    if (token !== this.renderToken || filePath !== this.editor.getPath() || this.destroyed)
      return false;
    if (!repository) {
      this.warn("This file is not inside a Git repository.");
      return false;
    }

    this.observeRepository(repository);
    const controller = new AbortController();
    this.renderAbortController = controller;
    let blame, customTemplate, originURL;
    const headOid = repository.getStatusSnapshot?.().head?.oid ?? null;

    try {
      [blame, customTemplate, originURL] = await Promise.all([
        repository.getBlame(filePath, {
          ignoreWhitespace: Boolean(lumine.config.get("git-blame.ignoreWhitespace")),
          signal: controller.signal,
        }),
        repository.getConfigValueAsync(GIT_CONFIG_URL_TEMPLATE, { signal: controller.signal }),
        this.readOriginURL(repository, controller.signal),
      ]);
    } catch (error) {
      const report = !controller.signal.aborted && token === this.renderToken && !this.destroyed;
      controller.abort();
      if (report) this.warn("Unable to show Git blame", error);
      return false;
    } finally {
      if (this.renderAbortController === controller) this.renderAbortController = null;
    }

    // A newer render started, or the editor closed, while git was working.
    if (
      token !== this.renderToken ||
      filePath !== this.editor.getPath() ||
      this.destroyed ||
      this.editor.isDestroyed()
    )
      return false;

    // A HEAD change during the initial show cannot refresh a gutter that has
    // not become visible yet. Resolve that same show request from a fresh read.
    if (headOid !== (repository.getStatusSnapshot?.().head?.oid ?? null)) return this.render();

    if (!blame.lines.length) {
      this.warn("This file has no committed history yet.");
      return false;
    }

    this.draw(blame.lines, customTemplate, originURL);
    return true;
  }

  draw(lines, customTemplate, originURL) {
    this.clear();
    this.originURL = originURL;
    this.repositoryTemplate = customTemplate;
    this.readDisplaySettings();
    this.markerLayer ??= this.editor.addMarkerLayer();
    const lastRow = this.editor.getLastBufferRow();
    let shade = "odd";
    const groups = [];

    for (const line of lines) {
      const row = line.line - 1;
      if (row < 0 || row > lastRow) continue;

      const previous = groups.at(-1);
      if (previous && previous.line.sha === line.sha && previous.endRow + 1 === row) {
        previous.endRow = row;
      } else {
        groups.push({ line, startRow: row, endRow: row });
      }
    }

    for (const { line, startRow, endRow } of groups) {
      shade = shade === "odd" ? "even" : "odd";
      // End at the last line's actual end: [endRow + 1, 0] would decorate the
      // next commit too, and [endRow, 0] would miss the last line's soft wraps.
      const marker = this.markerLayer.markBufferRange(
        [
          [startRow, 0],
          [endRow, this.editor.getBuffer().lineLengthForRow(endRow)],
        ],
        { invalidate: "never" },
      );
      const block = { marker, line, shade, item: null, label: null, geometry: null };
      this.markers.push(marker);
      this.blocks.push(block);
      this.blocksByMarker.set(marker, block);
    }
    this.gutter();
    this.bindLabelObserver();
    this.syncMountedBlocks();
    this.scheduleLabelUpdate();
  }

  readDisplaySettings() {
    this.remote = new RemoteRevision(
      this.originURL,
      this.repositoryTemplate || lumine.config.get("git-blame.commitUrlTemplate"),
    );
    this.displayOptions = {
      showHash: Boolean(lumine.config.get("git-blame.showHash")),
      dateStyle: lumine.config.get("git-blame.dateFormat"),
      authorStyle: lumine.config.get("git-blame.authorName"),
      colourAuthors: Boolean(lumine.config.get("git-blame.colorCommitAuthors")),
    };
  }

  refreshPresentation() {
    if (!this.blocks.length) return;
    this.readDisplaySettings();
    const element = this.editor.getElement();
    for (const block of [...this.mountedBlocks]) {
      this.unmountBlock(block);
      this.mountBlock(block, element.ownerDocument);
    }
    this.scheduleLabelUpdate();
  }

  syncMountedBlocks(force = false) {
    if (this.destroyed || this.editor.isDestroyed() || !this.attached || !this.blocks.length)
      return;
    const element = this.editor.getElement();
    if (!element.isConnected) return;
    const [first = 0, last = first] = element.getVisibleRowRange();
    const start = Math.max(0, first - OVERSCAN_ROWS);
    const end = Math.max(
      start,
      Math.min(last + OVERSCAN_ROWS, this.editor.getApproximateScreenLineCount() - 1),
    );
    if (!force && this.viewport?.start === start && this.viewport.end === end) return;
    this.viewport = { start, end };

    const wanted = new Set();
    const add = (firstRow, lastRow) => {
      for (const marker of this.markerLayer.findMarkers({
        intersectsBufferRowRange: [firstRow, lastRow],
      })) {
        wanted.add(this.blocksByMarker.get(marker));
      }
    };
    // Build intervals from rendered rows so a collapsed region with thousands
    // of hidden markers never becomes a single expensive overlap query.
    let firstRow = this.editor.bufferPositionForScreenPosition([start, 0]).row;
    let lastRow = firstRow;
    for (let screenRow = start + 1; screenRow <= end; screenRow++) {
      const row = this.editor.bufferPositionForScreenPosition([screenRow, 0]).row;
      if (row > lastRow + 1) {
        add(firstRow, lastRow);
        firstRow = row;
      }
      lastRow = row;
    }
    add(firstRow, lastRow);

    for (const block of this.mountedBlocks) if (!wanted.has(block)) this.unmountBlock(block);
    for (const block of wanted) if (!block.item) this.mountBlock(block, element.ownerDocument);
  }

  mountBlock(block, document) {
    const { marker, line, shade } = block;
    const item = createBlameLine(line, {
      ...this.displayOptions,
      document,
      shade,
      url: this.remote.url(line.sha),
    });
    block.item = item;
    block.label = item.querySelector(".git-blame-label");
    block.decoration = this.gutter().decorateMarker(marker, { class: "git-blame-marker", item });
    this.mountedBlocks.add(block);
    this.labelResizeObserver?.observe(item);
  }

  unmountBlock(block) {
    const { item, decoration } = block;
    block.item = block.label = block.decoration = block.geometry = null;
    this.mountedBlocks.delete(block);
    this.labelResizeObserver?.unobserve(item);
    this.tooltips.get(item)?.dispose();
    this.tooltips.delete(item);
    decoration.destroy();
  }

  bindLabelObserver() {
    this.releaseLabelObserver();
    if (this.destroyed || !this.blocks.length) return;
    const window = this.editor.getElement().ownerDocument.defaultView;
    const observer = new window.ResizeObserver(() => {
      if (this.labelResizeObserver === observer) this.updateLabels();
    });
    this.labelResizeObserver = observer;
    for (const { item } of this.mountedBlocks) observer.observe(item);
  }

  releaseLabelObserver() {
    this.labelResizeObserver?.disconnect();
    this.labelResizeObserver = null;
  }

  scheduleLabelUpdate() {
    if (!this.blocks.length || this.labelFrame != null) return;
    this.labelWindow = lumine.views.getView(this.editor).ownerDocument.defaultView;
    this.labelFrame = this.labelWindow.requestAnimationFrame(() => {
      this.labelFrame = null;
      this.labelWindow = null;
      this.syncMountedBlocks(true);
      this.updateLabels();
    });
  }

  cancelLabelUpdate() {
    if (this.labelFrame != null) this.labelWindow.cancelAnimationFrame(this.labelFrame);
    this.labelFrame = null;
    this.labelWindow = null;
  }

  updateLabels() {
    if (this.editor.isDestroyed()) return;
    const element = lumine.views.getView(this.editor);
    const lineHeight = this.editor.getLineHeightInPixels();
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

    for (const block of this.mountedBlocks) {
      const { marker, item } = block;
      block.geometry = null;
      if (!item.isConnected) continue;
      const range = marker.getScreenRange();
      const firstVisibleRow = this.editor.bufferPositionForScreenPosition([range.start.row, 0]).row;
      const startsInsideFold = firstVisibleRow < marker.getStartBufferPosition().row;
      // Hidden buffer rows can all map to the fold header. Only the commit of
      // that visible header may cover it; a block continuing below it is clipped.
      item.style.visibility = startsInsideFold && range.start.row === range.end.row ? "hidden" : "";
      const inset = startsInsideFold ? lineHeight : 0;
      item.style.clipPath = inset ? `inset(${inset}px 0 0 0)` : "";

      const top = element.pixelPositionAfterBlocksForScreenRow(range.start.row);
      const height = Number.parseFloat(item.style.height);
      if (!Number.isFinite(height)) continue;
      block.geometry = { top, height, inset, lineHeight };
    }
    this.updateLabelPositions();
  }

  updateLabelPositions() {
    if (this.editor.isDestroyed() || !this.mountedBlocks.size) return;
    const element = lumine.views.getView(this.editor);
    // Match the gutter's physical-pixel rounding exactly. Counteracting a
    // rounded transform with a fractional offset makes stationary text shimmer.
    const pixelSize = 1 / element.ownerDocument.defaultView.devicePixelRatio;
    const scrollTop = Math.round(element.getScrollTop() / pixelSize) * pixelSize;

    // Geometry is refreshed on layout changes, not on every animation frame:
    // measuring a block's offscreen first row can force a full editor render.
    for (const { item, label, geometry } of this.mountedBlocks) {
      if (!geometry || !item.isConnected) continue;
      const { top, height, inset, lineHeight } = geometry;
      const offset = Math.max(inset, Math.min(scrollTop - top, height - lineHeight));
      label.style.transform = `translateY(${offset}px)`;
    }
  }

  clear() {
    this.renderToken++;
    this.cancelRenderRequest();
    this.cancelLabelUpdate();
    this.releaseLabelObserver();
    this.viewport = null;
    this.markers = [];
    this.blocks = [];
    this.blocksByMarker.clear();
    for (const block of this.mountedBlocks) this.unmountBlock(block);
    this.markerLayer?.clear();
  }

  applyWidth(width) {
    const columns = Number(width);
    if (!Number.isFinite(columns) || columns <= 0) return;
    this.width = columns;
    // A custom property on the editor rather than a `<style>` element appended
    // to the document head, which upstream did once per gutter and never
    // removed -- and which named a selector that no longer exists.
    lumine.views.getView(this.editor).style.setProperty("--git-blame-column-width", `${columns}px`);
  }

  onClick(event) {
    if (event.target.closest?.(".git-blame-resize")) return;

    const line = event.target.closest?.(".git-blame-line");
    if (!line) return;

    const { sha, url } = line.dataset;
    if (!sha || isUncommitted(sha)) return;
    event.preventDefault();

    if (url) {
      void lumine.shell.openExternal(url).catch((error) => {
        lumine.notifications.addWarning("Unable to open the commit URL.", {
          detail: error.message,
          dismissable: true,
        });
      });
      return;
    }

    lumine.clipboard.write(sha);
    lumine.notifications.addSuccess("Commit hash copied to the clipboard.");
  }

  // Tooltips are attached on first hover rather than up front, so only the
  // commit blocks the user actually inspects need a tooltip registration.
  onMouseOver(event) {
    const line = event.target.closest?.(".git-blame-line");
    if (!line || line.contains(event.relatedTarget)) return;

    const summary = line.dataset.summary;
    if (!summary) return;

    const label = line.querySelector(".git-blame-label");
    if (!this.tooltips.has(line)) {
      // Anchor to the visible label: a long block's centre may be thousands of
      // pixels below the viewport. Hovering anywhere in the block triggers it.
      const tooltip = lumine.tooltips.add(label, {
        title: summary,
        placement: "right",
        html: false,
      });
      this.tooltips.set(line, tooltip);
    }

    // The label ignores pointer events, so forward the block's hover to its
    // tooltip anchor, including the first hover that created the tooltip.
    label.dispatchEvent(new MouseEvent("mouseenter"));
  }

  onMouseOut(event) {
    const line = event.target.closest?.(".git-blame-line");
    if (!line || line.contains(event.relatedTarget)) return;
    line.querySelector(".git-blame-label").dispatchEvent(new MouseEvent("mouseleave"));
  }

  onResizeStart(event) {
    if (!event.target.closest?.(".git-blame-resize")) return;
    event.preventDefault();

    this.resizeStartX = event.pageX;
    this.resizeStartWidth = this.width;
    this.resizeDocument = this.editor.getElement().ownerDocument;
    this.resizeDocument.addEventListener("mousemove", this.onResizeMove);
    this.resizeDocument.addEventListener("mouseup", this.onResizeEnd);
    this.resizeDocument.defaultView.addEventListener("blur", this.onResizeEnd);
    // Widening the gutter narrows the text, so a soft-wrapped editor would
    // otherwise reflow on every mousemove of this drag.
    this.layoutDrag = lumine.workspace.beginLayoutDrag();
  }

  onResizeMove(event) {
    if (this.resizeStartX == null) return;
    this.applyWidth(this.resizeStartWidth + (event.pageX - this.resizeStartX));
  }

  onResizeEnd() {
    if (this.resizeStartX == null) return;
    this.resizeStartX = null;
    this.resizeDocument.removeEventListener("mousemove", this.onResizeMove);
    this.resizeDocument.removeEventListener("mouseup", this.onResizeEnd);
    this.resizeDocument.defaultView.removeEventListener("blur", this.onResizeEnd);
    this.resizeDocument = null;
    this.layoutDrag.dispose();
    this.layoutDrag = null;
    lumine.config.set("git-blame.columnWidth", Math.round(this.width));
  }

  warn(message, error) {
    if (error == null) {
      lumine.notifications.addWarning(message);
      return;
    }
    const filePath = this.editor.getPath();
    lumine.notifications.addWarning(message, {
      detail: [filePath && `Path: ${filePath}`, error.message ?? String(error)]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onResizeEnd();
    this.clear();
    this.markerLayer?.destroy();
    this.markerLayer = null;
    this.stopObservingRepository();
    this.subscriptions.dispose();
    this.editor.gutterWithName(GUTTER_NAME)?.destroy();
    this.visible = false;
    this.visibilityRequested = false;
  }
}

module.exports = { BlameGutter, GUTTER_NAME };
