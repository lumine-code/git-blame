const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Git Blame full scan lifecycle regressions", () => {
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
