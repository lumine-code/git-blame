describe("Git Blame gutter interaction in detached windows", () => {
  // Processing fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let main, editor, width;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    width = lumine.config.get("git-blame.columnWidth");
    main = (await lumine.packages.activatePackage("git-blame")).mainModule;
    editor = await lumine.workspace.open();
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
    await lumine.packages.deactivatePackage("git-blame");
    lumine.config.set("git-blame.columnWidth", width);
  });
  it("uses the local mouse document and releases the drag before adoption", async () => {
    const gutter = main.gutterForEditor(editor);
    gutter.applyWidth(100);
    const extra = await lumine.workspace.detachItem(editor);
    const document = extra.getDocument();
    const MouseEvent = extra.getDOMWindow().MouseEvent;
    const handle = document.createElement("div");
    handle.className = "git-blame-resize";
    editor.getElement().appendChild(handle);
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 130 }));
    expect(gutter.width).toBe(130);
    expect(gutter.layoutDrag).not.toBeNull();
    await lumine.workspace.attachWindow(extra);
    expect(gutter.resizeStartX).toBeNull();
    expect(gutter.layoutDrag).toBeNull();
  });
});
