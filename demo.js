// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript", "tree-view"],
  viewport: { width: 1200, height: 600 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    const git = (args) =>
      require("node:child_process").execFileSync("git", args, {
        cwd: context.project,
        windowsHide: true,
      });
    git(["branch", "smoothing"]);
    git(["branch", "data-validation"]);
    state.editor = await open("Version Control/signal.js");
    state.editor.setText(
      "export function average(samples) {\n  return samples.reduce((sum, value) => sum + value, 0) / samples.length;\n}\n\nconst samples = [0.2, 0.8, -0.4, 0.5, 1.0];\nconsole.log(average(samples));\n",
    );
    await state.editor.save();
    await lumine.project.setPaths([fixture("Version Control")]);
    await new Promise((r) => setTimeout(r, 600));
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Read actual commit attribution next to the source lines.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          lumine.commands.dispatch(lumine.views.getView(state.editor), "git-blame:toggle");
        }
      },
      ready() {
        return Boolean(
          document
            .querySelector('.gutter[gutter-name="git-blame"]')
            ?.innerText.includes("Lumine Demo"),
        );
      },
    },
  ],
  async cleanup() {},
};
