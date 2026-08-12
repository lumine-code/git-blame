const {
  colourForAuthor,
  formatAuthor,
  formatDate,
  isUncommitted,
  shortHash,
} = require("../lib/format");

describe("format", () => {
  describe("isUncommitted", () => {
    it("recognises the all-zero sha git uses for an uncommitted line", () => {
      expect(isUncommitted("0".repeat(40))).toBe(true);
      expect(isUncommitted("0")).toBe(true);
    });

    it("rejects a real sha and anything that is not a string", () => {
      expect(isUncommitted("a0".repeat(20))).toBe(false);
      expect(isUncommitted(null)).toBe(false);
      expect(isUncommitted(undefined)).toBe(false);
    });
  });

  describe("shortHash", () => {
    it("abbreviates to seven characters", () => {
      expect(shortHash("0123456789abcdef")).toBe("0123456");
    });

    it("survives a missing sha", () => {
      expect(shortHash(null)).toBe("");
    });
  });

  describe("formatDate", () => {
    const date = new Date(2026, 7, 11, 13, 30, 0);

    it("writes an ISO date in the local timezone", () => {
      // Deliberately not `toISOString`, which would shift the day for anyone
      // east or west of Greenwich.
      expect(formatDate(date, "iso")).toBe("2026-08-11");
    });

    it("pads single-digit months and days", () => {
      expect(formatDate(new Date(2026, 0, 2), "iso")).toBe("2026-01-02");
    });

    it("writes short and long forms without throwing", () => {
      expect(formatDate(date, "short").length).toBeGreaterThan(0);
      expect(formatDate(date, "long").length).toBeGreaterThan(0);
    });

    it("writes relative dates against a supplied now", () => {
      const now = new Date(2026, 7, 14, 13, 30, 0);
      expect(formatDate(date, "relative", now)).toBe("3 days ago");
    });

    it("counts relative units towards zero rather than away from it", () => {
      // 40 hours falls in the one-day bucket, not the two-day one. `Intl`
      // names that bucket "yesterday" under `numeric: "auto"`.
      const now = new Date(2026, 7, 13, 5, 30, 0);
      expect(formatDate(date, "relative", now)).toBe("yesterday");
    });

    it("names the nearest bucket rather than a bare count where it can", () => {
      const now = new Date(2026, 7, 11, 13, 30, 30);
      expect(formatDate(date, "relative", now)).toBe("now");
    });

    it("returns an empty string for a missing or invalid date", () => {
      expect(formatDate(null, "iso")).toBe("");
      expect(formatDate(new Date("nonsense"), "iso")).toBe("");
    });
  });

  describe("formatAuthor", () => {
    it("returns the whole name by default", () => {
      expect(formatAuthor("Ada Lovelace")).toBe("Ada Lovelace");
    });

    it("returns just the first or last word on request", () => {
      expect(formatAuthor("Ada Lovelace", "first")).toBe("Ada");
      expect(formatAuthor("Ada Lovelace", "last")).toBe("Lovelace");
    });

    it("copes with a single-word name", () => {
      expect(formatAuthor("Ada", "first")).toBe("Ada");
      expect(formatAuthor("Ada", "last")).toBe("Ada");
    });

    it("collapses stray whitespace rather than yielding an empty word", () => {
      expect(formatAuthor("  Ada   Byron  Lovelace ", "last")).toBe("Lovelace");
      expect(formatAuthor("  Ada   Byron  Lovelace ", "full")).toBe("Ada Byron Lovelace");
    });

    it("returns an empty string for a missing name", () => {
      expect(formatAuthor(null)).toBe("");
      expect(formatAuthor("   ")).toBe("");
    });
  });

  describe("colourForAuthor", () => {
    it("returns a stable seven-character hex colour", () => {
      const colour = colourForAuthor("Ada Lovelace");
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      expect(colourForAuthor("Ada Lovelace")).toBe(colour);
    });

    it("gives different authors different colours", () => {
      expect(colourForAuthor("Ada Lovelace")).not.toBe(colourForAuthor("Grace Hopper"));
    });

    it("pads a component that needs it, rather than emitting a short colour", () => {
      // The upstream `substr(-2)` trick was right, but only by accident; this
      // pins the invariant for every name we can reach.
      for (const name of ["a", "b", "c", "zz", "Ada", "Grace Hopper", ""]) {
        expect(colourForAuthor(name)).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  });
});
