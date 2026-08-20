/**
 * Unanswered PR review-request ageing (BLO-24517).
 *
 * An agent-authored pull request in a repo whose ruleset requires an approving
 * review from a team can never satisfy that rule by itself. The request is
 * routed correctly — and then nothing anywhere notices that it went unanswered.
 * This module is the ageing clock for that wait.
 *
 * ## Why "has this PR been reviewed?" is the wrong question
 *
 * `allyblockcast` exists as **two** GitHub principals: the App installation
 * (`allyblockcast[bot]`, id 290875700) that authors and pushes, and a User seat
 * (`allyblockcast`, id 296676656) that reviews. They are formally distinct
 * accounts, so the App can push and the User can approve without tripping
 * `require_last_push_approval` — and the User seat is a member of the required
 * reviewer team, so its approval *satisfies the human-review requirement*
 * (recorded independently in `vendor/paperclip-adapter-claude-k8s/PROVENANCE.md`
 * and reconfirmed on this issue via onprem-k8s#2525, which merged into a
 * `bypass_actors: []` ruleset on a sole User-ally approval).
 *
 * Measured on `Blockcast/onprem-k8s` on 2026-08-20, across the 196 open
 * App-authored PRs carrying a live unanswered team request:
 *
 *   - **155** have reviews from ally identities only
 *   - **3** have a review from a genuine non-ally human
 *   - **48** have no review at all
 *
 * So a naive "does this PR have a review?" check sees 158 of 206 as answered
 * when a human has looked at **3**. That is a ~50x error, and it is why
 * {@link isAllyReviewIdentity} exists and why the clock below refuses to let an
 * ally review stop it. An escalation an agent can silence by reviewing its own
 * PR is not an escalation — the same principle `human-gated-ageing.ts` applies
 * to agent comments on human-gated issues.
 *
 * ## Why this module does not read `requested_teams` / `requested_reviewers`
 *
 * It cannot. The App token has no org-team read scope, so a request pending
 * against a **team** is invisible to it: REST omits the team from
 * `requested_teams`, and GraphQL returns the `reviewRequests` node with
 * `requestedReviewer` resolved to `null`. Neither surface says "no request";
 * both say "no request *you can see*".
 *
 * That distinction is not academic — it inverted this issue's root cause for ten
 * days. Measured 2026-08-20 on 206 open App-authored onprem-k8s PRs:
 *
 * | | count |
 * |---|---|
 * | REST `requested_reviewers + requested_teams == 0` | 145 |
 * | genuinely zero `reviewRequests` nodes | 10 |
 * | pending node, `requestedReviewer` unreadable (`null`) | 135 |
 *
 * 10 + 135 = 145 exactly. The issue had read that 145 as "the requests were made
 * and are gone", and proposed re-requesting reviewers to fix it. Timeline ground
 * truth on 10 of the 135 (`#1891 #1894 #1911 #1919 #1920 #1925 #1926 #1927
 * #1928 #1939`) shows one `review_requested` to `onprem-k8s-ally-reviewer` and
 * **zero** `review_request_removed` on every one. The requests are live.
 *
 * Hence {@link PendingReviewRequest} is expressed as "a request node exists,
 * whether or not its reviewer is readable" and callers derive it from GraphQL
 * `reviewRequests` plus timeline events — never from the REST pending arrays.
 * And hence this module escalates to a *named human* rather than re-requesting
 * a reviewer: the request is not what is missing.
 */

/**
 * Statuses of a review that represent a human having engaged with the PR.
 *
 * `COMMENTED` counts. Only `APPROVED` satisfies the *ruleset*, but this module
 * measures human attention, not merge-eligibility: a reviewer who left comments
 * has looked, and re-escalating at them is noise. `PENDING` (an unsubmitted
 * draft review) and `DISMISSED` (explicitly revoked) do not count.
 */
const ANSWERING_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);

