#!/usr/bin/env node

/**
 * Decides which open PRs may be handed to the merge queue, and why each of the
 * rest may not.
 *
 * Nothing currently lands a PR that Ally has already reviewed clean. They sit
 * open until a human notices, which on 2026-09-04 was the third of four
 * measured causes of 101 issues stalled `in_review` for 22-87 days
 * (BLO-32237). This script is the decision; the routine that runs it
 * (BLO-32511) only invokes it and posts the receipt.
 *
 * The classifier is pure and exhaustive: every PR gets exactly one row, and a
 * row is either an action or a named reason for inaction. There is no "no
 * opinion" outcome, because a PR silently absent from the receipt is
 * indistinguishable from one the script never fetched — the fail-open shape
 * `assertPrListComplete` exists to prevent one layer up.
 *
 * Default is a dry run. `--apply` performs the actions.
 *
 * ## The reporting half: approvals that rotted (BLO-33208)
 *
 * The same sweep answers a second question nothing else was asking. An approval
 * is the scarcest signal on a PR — a human read the diff and said yes, at a
 * measured fleet throughput of ~2.4 such actions/day — and it is silently spent
 * when master moves underneath the branch. A conflict is created by a commit on
 * the BASE, so there is no `synchronize`, no `pull_request` event and no check
 * re-run on the PR itself; `mergeStateStatus` is not a check, so it cannot be
 * expressed as a `gateSignals` monitor either. Nothing wakes the assignee, ever.
 *
 * That cohort has been cleaned up by hand four times (BLO-29984, BLO-31321,
 * BLO-32205, BLO-33208) and regrown in the same repos every time, which is why
 * it is folded in here as a standing `approval-rotted` row rather than cleaned
 * up a fifth time. It is REPORTED and never acted on: a deliberate sequencing
 * hold is indistinguishable from a strand on every API surface, and
 * trafficcontrol#1726 was exactly that — "do not merge before magma#1936", a
 * shared proto field-number space that a rebase would have broken.
 *
 * Folded in from the standalone detector in trafficcontrol#1815, which was
 * closed in favour of this: that one needed a repo secret no agent can
 * provision, so its schedule would have been permanently red and its alarm
 * state indistinguishable from its broken state (BLO-33268).
 *
 * ## Why the review verdict is read from the body, not from `commit_id`
 *
 * GitHub rewrites `commit_id` on APPROVED reviews when the head moves, so a
 * review can be recorded against a commit created after it was submitted
 * (measured on #1104, 2026-08-07; see I3 in check-ally-review-consistency.mjs).
 * The body's `Reviewed head:` attestation is the record of which tree was
 * actually read, so `canonicalReviewHead` is the selector here. Using
 * `commit_id` would let a force-push launder a stale review into a current one
 * — and this script's whole output is "merge it", so that failure is fatal.
 *
 * ## Why the *newest* attesting review wins (BLO-32240, Ally 2026-09-07)
 *
 * More than one review may attest the same head. #1418 @958587ad carries two:
 * `5124450619` with 1 Important, then `5125141599` clean 4h45m later, a verdict
 * reconciliation at unchanged head. A classifier that scans all reviews at head
 * and disqualifies on any Important reads that PR as blocked *permanently*,
 * because the superseded review is immortal and the head never moves on its
 * own. So: select the newest attesting operative review by `submitted_at` and
 * judge only that one. This matches the gate's own stated semantics —
 * `gate/ally-comment-findings` describes itself as reading Ally's "most recent"
 * consolidated review for the head.
 *
 * The mirror case is the dangerous one and is tested: older clean, newer
 * blocking must NOT enqueue. A naive "take any clean review at head" passes the
 * first case and fails open on the second.
 *
 * Note this is not in tension with the "exactly one attestation" rule. That
 * rule is about one `Reviewed head:` line per *body* (anti-forgery), enforced
 * by `canonicalReviewHead`; it is not a cap on reviews per head.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allyReviewLane,
  assertHeadSha,
  assertPrListComplete,
  canonicalReviewHead,
  hasBlockingFindings,
  hasStillPresentDisposition,
  isAllyAppLogin,
} from "./check-ally-review-consistency.mjs";

/**
 * An auto-merge request older than this is treated as wedged rather than
 * pending. The merge queue drains in minutes; a request still outstanding
 * overnight means it was armed against a gate that has since become
 * unsatisfiable, and it blocks re-enqueue because `--auto` is already set. 13h
 * clears a normal overnight queue without waiting a second working day.
 */
