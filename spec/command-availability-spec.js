const mainModule = require("../lib/main");

describe("Git Blame command availability", () => {
  let main, editor, repository, status, entry, gutter;
  beforeEach(() => {
    main = Object.create(mainModule);
    main.gutters = new Map();
    editor = {
      getPath: () => "/project/file",
      getGrammar: () => ({ scopeName: "source.test" }),
      isDestroyed: () => false,
    };
    main.editorForEvent = () => editor;
    status = { initialized: true, head: { oid: "commit" } };
    repository = { getStatusSnapshot: () => status, getStatusEntry: () => entry };
    spyOn(lumine.repositories, "getForPath").and.callFake(() => repository);
  });
  afterEach(() => lumine.repositories.getForPath.and.callThrough());

  it("requires a saved editor in a repository with committed history", () => {
    expect(main.canToggle({})).toBe(true);
    status.head = null;
    expect(main.canToggle({})).toBe(false);
    status.head = { oid: "commit" };
    entry = { untracked: true };
    expect(main.canToggle({})).toBe(false);
    entry = { ignored: true };
    expect(main.canToggle({})).toBe(false);
    repository = null;
    expect(main.canToggle({})).toBe(false);
    editor = null;
    expect(main.canToggle({})).toBe(false);
  });

  it("always allows closing an already visible gutter for the same editor", () => {
    gutter = { isVisible: () => true };
    main.gutters.set(editor, gutter);
    repository = null;
    expect(main.canToggle({})).toBe(true);
  });
});