/**
 * Days a review request may go unanswered before it is escalated.
 *
 * Derived from the age distribution of the 196 open App-authored onprem-k8s PRs
 * with a live unanswered team request, measured 2026-08-20:
 *
 * | band | count |
 * |------|-------|
 * | <3d      | 42 |
 * | 3–7d     | 24 |
 * | **7–14d**| **88** |
 * | 14–30d   | 42 |
 * | >=30d    |  0 |
 *
 * Median 8d, oldest 18d. Nothing survives past ~18 days — and that is not
 * because review arrives. Of the last 250 closed App-authored PRs in that repo,
 * 118 merged and **132 were closed unmerged**: the queue drains ~47% by
 * abandonment. A threshold set near the 18d edge would therefore fire mostly at
 * PRs that are about to be abandoned anyway, i.e. after the moment when a nudge
 * could still change the outcome.
 *
 * 7d puts the escalation at the front of the 7–14d pile-up (the largest single
 * band) rather than at its tail. It fires on 130 of 196 on day one, which is far
 * too many to act on at once — that is what {@link DEFAULT_MAX_ESCALATED} is
 * for. The threshold decides what counts as overdue; the cap decides how much of
 * it a human is shown in one sitting.
 */
export const DEFAULT_ESCALATE_AFTER_DAYS = 7;

/**
 * Attention budget for one sweep. The remainder is always reported as a count,
 * never silently dropped — a sweep that quietly truncates reads as "this is all
 * of it", which is how a 130-deep backlog looks solved.
 */
export const DEFAULT_MAX_ESCALATED = 15;

/**
 * Logins whose reviews cannot answer a request on an agent-authored PR.
 *
 * Stored bare (no `[bot]` suffix): {@link normalizeReviewLogin} strips it, so
 * the App (`allyblockcast[bot]`) and the User seat (`allyblockcast`) both
 * collapse onto one entry. Matching bare-vs-suffixed inconsistently is exactly
 * how the User seat slipped through — GraphQL renders App logins *without* the
 * suffix, so `login === "allyblockcast"` alone cannot tell the two apart, and
 * the reviewer-side answer is that it does not need to: neither can answer.
 *
 * **Deliberately wider than {@link AGENT_AUTHOR_LOGINS}.** This is the
 * *exclusion* set, and a false negative here is permanent: one review from an
 * unlisted Ally identity marks a PR `answered_by_human` and suppresses its
 * escalation forever. `blockcast-ci-packages` is Ally's prior review identity —
 * `.planning/ally-app/ally-app-setup.md` documents the
 * `blockcast-ci-packages` -> `ally` migration, and historical reviews under it
 * still sit on open PRs. The set mirrors `isConfiguredPrReviewerAuthor` in
 * `server/src/routes/github-webhook.ts`, which is the repo's existing authority
 * on "is this login Ally": `ally | allyblockcast | blockcast-ci-packages`.
 * Keep the two in step.
 */
export const ALLY_REVIEW_IDENTITY_LOGINS: readonly string[] = Object.freeze([
  "ally",
  "allyblockcast",
  "blockcast-ci-packages",
]);

const ALLY_REVIEW_IDENTITY_SET = new Set(ALLY_REVIEW_IDENTITY_LOGINS);

/**
 * Logins that count as *authoring* an agent PR — narrower on purpose.
 *
 * Authorship and reviewer-exclusion pull in opposite directions, so one list
 * cannot serve both. Widening the exclusion set is safe (it only ever withholds
 * an "answered" verdict); widening authorship is not, because it would pull
 * PRs written by other bots into a sweep scoped to *agent* PRs — and a human's
 * PR waiting on a human review is an ordinary queue, not a structural dead end.
 *
 * Only `allyblockcast` authors PRs today: every agent pod pushes through the
 * `allyblockcast[bot]` App installation (AGENTS.md, "Commit attribution is
 * write-path dependent"). `blockcast-ci-packages` reviewed but never authored,
 * so it belongs in the exclusion set and not here.
 */
export const AGENT_AUTHOR_LOGINS: readonly string[] = Object.freeze(["allyblockcast"]);

const AGENT_AUTHOR_SET = new Set(AGENT_AUTHOR_LOGINS);

/** Strip a `[bot]` suffix and case-fold, so App and User logins compare equal. */
export function normalizeReviewLogin(login: string | null | undefined): string | null {
  if (typeof login !== "string") return null;
  const trimmed = login.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed.endsWith("[bot]") ? trimmed.slice(0, -"[bot]".length) : trimmed;
}

/**
 * True when this login is an ally identity — App or User seat.
 *
 * Deliberately identity-based rather than `__typename`-based. Splitting on
 * `Bot` vs `User` would let the User seat through, and that seat's approvals are
 * precisely what satisfies the required-review rule today.
 */
export function isAllyReviewIdentity(login: string | null | undefined): boolean {
  const normalized = normalizeReviewLogin(login);
  return normalized !== null && ALLY_REVIEW_IDENTITY_SET.has(normalized);
}

