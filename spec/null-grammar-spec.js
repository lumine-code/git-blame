const path = require("node:path");

describe("git-blame with no grammar", () => {
  let editor, main;
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
    main = (await lumine.packages.activatePackage(path.join(__dirname, ".."))).mainModule;
    editor = await lumine.workspace.open();
  });
  afterEach(() => editor?.destroy());

  it("does not start blame and frees observers and render work when None is selected", async () => {
    const grammar = lumine.grammars.grammarForScopeName("text.plain");
    editor.setGrammar(grammar);
    const gutter = main.gutterForEditor(editor);
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(gutter.destroyed).toBe(true);
    expect(gutter.subscriptions.disposed).toBe(true);
    expect(main.gutters.has(editor)).toBe(false);
    spyOn(main, "gutterForEditor").and.callThrough();
    await main.toggle({ target: editor.getElement() });
    expect(main.gutterForEditor).not.toHaveBeenCalled();
    expect(main.canToggle({ target: editor.getElement() })).toBe(false);
    editor.setGrammar(grammar);
    expect(main.gutterForEditor(editor)).not.toBe(gutter);
  });
});
