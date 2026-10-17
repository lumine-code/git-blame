const path = require("node:path");

describe("Git Blame syntax palette ownership", () => {
  it("keeps gutter text and bands independent of the UI palette", () => {
    const sheet = lumine.themes.requireStylesheet(path.join(__dirname, "../styles/main.css"));
    const host = document.createElement("div");
    host.style.cssText =
      "--syntax-text-color: rgb(220,230,240); --syntax-gutter-background-color: rgb(20,30,40);";
    host.innerHTML =
      '<lumine-text-editor><div class="gutter" gutter-name="git-blame"><div class="git-blame-line git-blame-even"><span class="git-blame-hash">abc123</span><span class="git-blame-author">Author</span><span class="git-blame-date">Today</span></div></div></lumine-text-editor>';
    jasmine.attachToDOM(host);
    try {
      const row = host.querySelector(".git-blame-line");
      const colors = () => [
        getComputedStyle(row).backgroundColor,
        ...Array.from(row.children, (node) => getComputedStyle(node).color),
      ];
      const expected = colors();
      host.style.setProperty("--base-background-color", "white");
      host.style.setProperty("--text-color", "black");
      host.style.setProperty("--text-color-subtle", "red");
      expect(colors()).toEqual(expected);
      expect(getComputedStyle(row.firstElementChild).color).toBe("rgb(220, 230, 240)");
    } finally {
      host.remove();
      sheet.dispose();
    }
  });
});
