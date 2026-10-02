const path = require("path");
const { Emitter } = require("lumine");
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
    const emitter = new Emitter();
    let headOid = SHA_ONE;
    return {
      ensureRefsSnapshot: jasmine.createSpy("ensureRefsSnapshot").and.resolveTo(undefined),
      getBlame: jasmine.createSpy("getBlame").and.resolveTo({ revision: null, lines }),
      getConfigValueAsync: jasmine.createSpy("getConfigValueAsync").and.resolveTo(config),
      getOriginURL: () => origin,
      getStatusSnapshot: () => ({ head: { oid: headOid } }),
      onDidChangeStatusSnapshot: (callback) => emitter.on("did-change-status", callback),
      changeHead: (oid) => {
        headOid = oid;
        emitter.emit("did-change-status");
      },
    };
  }

  function gutter() {
    return editor.gutterWithName(GUTTER_NAME);
  }

  function blameElements() {
    return Array.from(editorElement.querySelectorAll(".git-blame-line"));
  }

  function blameDecorations() {
    return editor.getDecorations({ type: "gutter", gutterName: GUTTER_NAME });
  }

  async function settleDisplay() {
    await flushMicrotasks();
    editorElement.getComponent().updateSync();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    editorElement.getComponent().updateSync();
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
    it("adds a visible gutter with one label per consecutive commit block", async () => {
      await main.gutterForEditor(editor).toggle();

      expect(gutter()).toBeTruthy();
      expect(gutter().isVisible()).toBe(true);
      expect(blameElements().length).toBe(3);
      expect(blameElements()[0].querySelectorAll(".git-blame-label").length).toBe(1);
      expect(blameElements()[0].querySelectorAll(".git-blame-author").length).toBe(1);
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

    it("alternates the shade between consecutive commit blocks", async () => {
      await main.gutterForEditor(editor).toggle();

      const shades = blameElements().map((element) =>
        element.classList.contains("git-blame-odd") ? "odd" : "even",
      );
      expect(shades[0]).not.toBe(shades[1]);
      expect(shades[0]).toBe(shades[2]);
    });

    it("covers exactly the block's buffer rows", async () => {
      await main.gutterForEditor(editor).toggle();

      const ranges = blameDecorations().map((decoration) =>
        decoration.getMarker().getBufferRange().serialize(),
      );
      expect(ranges).toEqual([
        [
          [0, 0],
          [1, 3],
        ],
        [
          [2, 0],
          [2, 5],
        ],
        [
          [3, 0],
          [3, 4],
        ],
      ]);
    });

    it("starts a separate block when the same commit returns later", async () => {
      repository.getBlame.and.resolveTo({
        revision: null,
        lines: [...BLAME, blameLine(5, SHA_ONE, "Ada Lovelace")],
      });
      await main.gutterForEditor(editor).toggle();

      expect(blameElements().map((element) => element.dataset.sha)).toEqual([
        SHA_ONE,
        SHA_TWO,
        UNCOMMITTED,
        SHA_ONE,
      ]);
      expect(blameDecorations()[3].getMarker().getBufferRange().serialize()).toEqual([
        [4, 0],
        [4, 0],
      ]);
    });

    it("does not join matching commits across a missing blame row", async () => {
      repository.getBlame.and.resolveTo({
        revision: null,
        lines: [blameLine(1, SHA_ONE, "Ada"), blameLine(3, SHA_ONE, "Ada")],
      });
      await main.gutterForEditor(editor).toggle();

      expect(blameElements().length).toBe(2);
      expect(
        blameDecorations().map((decoration) => decoration.getMarker().getBufferRange().serialize()),
      ).toEqual([
        [
          [0, 0],
          [0, 3],
        ],
        [
          [2, 0],
          [2, 5],
        ],
      ]);
    });

    it("groups consecutive uncommitted rows under one label", async () => {
      repository.getBlame.and.resolveTo({
        revision: null,
        lines: [
          ...BLAME.slice(0, 2),
          blameLine(3, UNCOMMITTED, "Not Committed Yet"),
          blameLine(4, UNCOMMITTED, "Not Committed Yet"),
        ],
      });
      await main.gutterForEditor(editor).toggle();

      expect(blameElements().length).toBe(2);
      expect(editorElement.querySelectorAll(".git-blame-pending").length).toBe(1);
      expect(blameDecorations()[1].getMarker().getBufferRange().serialize()).toEqual([
        [2, 0],
        [3, 4],
      ]);
    });

    it("marks a line that is not committed yet", async () => {
      await main.gutterForEditor(editor).toggle();

      const last = blameElements()[2];
      expect(last.classList).toContain("git-blame-uncommitted");
      expect(last.textContent).toContain("Not committed yet");
    });

    it("links each block to its commit on the host", async () => {
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
      expect(blameElements().length).toBe(3);
    });
  });

  describe("hiding the gutter", () => {
    it("removes every decoration and hides the gutter", async () => {
      const blame = main.gutterForEditor(editor);
      await blame.toggle();
      expect(blameElements().length).toBe(3);

      await blame.toggle();
      expect(blame.isVisible()).toBe(false);
      expect(gutter().isVisible()).toBe(false);
      expect(blameElements().length).toBe(0);
    });

    it("cancels the initial blame read before the gutter becomes visible", async () => {
      let complete;
      repository.getBlame.and.returnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const blame = main.gutterForEditor(editor);
      const showing = blame.setVisible(true);
      await flushMicrotasks();
      expect(blame.isVisible()).toBe(false);

      await blame.setVisible(false);
      complete({ revision: null, lines: BLAME });

      expect(await showing).toBe(false);
      await settleDisplay();
      expect(blame.isVisible()).toBe(false);
      expect(gutter()?.isVisible()).not.toBe(true);
      expect(blameDecorations().length).toBe(0);
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
    it("keeps the latest initial show's repository observer after an older show is cancelled", async () => {
      const blame = main.gutterForEditor(editor);
      let finishOlder;
      let calls = 0;
      const render = blame.render.bind(blame);
      spyOn(blame, "render").and.callFake(() => {
        if (++calls === 1) return new Promise((resolve) => (finishOlder = resolve));
        return render();
      });
      const draw = blame.draw.bind(blame);
      spyOn(blame, "draw").and.callFake((...args) => {
        draw(...args);
        // Resume the older show after the new render has drawn, before the
        // newer setVisible continuation has marked the gutter as visible.
        finishOlder(false);
      });

      const older = blame.setVisible(true);
      const newer = blame.setVisible(true);

      expect(await older).toBe(false);
      expect(await newer).toBe(true);
      expect(blame.repository).toBe(repository);
      expect(blame.repositorySubscription).toBeTruthy();
    });

    it("cancels the refs request when an initial show is hidden", async () => {
      const blame = main.gutterForEditor(editor);
      repository.ensureRefsSnapshot.and.callFake(
        ({ signal }) =>
          new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
          ),
      );
      spyOn(lumine.notifications, "addWarning");

      const showing = blame.setVisible(true);
      const signal = repository.ensureRefsSnapshot.calls.mostRecent().args[0].signal;
      await blame.setVisible(false);

      expect(await showing).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    });

    it("cancels the commit URL config request when a pending show is hidden", async () => {
      const blame = main.gutterForEditor(editor);
      repository.getConfigValueAsync.and.callFake(
        (key, { signal }) =>
          new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
          ),
      );
      spyOn(lumine.notifications, "addWarning");

      const showing = blame.setVisible(true);
      await flushMicrotasks();
      const signal = repository.getConfigValueAsync.calls.mostRecent().args[1].signal;
      expect(repository.getBlame.calls.mostRecent().args[1].signal).toBe(signal);
      await blame.setVisible(false);

      expect(await showing).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    });

    it("retries an initial blame when HEAD changes before it finishes", async () => {
      const blame = main.gutterForEditor(editor);
      let finish;
      repository.getBlame.and.callFake(() => new Promise((resolve) => (finish = resolve)));
      const showing = blame.setVisible(true);
      await flushMicrotasks();
      repository.changeHead(SHA_TWO);
      repository.getBlame.and.resolveTo({ revision: null, lines: BLAME });
      finish({ revision: null, lines: BLAME });

      expect(await showing).toBe(true);
      expect(repository.getBlame.calls.mostRecent().args[1].signal.aborted).toBe(false);
      expect(blame.isVisible()).toBe(true);
    });

    it("refreshes after HEAD changes while skipping index-only status events", async () => {
      await main.gutterForEditor(editor).toggle();
      repository.getBlame.calls.reset();

      repository.changeHead(SHA_ONE);
      await flushMicrotasks();
      expect(repository.getBlame).not.toHaveBeenCalled();

      repository.changeHead(SHA_TWO);
      await flushMicrotasks();
      expect(repository.getBlame).toHaveBeenCalledTimes(1);
    });

    it("re-reads blame for the editor's new path", async () => {
      await main.gutterForEditor(editor).toggle();
      repository.getBlame.calls.reset();
      const newPath = path.join("repo", "renamed.js");
      editor.getPath.and.returnValue(newPath);
      editor.emitter.emit("did-change-path", newPath);
      await flushMicrotasks();

      expect(repository.getBlame.calls.mostRecent().args[0]).toBe(newPath);
    });

    it("cancels hidden blame requests and suppresses their late errors", async () => {
      const blame = main.gutterForEditor(editor);
      await blame.toggle();
      let rejectBlame;
      repository.getBlame.and.callFake(
        () => new Promise((resolve, reject) => (rejectBlame = reject)),
      );
      spyOn(lumine.notifications, "addWarning");
      const rendering = blame.render();
      await flushMicrotasks();
      const signal = repository.getBlame.calls.mostRecent().args[1].signal;

      await blame.setVisible(false);
      rejectBlame(new Error("late blame failure"));

      expect(await rendering).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
      expect(blameDecorations().length).toBe(0);
    });

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

  describe("interacting with a block", () => {
    it("opens the commit when the empty part of its block is clicked", async () => {
      spyOn(lumine.shell, "openExternal").and.resolveTo();
      await main.gutterForEditor(editor).toggle();

      blameElements()[0].click();
      expect(lumine.shell.openExternal).toHaveBeenCalledWith(
        `https://github.com/owner/repo/commit/${SHA_ONE}`,
      );
    });

    it("reports a rejected commit URL without an unhandled promise", async () => {
      const error = new Error("unsupported URL");
      spyOn(lumine.shell, "openExternal").and.rejectWith(error);
      spyOn(lumine.notifications, "addWarning");
      await main.gutterForEditor(editor).toggle();

      blameElements()[0].click();
      await flushMicrotasks();

      expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
        "Unable to open the commit URL.",
        { detail: error.message, dismissable: true },
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

    it("does nothing on an uncommitted block", async () => {
      spyOn(lumine.shell, "openExternal");
      await main.gutterForEditor(editor).toggle();

      blameElements()[2].click();
      expect(lumine.shell.openExternal).not.toHaveBeenCalled();
    });

    it("anchors one tooltip to the visible label when any part of its block is hovered", async () => {
      const tooltip = jasmine.createSpyObj("tooltip", ["dispose"]);
      spyOn(lumine.tooltips, "add").and.returnValue(tooltip);
      await main.gutterForEditor(editor).toggle();
      const block = blameElements()[0];
      const label = block.querySelector(".git-blame-label");
      const enter = jasmine.createSpy("label mouseenter");
      const leave = jasmine.createSpy("label mouseleave");
      label.addEventListener("mouseenter", enter);
      label.addEventListener("mouseleave", leave);
      block.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: editorElement }),
      );
      block
        .querySelector(".git-blame-author")
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: block }));
      block.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: label }));

      expect(enter).toHaveBeenCalledTimes(1);
      expect(leave).not.toHaveBeenCalled();
      block.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: editorElement }),
      );
      expect(leave).toHaveBeenCalledTimes(1);
      block.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: editorElement }),
      );
      expect(enter).toHaveBeenCalledTimes(2);

      expect(lumine.tooltips.add).toHaveBeenCalledOnceWith(label, {
        title: BLAME[0].summary,
        placement: "right",
        html: false,
      });

      await main.gutterForEditor(editor).setVisible(false);
      expect(tooltip.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("display layout", () => {
    it("includes the wrapped continuation of the block's last line", async () => {
      editor.setText(`one\n${"wrapped content ".repeat(12)}\nthree\nfour\n`);
      editor.update({
        softWrapped: true,
        softWrapAtPreferredLineLength: true,
        preferredLineLength: 20,
      });
      await main.gutterForEditor(editor).toggle();
      await settleDisplay();

      const endScreenRow = editor.screenPositionForBufferPosition([
        1,
        editor.lineTextForBufferRow(1).length,
      ]).row;
      expect(endScreenRow).toBeGreaterThan(1);
      expect(blameDecorations()[0].getMarker().getEndScreenPosition().row).toBe(endScreenRow);
      expect(blameElements()[0].getBoundingClientRect().height).toBeNear(
        (endScreenRow + 1) * editor.getLineHeightInPixels(),
      );
      expect(blameElements()[0].querySelectorAll(".git-blame-label").length).toBe(1);
    });

    it("keeps the label visible while scrolling inside a long block", async () => {
      const tooltip = jasmine.createSpyObj("tooltip", ["dispose"]);
      spyOn(lumine.tooltips, "add").and.returnValue(tooltip);
      editor.setText(Array.from({ length: 80 }, (_, row) => `line ${row}`).join("\n"));
      repository.getBlame.and.resolveTo({
        revision: null,
        lines: Array.from({ length: 80 }, (_, row) => blameLine(row + 1, SHA_ONE, "Ada")),
      });
      editorElement.setHeight(160);
      await main.gutterForEditor(editor).toggle();
      await settleDisplay();
      const before = repository.getBlame.calls.count();
      const block = blameElements()[0];
      const label = block.querySelector(".git-blame-label");
      const initialTop = label.getBoundingClientRect().top;

      editorElement.setScrollTop(20 * editor.getLineHeightInPixels() + 3);
      await settleDisplay();

      expect(editorElement.getScrollTop()).toBeGreaterThan(0);
      expect(label.getBoundingClientRect().top).toBeNear(initialTop);
      expect(block.getBoundingClientRect().top).toBeLessThan(initialTop);
      expect(blameElements().length).toBe(1);
      expect(repository.getBlame.calls.count()).toBe(before);
      block.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: editorElement }),
      );
      expect(lumine.tooltips.add.calls.mostRecent().args[0]).toBe(label);
      expect(lumine.tooltips.add.calls.mostRecent().args[0].getBoundingClientRect().top).toBeNear(
        initialTop,
      );

      editorElement.setScrollTop(0);
      await settleDisplay();
      expect(label.getBoundingClientRect().top).toBeNear(initialTop);
      expect(label.getBoundingClientRect().top).toBeNear(block.getBoundingClientRect().top);
    });

    it("does not move a label past the bottom of its block", async () => {
      editor.setText(Array.from({ length: 80 }, (_, row) => `line ${row}`).join("\n"));
      repository.getBlame.and.resolveTo({
        revision: null,
        lines: Array.from({ length: 80 }, (_, row) =>
          blameLine(row + 1, row < 10 ? SHA_ONE : SHA_TWO, "Ada"),
        ),
      });
      editorElement.setHeight(160);
      await main.gutterForEditor(editor).toggle();
      await settleDisplay();
      const block = blameElements()[0];
      const label = block.querySelector(".git-blame-label");

      editorElement.setScrollTop(9 * editor.getLineHeightInPixels() + 3);
      await settleDisplay();

      expect(label.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        block.getBoundingClientRect().bottom + 1,
      );
    });

    describe("smooth scrolling", () => {
      async function showSmoothGutter(blockRows = 240) {
        editor.setText(Array.from({ length: 240 }, (_, row) => `line ${row}`).join("\n"));
        repository.getBlame.and.resolveTo({
          revision: null,
          lines: Array.from({ length: 240 }, (_, row) =>
            blameLine(row + 1, row < blockRows ? SHA_ONE : SHA_TWO, "Ada"),
          ),
        });
        editorElement.setHeight(160);
        await main.gutterForEditor(editor).toggle();
        await settleDisplay();
        const component = editorElement.getComponent();
        // Use the editor's real frame path, with a deterministic animation clock.
        component.scrollAnimator.raf = () => 0;
        component.scrollAnimator.caf = () => {};
        return component;
      }

      async function scrollFrames(component, top, inspectFrame) {
        const animator = component.scrollAnimator;
        animator.scrollTo({ top, smoothness: 8 });
        expect(animator.isAnimating()).toBe(true);
        let frames = 0;
        while (animator.isAnimating() && frames < 100) {
          animator.advance(1000 / 60);
          // Measure the frame just committed by the editor. Waiting for the
          // label's separate rAF first would hide a one-frame lag.
          inspectFrame();
          frames++;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        expect(animator.isAnimating()).toBe(false);
        expect(frames).toBeGreaterThan(2);
      }

      it("keeps the label still in every fractional scroll frame across tile boundaries", async () => {
        const originalPixelRatio = window.devicePixelRatio;
        try {
          window.devicePixelRatio = 1.25;
          expect(window.devicePixelRatio).toBe(1.25);
          const component = await showSmoothGutter();
          const block = blameElements()[0];
          const label = block.querySelector(".git-blame-label");
          const initialTop = label.getBoundingClientRect().top;
          const initialTile = component.mountedTileStartRow;
          const lineHeight = editor.getLineHeightInPixels();
          const before = repository.getBlame.calls.count();
          let maxMovement = 0;
          let crossedTileBoundary = false;
          let fractionalFrames = 0;
          const inspectFrame = () => {
            maxMovement = Math.max(
              maxMovement,
              Math.abs(label.getBoundingClientRect().top - initialTop),
            );
            crossedTileBoundary ||= component.mountedTileStartRow !== initialTile;
            if (!Number.isInteger(editorElement.getScrollTop())) fractionalFrames++;
          };

          await scrollFrames(component, 120 * lineHeight + 0.37, inspectFrame);
          const updateSync = spyOn(component, "updateSync").and.callThrough();
          // The block starts far above the mounted tiles. Its sticky label
          // must not force the editor to render that off-screen row again.
          await scrollFrames(component, 120.5 * lineHeight + 0.63, inspectFrame);
          expect(updateSync).not.toHaveBeenCalled();
          await scrollFrames(component, 2 * lineHeight + 0.63, inspectFrame);

          expect(crossedTileBoundary).toBe(true);
          expect(fractionalFrames).toBeGreaterThan(2);
          expect(maxMovement)
            .withContext("maximum label movement within a sticky block")
            .toBeLessThan(0.05);
          expect(blameElements().length).toBe(1);
          expect(repository.getBlame.calls.count()).toBe(before);
        } finally {
          window.devicePixelRatio = originalPixelRatio;
        }
      });

      it("clamps to the block bottom in the same frame while scrolling both ways", async () => {
        const originalPixelRatio = window.devicePixelRatio;
        try {
          window.devicePixelRatio = 1.5;
          expect(window.devicePixelRatio).toBe(1.5);
          const component = await showSmoothGutter(12);
          const block = blameElements()[0];
          const label = block.querySelector(".git-blame-label");
          const initialTop = label.getBoundingClientRect().top;
          const lineHeight = editor.getLineHeightInPixels();
          let maxMovement = 0;
          let clampedFrames = 0;
          let stickyFrames = 0;
          const inspectFrame = () => {
            const blockBounds = block.getBoundingClientRect();
            const labelBounds = label.getBoundingClientRect();
            const expectedTop = Math.max(
              blockBounds.top,
              Math.min(initialTop, blockBounds.bottom - labelBounds.height),
            );
            maxMovement = Math.max(maxMovement, Math.abs(labelBounds.top - expectedTop));
            if (expectedTop < initialTop) clampedFrames++;
            else stickyFrames++;
          };

          await scrollFrames(component, 11.5 * lineHeight + 0.37, inspectFrame);
          await scrollFrames(component, 2 * lineHeight + 0.63, inspectFrame);

          expect(clampedFrames).toBeGreaterThan(2);
          expect(stickyFrames).toBeGreaterThan(2);
          expect(maxMovement)
            .withContext("maximum frame error at the block's sticky bottom")
            .toBeLessThan(0.05);
        } finally {
          window.devicePixelRatio = originalPixelRatio;
        }
      });
    });

    it("reflows one block after folding and unfolding its own rows", async () => {
      await main.gutterForEditor(editor).toggle();
      await settleDisplay();
      const block = blameElements()[0];
      const before = repository.getBlame.calls.count();
      expect(block.getBoundingClientRect().height).toBeNear(2 * editor.getLineHeightInPixels());

      editor.foldBufferRowRange(0, 1);
      await settleDisplay();
      expect(block.getBoundingClientRect().height).toBeNear(editor.getLineHeightInPixels());
      expect(block.querySelectorAll(".git-blame-label").length).toBe(1);

      editor.unfoldBufferRow(0);
      await settleDisplay();
      expect(block.getBoundingClientRect().height).toBeNear(2 * editor.getLineHeightInPixels());
      expect(repository.getBlame.calls.count()).toBe(before);
    });

    it("does not stack hidden commit blocks on a folded header", async () => {
      await main.gutterForEditor(editor).toggle();
      editor.foldBufferRowRange(0, 3);
      await settleDisplay();

      const displayed = blameElements().filter(
        (element) =>
          element.getBoundingClientRect().height > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      );
      expect(displayed.length).toBe(1);
      expect(displayed[0].dataset.sha).toBe(SHA_ONE);

      editor.unfoldBufferRow(0);
      await settleDisplay();
      expect(
        blameElements().filter(
          (element) =>
            element.getBoundingClientRect().height > 0 &&
            getComputedStyle(element).visibility !== "hidden",
        ).length,
      ).toBe(3);
    });

    it("places a block that starts inside a fold below the visible header", async () => {
      editor.setText("one\ntwo\nthree\nfour\nfive\nsix\n");
      repository.getBlame.and.resolveTo({
        revision: null,
        lines: [
          blameLine(1, SHA_ONE, "Ada"),
          ...[2, 3, 4, 5].map((row) => blameLine(row, SHA_TWO, "Grace")),
          blameLine(6, SHA_ONE, "Ada"),
        ],
      });
      await main.gutterForEditor(editor).toggle();
      await settleDisplay();

      editor.foldBufferRowRange(0, 2);
      await settleDisplay();
      const [header, continuation] = blameElements();
      const label = continuation.querySelector(".git-blame-label");
      const lineHeight = editor.getLineHeightInPixels();

      expect(getComputedStyle(continuation).visibility).toBe("visible");
      expect(continuation.style.clipPath).toBe(`inset(${lineHeight}px 0px 0px)`);
      expect(label.getBoundingClientRect().top).toBeNear(
        header.getBoundingClientRect().top + lineHeight,
      );
      expect(label.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        continuation.getBoundingClientRect().bottom + 1,
      );

      editor.unfoldBufferRow(0);
      await settleDisplay();
      expect(continuation.style.clipPath).toBe("");
      expect(label.getBoundingClientRect().top).toBeNear(continuation.getBoundingClientRect().top);
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
  });

  describe("teardown", () => {
    it("does not recreate the gutter when a destroyed controller's blame read finishes", async () => {
      let complete;
      repository.getBlame.and.returnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const blame = main.gutterForEditor(editor);
      const showing = blame.setVisible(true);
      await flushMicrotasks();

      blame.destroy();
      complete({ revision: null, lines: BLAME });

      expect(await showing).toBe(false);
      await settleDisplay();
      expect(editor.gutterWithName(GUTTER_NAME)).toBeFalsy();
      expect(blameDecorations().length).toBe(0);
      expect(blameElements().length).toBe(0);
    });

    it("ignores an unfinished refresh when the package deactivates", async () => {
      const blame = main.gutterForEditor(editor);
      await blame.setVisible(true);
      let complete;
      repository.getBlame.and.returnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const rendering = blame.render();
      await flushMicrotasks();

      await lumine.packages.deactivatePackage("git-blame");
      complete({ revision: null, lines: BLAME });

      expect(await rendering).toBe(false);
      await settleDisplay();
      expect(editor.gutterWithName(GUTTER_NAME)).toBeFalsy();
      expect(blameDecorations().length).toBe(0);
      expect(blameElements().length).toBe(0);
    });

    it("removes the gutter and its decorations when the package deactivates", async () => {
      await main.gutterForEditor(editor).toggle();
      expect(blameElements().length).toBe(3);

      await lumine.packages.deactivatePackage("git-blame");

      expect(blameElements().length).toBe(0);
      expect(editor.gutterWithName(GUTTER_NAME)).toBeFalsy();
    });
  });
});
