// Display helpers for a blame line. All pure, so they carry the bulk of the
// spec coverage without needing an editor or a repository.
//
// Upstream reached for moment to format dates and lodash to split names. Both
// are gone: `Intl` covers every format offered here, including the relative one
// moment was mostly carried for.

const SHORT_HASH_LENGTH = 7;

// Largest first, so the first unit the gap reaches is the one used.
const RELATIVE_UNITS = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

// A line that is not committed yet blames against the all-zero sha.
function isUncommitted(sha) {
  return typeof sha === "string" && /^0+$/.test(sha);
}

function shortHash(sha) {
  return typeof sha === "string" ? sha.slice(0, SHORT_HASH_LENGTH) : "";
}

function formatRelative(date, now) {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.trunc(seconds / size), unit);
  }
  return formatter.format(0, "second");
}

function formatDate(date, style = "short", now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";

  switch (style) {
    case "relative":
      return formatRelative(date, now);
    case "iso":
      // Local rather than UTC: `toISOString` would shift the date across the
      // day boundary for anyone east or west of Greenwich.
      return [
        String(date.getFullYear()).padStart(4, "0"),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("-");
    case "long":
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
    case "short":
    default:
      return new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(date);
  }
}

function formatAuthor(name, style = "full") {
  if (typeof name !== "string") return "";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  switch (style) {
    case "first":
      return words[0];
    case "last":
      return words[words.length - 1];
    case "full":
    default:
      return words.join(" ");
  }
}

// Stable colour per author, so the same person keeps the same stripe across
// files and sessions.
const colourCache = new Map();

function colourForAuthor(name) {
  const key = String(name ?? "");
  const cached = colourCache.get(key);
  if (cached) return cached;

  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }

  let colour = "#";
  for (let i = 0; i < 3; i++) {
    colour += ((hash >> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }

  colourCache.set(key, colour);
  return colour;
}

module.exports = {
  SHORT_HASH_LENGTH,
  colourForAuthor,
  formatAuthor,
  formatDate,
  isUncommitted,
  shortHash,
};
