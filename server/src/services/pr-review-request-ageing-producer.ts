/**
 * Digest producer for unanswered PR review requests (BLO-30259).
 *
 * This is the registration that makes `pr-review-request-ageing.ts` reachable.
 * That module landed via paperclip#1450 with 22KB of tested logic and **zero**
 * production importers — the same shape as BLO-19130 before BLO-29420, and for
 * the same reason: nothing had the data to call it with.
 *
 * `collect` is a pure read of `pull_request_review_state`, which is required
 * rather than stylistic. Producer collection runs inside the per-company digest
 * transaction with the advisory lock held, so a GitHub call here would serialise
 * every company's digest behind GitHub latency. `pr-review-state-reconciler.ts`
 * owns the network I/O on its own interval.
 *
 * ## AC4 — `escalatedAt` is deliberately left `null`, with no new column
 *
 * `AgeingPullRequest.escalatedAt` documents itself as stored state for an
 * *escalate-once* model: a non-null value suppresses re-escalation outright. That
 * model predates the delivery seam and is wrong for it.
 *
 * The seam BLO-29420 shipped is **refresh-in-place**: one durable row per
 * company, `originId` period-free, recomputed every period. Its idempotency
 * boundary is the digest row itself — a repeat tick returns `unchanged` and
 * writes nothing. Layering a per-PR `escalatedAt` on top would mean a PR appears
 * in the digest exactly once and then vanishes **while still unanswered**, so the
 * row would get quieter as the backlog got worse. That is precisely the silent
 * absence BLO-29420 and BLO-23511 exist to end.
 *
 * So no column is added and the field is never populated. An unanswered request
 * keeps being reported until it is answered, which is the behaviour the digest
 * already guarantees for human-gated issues. The suppression the original model
 * wanted — not re-notifying about the same thing every tick — is delivered by the
 * seam's `unchanged` outcome instead, at the row level rather than per PR.
 *
 * ## AC6 — unreadable is rendered, never collapsed into empty
 *
 * A PR whose review state could not be read is **excluded from the ageing input
 * and reported in its own block**. It is not passed through with
 * `pendingReviewRequests: []`, because the module would then tally it as
 * `no_pending_request` — a different, much rarer defect — and a reader would see
 * "no pending request" for a PR that may well have one. When every row is
 * unreadable the producer still returns a section, so an outage can never render
 * as a clean queue.
 */

import { asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pullRequestReviewState } from "@paperclipai/db";
import {
  DEFAULT_ESCALATE_AFTER_DAYS,
  DEFAULT_MAX_ESCALATED,
  formatPullRequestRef,
  sanitizeRenderedField,
  selectAgedReviewRequests,
  type AgeingPullRequest,
} from "./pr-review-request-ageing.js";
import type { DigestProducer, DigestSection } from "./human-gated-ageing-digest.js";

export const PR_REVIEW_REQUEST_AGEING_SECTION_KEY = "pr-review-request-ageing";

/** A stored row the ageing pass must not be asked to judge. */
export type UnreadableReviewState = {
  repo: string;
  number: number;
  url: string | null;
  reason: string;
};

export type LoadedReviewState = {
  ageing: AgeingPullRequest[];
  unreadable: UnreadableReviewState[];
};

/**
 * Read one company's open-PR review state, splitting rows the ageing pass can
 * judge from rows it cannot.
 *
 * A row is judgeable only when **both** probes answered. Requests alone are not
 * enough: without readable reviews there is no way to tell an unanswered request
 * from one a human already replied to, and guessing in either direction is a
 * wrong verdict rather than a missing one.
 */
export async function loadPullRequestReviewState(
  db: Db,
  companyId: string,
): Promise<LoadedReviewState> {
  const rows = await db
    .select()
    .from(pullRequestReviewState)
    .where(eq(pullRequestReviewState.companyId, companyId))
    .orderBy(asc(pullRequestReviewState.prCreatedAt));

  const ageing: AgeingPullRequest[] = [];
  const unreadable: UnreadableReviewState[] = [];

  for (const row of rows) {
    if (!row.requestsReadable || !row.reviewsReadable) {
      unreadable.push({
        repo: row.repoFullName,
        number: row.prNumber,
        url: row.url,
        reason:
          row.unreadableReason ??
          (!row.requestsReadable ? "review requests unreadable" : "reviews unreadable"),
      });
      continue;
    }
    ageing.push({
      repo: row.repoFullName,
      number: row.prNumber,
      title: row.title,
      url: row.url,
      authorLogin: row.authorLogin,
      createdAt: row.prCreatedAt.toISOString(),
      isDraft: row.isDraft,
      pendingReviewRequests: row.pendingReviewRequests ?? [],
      // Key presence is load-bearing: `validateShape` rejects a missing
      // `reviews` key precisely so a caller that forgot to fetch them cannot
      // make every PR look unanswered.
      reviews: row.reviews ?? [],
      // AC4: never populated. See the module docblock.
      escalatedAt: null,
    });
  }

  return { ageing, unreadable };
}

