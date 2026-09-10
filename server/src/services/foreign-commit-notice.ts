/**
 * Foreign-commit detection for PR branches (BLO-19528).
 *
 * An agent is not told when *another* agent commits to a branch it believes it
 * solely owns. On trafficcontrol#1292 a genuine per-agent `git push` by
 * BackendEngineerGo landed on the CTO's branch; the CTO's next status comment
 * still described a PR it believed it solely authored. The same drift earlier
 * in that issue's history nearly caused a force-push over a teammate's work.
 *
 * This module answers one question, with no I/O: **given the commits on a PR
 * and the linked issue's assignee, which commits were authored by somebody
 * else?** The route layer supplies the commits and performs the notification;
 * keeping the decision pure is what makes the false-positive boundary below
 * testable without a database or a GitHub token.
 *
 * ## Why attribution is decided on the git author email
 *
 * Commit attribution here is *write-path dependent, not agent dependent*
 * (BLO-21416). Every agent pod pushes with the same shared `allyblockcast[bot]`
 * GitHub App credential, so `author.login` on a REST-created commit names the
 * App for every agent alike and cannot identify anyone. What *does* differ per
 * agent is the git author email, which BLO-23894 provisions per checkout as
 * `<agent-url-key>@paperclip.blockcast.net`.
 *
 * So we key on `commit.author.email` and never on `author.login`.
 *
 * ## The four exclusions, and why each one exists
 *
 * The original filing proposed flagging any commit whose author was the App.
 * That check is *inverted*: it returns 4 hits on trafficcontrol#1326, a branch
 * that is entirely one agent's own work, because it flags every squash-merge
 * and every REST-path commit including the assignee's own. Shipping a detector
 * wired to a signal that lies is worse than shipping nothing, so each exclusion
 * below is a deliberate false-positive guard:
 *
 * 1. `merge_commit` — multi-parent commits are created by the GitHub merge API
 *    and are legitimately App-attributed. Excluded per BLO-21416's scope
 *    boundary.
 * 2. `shared_app_identity` — an App-stamped author is *unattributable*, not
 *    foreign. It is equally likely to be the assignee's own REST-path commit,
 *    so notifying on it reproduces exactly the inverted check above. The CI
 *    gate `scripts/check-commit-author-attribution.mjs` already rejects these
 *    at PR time, which is the correct place to police them.
 * 3. `unattributable_identity` — an author email that maps to no agent in the
 *    issue's company. Deliberately silent: see the scope note below.
 * 4. `assignee_own_commit` — the assignee's own work, on either write path.
 *
 * Only a commit that survives all four is reported.
 *
 * ## Scope note: unattributable identities are not reported
 *
 * A human contributor pushing to an agent's branch is a real coordination
 * hazard, but their email maps to no agent and we cannot name them from the
 * agent roster alone. Reporting every unmatched address would make the notice
 * fire on ordinary human collaboration and on vendored/imported commits, which
 * is the noise failure this feature is specifically warned against. They are
 * counted as `unattributable_identity` so the residual is visible in the
 * route's response rather than silently dropped.
 */

import { deriveAgentUrlKey } from "@paperclipai/shared";
import {
  PAPERCLIP_AGENT_EMAIL_DOMAIN,
  isSharedAppAuthorEmail,
} from "./git-checkout-identity.js";

/**
 * Domains whose local part is a provisioned agent url key.
 *
 * `paperclip.blockcast.net` is the domain BLO-23894 provisions today and is
 * authoritative. `blockcast.net` is the earlier convention still present in
 * branch history -- trafficcontrol#1292's `d51b62a3`, the commit this feature
 * exists to catch, carries `backend-engineer-go@blockcast.net`. Recognizing it
 * is what lets that commit serve as a regression witness.
 *
 * The domain allowlist is doing real work: it is why an ordinary human address
 * cannot be mistaken for an agent even if its local part happens to collide
 * with an agent's url key.
 */
export const AGENT_AUTHOR_EMAIL_DOMAINS: readonly string[] = [
  PAPERCLIP_AGENT_EMAIL_DOMAIN,
  "blockcast.net",
];

/** One commit as reported by the GitHub PR commits API, reduced to what we decide on. */
export type CommitAuthorRef = {
  sha: string;
  /** `commit.author.email` -- the git author, NOT `author.login`. */
  authorEmail: string | null;
  /** `commit.author.name`, used only for display when no agent resolves. */
  authorName: string | null;
  /** `parents.length`. >1 means a merge/squash commit created by the merge API. */
  parentCount: number;
};

/** An agent in the issue's company, as needed to reverse an email to an identity. */
export type NotifiableAgentRef = {
  id: string;
  name: string | null;
};

/** A commit authored by an identity other than the linked issue's assignee. */
export type ForeignCommit = {
  sha: string;
  agentId: string;
  agentName: string | null;
  authorEmail: string;
};

