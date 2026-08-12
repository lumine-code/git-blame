const { RemoteRevision, parseRemote, render, templateForHost } = require("../lib/remote-revision");

describe("remote-revision", () => {
  describe("parseRemote", () => {
    it("parses an https remote", () => {
      expect(parseRemote("https://github.com/owner/repo.git")).toEqual({
        host: "github.com",
        project: "owner",
        repo: "repo",
      });
    });

    it("parses an scp-style ssh remote", () => {
      expect(parseRemote("git@github.com:owner/repo.git")).toEqual({
        host: "github.com",
        project: "owner",
        repo: "repo",
      });
    });

    it("parses an ssh:// remote", () => {
      expect(parseRemote("ssh://git@github.com/owner/repo.git")).toEqual({
        host: "github.com",
        project: "owner",
        repo: "repo",
      });
    });

    it("keeps a nested group in the project", () => {
      // Upstream matched only the last two path segments, so the group was
      // dropped and the resulting link 404'd.
      expect(parseRemote("https://gitlab.com/group/subgroup/repo.git")).toEqual({
        host: "gitlab.com",
        project: "group/subgroup",
        repo: "repo",
      });
    });

    it("tolerates a missing .git suffix and a trailing slash", () => {
      expect(parseRemote("https://github.com/owner/repo/")).toEqual({
        host: "github.com",
        project: "owner",
        repo: "repo",
      });
    });

    it("returns null for something that is not a remote", () => {
      expect(parseRemote("")).toBe(null);
      expect(parseRemote(null)).toBe(null);
      expect(parseRemote("not a url")).toBe(null);
      expect(parseRemote("https://github.com/owner")).toBe(null);
    });
  });

  describe("templateForHost", () => {
    it("recognises the three hosts it knows", () => {
      expect(templateForHost("github.com")).toContain("/commit/");
      expect(templateForHost("gitlab.com")).toContain("/commit/");
      expect(templateForHost("bitbucket.org")).toContain("/commits/");
    });

    it("recognises a subdomain of a known host", () => {
      expect(templateForHost("www.github.com")).not.toBe(null);
    });

    it("does not match a host that merely contains the name", () => {
      // Upstream tested /github.com/ with unescaped dots against the whole
      // remote, so `githubXcom.example.org` matched.
      expect(templateForHost("github-com.example.org")).toBe(null);
      expect(templateForHost("notgithub.com.example.org")).toBe(null);
    });

    it("returns null for an unknown host", () => {
      expect(templateForHost("git.example.com")).toBe(null);
    });
  });

  describe("render", () => {
    it("substitutes every placeholder it knows", () => {
      expect(
        render("https://{host}/{project}/{repo}/commit/{revision}", {
          host: "h",
          project: "p",
          repo: "r",
          revision: "abc",
        }),
      ).toBe("https://h/p/r/commit/abc");
    });

    it("leaves an unknown placeholder alone", () => {
      expect(render("{nope}/{repo}", { repo: "r" })).toBe("{nope}/r");
    });

    it("does not evaluate the template", () => {
      // The template can come from a repository's own git config, so it must
      // never be compiled into a function the way lodash templates were.
      const evil = "https://x/{revision}<%= (()=>{throw new Error('ran')})() %>";
      expect(render(evil, { revision: "abc" })).toBe(
        "https://x/abc<%= (()=>{throw new Error('ran')})() %>",
      );
    });
  });

  describe("RemoteRevision", () => {
    it("builds a GitHub commit url", () => {
      const remote = new RemoteRevision("git@github.com:owner/repo.git");
      expect(remote.url("abc123")).toBe("https://github.com/owner/repo/commit/abc123");
    });

    it("builds a Bitbucket commit url with its different path", () => {
      const remote = new RemoteRevision("https://bitbucket.org/owner/repo.git");
      expect(remote.url("abc123")).toBe("https://bitbucket.org/owner/repo/commits/abc123");
    });

    it("uses a custom template ahead of a known host", () => {
      const remote = new RemoteRevision(
        "https://github.com/owner/repo.git",
        "https://mirror.example.com/{project}/{repo}/c/{revision}",
      );
      expect(remote.url("abc123")).toBe("https://mirror.example.com/owner/repo/c/abc123");
    });

    it("uses a custom template for an unknown host", () => {
      const remote = new RemoteRevision(
        "https://git.example.com/owner/repo.git",
        "https://git.example.com/{project}/{repo}/commit/{revision}",
      );
      expect(remote.url("abc123")).toBe("https://git.example.com/owner/repo/commit/abc123");
    });

    it("returns null when there is nowhere to link to", () => {
      expect(new RemoteRevision("https://git.example.com/owner/repo").url("abc")).toBe(null);
      expect(new RemoteRevision(null).url("abc")).toBe(null);
      expect(new RemoteRevision("git@github.com:owner/repo.git").url(null)).toBe(null);
    });
  });
});
