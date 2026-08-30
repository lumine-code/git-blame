const path = require("path");
const { GUTTER_NAME } = require("../lib/blame-gutter");

describe("git-blame", () => {
  let editor, editorElement, workspaceElement, main, repository;

  const SHA_ONE = "1".repeat(40);
  const SHA_TWO = "2".repeat(40);
  const UNCOMMITTED = "0".repeat(40);

  function blameLine(row, sha, name) {
    return {
      line: row,
      originalLine: row,
      sha,
      author: { name, email: `${name}@example.com`, date: new Date(2026, 7, 11) },
      summary: `Summary for ${sha.slice(0, 4)}`,
    };
  }

  const BLAME = [
    blameLine(1, SHA_ONE, "Ada Lovelace"),
    blameLine(2, SHA_ONE, "Ada Lovelace"),
    blameLine(3, SHA_TWO, "Grace Hopper"),
    blameLine(4, UNCOMMITTED, "Not Committed Yet"),
  ];

  function fakeRepository({
    lines = BLAME,
    origin = "git@github.com:owner/repo.git",
    config = null,
  } = {}) {
    return {
      ensureRefsSnapshot: jasmine.createSpy("ensureRefsSnapshot").and.resolveTo(undefined),
      getBlame: jasmine.createSpy("getBlame").and.resolveTo({ revision: null, lines }),
      getConfigValueAsync: jasmine.createSpy("getConfigValueAsync").and.resolveTo(config),
      getOriginURL: () => origin,
    };
  }

  function gutter() {
    return editor.gutterWithName(GUTTER_NAME);
  }

  function blameElements() {
    return Array.from(editorElement.querySelectorAll(".git-blame-line"));
  }

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);

    editor = await lumine.workspace.open();
    editor.setText("one\ntwo\nthree\nfour\n");
    editorElement = lumine.views.getView(editor);

    // Hermetic: the path is never touched on disk, only handed to the stubbed
    // registry and the stubbed blame call.
    spyOn(editor, "getPath").and.returnValue(path.join("repo", "file.js"));
    repository = fakeRepository();
    spyOn(lumine.repositories, "getForPath").and.returnValue(repository);

    // The package is lazily activated by its command, so `activatePackage`
    // alone never resolves; the dispatch below is what triggers it, and it is
    // then replayed into the real handler.
    const activation = lumine.packages.activatePackage("git-blame");
    lumine.commands.dispatch(workspaceElement, "git-blame:toggle");
    main = (await activation).mainModule;

    // Undo that replayed toggle so every spec starts from a hidden gutter.
    await flushMicrotasks();
    await main.gutterForEditor(editor).setVisible(false);
  });

  describe("activation", () => {
    it("activates on its command and registers it at the workspace", () => {
      expect(lumine.packages.isPackageActive("git-blame")).toBe(true);
      const commands = lumine.commands
        .findCommands({ target: workspaceElement })
        .map((command) => command.name);
      expect(commands).toContain("git-blame:toggle");
    });
  });

  describe("showing the gutter", () => {
    it("adds a visible gutter with one decoration per blamed line", async () => {
      await main.gutterForEditor(editor).toggle();

      expect(gutter()).toBeTruthy();
      expect(gutter().isVisible()).toBe(true);
      expect(blameElements().length).toBe(4);
    });

    it("reads blame through the repository rather than spawning git", async () => {
      await main.gutterForEditor(editor).toggle();

      expect(repository.getBlame).toHaveBeenCalled();
      expect(repository.getBlame.calls.mostRecent().args[0]).toBe(editor.getPath());
    });

    it("loads the refs snapshot before reading the origin url", async () => {
      // `getOriginURL` reads the refs snapshot and returns null until it loads.
      await main.gutterForEditor(editor).toggle();
      expect(repository.ensureRefsSnapshot).toHaveBeenCalled();
    });

    it("bands consecutive lines from the same commit together", async () => {
      await main.gutterForEditor(editor).toggle();

      const shades = blameElements().map((element) =>
        element.classList.contains("git-blame-odd") ? "odd" : "even",
      );
      expect(shades[0]).toBe(shades[1]);
      expect(shades[1]).not.toBe(shades[2]);
    });

    it("marks a line that is not committed yet", async () => {
      await main.gutterForEditor(editor).toggle();

      const last = blameElements()[3];
      expect(last.classList).toContain("git-blame-uncommitted");
      expect(last.textContent).toContain("Not committed yet");
    });

    it("links each line to its commit on the host", async () => {
      await main.gutterForEditor(editor).toggle();

      expect(blameElements()[0].dataset.url).toBe(
        `https://github.com/owner/repo/commit/${SHA_ONE}`,
      );
    });

    it("prefers the repository's own url template over the setting", async () => {
      lumine.config.set("git-blame.commitUrlTemplate", "https://setting/{revision}");
      repository.getConfigValueAsync.and.resolveTo("https://from-git-config/{revision}");

      await main.gutterForEditor(editor).toggle();
      expect(blameElements()[0].dataset.url).toBe(`https://from-git-config/${SHA_ONE}`);
    });

    it("passes the ignore-whitespace setting through to git", async () => {
      lumine.config.set("git-blame.ignoreWhitespace", true);
      await main.gutterForEditor(editor).toggle();

      expect(repository.getBlame.calls.mostRecent().args[1].ignoreWhitespace).toBe(true);
    });

    it("skips a blamed line that is past the end of the buffer", async () => {
      repository.getBlame.and.resolveTo({
        revision: null,
        lines: [...BLAME, blameLine(99, SHA_ONE, "Ada Lovelace")],
      });

      await main.gutterForEditor(editor).toggle();
      expect(blameElements().length).toBe(4);
    });
  });

  describe("hiding the gutter", () => {
    it("removes every decoration and hides the gutter", async () => {
      const blame = main.gutterForEditor(editor);
      await blame.toggle();
      expect(blameElements().length).toBe(4);

      await blame.toggle();
      expect(blame.isVisible()).toBe(false);
      expect(gutter().isVisible()).toBe(false);
      expect(blameElements().length).toBe(0);
    });
  });

  describe("when it cannot blame", () => {
    it("warns and stays hidden for a file that has never been saved", async () => {
      spyOn(lumine.notifications, "addWarning");
      editor.getPath.and.returnValue(null);

      const shown = await main.gutterForEditor(editor).toggle();
      expect(shown).toBe(false);
      expect(lumine.notifications.addWarning).toHaveBeenCalled();
      expect(blameElements().length).toBe(0);
    });

    it("warns and stays hidden for a file outside any repository", async () => {
      spyOn(lumine.notifications, "addWarning");
      lumine.repositories.getForPath.and.returnValue(null);

      const shown = await main.gutterForEditor(editor).toggle();
      expect(shown).toBe(false);
      expect(lumine.notifications.addWarning).toHaveBeenCalled();
    });

    it("warns and stays hidden when git fails", async () => {
      spyOn(lumine.notifications, "addWarning");
      repository.getBlame.and.rejectWith(new Error("no such path"));

      const shown = await main.gutterForEditor(editor).toggle();
      expect(shown).toBe(false);
      expect(lumine.notifications.addWarning).toHaveBeenCalled();
    });

    it("warns and stays hidden when the file has no history", async () => {
      spyOn(lumine.notifications, "addWarning");
      repository.getBlame.and.resolveTo({ revision: null, lines: [] });

      const shown = await main.gutterForEditor(editor).toggle();
      expect(shown).toBe(false);
      expect(lumine.notifications.addWarning).toHaveBeenCalled();
    });

    it("says nothing at all when there is no editor to blame", () => {
      spyOn(lumine.notifications, "addWarning");
      spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(null);

      expect(main.toggle({})).toBeUndefined();
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    });
  });

  describe("refreshing", () => {
    it("re-reads blame when the file is saved", async () => {
      await main.gutterForEditor(editor).toggle();
      const before = repository.getBlame.calls.count();

      // `TextEditor#onDidSave` delegates to the buffer, so the buffer is what
      // has to emit for the subscription to fire.
      editor.getBuffer().emitter.emit("did-save", { path: editor.getPath() });
      await flushMicrotasks();

      expect(repository.getBlame.calls.count()).toBeGreaterThan(before);
    });

    it("does not re-read blame while hidden", async () => {
      const before = repository.getBlame.calls.count();

      // `TextEditor#onDidSave` delegates to the buffer, so the buffer is what
      // has to emit for the subscription to fire.
      editor.getBuffer().emitter.emit("did-save", { path: editor.getPath() });
      await flushMicrotasks();

      expect(repository.getBlame.calls.count()).toBe(before);
    });

    it("re-renders when a display setting changes", async () => {
      await main.gutterForEditor(editor).toggle();
      expect(blameElements()[0].querySelector(".git-blame-hash")).not.toBe(null);

      lumine.config.set("git-blame.showHash", false);
      await flushMicrotasks();

      expect(blameElements()[0].querySelector(".git-blame-hash")).toBe(null);
    });
  });

  describe("clicking a line", () => {
    it("opens the commit on the host", async () => {
      spyOn(lumine.shell, "openExternal");
      await main.gutterForEditor(editor).toggle();

      blameElements()[0].click();
      expect(lumine.shell.openExternal).toHaveBeenCalledWith(
        `https://github.com/owner/repo/commit/${SHA_ONE}`,
      );
    });

    it("copies the hash when there is nowhere to open", async () => {
      spyOn(lumine.shell, "openExternal");
      repository.getOriginURL = () => null;
      await main.gutterForEditor(editor).toggle();

      blameElements()[0].click();
      expect(lumine.shell.openExternal).not.toHaveBeenCalled();
      expect(lumine.clipboard.read()).toBe(SHA_ONE);
    });

    it("does nothing on an uncommitted line", async () => {
      spyOn(lumine.shell, "openExternal");
      await main.gutterForEditor(editor).toggle();

      blameElements()[3].click();
      expect(lumine.shell.openExternal).not.toHaveBeenCalled();
    });
  });

  describe("width", () => {
    it("sets the width as a custom property on the editor", async () => {
      lumine.config.set("git-blame.columnWidth", 300);
      await main.gutterForEditor(editor).toggle();

      expect(editorElement.style.getPropertyValue("--git-blame-column-width")).toBe("300px");
    });

    it("does not leave a style element behind in the document head", async () => {
      await main.gutterForEditor(editor).toggle();
      expect(document.getElementById("com.alexcorre.git-blame.style")).toBe(null);
    });

    // Widening the gutter narrows the text, so without this a soft-wrapped
    // editor re-wraps on every mousemove of the drag.
    it("declares a layout drag for as long as the handle is held", async () => {
      const drag = jasmine.createSpyObj("layoutDrag", ["dispose"]);
      spyOn(lumine.workspace, "beginLayoutDrag").and.returnValue(drag);
      await main.gutterForEditor(editor).toggle();

      const handle = editorElement.querySelector(".git-blame-resize");
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(lumine.workspace.beginLayoutDrag).toHaveBeenCalled();
      expect(drag.dispose).not.toHaveBeenCalled();

      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(drag.dispose).toHaveBeenCalled();
    });

    it("keeps a resize gesture in the detached editor's document", async () => {
      const drag = jasmine.createSpyObj("layoutDrag", ["dispose"]);
      spyOn(lumine.workspace, "beginLayoutDrag").and.returnValue(drag);
      await main.gutterForEditor(editor).toggle();
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      frame.contentDocument.adoptNode(editorElement);
      frame.contentDocument.body.appendChild(editorElement);

      try {
        const handle = editorElement.querySelector(".git-blame-resize");
        const MouseEvent = frame.contentWindow.MouseEvent;
        const initialWidth = Number.parseFloat(
          editorElement.style.getPropertyValue("--git-blame-column-width"),
        );
        handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }));
        frame.contentDocument.dispatchEvent(new MouseEvent("mousemove", { clientX: 125 }));
        frame.contentDocument.dispatchEvent(new MouseEvent("mouseup"));

        expect(editorElement.style.getPropertyValue("--git-blame-column-width")).toBe(
          `${initialWidth + 25}px`,
        );
        expect(drag.dispose).toHaveBeenCalled();
      } finally {
        document.adoptNode(editorElement);
        jasmine.attachToDOM(editorElement);
        frame.remove();
      }
    });
  });

  describe("teardown", () => {
    it("removes the gutter and its decorations when the package deactivates", async () => {
      await main.gutterForEditor(editor).toggle();
      expect(blameElements().length).toBe(4);

      await lumine.packages.deactivatePackage("git-blame");

      expect(blameElements().length).toBe(0);
      expect(editor.gutterWithName(GUTTER_NAME)).toBeFalsy();
    });
  });
});