export type PullRequestReview = {
  authorLogin?: string | null;
  /** ISO-8601. A review with no parseable timestamp cannot stop the clock. */
  submittedAt?: string | null;
  state?: string | null;
};

/**
 * A pending review request. `reviewerLogin`/`reviewerSlug` are optional
 * *because they are frequently unreadable* — see the module docblock. Presence
 * of the request is the signal; the identity of the requestee is a nicety.
 */
export type PendingReviewRequest = {
  /** ISO-8601 of the `review_requested` event, from the timeline. */
  requestedAt?: string | null;
  reviewerLogin?: string | null;
  reviewerSlug?: string | null;
};

export type AgeingPullRequest = {
  /** `owner/name`. */
  repo: string;
  number: number;
  title?: string | null;
  url?: string | null;
  authorLogin?: string | null;
  /** ISO-8601 PR creation time. Floor of the clock. */
  createdAt: string;
  isDraft?: boolean | null;
  /**
   * Pending requests, including ones whose requestee could not be resolved.
   * Empty means genuinely none — which for an agent-authored PR is its own
   * (rarer) problem and is reported separately rather than escalated here.
   */
  pendingReviewRequests?: PendingReviewRequest[] | null;
  reviews?: PullRequestReview[] | null;
  /**
   * When this PR was last escalated, or null if never. The idempotency key:
   * a non-null value suppresses re-escalation outright.
   *
   * This is a *stored* field, not derived from the PR, because the whole point
   * is that the PR looks identical before and after an escalation — nothing on
   * GitHub changes. Deriving "have I escalated this?" from PR state is what
   * produced 28 stacked review-request markers on paperclip#937.
   */
  escalatedAt?: string | null;
};

export type AgedReviewRequest = AgeingPullRequest & {
  /** The clock this PR is measured on. */
  requestClockAt: Date;
  unansweredDays: number;
  /** True when reviews exist but every one is an ally identity. */
  allyOnlyReviews: boolean;
};

export type SkipReason =
  | "not_agent_authored"
  | "draft"
  | "no_pending_request"
  | "answered_by_human"
  | "within_threshold"
  | "already_escalated";

export type MalformedPullRequest = { pullRequest: AgeingPullRequest; reason: string };

function parseTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Reviews that count as a human having answered: non-ally, submitted, engaged. */
export function answeringHumanReviews(pr: AgeingPullRequest): PullRequestReview[] {
  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  return reviews.filter((review) => {
    if (isAllyReviewIdentity(review.authorLogin)) return false;
    if (normalizeReviewLogin(review.authorLogin) === null) return false;
    const state = typeof review.state === "string" ? review.state.toUpperCase() : "";
    if (!ANSWERING_REVIEW_STATES.has(state)) return false;
    return parseTimestamp(review.submittedAt) !== null;
  });
}

export function hasPendingReviewRequest(pr: AgeingPullRequest): boolean {
  return Array.isArray(pr.pendingReviewRequests) && pr.pendingReviewRequests.length > 0;
}

/**
 * The clock: when the oldest still-pending request was made, falling back to PR
 * creation when no request carries a readable timestamp.
 *
 * Uses the **oldest** pending request rather than the newest so that stacking a
 * second request onto a PR cannot reset its age. Without that, the re-request
 * reflex this module exists to discourage would also be a way to silence it.
 */
