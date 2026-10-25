describe("Git Blame gutter measurements across windows", () => {
  // Processing fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let gutter;

  afterEach(async () => {
    gutter?.destroy();
    await lumine.workspace.discardEditorWindows();
  });

  it("releases its label observer and observes labels in the destination window", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const editor = await lumine.workspace.open();
    editor.setText("line\n");
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    lumine.packages.loadPackage("git-blame");
    spyOn(lumine.repositories, "observeForPath").and.returnValue({ dispose() {} });
    const { BlameGutter } = require("../lib/blame-gutter");
    gutter = new BlameGutter(editor);
    const source = spyOn(window, "ResizeObserver").and.callThrough();
    gutter.draw(
      [{ line: 1, sha: "a".repeat(40), author: { name: "Ada", date: new Date() } }],
      null,
      { getOriginURL: () => "https://github.com/example/example.git" },
    );
    const observer = source.calls.mostRecent().returnValue;
    const disconnect = spyOn(observer, "disconnect").and.callThrough();
    await lumine.workspace.movePaneItem(editor, {
      targetPane: extra.getEditorContainer().getActivePane(),
    });
    expect(disconnect).toHaveBeenCalled();
  });
});
