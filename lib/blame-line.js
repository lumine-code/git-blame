const { colourForAuthor, formatAuthor, formatDate, isUncommitted, shortHash } = require("./format");

// Builds the element shown in the gutter for one consecutive commit block.
//
// This replaced a React component tree (react, react-dom and recompose, for
// three spans and a link). Nothing is bound per line either: the sha, the link
// and the commit summary ride on data attributes and the gutter handles clicks
// and tooltips by delegation, so a ten-thousand-line file adds no listeners.
function createBlameLine(line, options = {}) {
  const {
    shade = "even",
    url = null,
    showHash = true,
    dateStyle = "short",
    authorStyle = "full",
    colourAuthors = false,
    now,
  } = options;

  const element = document.createElement("div");
  element.className = `git-blame-line git-blame-${shade}`;
  element.dataset.sha = line.sha ?? "";

  // The strip spans the entire block, including its wrapped screen rows.
  const resize = document.createElement("div");
  resize.className = "git-blame-resize";
  element.append(resize);

  // Only this label moves when a long block scrolls past the viewport's top.
  // Its background, click target and resize edge still span the whole block.
  const label = document.createElement("div");
  label.className = "git-blame-label";
  element.append(label);

  if (isUncommitted(line.sha)) {
    element.classList.add("git-blame-uncommitted");
    const pending = document.createElement("span");
    pending.className = "git-blame-pending";
    // Upstream rendered nothing at all for these, leaving a hole in the gutter
    // opposite every line you had just written.
    pending.textContent = "Not committed yet";
    label.append(pending);
    return element;
  }

  if (url) element.dataset.url = url;
  if (line.summary) element.dataset.summary = line.summary;

  if (colourAuthors) {
    element.classList.add("git-blame-coloured");
    element.style.setProperty("--git-blame-author-colour", colourForAuthor(line.author?.name));
  }

  if (showHash) {
    const hash = document.createElement("span");
    hash.className = "git-blame-hash";
    hash.textContent = shortHash(line.sha);
    label.append(hash);
  }

  const date = document.createElement("span");
  date.className = "git-blame-date";
  date.textContent = formatDate(line.author?.date, dateStyle, now);
  label.append(date);

  const author = document.createElement("span");
  author.className = "git-blame-author";
  author.textContent = formatAuthor(line.author?.name, authorStyle);
  label.append(author);

  return element;
}

module.exports = { createBlameLine };
