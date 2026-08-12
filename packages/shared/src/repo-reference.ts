/**
 * BLO-20341: precision-first extraction of repository references from
 * free-form issue prose, plus normalization of a workspace `repoUrl` into the
 * same comparable identity.
 *
 * This exists to support a *detect-only* guard: a delegated sub-issue inherits
 * `projectId` / `executionWorkspaceId` from its parent — i.e. from where the
 * bug was discovered, not from where the code that must change actually lives.
 * When those differ the assignee wakes in the wrong repo. We flag the
 * discrepancy; we never re-home the issue, because inferring the right binding
 * from prose is exactly the guess that produces a confidently wrong answer.
 *
 * The design bias is therefore **precision over recall**. A missed mismatch
 * costs one confused agent turn, which is the status quo. A false positive
 * costs a misleading comment on every issue that happens to quote a directory
 * path, which would train readers to ignore the signal entirely. So:
 *
 *  - Tier 1/2 (`github.com/owner/repo`, `git@github.com:owner/repo`) are
 *    unambiguous and always accepted.
 *  - Tier 3 (a bare `owner/repo` slug) is accepted **only** inside backticks,
 *    and even then only when the owner is already known to this company or a
 *    repo cue word sits nearby. An unquoted bare slug is never matched — in
 *    ordinary prose `foo/bar` is far more often a path than a repo.
 */

/** How confident we are that a match denotes a repository. */
export type RepoReferenceConfidence = "url" | "cued_slug";

export type RepoReference = {
  /** Host the reference points at. Always `github.com` for extracted refs. */
  host: string;
  owner: string;
  repo: string;
  /** Comparable identity, lowercased: `github.com/owner/repo`. */
  key: string;
  /** `owner/repo`, lowercased — for display. */
  slug: string;
  /** The exact substring that produced this match, for the flag comment. */
  matchedText: string;
  confidence: RepoReferenceConfidence;
};

export type ExtractRepoReferencesOptions = {
  /**
   * Owners already known to this company (derived from its workspace repo
   * URLs). A backticked `owner/repo` whose owner is on this list is accepted
   * without needing a nearby cue word.
   */
  knownOwners?: Iterable<string>;
};

/**
 * First path segment of a backticked `a/b` that means "source directory", not
 * "repository owner". Without this, `packages/db`, `server/src` and
 * `deploy/helm` — which appear constantly in our issue prose — would each read
 * as a repo reference.
 */
const SOURCE_DIRECTORY_DENYLIST = new Set([
  ".github",
  "api",
  "app",
  "apps",
  "assets",
  "bin",
  "build",
  "charts",
  "client",
  "cmd",
  "common",
  "components",
  "config",
  "core",
  "deploy",
  "dist",
  "doc",
  "docs",
  "example",
  "examples",
  "helm",
  "internal",
  "lib",
  "migrations",
  "node_modules",
  "packages",
  "pkg",
  "public",
  "routes",
  "script",
  "scripts",
  "server",
  "services",
  "shared",
  "src",
  "static",
  "styles",
  "test",
  "tests",
  "tools",
  "types",
  "ui",
  "utils",
  "web",
]);

/**
 * GitHub paths whose first segment is a site route rather than an owner, so
 * `github.com/orgs/Blockcast` does not read as owner `orgs`, repo `Blockcast`.
 */
const GITHUB_RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "blog",
  "collections",
  "contact",
  "enterprise",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
  "users",
]);

/** Words that, near a bare slug, make "repository" the likely reading. */
const REPO_CUE_PATTERN =
  /\b(repo|repos|repository|repositories|vendor|vendors|vendored|upstream|fork|forked|clone|cloned|monorepo|codebase|remote|submodule|mirror|github)\b/i;

/**
 * Words that make "git ref" the likely reading instead. Branch names are
 * spelled exactly like `owner/repo` (`codex/blo-17910-settlement-core`), and
 * prose about a branch almost always mentions one of these. A negative cue
 * beats a positive one — "the multicast checkout parked on `codex/…`" carries
 * both, and it is a branch.
 */
const NEGATIVE_CUE_PATTERN =
  /\b(branch|branches|worktree|checkout|parked|rebase|rebased|cherry-pick|ref|refs|tag|head)\b/i;

/**
 * First segment of a backticked `a/b` that means "git branch prefix". These
 * are the conventional prefixes in this org's branch names.
 */
const BRANCH_PREFIX_DENYLIST = new Set([
  "blo",
  "bugfix",
  "build",
  "chore",
  "ci",
  "codex",
  "cto",
  "dependabot",
  "develop",
  "feat",
  "feature",
  "fix",
  "hotfix",
  "main",
  "master",
  "perf",
  "platformsre",
  "refactor",
  "release",
  "renovate",
  "revert",
  "staging",
  "style",
  "wip",
]);

