const { CompositeDisposable } = require("lumine");
const { BlameGutter } = require("./blame-gutter");

module.exports = {
  activate() {
    this.gutters = new Map();
    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(
      lumine.commands.add("lumine-workspace", {
        "git-blame:toggle": (event) => this.toggle(event),
      }),
    );
  },

  deactivate() {
    for (const gutter of this.gutters.values()) gutter.destroy();
    this.gutters.clear();
    this.subscriptions.dispose();
    this.subscriptions = null;
  },

  toggle(event) {
    // The menu and the palette dispatch at whatever holds focus, a keystroke
    // and a right-click at the editor they came from.
    const editor =
      lumine.textEditors.getTextEditorForElement(event?.target, { includeMini: false }) ??
      lumine.workspace.getActiveTextEditor() ??
      null;

    // No editor at all: the absence is already on screen, so say nothing.
    // Anything the gutter itself refuses is reported by the gutter, which knows
    // which of the reasons applied.
    if (!editor) return undefined;

    return this.gutterForEditor(editor).toggle();
  },

  gutterForEditor(editor) {
    let gutter = this.gutters.get(editor);
    if (gutter) return gutter;

    gutter = new BlameGutter(editor);
    this.gutters.set(editor, gutter);
    this.subscriptions.add(
      editor.onDidDestroy(() => {
        this.gutters.get(editor)?.destroy();
        this.gutters.delete(editor);
      }),
    );
    return gutter;
  },
};