export type CommitSkipReason =
  | "merge_commit"
  | "shared_app_identity"
  | "unattributable_identity"
  | "assignee_own_commit";

export type ForeignCommitSelection = {
  notify: ForeignCommit[];
  skipped: Array<{ sha: string; reason: CommitSkipReason }>;
};

function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Split a provisioned agent address into its url-key local part.
 *
 * Returns null for any address outside {@link AGENT_AUTHOR_EMAIL_DOMAINS}, and
 * for a malformed address with an empty local part (`@paperclip.blockcast.net`
 * is reachable when an agent name normalizes to nothing).
 */
export function agentUrlKeyFromAuthorEmail(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return null;
  const localPart = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (localPart.length === 0) return null;
  if (!AGENT_AUTHOR_EMAIL_DOMAINS.includes(domain)) return null;
  return localPart;
}

/**
 * Resolve a git author email to an agent in the issue's company.
 *
 * The local part is `deriveAgentUrlKey(agent.name, agent.id)`, which is the
 * same derivation `buildAgentGitIdentity` uses when provisioning a checkout, so
 * recomputing it over the company roster inverts the mapping exactly.
 *
 * Ambiguity fails closed: `deriveAgentUrlKey` collapses punctuation, so two
 * differently-named agents can share a url key. Returning null on a tie keeps
 * us from naming the wrong teammate in a notification.
 */
export function resolveAgentByAuthorEmail(
  email: string | null | undefined,
  agents: readonly NotifiableAgentRef[],
): NotifiableAgentRef | null {
  const urlKey = agentUrlKeyFromAuthorEmail(email);
  if (!urlKey) return null;
  const matches = agents.filter(
    (agent) => deriveAgentUrlKey(agent.name ?? null, agent.id ?? null) === urlKey,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Select the commits on a PR authored by somebody other than the issue assignee.
 *
 * Order matters: merge commits are excluded before the identity checks, because
 * a squash-merge is App-attributed and would otherwise be reported as an
 * unattributable identity rather than as the merge it is.
 */
export function selectForeignCommits(input: {
  commits: readonly CommitAuthorRef[];
  assigneeAgentId: string | null;
  agents: readonly NotifiableAgentRef[];
}): ForeignCommitSelection {
  const notify: ForeignCommit[] = [];
  const skipped: Array<{ sha: string; reason: CommitSkipReason }> = [];
  const seen = new Set<string>();

  for (const commit of input.commits) {
    const sha = commit.sha?.trim();
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);

    if (commit.parentCount > 1) {
      skipped.push({ sha, reason: "merge_commit" });
      continue;
    }

    const email = normalizeEmail(commit.authorEmail);
    if (isSharedAppAuthorEmail(email)) {
      skipped.push({ sha, reason: "shared_app_identity" });
      continue;
    }

    const agent = resolveAgentByAuthorEmail(email, input.agents);
    if (!agent || !email) {
      skipped.push({ sha, reason: "unattributable_identity" });
      continue;
    }

    if (input.assigneeAgentId && agent.id === input.assigneeAgentId) {
      skipped.push({ sha, reason: "assignee_own_commit" });
      continue;
    }

    notify.push({ sha, agentId: agent.id, agentName: agent.name, authorEmail: email });
  }

  return { notify, skipped };
}

/**
 * Stable idempotency key for one notice.
 *
 * Keyed on `(repo, pr, sha)` rather than on the delivery id so a webhook
 * redelivery, a reopen, or a force-push that replays an already-reported SHA
 * all collapse onto the same row via the partial unique index on
 * `(issue_id, idempotency_key)`.
 */
export function foreignCommitNoticeIdempotencyKey(input: {
  repoFullName: string;
  prNumber: number;
  sha: string;
}): string {
  return `github-foreign-commit:${input.repoFullName}:${input.prNumber}:${input.sha}`;
}

/** Render the notice posted to the assignee's issue. */
export function buildForeignCommitNoticeBody(input: {
  commit: ForeignCommit;
  repoFullName: string;
  prNumber: number;
  prUrl: string | null;
}): string {
  const who = input.commit.agentName ?? input.commit.authorEmail;
  const shortSha = input.commit.sha.slice(0, 12);
  const prRef = input.prUrl
    ? `[${input.repoFullName}#${input.prNumber}](${input.prUrl})`
    : `${input.repoFullName}#${input.prNumber}`;
  return [
    `## Another agent committed to this issue's PR branch`,
    "",
    `**${who}** pushed a commit to ${prRef}, which is assigned to you.`,
    "",
    `- Commit: \`${shortSha}\``,
    `- Author identity: \`${input.commit.authorEmail}\``,
    `- Pull request: ${prRef}`,
    "",
    "Re-read the branch before your next push or status report: a force-push now would",
    "overwrite work that is not yours, and a status summary written from memory will not",
    "match what is actually on the branch.",
  ].join("\n");
}
