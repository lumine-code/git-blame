const { CompositeDisposable } = require("lumine");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "git-blame",
      tips: [
        "You can see who last changed each line, and when, with {{ 'git-blame:toggle' | keystroke }}",
      ],
    };
  },

  activate() {
    this.gutters = new Map();
    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "git-blame:toggle": {
          isAvailable: (event) => this.canToggle(event),
          didDispatch: (event) => this.toggle(event),
        },
      }),
    );
  },

  deactivate() {
    for (const gutter of this.gutters?.values() ?? []) gutter.destroy();
    this.gutters?.clear();
    this.subscriptions?.dispose();
    this.subscriptions = null;
  },

  editorForEvent(event) {
    // The menu and the palette dispatch at whatever holds focus, a keystroke
    // and a right-click at the editor they came from.
    const context = event?.context;
    return (
      lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false }) ??
      (context
        ? (context.embeddedEditor ??
          context.editor ??
          context.window?.getEditorContainer?.()?.getActiveEmbeddedTextEditor?.() ??
          null)
        : (lumine.workspace.getActiveEmbeddedTextEditor() ??
          lumine.workspace.getActiveTextEditor() ??
          null))
    );
  },

  canToggle(event) {
    const editor = this.editorForEvent(event);
    if (!editor || editor.isDestroyed() || editor.getGrammar() === lumine.grammars.nullGrammar)
      return false;
    if (this.gutters.get(editor)?.isVisible()) return true;
    const path = editor.getPath();
    const repository = path && lumine.repositories.getForPath(path);
    if (!repository || repository.isDestroyed?.()) return false;
    const snapshot = repository.getStatusSnapshot?.();
    const entry = repository.getStatusEntry?.(path);
    return Boolean(
      !snapshot?.initialized ||
      (snapshot.head?.oid && !entry?.untracked && !entry?.ignored && entry?.indexStatus !== "A"),
    );
  },

  toggle(event) {
    const editor = this.editorForEvent(event);

    // No editor at all: the absence is already on screen, so say nothing.
    // Anything the gutter itself refuses is reported by the gutter, which knows
    // which of the reasons applied.
    if (!editor || editor.getGrammar() === lumine.grammars.nullGrammar) return undefined;

    return Promise.resolve(this.gutterForEditor(editor).toggle()).finally(() =>
      lumine.commands.invalidateAvailability(),
    );
  },

  gutterForEditor(editor) {
    if (editor.getGrammar() === lumine.grammars.nullGrammar) return;
    let gutter = this.gutters.get(editor);
    if (gutter) return gutter;

    const { BlameGutter } = require("./blame-gutter");
    gutter = new BlameGutter(editor);
    this.gutters.set(editor, gutter);
    const owner = this.subscriptions;
    const retire = () => {
      const current = this.gutters.get(editor) === gutter;
      if (current) {
        this.gutters.delete(editor);
      }
      // Release the exact closed-editor callback before opaque gutter cleanup.
      owner.remove(registration);
      registration.dispose();
      if (current) gutter.destroy();
      lumine.commands.invalidateAvailability();
    };
    const registration = new CompositeDisposable(
      editor.onDidDestroy(retire),
      editor.onDidChangeGrammar(() => {
        if (editor.getGrammar() === lumine.grammars.nullGrammar) retire();
      }),
    );
    owner.add(registration);
    return gutter;
  },
};