/**
 * GitHub path segments that follow `owner/repo` in a *citation* rather than a
 * statement about where code lives. Linking another repo's PR for context is
 * one of the most common things our issue prose does, and reading it as "the
 * work belongs in that repo" was the single largest false-positive source in
 * the BLO-20341 sweep. `blob`/`tree`/`raw` are deliberately absent: those name
 * a file path and really are a location claim.
 */
const CITATION_PATH_SEGMENTS = new Set([
  "actions",
  "blame",
  "commit",
  "commits",
  "compare",
  "discussions",
  "issues",
  "labels",
  "milestone",
  "milestones",
  "projects",
  "pull",
  "pulls",
  "releases",
  "security",
  "tags",
  "wiki",
]);

/** How far either side of a bare slug we look for a cue word. */
const CUE_WINDOW_CHARS = 60;

/** A trailing `.ts`/`.md`/… means the second segment is a file, not a repo. */
const FILE_EXTENSION_PATTERN =
  /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|json|ya?ml|sh|bash|py|go|rs|sql|txt|toml|lock|css|scss|html|xml|ini|conf|env|png|jpe?g|svg|gif|pdf)$/i;

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";

const HTTPS_REPO_PATTERN = new RegExp(
  `(?:https?://)?(?:www\\.)?github\\.com/(${SEGMENT})/(${SEGMENT})((?:/[A-Za-z0-9._-]+)*)`,
  "gi",
);

const SSH_REPO_PATTERN = new RegExp(
  `git@github\\.com:(${SEGMENT})/(${SEGMENT})`,
  "gi",
);

