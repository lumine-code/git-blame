const { createBlameLine } = require("../lib/blame-line");

describe("blame-line", () => {
  const line = {
    line: 1,
    originalLine: 1,
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    author: { name: "Ada Lovelace", email: "ada@example.com", date: new Date(2026, 7, 11) },
    summary: "Teach the engine to weave",
  };

  it("renders the hash, date and author", () => {
    const element = createBlameLine(line, { dateStyle: "iso" });
    expect(element.querySelector(".git-blame-hash").textContent).toBe("abcdef1");
    expect(element.querySelector(".git-blame-date").textContent).toBe("2026-08-11");
    expect(element.querySelector(".git-blame-author").textContent).toBe("Ada Lovelace");
  });

  it("omits the hash when asked to", () => {
    const element = createBlameLine(line, { showHash: false });
    expect(element.querySelector(".git-blame-hash")).toBe(null);
  });

  it("shortens the author on request", () => {
    const element = createBlameLine(line, { authorStyle: "first" });
    expect(element.querySelector(".git-blame-author").textContent).toBe("Ada");
  });

  it("carries the sha, url and summary as data rather than as listeners", () => {
    const element = createBlameLine(line, { url: "https://example.com/c/abc" });
    expect(element.dataset.sha).toBe(line.sha);
    expect(element.dataset.url).toBe("https://example.com/c/abc");
    expect(element.dataset.summary).toBe("Teach the engine to weave");
  });

  it("omits the url when there is nowhere to link", () => {
    const element = createBlameLine(line, { url: null });
    expect(element.dataset.url).toBeUndefined();
  });

  it("applies the shade it is given", () => {
    expect(createBlameLine(line, { shade: "odd" }).classList).toContain("git-blame-odd");
    expect(createBlameLine(line, { shade: "even" }).classList).toContain("git-blame-even");
  });

  it("sets an author colour only when colouring is on", () => {
    const plain = createBlameLine(line, { colourAuthors: false });
    expect(plain.style.getPropertyValue("--git-blame-author-colour")).toBe("");

    const coloured = createBlameLine(line, { colourAuthors: true });
    expect(coloured.classList).toContain("git-blame-coloured");
    expect(coloured.style.getPropertyValue("--git-blame-author-colour")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("carries a resize handle on every row", () => {
    expect(createBlameLine(line, {}).querySelector(".git-blame-resize")).not.toBe(null);
  });

  describe("an uncommitted line", () => {
    const pending = { ...line, sha: "0".repeat(40) };

    it("says so instead of rendering a blank row", () => {
      // Upstream skipped these entirely, leaving a hole in the gutter opposite
      // every line you had just written.
      const element = createBlameLine(pending, {});
      expect(element.classList).toContain("git-blame-uncommitted");
      expect(element.querySelector(".git-blame-pending").textContent).toBe("Not committed yet");
    });

    it("carries no hash, date, author or link", () => {
      const element = createBlameLine(pending, { url: "https://example.com/c/000" });
      expect(element.querySelector(".git-blame-hash")).toBe(null);
      expect(element.querySelector(".git-blame-date")).toBe(null);
      expect(element.querySelector(".git-blame-author")).toBe(null);
      expect(element.dataset.url).toBeUndefined();
    });
  });
});
