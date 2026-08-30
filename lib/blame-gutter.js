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
    this.visible = false;
    this.markers = [];
    this.tooltips = new Map();
    // Guards against an older, slower blame landing on top of a newer one.
    this.renderToken = 0;
    this.layoutDrag = null;

    this.subscriptions = new CompositeDisposable();
    this.renderSubscriptions = new CompositeDisposable();

    this.onClick = this.onClick.bind(this);
    this.onMouseOver = this.onMouseOver.bind(this);
    this.onResizeStart = this.onResizeStart.bind(this);
    this.onResizeMove = this.onResizeMove.bind(this);
    this.onResizeEnd = this.onResizeEnd.bind(this);

    this.applyWidth(lumine.config.get("git-blame.columnWidth"));

    const element = lumine.views.getView(editor);
    element.addEventListener("click", this.onClick);
    element.addEventListener("mouseover", this.onMouseOver);
    element.addEventListener("mousedown", this.onResizeStart);
    this.subscriptions.add(
      new Disposable(() => {
        element.removeEventListener("click", this.onClick);
        element.removeEventListener("mouseover", this.onMouseOver);
        element.removeEventListener("mousedown", this.onResizeStart);
      }),
      // Blame only changes when history does, so a save is the cheap and
      // accurate moment to refresh. Upstream rendered once and then showed the
      // same attribution for the rest of the session.
      editor.onDidSave(() => this.refresh()),
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
    if (visible === this.visible) return this.visible;

    if (!visible) {
      this.visible = false;
      this.clear();
      this.editor.gutterWithName(GUTTER_NAME)?.hide();
      return false;
    }

    // Render before showing, so a file with no blame to show never flashes an
    // empty gutter open and closed.
    const rendered = await this.render();
    if (!rendered) return false;

    this.visible = true;
    this.gutter().show();
    return true;
  }

  refresh() {
    if (this.visible) this.render();
  }

  gutter() {
    return (
      this.editor.gutterWithName(GUTTER_NAME) ??
      this.editor.addGutter({ name: GUTTER_NAME, visible: false, priority: 100 })
    );
  }

  // Resolves the blame and rebuilds every decoration. Returns whether anything
  // was drawn; the caller uses that to decide whether to open the gutter.
  async render() {
    const filePath = this.editor.getPath();
    if (!filePath) {
      this.warn("Save this file before blaming it.");
      return false;
    }

    const repository = lumine.repositories.getForPath(filePath);
    if (!repository) {
      this.warn("This file is not inside a Git repository.");
      return false;
    }

    const token = ++this.renderToken;
    let blame, customTemplate;

    try {
      // `getOriginURL` reads the refs snapshot, which is empty until loaded.
      await repository.ensureRefsSnapshot();
      [blame, customTemplate] = await Promise.all([
        repository.getBlame(filePath, {
          ignoreWhitespace: Boolean(lumine.config.get("git-blame.ignoreWhitespace")),
        }),
        repository.getConfigValueAsync(GIT_CONFIG_URL_TEMPLATE),
      ]);
    } catch (error) {
      this.warn(`Could not blame this file. ${error.message}`);
      return false;
    }

    // A newer render started, or the editor closed, while git was working.
    if (token !== this.renderToken || this.editor.isDestroyed()) return false;

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
    let previousSha = null;
    let shade = "odd";

    for (const line of lines) {
      const row = line.line - 1;
      if (row < 0 || row > lastRow) continue;

      // Alternate the background whenever the commit changes, so a block of
      // lines from one commit reads as one block.
      if (line.sha !== previousSha) shade = shade === "odd" ? "even" : "odd";
      previousSha = line.sha;

      const marker = this.editor.markBufferPosition([row, 0], { invalidate: "never" });
      const item = createBlameLine(line, { ...options, shade, url: remote.url(line.sha) });
      gutter.decorateMarker(marker, { class: "git-blame-marker", item });
      this.markers.push(marker);
    }
  }

  clear() {
    // Destroying a marker destroys the decorations attached to it.
    for (const marker of this.markers) marker.destroy();
    this.markers = [];
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
      lumine.shell.openExternal(url);
      return;
    }

    lumine.clipboard.write(sha);
    lumine.notifications.addSuccess("Commit hash copied to the clipboard.");
  }

  // Tooltips are attached on first hover rather than up front: a file with ten
  // thousand lines would otherwise register ten thousand of them before
  // showing anything.
  onMouseOver(event) {
    const line = event.target.closest?.(".git-blame-line");
    if (!line || this.tooltips.has(line)) return;

    const summary = line.dataset.summary;
    if (!summary) return;

    const tooltip = lumine.tooltips.add(line, { title: summary, placement: "right" });
    this.tooltips.set(line, tooltip);
    this.renderSubscriptions.add(tooltip);

    // The tooltip subscribes to `mouseenter`, which has already been and gone
    // by the time `mouseover` reaches here, so the first hover would otherwise
    // show nothing.
    const MouseEvent = line.ownerDocument.defaultView.MouseEvent;
    line.dispatchEvent(new MouseEvent("mouseenter"));
  }

  onResizeStart(event) {
    if (!event.target.closest?.(".git-blame-resize")) return;
    event.preventDefault();

    this.resizeStartX = event.pageX;
    this.resizeStartWidth = this.width;
    this.resizeDocument = event.currentTarget.ownerDocument;
    this.resizeDocument.addEventListener("mousemove", this.onResizeMove);
    this.resizeDocument.addEventListener("mouseup", this.onResizeEnd);
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
    this.resizeDocument?.removeEventListener("mousemove", this.onResizeMove);
    this.resizeDocument?.removeEventListener("mouseup", this.onResizeEnd);
    this.resizeDocument = null;
    this.layoutDrag?.dispose();
    this.layoutDrag = null;
    lumine.config.set("git-blame.columnWidth", Math.round(this.width));
  }

  warn(message) {
    lumine.notifications.addWarning(message);
  }

  destroy() {
    this.onResizeEnd();
    this.clear();
    this.subscriptions.dispose();
    this.editor.gutterWithName(GUTTER_NAME)?.destroy();
    this.visible = false;
  }
}

module.exports = { BlameGutter, GUTTER_NAME };