const BACKTICKED_PATTERN = /`([^`\n]{1,120})`/g;

const BARE_SLUG_PATTERN = new RegExp(`^(${SEGMENT})/(${SEGMENT})$`);

/** Strip a trailing `.git` and any punctuation prose left glued to the name. */
function cleanRepoSegment(raw: string): string | null {
  let repo = raw.replace(/[).,;:'"\]]+$/, "");
  repo = repo.replace(/\.git$/i, "");
  repo = repo.replace(/[).,;:'"\]]+$/, "");
  if (!repo) return null;
  // A name that is only dots/dashes is punctuation we failed to strip.
  if (!/[A-Za-z0-9]/.test(repo)) return null;
  return repo;
}

function makeReference(
  owner: string,
  repo: string,
  matchedText: string,
  confidence: RepoReferenceConfidence,
): RepoReference | null {
  const cleanedRepo = cleanRepoSegment(repo);
  if (!cleanedRepo) return null;
  if (GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  // GitHub permits one-character names, but in prose a single character is
  // almost always a truncated URL (issue descriptions get clipped in list
  // payloads) rather than a real repo. Losing the rare genuine `o/x` is a
  // better trade than inventing a reference from a clipped link.
  if (owner.length < 2 || cleanedRepo.length < 2) return null;
  const slug = `${owner}/${cleanedRepo}`.toLowerCase();
  return {
    host: "github.com",
    owner,
    repo: cleanedRepo,
    key: `github.com/${slug}`,
    slug,
    matchedText,
    confidence,
  };
}

function hasNearbyRepoCue(text: string, start: number, end: number): boolean {
  const window = text.slice(
    Math.max(0, start - CUE_WINDOW_CHARS),
    Math.min(text.length, end + CUE_WINDOW_CHARS),
  );
  // A git-ref reading beats a repository reading when both are signalled.
  if (NEGATIVE_CUE_PATTERN.test(window)) return false;
  return REPO_CUE_PATTERN.test(window);
}

/** True when the path after `owner/repo` makes the URL a citation, not a location. */
function isCitationPath(trailingPath: string | undefined): boolean {
  if (!trailingPath) return false;
  const firstSegment = trailingPath.split("/").filter(Boolean)[0];
  if (!firstSegment) return false;
  return CITATION_PATH_SEGMENTS.has(firstSegment.toLowerCase());
}

/**
 * Extract every repository this text plausibly refers to, most-confident
 * first, deduplicated by identity.
 */
export function extractRepoReferences(
  text: string | null | undefined,
  options: ExtractRepoReferencesOptions = {},
): RepoReference[] {
  if (!text) return [];
  const knownOwners = new Set(
    [...(options.knownOwners ?? [])].map((owner) => owner.toLowerCase()),
  );
  const byKey = new Map<string, RepoReference>();

  const record = (reference: RepoReference | null) => {
    if (!reference) return;
    const existing = byKey.get(reference.key);
    // A URL match is strictly better evidence than a cued slug for the same
    // repo, so let it win if both appear.
    if (existing && !(existing.confidence === "cued_slug" && reference.confidence === "url")) {
      return;
    }
    byKey.set(reference.key, reference);
  };

  HTTPS_REPO_PATTERN.lastIndex = 0;
  let httpsMatch: RegExpExecArray | null;
  while ((httpsMatch = HTTPS_REPO_PATTERN.exec(text)) !== null) {
    if (isCitationPath(httpsMatch[3])) continue;
    record(makeReference(httpsMatch[1], httpsMatch[2], httpsMatch[0], "url"));
  }

  SSH_REPO_PATTERN.lastIndex = 0;
  let sshMatch: RegExpExecArray | null;
  while ((sshMatch = SSH_REPO_PATTERN.exec(text)) !== null) {
    record(makeReference(sshMatch[1], sshMatch[2], sshMatch[0], "url"));
  }

  BACKTICKED_PATTERN.lastIndex = 0;
  let backticked: RegExpExecArray | null;
  while ((backticked = BACKTICKED_PATTERN.exec(text)) !== null) {
    const inner = backticked[1].trim();
    const slugMatch = BARE_SLUG_PATTERN.exec(inner);
    if (!slugMatch) continue;
    const [, owner, repo] = slugMatch;
    if (SOURCE_DIRECTORY_DENYLIST.has(owner.toLowerCase())) continue;
    if (BRANCH_PREFIX_DENYLIST.has(owner.toLowerCase())) continue;
    if (FILE_EXTENSION_PATTERN.test(repo)) continue;
    // Single-character segments are noise (`a/b`), never real repo slugs here.
    if (owner.length < 2 || repo.length < 2) continue;
    const windowStart = backticked.index;
    const windowEnd = backticked.index + backticked[0].length;
    // A known owner is strong evidence, but not strong enough to survive an
    // explicit git-ref cue — `Blockcast/foo` can still be a branch name.
    const negated = NEGATIVE_CUE_PATTERN.test(
      text.slice(
        Math.max(0, windowStart - CUE_WINDOW_CHARS),
        Math.min(text.length, windowEnd + CUE_WINDOW_CHARS),
      ),
    );
    if (negated) continue;
    const accepted =
      knownOwners.has(owner.toLowerCase()) || hasNearbyRepoCue(text, windowStart, windowEnd);
    if (!accepted) continue;
    record(makeReference(owner, repo, inner, "cued_slug"));
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "url" ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

export type RepoIdentity = {
  host: string;
  owner: string;
  repo: string;
  /** Comparable identity, lowercased: `host/owner/repo`. */
  key: string;
  /** `owner/repo`, lowercased — for display. */
  slug: string;
};

/**
 * Normalize a workspace `repoUrl` into the same identity shape the extractor
 * emits, so bound-vs-referenced comparison is a string equality on `key`.
 *
 * Handles the three forms our workspace rows actually carry:
 * `https://host/owner/repo(.git)`, `git@host:owner/repo(.git)`, and
 * `ssh://git@host/owner/repo(.git)`.
 */
export function parseRepoIdentity(
  repoUrl: string | null | undefined,
): RepoIdentity | null {
  if (!repoUrl) return null;
  const trimmed = repoUrl.trim();
  if (!trimmed) return null;

  let host: string | null = null;
  let path: string | null = null;

  const scpLike = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(.+)$/.exec(trimmed);
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed);

  if (hasScheme) {
    const withoutScheme = trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
    const withoutUser = withoutScheme.replace(/^[^@/]+@/, "");
    const slashIndex = withoutUser.indexOf("/");
    if (slashIndex === -1) return null;
    host = withoutUser.slice(0, slashIndex);
    path = withoutUser.slice(slashIndex + 1);
  } else if (scpLike) {
    host = scpLike[1];
    path = scpLike[2];
  } else {
    // Bare `host/owner/repo` with no scheme at all.
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex === -1) return null;
    host = trimmed.slice(0, slashIndex);
    path = trimmed.slice(slashIndex + 1);
  }

  if (!host || !path) return null;
  host = host.replace(/:\d+$/, "").replace(/^www\./i, "").toLowerCase();

  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[segments.length - 2];
  const repo = cleanRepoSegment(segments[segments.length - 1]);
  if (!owner || !repo) return null;

  const slug = `${owner}/${repo}`.toLowerCase();
  return { host, owner, repo, key: `${host}/${slug}`, slug };
}

/** Owner half of a workspace `repoUrl`, for seeding `knownOwners`. */
export function repoOwnerFromUrl(repoUrl: string | null | undefined): string | null {
  return parseRepoIdentity(repoUrl)?.owner ?? null;
}