export function reviewRequestClockAt(pr: AgeingPullRequest): Date {
  const createdAt = parseTimestamp(pr.createdAt);
  const requestedAts = (pr.pendingReviewRequests ?? [])
    .map((request) => parseTimestamp(request.requestedAt))
    .filter((value): value is Date => value !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  const oldestRequest = requestedAts[0] ?? null;
  if (!createdAt) {
    if (!oldestRequest) {
      throw new Error(`PR ${pr.repo}#${pr.number} has no parseable createdAt`);
    }
    return oldestRequest;
  }
  if (!oldestRequest) return createdAt;
  // A request cannot predate the PR; if it appears to, the PR clock is the
  // trustworthy one.
  return oldestRequest > createdAt ? oldestRequest : createdAt;
}

export function unansweredDays(pr: AgeingPullRequest, now: Date): number {
  return (now.getTime() - reviewRequestClockAt(pr).getTime()) / 86_400_000;
}

/**
 * True when the PR was authored by an agent identity.
 *
 * Agent-authored is the scope because a human's own PR needing a human review is
 * an ordinary queue, not a structural dead end. Uses the narrow
 * {@link AGENT_AUTHOR_LOGINS}, not the wider reviewer-exclusion set.
 */
export function isAgentAuthoredPullRequest(pr: AgeingPullRequest): boolean {
  const normalized = normalizeReviewLogin(pr.authorLogin);
  return normalized !== null && AGENT_AUTHOR_SET.has(normalized);
}

export type SelectAgedReviewRequestOptions = {
  now: Date;
  escalateAfterDays?: number;
  maxEscalated?: number;
};

export type AgedReviewRequestReport = {
  /** Past threshold, oldest first, truncated to `maxEscalated`. */
  escalate: AgedReviewRequest[];
  /** Past threshold but dropped by the cap. Never silently discarded. */
  overflowCount: number;
  /** Everything past threshold, before the cap — the true backlog depth. */
  overdueCount: number;
  skipped: Record<SkipReason, number>;
  /**
   * Agent-authored, non-draft PRs with **no** pending request at all. Distinct
   * from the escalation list: nothing is waiting to be answered, so ageing does
   * not apply, but an agent PR nobody was asked to review is still a defect.
   */
  missingReviewRequest: AgeingPullRequest[];
  malformed: MalformedPullRequest[];
  escalateAfterDays: number;
  maxEscalated: number;
};

function emptySkipTally(): Record<SkipReason, number> {
  return {
    not_agent_authored: 0,
    draft: 0,
    no_pending_request: 0,
    answered_by_human: 0,
    within_threshold: 0,
    already_escalated: 0,
  };
}

function validateShape(pr: AgeingPullRequest): string | null {
  if (typeof pr?.repo !== "string" || pr.repo.trim().length === 0) return "missing repo";
  if (!Number.isInteger(pr?.number)) return "missing or non-integer number";
  if (!Object.prototype.hasOwnProperty.call(pr, "createdAt")) return "missing createdAt key";
  if (parseTimestamp(pr.createdAt) === null && !hasPendingReviewRequest(pr)) {
    return "unparseable createdAt and no request timestamp to fall back on";
  }
  // An absent `reviews` *key* is a mapping failure — the caller forgot to fetch
  // them — and would make every PR look unanswered. An explicit `[]` is a real
  // "nobody has reviewed" and is fine. Gate on key presence, not on
  // `!== undefined`: the latter exempts exactly the case this rejects, and the
  // failure runs toward escalating everything.
  if (!Object.prototype.hasOwnProperty.call(pr, "reviews")) return "missing reviews key";
  if (pr.reviews !== null && !Array.isArray(pr.reviews)) {
    return "reviews is present but not an array";
  }
  return null;
}

/**
 * Validate the threshold once, at the boundary.
 *
 * Every decision below is `unansweredDays > threshold`, and every comparison
 * against `NaN` is false — so one malformed threshold does not throw, it
 * silently escalates nothing and reports a clean sweep. A false all-clear on an
 * escalation path is the worst available failure mode, so it fails loudly here.
 */
function validateThreshold(escalateAfterDays: number): void {
  if (typeof escalateAfterDays !== "number" || !Number.isFinite(escalateAfterDays)) {
    throw new Error(`escalateAfterDays must be a finite number, got ${String(escalateAfterDays)}`);
  }
  if (escalateAfterDays < 0) {
    throw new Error(`escalateAfterDays must not be negative, got ${escalateAfterDays}`);
  }
}

function validateMaxEscalated(maxEscalated: number): void {
  if (!Number.isInteger(maxEscalated) || maxEscalated < 0) {
    throw new Error(`maxEscalated must be a non-negative integer, got ${String(maxEscalated)}`);
  }
}

/**
 * Validate the clock's other operand.
 *
 * `now` is the same hazard as the threshold and needs the same guard: an
 * `Invalid Date` makes `unansweredDays` return `NaN`, every `days > threshold`
 * false, and the whole input tallies as `within_threshold` — a silent clean
 * sweep. Note this is the *only* silent path: a non-`Date` `now` throws inside
 * the per-PR `try` and at least lands in `malformed`, whereas an invalid `Date`
 * object sails through arithmetic without raising.
 */
function validateNow(now: Date): void {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error(`now must be a valid Date, got ${String(now)}`);
  }
}