function renderUnreadableBlock(unreadable: readonly UnreadableReviewState[]): string[] {
  if (unreadable.length === 0) return [];
  const lines = [
    `### ⚠ Review state unreadable for ${unreadable.length} pull request${unreadable.length === 1 ? "" : "s"}`,
    "",
    "These are **not** an all-clear. Their review state could not be read this period, so",
    "whether a request is waiting on a human is unknown — they are withheld from the ageing",
    "list rather than counted as answered or as having no request.",
    "",
  ];
  for (const row of unreadable.slice(0, DEFAULT_MAX_ESCALATED)) {
    const ref = sanitizeRenderedField(`${row.repo}#${row.number}`, "(unidentified pull request)");
    const reason = sanitizeRenderedField(row.reason, "unknown reason");
    lines.push(row.url ? `- [${ref}](${row.url}) — ${reason}` : `- ${ref} — ${reason}`);
  }
  if (unreadable.length > DEFAULT_MAX_ESCALATED) {
    lines.push(`- …and ${unreadable.length - DEFAULT_MAX_ESCALATED} more.`);
  }
  return lines;
}

function renderEscalationBlock(
  report: ReturnType<typeof selectAgedReviewRequests>,
): string[] {
  if (report.overdueCount === 0) return [];
  const lines = [
    `### Unanswered PR review requests past ${report.escalateAfterDays}d (${report.overdueCount} overdue)`,
    "",
    "Agent-authored pull requests with a live review request that no human has answered.",
    "Ally's own reviews do not stop this clock — the App and the User seat are both ally",
    "identities, and a PR an agent reviewed itself is not a PR a human has looked at.",
    "",
  ];
  for (const pr of report.escalate) {
    const ref = formatPullRequestRef(pr);
    const title = sanitizeRenderedField(pr.title, "(untitled)");
    const age = pr.unansweredDays.toFixed(1);
    const ally = pr.allyOnlyReviews ? " _(ally-only reviews)_" : "";
    lines.push(pr.url ? `- **${age}d** — [${ref}](${pr.url}) ${title}${ally}` : `- **${age}d** — ${ref} ${title}${ally}`);
  }
  if (report.overflowCount > 0) {
    lines.push(
      "",
      `_…and ${report.overflowCount} more past the threshold, withheld by the ${report.maxEscalated}-item attention cap._`,
    );
  }
  return lines;
}

function renderMalformedBlock(
  report: ReturnType<typeof selectAgedReviewRequests>,
): string[] {
  if (report.malformed.length === 0) return [];
  const lines = [
    `### ⚠ ${report.malformed.length} row${report.malformed.length === 1 ? "" : "s"} could not be evaluated`,
    "",
  ];
  for (const entry of report.malformed.slice(0, DEFAULT_MAX_ESCALATED)) {
    lines.push(
      `- ${formatPullRequestRef(entry.pullRequest)} — ${sanitizeRenderedField(entry.reason, "unreadable")}`,
    );
  }
  return lines;
}

/**
 * Render the section.
 *
 * Returns `null` only when there is genuinely nothing to say: nothing overdue,
 * nothing unreadable, nothing malformed. Every other path renders — an empty
 * section and a healthy one must not look identical.
 */
export function buildPrReviewRequestAgeingSection(
  loaded: LoadedReviewState,
  now: Date,
  options: { escalateAfterDays?: number; maxEscalated?: number } = {},
): DigestSection | null {
  const report = selectAgedReviewRequests(loaded.ageing, {
    now,
    escalateAfterDays: options.escalateAfterDays ?? DEFAULT_ESCALATE_AFTER_DAYS,
    maxEscalated: options.maxEscalated ?? DEFAULT_MAX_ESCALATED,
  });

  if (
    report.overdueCount === 0 &&
    report.malformed.length === 0 &&
    loaded.unreadable.length === 0
  ) {
    return null;
  }

  const blocks = [
    renderEscalationBlock(report),
    renderUnreadableBlock(loaded.unreadable),
    renderMalformedBlock(report),
  ].filter((block) => block.length > 0);

  return {
    key: PR_REVIEW_REQUEST_AGEING_SECTION_KEY,
    markdown: blocks.map((block) => block.join("\n")).join("\n\n"),
    // Unreadable rows count as items: a period where every probe failed must
    // report a non-zero item count, or the seam treats the section as
    // "ran clean, nothing overdue".
    itemCount: report.overdueCount + loaded.unreadable.length,
  };
}

/** The registration itself. This import is what flips AC1's importer count. */
export const prReviewRequestAgeingProducer: DigestProducer = {
  key: PR_REVIEW_REQUEST_AGEING_SECTION_KEY,
  collect: async ({ db, companyId, now }) => {
    const loaded = await loadPullRequestReviewState(db, companyId);
    return buildPrReviewRequestAgeingSection(loaded, now);
  },
};
