// Builds a link to a commit on the repository's hosting service.
//
// Upstream compiled the template with lodash's `_.template`, wrapped in
// `loophole` to get around the content-security policy. That turns a string
// from the settings file -- or from a repository's own git config -- into
// executed code, which is not something a blame gutter needs. Placeholders are
// substituted literally here, so there is no compilation step and nothing to
// escape past.

const HOSTS = [
  { host: /(^|\.)github\.com$/i, template: "https://{host}/{project}/{repo}/commit/{revision}" },
  { host: /(^|\.)gitlab\.com$/i, template: "https://{host}/{project}/{repo}/commit/{revision}" },
  {
    host: /(^|\.)bitbucket\.org$/i,
    template: "https://{host}/{project}/{repo}/commits/{revision}",
  },
];

// Splits a remote URL into its host, project and repository. Handles both the
// scp-like `git@host:owner/repo` spelling and real URLs.
//
// Everything but the last path segment becomes the project, so a nested GitLab
// group survives. Upstream matched only the final two segments, so
// `gitlab.com/group/subgroup/repo` lost the group and produced a dead link.
function parseRemote(remote) {
  const cleaned = String(remote ?? "")
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!cleaned) return null;

  let host, path;
  const scpLike = /^(?:[^@/]+@)([^:/]+):(.+)$/.exec(cleaned);
  if (scpLike) {
    [, host, path] = scpLike;
  } else {
    try {
      const url = new URL(cleaned);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  }

  const segments = path.split("/").filter(Boolean);
  if (!host || segments.length < 2) return null;

  return {
    host,
    project: segments.slice(0, -1).join("/"),
    repo: segments[segments.length - 1],
  };
}

function templateForHost(host) {
  return HOSTS.find((candidate) => candidate.host.test(host))?.template ?? null;
}

function render(template, values) {
  return String(template).replace(/\{(host|project|repo|revision)\}/g, (match, key) =>
    values[key] == null ? match : String(values[key]),
  );
}

class RemoteRevision {
  // `customTemplate` comes either from the package setting or from a
  // repository's own `git-blame.commitUrlTemplate` config value, and wins over
  // the built-in hosts so a self-hosted instance can be pointed anywhere.
  constructor(remoteUrl, customTemplate = null) {
    this.parsed = parseRemote(remoteUrl);
    this.customTemplate = customTemplate || null;
  }

  getTemplate() {
    if (this.customTemplate) return this.customTemplate;
    if (!this.parsed) return null;
    return templateForHost(this.parsed.host);
  }

  // Returns null rather than an empty string when no link can be built, so the
  // caller can tell "no link" from "a link to nowhere".
  url(revision) {
    const template = this.getTemplate();
    if (!template || !this.parsed || !revision) return null;

    return render(template, {
      host: this.parsed.host,
      project: this.parsed.project,
      repo: this.parsed.repo,
      revision,
    });
  }
}

module.exports = { RemoteRevision, parseRemote, render, templateForHost };
