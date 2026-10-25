const path = require("node:path");
const packageRoot = path.join(__dirname, "..");

describe("git-blame menu commands in captured presentation contexts", () => {
  // Processing fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let main, first, second, firstPane, notebook, captured;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      if (!jasmine.isSpy(lumine.shell[method])) spyOn(lumine.shell, method).and.resolveTo();
    if (!jasmine.isSpy(lumine.application.openWindow))
      spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    first = await lumine.workspace.open();
    firstPane = lumine.workspace.paneForItem(first);
    second = lumine.workspace.buildTextEditor();
    main = (await lumine.packages.activatePackage(packageRoot)).mainModule;
    captured = jasmine.createSpy("toggle captured blame");
    spyOn(first, "getPath").and.returnValue("/project/first.js");
    spyOn(second, "getPath").and.returnValue("/project/second.js");
    spyOn(lumine.repositories, "getForPath").and.returnValue({
      getWorkingDirectory: () => "/project",
      isDestroyed: () => false,
    });
    spyOn(main, "gutterForEditor").and.callFake((editor) => ({ toggle: () => captured(editor) }));
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("git-blame");
    lumine.repositories.getForPath.and.callThrough();
    await lumine.workspace.discardEditorWindows();
    if (notebook) await lumine.workspace.paneForItem(notebook)?.destroyItem(notebook);
    first?.destroy();
    second?.destroy();
    main = first = second = firstPane = notebook = captured = null;
  });

  it("keeps the invoking window document when the global active editor is elsewhere", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    firstPane.activate();
    firstPane.activateItem(first);
    const button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);

    await lumine.commands.dispatch(button, "git-blame:toggle");

    expect(captured).toHaveBeenCalledOnceWith(second);
  });

  it("uses a captured notebook cell from a non-editor command target", async () => {
    const element = document.createElement("div");
    const button = document.createElement("button");
    element.appendChild(button);
    notebook = {
      element,
      getTitle: () => "Command Context Notebook",
      getActiveEmbeddedTextEditor: () => second,
    };
    const pane = firstPane.splitRight();
    pane.activateItem(notebook, { activatePane: true });
    firstPane.activate();
    firstPane.activateItem(first);
    const context = lumine.workspace.resolveCommandContext(button);
    expect(context.editor).toBeUndefined();
    expect(context.embeddedEditor).toBe(second);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);

    await lumine.commands.dispatch(button, "git-blame:toggle");

    expect(captured).toHaveBeenCalledOnceWith(second);
  });

  it("does not select a shared main editor when the invoking presentation has no document", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    firstPane.activate();
    firstPane.activateItem(first);
    const button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);

    await lumine.commands.dispatch(button, "git-blame:toggle");

    expect(captured).not.toHaveBeenCalled();
  });
});