export const STALE_ENQUEUE_HOURS = 13;

export const CODEOWNER_REQUEST_MARKER = "<!-- landing-routine:codeowner-request -->";
export const STALE_ENQUEUE_MARKER = "<!-- landing-routine:stale-enqueue -->";

/** Either label is an explicit human "not this one". */
export const SKIP_LABELS = ["do-not-merge", "review-gate-override"];

/**
 * A blast-radius cap, not a throughput target. A classifier bug that says
 * "enqueue" for the wrong reason costs at most this many PRs per fire, and the
 * receipt names every PR the cap deferred so the truncation is never silent.
 *
 * Per FIRE, not per repo: `classifyAll` is called once per swept repo, so the
 * counter has to carry across those calls via `spent` or the real ceiling is
 * `10 x repos` — the cap quietly scaling with the very knob that makes a
 * classifier bug reach further.
 */
export const MAX_ENQUEUES_PER_FIRE = 10;

/**
 * SKIPPED and NEUTRAL are passes: a path-filtered job and a soft-reporting one
 * both legitimately decline to run. Everything else — including a null
 * conclusion, which is a check still in flight — is not a verdict of success
 * and must not be read as one.
 */
const PASSING_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Contexts that mirror Ally's review verdict rather than reporting CI.
 *
 * These are excluded from the check rule because the review rule below reads
 * the same fact from the authoritative source, and reads it correctly. The
 * statuses do not: measured on #1681 @c57fafa0 (2026-09-13), the newest
 * attesting review is `Critical Issues (0)` / `Important Issues (0)` — clean,
 * two non-blocking Suggestions — while `gate/ally-comment-findings` sits at
 * `failure` claiming "carries an unresolved finding". Same divergence recorded
 * on #1418 (BLO-32514), where the status was stale for over a day against a
 * verdict it no longer described.
 *
 * Counting them as checks would be a permanent false hold: a commit status
 * never moves on its own, so such a PR could never enqueue however clean its
 * review became. That is the same immortal-stale-verdict failure the
 * newest-review rule exists to prevent, arriving through a different door.
 *
 * Deliberately narrow. It matches only the `review/ally-*` and `gate/ally-*`
 * legacy-status namespace. The bare `review` context is the PR-quality gate and
 * is a real check; any Ally-named *check-run* is the workflow that publishes
 * the status, and is also a real check. Neither is excluded — and that is
 * enforced by `isAllyVerdictStatus` below rather than assumed, because the
 * names are only unambiguous while no check-run happens to share one.
 * Measured on #1821 @5cc6a70e: all three Ally rows are `StatusContext`, so the
 * name-only reading was load-bearing and untyped.
 *
 * This removes a duplicate reading, not a gate. `allyVerdictAtHead` still
 * blocks on Critical/Important findings and on a still-present prior
 * disposition, from the newest review that attests the current head.
 */
const ALLY_VERDICT_STATUS_RE = /^(?:review|gate)\/ally-/i;

/**
 * Merge states that mean the PR cannot land as it stands. BLOCKED and BEHIND
 * are deliberately absent: BLOCKED is the normal state of a PR awaiting the
 * code-owner approval we may have just requested, and BEHIND is what the merge
 * queue exists to resolve. `--auto` waits for both correctly.
 */
const UNLANDABLE_MERGE_STATES = new Set(["DIRTY", "UNSTABLE", "UNKNOWN"]);

