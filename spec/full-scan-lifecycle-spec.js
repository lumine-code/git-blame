const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Git Blame full scan lifecycle regressions", () => {
  // Processing fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let directory, temporaryRoot, editor, main, repository, file;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  beforeEach(async () => {
    jasmine.useRealClock();
    // These tests render real editor/tooltips and run Git, but never launch an
    // external program. Install every shell boundary before package activation.
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo(name === "openApplication" ? 7 : "");
    temporaryRoot = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporaryRoot, "blame-lifecycle-")),
    );
    file = path.join(directory, "saved.js");
    fs.writeFileSync(file, "one\ntwo\n");
    repository = await lumine.repositories.initialize(directory, { initialBranch: "main" });
    const operations = repository.getOperations();
    await operations.setConfig("user.name", "Blame Lifecycle");
    await operations.setConfig("user.email", "blame@lumine.invalid");
    await operations.stageFiles(["saved.js"]);
    await operations.commit("Initial lifecycle commit");
    editor = await lumine.workspace.open(file);
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("git-blame")).mainModule;
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("git-blame");
    lumine.repositories.setActiveRepository(null);
    editor.destroy();
    await lumine.repositories.forget(repository);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(temporaryRoot, directory);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw Error("Blame fixture escaped its root");
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  it("releases the exact editor-close registration from the package owner", () => {
    const before = new Set(main.subscriptions.disposables);
    const gutter = main.gutterForEditor(editor);
    const registration = [...main.subscriptions.disposables].find((item) => !before.has(item));
    expect(registration).toBeTruthy();
    editor.destroy();
    expect(main.gutters.has(editor)).toBe(false);
    expect(gutter.destroyed).toBe(true);
    expect(main.subscriptions.disposables.has(registration)).toBe(false);
    expect(registration.disposed).toBe(true);
  });

  it("resumes a requested gutter before an obsolete None-era request settles", async () => {
    const grammar = editor.getGrammar();
    const gutter = main.gutterForEditor(editor);
    let release;
    const original = repository.getBlame.bind(repository);
    spyOn(repository, "getBlame").and.callFake((...args) => {
      if (release) return original(...args);
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    spyOn(gutter, "draw").and.callThrough();
    const pending = gutter.setVisible(true);
    await conditionPromise(() => repository.getBlame.calls.count() > 0);
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(gutter.renderAbortController).toBeNull();
    expect(gutter.destroyed).toBe(true);
    editor.setGrammar(grammar);
    const resumed = main.gutters.get(editor);
    expect(resumed).toBeTruthy();
    expect(resumed).not.toBe(gutter);
    await conditionPromise(() => resumed.isVisible());
    expect(resumed.markers.length).toBeGreaterThan(0);
    release({ lines: [] });
    expect(await pending).toBe(false);
    expect(gutter.draw).not.toHaveBeenCalled();
    expect(gutter.markers).toEqual([]);
    expect(main.gutters.get(editor)).toBe(resumed);
    expect(editor.gutterWithName("git-blame").isVisible()).toBe(true);
  });

  it("restores only visible per-view gutters when a shared buffer regains its grammar", async () => {
    const grammar = editor.getGrammar();
    const second = lumine.workspace.buildTextEditor({ buffer: editor.getBuffer() });
    try {
      const visible = main.gutterForEditor(editor);
      const hidden = main.gutterForEditor(second);
      expect(await visible.setVisible(true)).toBe(true);
      second.setGrammar(lumine.grammars.nullGrammar);
      expect(visible.destroyed).toBe(true);
      expect(hidden.destroyed).toBe(true);
      expect(main.gutters.size).toBe(0);
      second.setGrammar(grammar);
      const resumed = main.gutters.get(editor);
      await conditionPromise(() => resumed?.isVisible());
      expect(main.gutters.has(second)).toBe(false);
      await resumed.setVisible(false);
      editor.setGrammar(lumine.grammars.nullGrammar);
      editor.setGrammar(grammar);
      expect(main.gutters.size).toBe(0);
    } finally {
      second.destroy();
    }
  });
  it("refreshes external saved-file reloads after startup settles and keeps hidden gutters inert", async () => {
    const gutter = main.gutterForEditor(editor);
    expect(await gutter.setVisible(true)).toBe(true);
    // An initial resolver callback can itself refresh. Let that finish before
    // measuring the external reload rather than mistaking startup for a fix.
    await delay(500);
    const getBlame = spyOn(repository, "getBlame").and.callThrough();
    const originalHead = repository.getStatusSnapshot().head.oid;
    fs.writeFileSync(file, "changed\ntwo\n");
    await editor.getBuffer().reload();
    await delay(500);
    expect(getBlame.calls.count()).toBeGreaterThan(0);
    expect(repository.getStatusSnapshot().head.oid).toBe(originalHead);
    if (!getBlame.calls.count()) return;
    await globalThis.conditionPromise(() =>
      gutter.blocks.some((block) => /^0+$/.test(block.item.dataset.sha)),
    );
    await gutter.setVisible(false);
    getBlame.calls.reset();
    fs.writeFileSync(file, "hidden\ntwo\n");
    await editor.getBuffer().reload();
    await delay(300);
    expect(getBlame).not.toHaveBeenCalled();
  });
  it("disposes actual tooltip registrations when their editor closes", async () => {
    const gutter = main.gutterForEditor(editor);
    expect(await gutter.setVisible(true)).toBe(true);
    const add = spyOn(lumine.tooltips, "add").and.callThrough();
    gutter.onMouseOver({ target: gutter.blocks[0].item, relatedTarget: null });
    const tooltip = add.calls.mostRecent().returnValue;
    expect(tooltip).toBeTruthy();
    editor.destroy();
    expect(tooltip.disposed).toBe(true);
    expect(gutter.tooltips.size).toBe(0);
  });
});
