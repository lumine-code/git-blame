const { CompositeDisposable, Disposable } = require("lumine");
const { createBlameLine } = require("./blame-line");
const { RemoteRevision } = require("./remote-revision");
const { isUncommitted } = require("./format");

const GUTTER_NAME = "git-blame";
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
  "git-blame.ignoreWhitespace",
  "git-blame.showHash",
];

class BlameGutter {
  constructor(editor) {
    this.editor = editor;
    this.destroyed = false;
    this.visible = false;
    this.visibilityGeneration = 0;
    this.markers = [];
    this.blocks = [];
    this.labelFrame = null;
    this.tooltips = new Map();
    // Guards against an older, slower blame landing on top of a newer one.
    this.renderToken = 0;
    this.renderAbortController = null;
    this.repository = null;
    this.repositorySubscription = null;
    this.layoutDrag = null;

    this.subscriptions = new CompositeDisposable();
    this.renderSubscriptions = new CompositeDisposable();

    this.onClick = this.onClick.bind(this);
    this.onMouseOver = this.onMouseOver.bind(this);
    this.onMouseOut = this.onMouseOut.bind(this);
    this.onResizeStart = this.onResizeStart.bind(this);
    this.onResizeMove = this.onResizeMove.bind(this);
    this.onResizeEnd = this.onResizeEnd.bind(this);

    this.applyWidth(lumine.config.get("git-blame.columnWidth"));

    const element = lumine.views.getView(editor);
    element.addEventListener("click", this.onClick);
    element.addEventListener("mouseover", this.onMouseOver);
    element.addEventListener("mouseout", this.onMouseOut);
    element.addEventListener("mousedown", this.onResizeStart);
    this.subscriptions.add(
      new Disposable(() => {
        element.removeEventListener("click", this.onClick);
        element.removeEventListener("mouseover", this.onMouseOver);
        element.removeEventListener("mouseout", this.onMouseOut);
        element.removeEventListener("mousedown", this.onResizeStart);
      }),
      // Saved working-tree changes affect attribution immediately. History
      // changes are observed separately through the repository's HEAD below.
      editor.onDidSave(() => this.refresh()),
      lumine.repositories.observeForPath(
        () => editor.getPath(),
        (repository, { ready, error }) => {
          if (!this.visible || this.destroyed) return;
          this.clear();
          this.stopObservingRepository();
          if (error) this.warn(`Could not resolve this file's repository. ${error.message}`);
          if (!ready) return;
          if (repository) void this.render(repository);
          else void this.setVisible(false);
        },
        { onDidChangePath: (callback) => editor.onDidChangePath(callback), snapshots: "none" },
      ),
      editor.onDidChange(() => this.scheduleLabelUpdate()),
      // The editor moves its gutter in the same animation frame as this event.
      // A separate rAF would leave the label one scroll step behind it.
      element.onDidChangeScrollTop(() => this.updateLabelPositions()),
      lumine.config.onDidChange("git-blame.columnWidth", ({ newValue }) =>
        this.applyWidth(newValue),
      ),
      ...DISPLAY_SETTINGS.map((key) => lumine.config.onDidChange(key, () => this.refresh())),
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

  // Resolves the blame and rebuilds every decoration. Returns whether anything
  // was drawn; the caller uses that to decide whether to open the gutter.
  async render(resolvedRepository) {
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
        this.warn(`Could not resolve this file's repository. ${error.message}`);
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
    let blame, customTemplate;
    let headOid;

    try {
      // `getOriginURL` reads the refs snapshot, which is empty until loaded.
      await repository.ensureRefsSnapshot({ signal: controller.signal });
      if (controller.signal.aborted || token !== this.renderToken) return false;
      headOid = repository.getStatusSnapshot?.().head?.oid ?? null;
      [blame, customTemplate] = await Promise.all([
        repository.getBlame(filePath, {
          ignoreWhitespace: Boolean(lumine.config.get("git-blame.ignoreWhitespace")),
          signal: controller.signal,
        }),
        repository.getConfigValueAsync(GIT_CONFIG_URL_TEMPLATE, { signal: controller.signal }),
      ]);
    } catch (error) {
      if (!controller.signal.aborted && token === this.renderToken && !this.destroyed) {
        this.warn(`Could not blame this file. ${error.message}`);
      }
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

    this.draw(
      blame.lines,
      customTemplate || lumine.config.get("git-blame.commitUrlTemplate"),
      repository,
    );
    return true;
  }

  draw(lines, customTemplate, repository) {
    this.clear();

    const remote = new RemoteRevision(repository.getOriginURL(), customTemplate);
    const options = {
      showHash: Boolean(lumine.config.get("git-blame.showHash")),
      dateStyle: lumine.config.get("git-blame.dateFormat"),
      authorStyle: lumine.config.get("git-blame.authorName"),
      colourAuthors: Boolean(lumine.config.get("git-blame.colorCommitAuthors")),
    };

    const gutter = this.gutter();
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

    // Geometry changes when a block is mounted, wrapped or folded. Observing
    // its size also handles font changes without reaching into editor internals.
    // ResizeObserver runs after layout and before paint. Newly mounted blocks
    // need their label positioned here, rather than waiting another frame.
    const observer = new ResizeObserver(() => this.updateLabels());
    this.renderSubscriptions.add(new Disposable(() => observer.disconnect()));

    for (const { line, startRow, endRow } of groups) {
      shade = shade === "odd" ? "even" : "odd";
      // End at the last line's actual end: [endRow + 1, 0] would decorate the
      // next commit too, and [endRow, 0] would miss the last line's soft wraps.
      const marker = this.editor.markBufferRange(
        [
          [startRow, 0],
          [endRow, this.editor.lineTextForBufferRow(endRow).length],
        ],
        { invalidate: "never" },
      );
      const item = createBlameLine(line, { ...options, shade, url: remote.url(line.sha) });
      gutter.decorateMarker(marker, { class: "git-blame-marker", item });
      this.markers.push(marker);
      this.blocks.push({
        marker,
        item,
        label: item.querySelector(".git-blame-label"),
        geometry: null,
      });
      observer.observe(item);
    }
    this.scheduleLabelUpdate();
  }

  scheduleLabelUpdate() {
    if (!this.blocks.length || this.labelFrame != null) return;
    this.labelFrame = requestAnimationFrame(() => {
      this.labelFrame = null;
      this.updateLabels();
    });
  }

  updateLabels() {
    if (this.editor.isDestroyed()) return;
    const element = lumine.views.getView(this.editor);
    const lineHeight = this.editor.getLineHeightInPixels();
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

    for (const block of this.blocks) {
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

      const top = element.pixelPositionForScreenPosition([range.start.row, 0]).top;
      const height = Number.parseFloat(item.style.height);
      if (!Number.isFinite(height)) continue;
      block.geometry = { top, height, inset, lineHeight };
    }
    this.updateLabelPositions();
  }

  updateLabelPositions() {
    if (this.editor.isDestroyed() || !this.blocks.length) return;
    const element = lumine.views.getView(this.editor);
    // Match the gutter's physical-pixel rounding exactly. Counteracting a
    // rounded transform with a fractional offset makes stationary text shimmer.
    const pixelSize = 1 / window.devicePixelRatio;
    const scrollTop = Math.round(element.getScrollTop() / pixelSize) * pixelSize;

    // Geometry is refreshed on layout changes, not on every animation frame:
    // measuring a block's offscreen first row can force a full editor render.
    for (const { item, label, geometry } of this.blocks) {
      if (!geometry || !item.isConnected) continue;
      const { top, height, inset, lineHeight } = geometry;
      const offset = Math.max(inset, Math.min(scrollTop - top, height - lineHeight));
      label.style.transform = `translateY(${offset}px)`;
    }
  }

  clear() {
    this.renderToken++;
    this.cancelRenderRequest();
    if (this.labelFrame != null) cancelAnimationFrame(this.labelFrame);
    this.labelFrame = null;
    // Destroying a marker destroys the decorations attached to it.
    for (const marker of this.markers) marker.destroy();
    this.markers = [];
    this.blocks = [];
    this.tooltips.clear();
    this.renderSubscriptions.dispose();
    this.renderSubscriptions = new CompositeDisposable();
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
      this.renderSubscriptions.add(tooltip);
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
    document.addEventListener("mousemove", this.onResizeMove);
    document.addEventListener("mouseup", this.onResizeEnd);
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
    document.removeEventListener("mousemove", this.onResizeMove);
    document.removeEventListener("mouseup", this.onResizeEnd);
    this.layoutDrag.dispose();
    this.layoutDrag = null;
    lumine.config.set("git-blame.columnWidth", Math.round(this.width));
  }

  warn(message) {
    lumine.notifications.addWarning(message);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onResizeEnd();
    this.clear();
    this.stopObservingRepository();
    this.subscriptions.dispose();
    this.editor.gutterWithName(GUTTER_NAME)?.destroy();
    this.visible = false;
  }
}

module.exports = { BlameGutter, GUTTER_NAME };