/**
 * How long after the newest check reports before an all-green rollup is
 * believed (BLO-33208 bucket-B age floor).
 *
 * Checks register over the seconds-to-minutes following a push, so a rollup
 * read mid-registration is green only because the reds have not arrived yet.
 * `failingChecks` structurally cannot see this: an absent check and a passing
 * one are the same empty set. Measured next door on onprem-k8s#3269, where one
 * head dispatched 4 workflows and the identical tree dispatched 22 once a merge
 * commit could be computed (BLO-32606).
 *
 * 15 minutes, not the 24h the reporting-only detector used: that floor existed
 * to avoid paging a human about a PR mid-CI, and this script acts rather than
 * pages. The enqueue is `--auto`, so GitHub re-gates on required checks anyway
 * and the cost of being wrong is one deferred fire. Calibrate with
 * LAND_CLEAN_PRS_SETTLE_MINUTES if a repo's checks register more slowly.
 */
export const CHECK_SETTLE_MINUTES = 15;

function isDismissedOrPending(review) {
  const state = String(review?.state ?? "").toUpperCase();
  return state === "DISMISSED" || state === "PENDING";
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * The latest state per check, as `[name, state]` pairs.
 *
 * A re-run, or a cancelled-then-superseded run, leaves both attempts hanging
 * off the same head. Reading them all makes a green PR look red (BLO-32733),
 * so the newest row per check wins. `statusCheckRollup` unifies the check-run
 * and legacy commit-status surfaces, which is why this reads one field rather
 * than two endpoints that are each blind to the other.
 *
 * "Per check" means per (surface, name), not per name: the union carries
 * `CheckRun` and `StatusContext` rows in independent namespaces, so keying on
 * the name alone lets a newer green status context shadow an older failing
 * check-run of the same name and enqueue past a red required check. Pairs
 * rather than a Map for the same reason — a Map cannot hold both.
 */
export function latestCheckStates(rollup) {
  const latest = new Map();
  for (const context of rollup ?? []) {
    const name = String(context?.name ?? context?.context ?? "").trim();
    if (name === "") continue;
    const state = String(
      context?.conclusion || context?.state || context?.status || "PENDING",
    ).toUpperCase();
    const at = Date.parse(
      context?.completedAt || context?.startedAt || context?.createdAt || "",
    );
    const stamp = Number.isFinite(at) ? at : 0;
    const key = `${context?.__typename ?? ""} ${name}`;
    const seen = latest.get(key);
    if (!seen || stamp >= seen.stamp) latest.set(key, { name, state, stamp });
  }
  return [...latest.values()].map(({ name, state }) => [name, state]);
}

/**
 * A legacy commit status in the Ally verdict-mirror namespace.
 *
 * Keyed on `__typename`, not on the name alone: `statusCheckRollup` unions
 * `CheckRun` and `StatusContext`, so a name-only predicate would also swallow a
 * genuinely failing *check-run* that happened to carry one of these names —
 * contradicting the comment above and letting a PR enqueue past a red required
 * check. Fails safe: if `__typename` is ever absent the row is treated as a
 * real check, which can only over-hold, never over-enqueue.
 */
function isAllyVerdictStatus(context) {
  return (
    context?.__typename === "StatusContext" &&
    ALLY_VERDICT_STATUS_RE.test(String(context?.context ?? ""))
  );
}

export function failingChecks(rollup) {
  return [...latestCheckStates((rollup ?? []).filter((c) => !isAllyVerdictStatus(c)))]
    .filter(([, state]) => !PASSING_CHECK_STATES.has(state))
    .map(([name, state]) => `${name}=${state}`);
}

/** Operative Ally App reviews whose body attests this exact head. */
export function attestingAppReviews(reviews, headSha) {
  const head = lower(headSha);
  return (reviews ?? []).filter(
    (review) =>
      allyReviewLane(review?.user) === "app" &&
      !isDismissedOrPending(review) &&
      canonicalReviewHead(review?.body) === head,
  );
}

/**
 * @returns {{verdict: "clean"|"blocking"|"stale-head"|"missing", review: object|null}}
 */
export function allyVerdictAtHead(pr) {
  const attesting = attestingAppReviews(pr?.reviews, pr?.headRefOid);
  if (attesting.length === 0) {
    const hasOperativeAppReview = (pr?.reviews ?? []).some(
      (review) => allyReviewLane(review?.user) === "app" && !isDismissedOrPending(review),
    );
    return { verdict: hasOperativeAppReview ? "stale-head" : "missing", review: null };
  }

  const newest = attesting.reduce((a, b) =>
    (Date.parse(b?.submitted_at ?? "") || 0) >= (Date.parse(a?.submitted_at ?? "") || 0) ? b : a,
  );
  const blocking =
    hasBlockingFindings(newest.body) || hasStillPresentDisposition(newest.body);
  return { verdict: blocking ? "blocking" : "clean", review: newest };
}

/**
 * Requested reviewers with no APPROVED review at the current head.
 *
 * D7: GitHub does not enforce CODEOWNERS on this repo, so an outstanding owner
 * request is a real gate that only this script observes. A team request can
 * never be satisfied by a login match and so always counts as outstanding,
 * which is correct — a team has not reviewed until one of its members has.
 *
 * This matches on `commit_id` rather than a body attestation because a human
 * approval carries no attestation to read. That inherits GitHub's own
 * re-anchoring behaviour on force-push, i.e. it can read a re-anchored stale
 * approval as current. The residual is bounded by `dismiss_stale_reviews_on_push`
 * server-side, and the direction matches what GitHub's own merge gate would do.
 */
export function unsatisfiedOwners(pr) {
  const head = lower(pr?.headRefOid);
  const approved = new Set(
    (pr?.reviews ?? [])
      .filter(
        (review) =>
          String(review?.state ?? "").toUpperCase() === "APPROVED" &&
          lower(review?.commit_id) === head,
      )
      .map((review) => lower(review?.user?.login)),
  );
  return (pr?.reviewRequests ?? [])
    .map((request) =>
      request?.login ? String(request.login) : request?.slug ? `team:${request.slug}` : null,
    )
    .filter((who) => who !== null && !approved.has(lower(who)));
}

/**
 * APPROVED reviewers on this PR, split into human and bot lanes.
 *
 * Only a human approval consumed a scarce resource — human review throughput on
 * this fleet measures ~2.4 actions/day — so a PR that rotted after a person
 * said yes is categorically more expensive than one carrying a bot approval.
 * Reporting them as one "approved" count overstated BLO-33208's own cohort by
 * ~2.7x, which is why the two lanes stay separate all the way to the receipt.
 *
 * Keyed on the REST `user.type` field and never on a `[bot]` login suffix: the
 * suffix is a naming convention any account may adopt, and identity is what
 * decides whether a person was spent. Head is deliberately not considered — the
 * approval was paid for whether or not the branch has moved since.
 */
export function approvalLanes(pr) {
  const human = new Set();
  const bot = new Set();
  for (const review of pr?.reviews ?? []) {
    if (String(review?.state ?? "").toUpperCase() !== "APPROVED") continue;
    const login = String(review?.user?.login ?? "<unknown>");
    (String(review?.user?.type ?? "") === "Bot" ? bot : human).add(login);
  }
  return { human: [...human].sort(), bot: [...bot].sort() };
}

/** Human lane first: the receipt should lead with the expensive case. */
function approvalNote(pr) {
  const { human, bot } = approvalLanes(pr);
  if (human.length > 0) return `spent human approval: ${human.join(", ")}`;
  if (bot.length > 0) return `bot-only approval: ${bot.join(", ")}`;
  return null;
}

/**
 * Whether an all-green rollup has been green long enough to believe.
 *
 * Two ways it has not. A rollup with zero rows is a stop, not a pass: the two
 * surfaces `statusCheckRollup` unions are each capable of carrying the real
 * verdict, so nothing reporting means nothing has attested this head, which
 * renders identically to every check passing. And a rollup whose newest row is
 * younger than the floor is still registering — see CHECK_SETTLE_MINUTES.
 *
 * A non-empty rollup carrying no parseable timestamp counts as settled, which
 * is the opposite of the empty case on purpose. Undatable rows cannot be shown
 * to be *fresh* either, and a commit status never moves on its own, so holding
 * would be permanent — the same immortal-stale-verdict shape the newest-review
 * rule exists to prevent. Enqueuing early is bounded instead: it only arms
 * `--auto`, which re-gates on required checks server-side.
 */
export function checkSettlement(
  rollup,
  { now = Date.now(), settleMinutes = CHECK_SETTLE_MINUTES } = {},
) {
  if ((rollup ?? []).length === 0) return { settled: false, reason: "none" };
  const stamps = (rollup ?? [])
    .map((c) => Date.parse(c?.completedAt || c?.startedAt || c?.createdAt || ""))
    .filter((at) => Number.isFinite(at));
  if (stamps.length === 0) return { settled: true };
  const ageMinutes = (now - Math.max(...stamps)) / 60_000;
  if (ageMinutes < settleMinutes) {
    return {
      settled: false,
      reason: "settling",
      detail: `newest check reported ${ageMinutes.toFixed(1)}m ago, floor ${settleMinutes}m`,
    };
  }
  return { settled: true };
}

/**
 * The rules decidable from `gh pr list` alone, or null when this PR needs its
 * checks and reviews fetched.
 *
 * Split out because `statusCheckRollup` is expensive: asking for it across all
 * 139 open PRs in one GraphQL call returns 502/504 (measured 2026-09-13 at
 * limits 150, 200 and 500). Deciding the cheap rules first means only the PRs
 * that survive them cost two API calls each, and on a repo where most open PRs
 * are already enqueued or human-authored that is most of them avoided.
 */
export function classifyFromListing(pr, { now = Date.now() } = {}) {
  const row = (action, reason, detail = null) => ({
    number: pr?.number,
    headSha: pr?.headRefOid,
    action,
    reason,
    detail,
  });

  if (!isAllyAppLogin(pr?.author?.login) || pr?.author?.is_bot !== true) {
    return row("skip", "human-author", pr?.author?.login ?? "<unknown>");
  }

  const labels = (pr?.labels ?? []).map((label) => lower(label?.name));
  const optOut = SKIP_LABELS.find((label) => labels.includes(label));
  if (optOut) return row("skip", `label:${optOut}`);

  // Draft is the author's own "not this one", in the same category as the
  // opt-out labels above, and it is the only machine-readable form a deliberate
  // sequencing hold reliably takes. trafficcontrol#1726 is the case: draft,
  // CLEAN, Ally-authored, reviewed clean, and its body reads "Draft, and
  // blocked by design. Do not merge before magma#1936" — the two repos carry a
  // byte-identical proto sharing one field-number space, so landing this half
  // alone is the BLO-29906 breakage. It classified `enqueue` until this rule
  // existed; GitHub would have refused the auto-merge, but relying on that is
  // luck, and it evaporates the moment someone marks the PR ready while the
  // sequencing constraint still holds.
  if (pr?.isDraft === true) return row("skip", "draft");

  if (pr?.autoMergeRequest) {
    const enabledAt = Date.parse(pr.autoMergeRequest.enabledAt ?? "");
    // An unparseable timestamp must not read as infinitely old: treating it as
    // fresh leaves the PR alone, which is the recoverable direction.
    const ageHours = Number.isFinite(enabledAt) ? (now - enabledAt) / 3_600_000 : 0;
    if (ageHours > STALE_ENQUEUE_HOURS) {
      return row("stale-enqueue", `auto-merge armed ${ageHours.toFixed(1)}h ago`);
    }
    return row("already-enqueued", `auto-merge armed ${ageHours.toFixed(1)}h ago`);
  }

  return null;
}

/**
 * One row per PR. Rules are ordered so that the reason reported is the one a
 * human would act on first: an explicit opt-out beats a red check, and a red
 * check beats a missing review, because fixing the review would not help.
 *
 * DIRTY is decided ahead of the check rules, and that ordering is load-bearing
 * rather than cosmetic. GitHub cannot evaluate a `paths:` filter on a PR whose
 * merge commit will not compute, so on a conflicted PR every path-filtered
 * workflow is silently never dispatched — no run, no check-run, no "expected"
 * row. The surviving checks then read green and mean nothing (BLO-32606,
 * measured on onprem-k8s#3269). Reading them first would report `checks:` as
 * the reason, or worse read the remnant as a pass; the conflict is both the
 * true cause and the only actionable one.
 */
export function classifyPr(pr, { now = Date.now(), settleMinutes = CHECK_SETTLE_MINUTES } = {}) {
  const fromListing = classifyFromListing(pr, { now });
  if (fromListing) return fromListing;

  const row = (action, reason, detail = null) => ({
    number: pr?.number,
    headSha: pr?.headRefOid,
    action,
    reason,
    detail,
  });

  const mergeState = String(pr?.mergeStateStatus ?? "UNKNOWN").toUpperCase();
  if (mergeState === "DIRTY") {
    // An approval already paid for here is the BLO-33208 priority cohort: the
    // work is finished and reviewed, master moved underneath it, and no GitHub
    // event fires because the conflicting commit landed on the BASE. Given its
    // own action so the receipt tally carries the count rather than burying it
    // among every other `skip`.
    const spent = approvalNote(pr);
    if (spent) return row("approval-rotted", "mergestate:DIRTY", spent);
    return row("skip", "mergestate:DIRTY");
  }

  const failing = failingChecks(pr?.statusCheckRollup);
  if (failing.length > 0) {
    return row("skip", `checks:${failing[0].split("=")[1]}`, failing.join(", "));
  }

  const settlement = checkSettlement(pr?.statusCheckRollup, { now, settleMinutes });
  if (!settlement.settled) return row("skip", `checks:${settlement.reason}`, settlement.detail);

  const { verdict } = allyVerdictAtHead(pr);
  if (verdict !== "clean") return row("skip", `review:${verdict}`);

  const owners = unsatisfiedOwners(pr);
  if (owners.length > 0) {
    return row("codeowner-review-requested", "owner-approval-pending", owners.join(", "));
  }

  if (UNLANDABLE_MERGE_STATES.has(mergeState)) return row("skip", `mergestate:${mergeState}`);

  return row("enqueue", `mergestate:${mergeState}`);
}

/** Classifies every PR and applies the per-fire enqueue cap. */
export function classifyAll(
  prs,
  {
    now = Date.now(),
    maxEnqueues = MAX_ENQUEUES_PER_FIRE,
    settleMinutes = CHECK_SETTLE_MINUTES,
    spent = 0,
  } = {},
) {
  let enqueued = spent;
  return (prs ?? []).map((pr) => {
    const classified = classifyPr(pr, { now, settleMinutes });
    if (classified.action !== "enqueue") return classified;
    if (enqueued >= maxEnqueues) {
      return { ...classified, action: "skip", reason: `cap:${maxEnqueues}-per-fire` };
    }
    enqueued += 1;
    return classified;
  });
}

/**
 * A gh failure that means the whole fire is untrustworthy rather than this one
 * PR being awkward. Continuing past exhausted rate limits or bad credentials
 * would produce a receipt whose `skip:` rows are indistinguishable from real
 * verdicts, so the fire aborts and says so.
 */
export function isFatalGhError(message) {
  return /rate limit|bad credentials|HTTP 40[13]|could not read (?:Username|Password)/i.test(
    String(message ?? ""),
  );
}

export function renderReceipt(rows) {
  const lines = [
    "| PR | action | reason | detail |",
    "| --- | --- | --- | --- |",
    ...(rows ?? []).map(
      (r) => `| #${r.number} | \`${r.action}\` | \`${r.reason}\` | ${r.detail ?? ""} |`,
    ),
  ];
  const tally = new Map();
  for (const r of rows ?? []) tally.set(r.action, (tally.get(r.action) ?? 0) + 1);
  lines.push(
    "",
    [...tally].sort().map(([action, count]) => `${action}: ${count}`).join(" · ") ||
      "no open PRs",
  );
  return lines.join("\n");
}

const PR_LIST_FIELDS =
  "number,headRefOid,author,labels,isDraft,autoMergeRequest,mergeStateStatus,reviewRequests";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Lists open PRs, then hydrates checks and reviews only for the ones the cheap
 * rules could not decide. `statusCheckRollup` is deliberately absent from the
 * list query — including it makes GitHub time out across this repo's open PR
 * count — so it is fetched per PR alongside the REST reviews.
 *
 * Reviews come from REST rather than `gh pr view --json reviews` because the
 * identity rules pin immutable REST account IDs, which the GraphQL shape does
 * not carry. A login string alone is not review evidence (I5).
 */
function fetchOpenPrs(repo) {
  const rows = JSON.parse(
    gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", PR_LIST_FIELDS]),
  );
  assertPrListComplete(rows, repo, 500);
  return rows.map((row) => {
    assertHeadSha(row, repo);
    if (classifyFromListing(row)) return row;
    return {
      ...row,
      statusCheckRollup: JSON.parse(
        gh(["pr", "view", String(row.number), "--repo", repo, "--json", "statusCheckRollup"]),
      ).statusCheckRollup,
      reviews: JSON.parse(gh(["api", `repos/${repo}/pulls/${row.number}/reviews`, "--paginate"])),
    };
  });
}

/** Posts `body` unless a comment carrying `marker` is already on the PR. */
function commentOnce(repo, number, marker, body) {
  const existing = JSON.parse(
    gh(["api", `repos/${repo}/issues/${number}/comments`, "--paginate"]),
  );
  if (existing.some((comment) => String(comment?.body ?? "").includes(marker))) return "already-posted";
  gh(["pr", "comment", String(number), "--repo", repo, "--body", `${marker}\n${body}`]);
  return "posted";
}

function applyRow(repo, row) {
  if (row.action === "enqueue") {
    gh(["pr", "merge", String(row.number), "--repo", repo, "--auto"]);
    return "auto-merge armed";
  }
  if (row.action === "stale-enqueue") {
    gh(["pr", "merge", String(row.number), "--repo", repo, "--disable-auto"]);
    return commentOnce(
      repo,
      row.number,
      STALE_ENQUEUE_MARKER,
      `Auto-merge had been armed for over ${STALE_ENQUEUE_HOURS}h without landing, so the landing ` +
        `routine disarmed it. It will re-arm on the next fire once this PR classifies clean.`,
    );
  }
  if (row.action === "codeowner-review-requested") {
    return commentOnce(
      repo,
      row.number,
      CODEOWNER_REQUEST_MARKER,
      `This PR is clean at its current head but still has an outstanding code-owner review ` +
        `request (${row.detail}). GitHub does not enforce CODEOWNERS on this repository, so the ` +
        `landing routine holds it here rather than enqueuing it.`,
    );
  }
  return null;
}

/**
 * Repos this fire covers. Comma-separated, because the rot this detects is not
 * repo-local: the DIRTY-after-approval cohort has been cleaned up by hand four
 * times (BLO-29984 multicast, BLO-31321 trafficcontrol, BLO-32205 onprem-k8s,
 * BLO-33208) and regrown in the same repos every time. A single-repo sweep is
 * how the other two stay unobserved between cleanups.
 */
export function targetRepos(value = process.env.LAND_CLEAN_PRS_REPO) {
  const repos = String(value ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean);
  return repos.length > 0 ? repos : ["Blockcast/paperclip"];
}

/**
 * The settling floor, from the environment, refusing anything that is not a
 * real number of minutes.
 *
 * `Number("15m")` is `NaN`, and `ageMinutes < NaN` is `false`, so an
 * unparseable value used to report every rollup as settled — the guard
 * disarming itself in the fail-OPEN direction, silently. `15m` is the likely
 * bad input, invited by the "15 minutes" phrasing and by the `floor 15m` the
 * detail string prints back. Blank is unset, not zero, for the same reason:
 * `Number("")` is `0`, which is finite and would disable the floor.
 *
 * Same rule `classifyFromListing` already applies to an unparseable
 * `autoMergeRequest.enabledAt`, which refuses to let a bad timestamp read as
 * infinitely old.
 */
export function settleMinutesFrom(value = process.env.LAND_CLEAN_PRS_SETTLE_MINUTES) {
  const raw = String(value ?? "").trim();
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed) || parsed < 0) return CHECK_SETTLE_MINUTES;
  return parsed;
}