/**
 * Select agent-authored PRs whose pending review request has gone unanswered
 * past the threshold.
 *
 * Note the return shape has no "nothing to do" boolean. Callers must distinguish
 * `escalate.length === 0` from `malformed.length === 0` — a sweep whose input
 * mapping broke produces an empty escalation list that looks exactly like a
 * healthy queue.
 */
export function selectAgedReviewRequests(
  pullRequests: readonly AgeingPullRequest[],
  options: SelectAgedReviewRequestOptions,
): AgedReviewRequestReport {
  const escalateAfterDays = options.escalateAfterDays ?? DEFAULT_ESCALATE_AFTER_DAYS;
  const maxEscalated = options.maxEscalated ?? DEFAULT_MAX_ESCALATED;
  validateThreshold(escalateAfterDays);
  validateMaxEscalated(maxEscalated);
  validateNow(options.now);

  const skipped = emptySkipTally();
  const malformed: MalformedPullRequest[] = [];
  const missingReviewRequest: AgeingPullRequest[] = [];
  const overdue: AgedReviewRequest[] = [];

  for (const pr of pullRequests) {
    const shapeError = validateShape(pr);
    if (shapeError) {
      malformed.push({ pullRequest: pr, reason: shapeError });
      continue;
    }
    if (!isAgentAuthoredPullRequest(pr)) {
      skipped.not_agent_authored += 1;
      continue;
    }
    // Drafts are excluded because the reviewer-wake path suppresses automatic
    // review on them: a draft is not waiting on a human, it is waiting on its
    // author. Ageing one would escalate at a human who cannot act.
    if (pr.isDraft === true) {
      skipped.draft += 1;
      continue;
    }
    if (!hasPendingReviewRequest(pr)) {
      skipped.no_pending_request += 1;
      missingReviewRequest.push(pr);
      continue;
    }
    if (answeringHumanReviews(pr).length > 0) {
      skipped.answered_by_human += 1;
      continue;
    }
    if (pr.escalatedAt) {
      skipped.already_escalated += 1;
      continue;
    }

    let days: number;
    let clockAt: Date;
    try {
      clockAt = reviewRequestClockAt(pr);
      days = (options.now.getTime() - clockAt.getTime()) / 86_400_000;
    } catch (error) {
      malformed.push({
        pullRequest: pr,
        reason: error instanceof Error ? error.message : "unreadable clock",
      });
      continue;
    }
    if (!(days > escalateAfterDays)) {
      skipped.within_threshold += 1;
      continue;
    }

    const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
    overdue.push({
      ...pr,
      requestClockAt: clockAt,
      unansweredDays: days,
      allyOnlyReviews:
        reviews.length > 0 && reviews.every((review) => isAllyReviewIdentity(review.authorLogin)),
    });
  }

  overdue.sort((a, b) => b.unansweredDays - a.unansweredDays);
  const escalate = overdue.slice(0, maxEscalated);

  return {
    escalate,
    overflowCount: overdue.length - escalate.length,
    overdueCount: overdue.length,
    skipped,
    missingReviewRequest,
    malformed,
    escalateAfterDays,
    maxEscalated,
  };
}

/** Longest PR-controlled string rendered into a digest, before ellipsis. */
const MAX_RENDERED_FIELD_CHARS = 160;

/**
 * Bound one PR-controlled string to inert, single-line Markdown.
 *
 * PR titles are attacker-influenced — anyone who can open a PR chooses one — and
 * this digest is consumed by an agent prompt, so a title carrying a newline
 * stops being a bullet's payload and becomes a line the model reads as
 * instruction. Mirrors the treatment in `human-gated-ageing.ts`; see the
 * untrusted-region note there. Neutralising here rather than per call site means
 * a newly rendered field cannot miss it.
 */
export function sanitizeRenderedField(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const singleLine = Array.from(value)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (singleLine.length === 0) return fallback;
  const bounded =
    singleLine.length > MAX_RENDERED_FIELD_CHARS
      ? `${singleLine.slice(0, MAX_RENDERED_FIELD_CHARS)}…`
      : singleLine;
  // Strip leading markers repeatedly: a single non-global pass leaves a nested
  // marker behind, so `"> # text"` would still render as a heading.
  return bounded.replace(/`/g, "'").replace(/^(?:[#>*\-+_=|[\]]+\s*)+/, "");
}

export function formatPullRequestRef(pr: AgeingPullRequest): string {
  return sanitizeRenderedField(`${pr.repo}#${pr.number}`, "(unidentified pull request)");
}