function runRepo(repo, apply, settleMinutes, spent, rotted) {
  const rows = classifyAll(fetchOpenPrs(repo), { settleMinutes, spent });

  for (const row of rows) {
    if (row.action === "approval-rotted") rotted.push(`${repo}#${row.number} (${row.detail})`);
  }

  for (const row of rows) {
    if (!apply) continue;
    try {
      const outcome = applyRow(repo, row);
      if (outcome) row.detail = [row.detail, outcome].filter(Boolean).join(" — ");
    } catch (error) {
      const message = error?.stderr?.toString() || error?.message || String(error);
      if (isFatalGhError(message)) {
        row.action = "aborted";
        row.detail = message.trim().split("\n")[0];
        console.log(`## ${repo}\n\n${renderReceipt(rows)}`);
        // Print the priority cohort before dying: it is the expensive half of
        // the output, and the repos that already completed earned it.
        reportRotted(rotted);
        console.error(`\nAborted the fire: ${row.detail}`);
        process.exit(1);
      }
      row.detail = [row.detail, `failed: ${message.trim().split("\n")[0]}`]
        .filter(Boolean)
        .join(" — ");
    }
  }

  console.log(`## ${repo}\n\n${renderReceipt(rows)}`);
  return rows;
}

function reportRotted(rotted) {
  if (rotted.length === 0) return;
  // Reported, never acted on. A deliberate hold is invisible on every API
  // surface — trafficcontrol#1726 read exactly like a strand while its body
  // said "do not merge before magma#1936", a shared proto field-number space.
  // So: read the PR body before rebasing anything here.
  console.log(
    `approval-rotted (BLO-33208 priority cohort) — ${rotted.length}:\n` +
      rotted.map((row) => `  ${row}`).join("\n") +
      "\nRead each PR body before rebasing: a deliberate sequencing hold is " +
      "indistinguishable from a strand on every API surface.",
  );
}

function main() {
  const apply = process.argv.includes("--apply");
  const settleMinutes = settleMinutesFrom();
  const rotted = [];
  let spent = 0;

  // `finally`, because the cohort is the expensive half of the output and the
  // likeliest thrower is `fetchOpenPrs` — outside `runRepo`'s try, one list
  // call plus two per undecided PR, multiplied by the repo count, and in a dry
  // run the only `gh` traffic there is. The explicit call before `process.exit`
  // in `runRepo` stays: `exit` does not unwind, so this block never runs there.
  try {
    for (const repo of targetRepos()) {
      const rows = runRepo(repo, apply, settleMinutes, spent, rotted);
      spent += rows.filter((row) => row.action === "enqueue").length;
      console.log("");
    }
  } finally {
    reportRotted(rotted);
  }

  if (!apply) console.log("\n(dry run — pass --apply to act)");
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}
