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

/**
 * How long a head may go without reporting before a hold still standing on it
 * is reported as durable rather than in flight.
 *
 * Note what that is NOT: it is not how long the hold has stood. Nothing cheap
 * dates a hold's onset, and `judgeableAgeHours` explains why the head clock is
 * the right proxy anyway. A row that acquired its hold this fire, on CI that
 * finished yesterday, is reported — correctly, because the question is whether
 * the verdict has been available and unacted-on, not who noticed when.
 *
 * The classifier already names a reason for every PR it does not enqueue, so
 * nothing here is newly discovered — what is missing is DURATION. A row that
 * has read `codeowner-review-requested` for three days and one that acquired
 * the same reason four minutes ago are byte-identical in the receipt, and a
 * fire only ever shows the instant it ran. The tail that results is invisible
 * by construction: measured 2026-10-29 on Blockcast/paperclip, two of the four
 * oldest unlanded PRs carried holds that could not clear on their own (#3051
 * waiting on a code owner since 2026-10-27, #3032 red on the non-required
 * `review` check since 2026-10-26), and nothing anywhere said how long.
 *
 * 13h, matching STALE_ENQUEUE_HOURS and for the same reason: it clears a
 * normal overnight queue without waiting a second working day. It is also ~2x
 * the create->merge spread measured over the 12 most recent merges on that
 * repo the same day (2.2-6.8h), so a hold still standing at this age is past
 * every landing that repo actually performs.
 */
export const STALE_HOLD_HOURS = 13;

/**
 * How many times GitHub may eject the SAME head before the enqueuer stops
 * putting it back.
 *
 * Two, deliberately, and the second one is the whole discriminator.
 *
 * An ejection has three causes and they need opposite responses: an infra
 * flake (retry at the same head), a reproducible assertion (the head must
 * move), and collateral from an entry ahead in the queue (nothing to do). A
 * single ejection cannot tell them apart. Measured on #3089, 2026-10-29: of
 * the four failing jobs on queue head `15e7dcef`, THREE were infrastructure —
 * `mirror` died mid-checkout with `The runner has received a shutdown signal`
 * and took both vendored-adapter jobs with it as `The operation was
 * canceled` — and all three were `success` on the rebuilt heads. Holding on
 * the first ejection would have stranded a healthy PR indefinitely.
 *
 * Re-running IS the retest, so the second ejection at an unchanged head is
 * evidence the first was not a flake. That makes the threshold the cheap
 * substitute for classifying the failure: it needs no log scraping, no job
 * name allowlist and no guess about which runner died, and it degrades in the
 * recoverable direction — one wasted re-enqueue, never a permanent hold.
 *
 * ⛔ Do NOT lower this to 1. That reintroduces exactly the hold this comment
 * rules out, and the cost is paid by the PRs behind it: with
 * `mergingStrategy: ALLGREEN` + `mergeMethod: REBASE` an ejection rebuilds
 * every entry behind it from zero (#3089's 13:48:05Z ejection cost #3085 and
 * #3032 ~43 min each, for a failure in neither).
 */
export const EJECTIONS_BEFORE_HOLD = 2;

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
 *
 * What carries is SUCCESSFUL enqueues only (see `sweepRepos`): a row that
 * `markFailure` renamed to `enqueue-failed` costs nothing, because a failed
 * enqueue merged no PR. So the cap bounds PRs landed per fire, which is the
 * guarantee above, and does not bound attempts: a repo whose enqueues all fail
 * leaves the next repo a full budget, up to `10 x repos` doomed calls. Those
 * are no-ops, so that is accepted rather than spending budget on them and
 * starving later repos in the sweep.
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
 * is a real check; an Ally-named *check-run* with no identically-named status
 * beside it is the workflow that publishes the status, and is also a real
 * check. Neither is excluded — and that is enforced by `isAllyVerdictStatus`
 * below rather than assumed.
 *
 * The name-only reading was once load-bearing and untyped, on the strength of
 * #1821 @5cc6a70e, where all three Ally rows were `StatusContext`. That
 * measurement is STALE — do not restore a reasoning that depends on it. The
 * gate now publishes a `CheckRun` of the same name too (#1957 @68f3f598), so
 * `__typename` alone leaks the twin through as CI. Typing is still correct and
 * still necessary; it is just no longer sufficient, and the twin case is
 * handled in `withoutAllyVerdictMirrors` below.
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
 * queue exists to resolve. gh never merges either outright, so `--auto` arms
 * and waits where auto-merge is available and lands in `enqueue-failed` where
 * it is not.
 *
 * This set is also a merge gate, not only a hold list. `gh pr merge --auto`
 * merges immediately instead of arming when the state is CLEAN, HAS_HOOKS or
 * UNSTABLE (`isImmediatelyMergeable`, cli/cli `pkg/cmd/pr/merge/merge.go`).
 * UNSTABLE is a non-passing status the check rule can miss, because that rule
 * ignores Ally verdict statuses by design, so dropping it here turns a hold
 * into an immediate merge past a red status. A test pins it.
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
    const key = `${context?.__typename ?? ""}\u0000${name}`;
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

/**
 * The rollup with every Ally verdict mirror removed, on BOTH surfaces.
 *
 * `isAllyVerdictStatus` alone is not enough: the gate now publishes a
 * `CheckRun` carrying the same name as the status, so typing on
 * `StatusContext` strips one copy and reads the other as CI. Measured on
 * #1957 @68f3f598 — `gate/ally-comment-findings` is `FAILURE` on both
 * surfaces, and 9 of the 10 open bot-authored PRs sampled carry the check-run
 * twin. It leaks into both rules: `failingChecks` sees a red required check,
 * and once the status copy is filtered the twin is the newest datable row, so
 * it resets the settle floor too (#1981).
 *
 * A check-run counts as a mirror only while a status of the same name sits
 * beside it in the same rollup — that twin is what proves it is a duplicate
 * reading rather than a real check. This is why the exclusion is not simply
 * untyped: a check-run that merely *starts with* `review/ally-` and has no
 * twin is still a genuine check, which is the reason `__typename` keying
 * exists at all.
 *
 * Direction if the status copy ever stops being published: the orphan
 * check-run is read as CI. A FAILURE orphan over-holds (`checks:FAILURE`); a
 * passing orphan (SUCCESS/NEUTRAL/SKIPPED) counts as a row attesting the head,
 * so the `checks:none` stop does not fire and classification falls through to
 * `review:*`, i.e. it can over-enqueue relative to a mirror-free rollup.
 * Measured at #1957 @7c4a8006: 0 of 14 open bot PRs carry an orphan today;
 * revisit this exclusion (name-only, independent of the twin) if the legacy
 * status is retired.
 */
export function withoutAllyVerdictMirrors(rollup) {
  const twins = new Set(
    (rollup ?? []).filter(isAllyVerdictStatus).map((c) => String(c?.context ?? "").trim()),
  );
  return (rollup ?? []).filter(
    (c) =>
      !isAllyVerdictStatus(c) &&
      !(c?.__typename === "CheckRun" && twins.has(String(c?.name ?? "").trim())),
  );
}

export function failingChecks(rollup) {
  return [...latestCheckStates(withoutAllyVerdictMirrors(rollup))]
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
 * The GitHub-documented CODEOWNERS locations, in GitHub's own precedence
 * order. The first file that exists is the only one that applies.
 */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** Files past this count mean GitHub truncated the diff listing, not that the PR is small. */
export const MAX_PR_FILES = 3000;

/**
 * `@login` -> `login`, `@org/team` -> `team:team`, so an owner token compares
 * directly against what `unsatisfiedOwners` builds from `reviewRequests`.
 * An email owner normalises to itself and simply never matches a request,
 * which is correct: an email in CODEOWNERS requests nobody.
 */
function normalizeOwner(owner) {
  const raw = String(owner ?? "").replace(/^@/, "");
  const slash = raw.indexOf("/");
  return slash === -1 ? raw : `team:${raw.slice(slash + 1)}`;
}

/**
 * Translates one CODEOWNERS pattern into an anchored RegExp.
 *
 * The syntax is gitignore's, and the two rules that matter here are the ones
 * the repo's own CODEOWNERS relies on and a naive glob gets wrong:
 *
 * - A pattern with NO slash matches at **any depth**. `package.json` owns
 *   `packages/adapters/acpx-local/package.json`, which is exactly why the
 *   checked-in file carries a comment saying so.
 * - A slash anywhere but the end anchors to the repo root. `scripts/release*.sh`
 *   does not reach `scripts/nested/release-x.sh`, because `*` stops at `/`.
 */
export function codeownersPatternToRegExp(pattern) {
  let body = String(pattern ?? "");
  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.slice(0, -1);
  const rooted = body.startsWith("/");
  if (rooted) body = body.slice(1);
  // A slash anywhere but the end still anchors; only a bare name floats.
  const anchored = rooted || body.includes("/");

  // Scanned rather than chain-replaced. A `.replace` pass that rewrites `*`
  // after having already emitted `.*` for `**` cannot tell its own output from
  // the input, and any lookbehind guarding against that also fires on a
  // legitimate `*` following an escaped literal dot.
  let source = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "*") {
      if (body[i + 1] === "*") {
        const atStart = i === 0;
        const slashBefore = body[i - 1] === "/";
        const slashAfter = body[i + 2] === "/";
        const atEnd = i + 2 === body.length;
        if (slashBefore && slashAfter) {
          // `a/**/b` spans zero or more whole segments. The `/` is already emitted.
          source += "(?:.+/)?";
          i += 2;
        } else if (slashBefore && atEnd) {
          source += ".*"; // `a/**` owns everything beneath `a/`
          i += 1;
        } else if (atStart && slashAfter) {
          source = "(?:.*/)?"; // `**/b` floats to any depth
          i += 2;
        } else {
          // gitignore: "other consecutive asterisks are considered regular
          // asterisks". `a**b` is therefore confined to one segment, where
          // `.*` would have crossed `/` and owned paths gitignore does not.
          source += "[^/]*";
          i += 1;
        }
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A directory pattern owns its contents; so does a bare name that turns out
  // to be a directory, which is why the non-`dirOnly` tail is optional.
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${source}${suffix}`);
}

/**
 * Drops the trailing comment from one CODEOWNERS line.
 *
 * A `#` escaped as `\#` is a literal `#` belonging to the pattern, not the
 * start of a comment, so a blanket `/#.*$/` strip truncates such a pattern
 * into a different -- and silently wider or narrower -- one.
 */
export function stripCodeownersComment(line) {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\" && line[i + 1] === "#") {
      out += "#"; // escaped, so it is part of the pattern
      i += 1;
      continue;
    }
    if (line[i] === "#") break;
    out += line[i];
  }
  return out.trim();
}

/**
 * Parses CODEOWNERS text into rules in file order. Callers must apply
 * LAST-match-wins, which is GitHub's precedence and the opposite of what a
 * `find`-style first-match loop does.
 */
export function parseCodeowners(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => stripCodeownersComment(line))
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields.length > 1)
    .map(([pattern, ...owners]) => ({
      pattern,
      matcher: codeownersPatternToRegExp(pattern),
      owners: owners.map(normalizeOwner).filter((owner) => owner.length > 0),
    }));
}

/**
 * The owner tokens CODEOWNERS assigns to `files`, lowercased.
 *
 * Last match wins PER FILE, then the per-file winners are unioned: a PR
 * touching two differently-owned paths owes both owners.
 */
export function ownersForFiles(files, rules) {
  const owners = new Set();
  for (const file of files ?? []) {
    const path = String(file ?? "");
    let winner = null;
    for (const rule of rules ?? []) if (rule.matcher.test(path)) winner = rule;
    for (const owner of winner?.owners ?? []) owners.add(lower(owner));
  }
  return owners;
}

/**
 * Owner tokens this PR's CURRENT diff actually owes, or `null` when that
 * cannot be determined.
 *
 * `null` is load-bearing and must stay distinguishable from the empty set.
 * This script's output is "merge it", so an unreadable CODEOWNERS or a
 * truncated file list has to fall back to the old, over-holding behaviour —
 * never to "nobody is owed", which would enqueue every held PR at once.
 */
export function impliedOwners(pr) {
  const rules = pr?.codeownerRules;
  const files = pr?.files;
  if (!Array.isArray(rules) || !Array.isArray(files)) return null;
  if (files.length >= MAX_PR_FILES) return null;
  return ownersForFiles(files, rules);
}

/**
 * Requested reviewers with no APPROVED review at the current head, scoped to
 * the ones CODEOWNERS still names for this PR's current file list.
 *
 * D7: GitHub does not enforce CODEOWNERS on this repo, so an outstanding owner
 * request is a real gate that only this script observes. A team request can
 * never be satisfied by a login match and so always counts as outstanding,
 * which is correct — a team has not reviewed until one of its members has.
 *
 * PEN-3474: `reviewRequests` on its own is the WRONG set to hold on, in two
 * measured ways, and both are permanent because nothing ever clears them.
 *
 * 1. **A request GitHub never withdraws.** GitHub auto-requests code owners
 *    when a PR opens and does NOT withdraw the request when a force-push takes
 *    the owned file back out of the diff. #3067 opened touching
 *    `.github/workflows/pr.yml`, was auto-requested to `@kkroo` two seconds
 *    later, then force-pushed down to one file that no rule matches — and this
 *    function still reported `kkroo`, so a green PR held forever on an owner
 *    who owns nothing in it. GraphQL's `asCodeOwner` does not see this either:
 *    it read `true` on #3067 at the same instant, because GitHub stamps it at
 *    request time and never recomputes it.
 * 2. **A request no review can satisfy.** The `allyblockcast` *User* seat
 *    (id 296676656) is a different principal from the `allyblockcast[bot]` App
 *    (id 290875700) that submits every review, so the login never matches; at
 *    the time of filing that pinned 70 of 124 open PRs. CODEOWNERS names only
 *    `@kkroo`, so such a request is not code-owner-derived and is now dropped
 *    by construction.
 *
 * This does NOT weaken a deliberate human hold, because a review request was
 * never the instrument for one: `SKIP_LABELS` and draft state are, both
 * machine-readable and both withdrawable by the human who set them.
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
  const outstanding = (pr?.reviewRequests ?? [])
    .map((request) =>
      request?.login ? String(request.login) : request?.slug ? `team:${request.slug}` : null,
    )
    .filter((who) => who !== null && !approved.has(lower(who)));

  const implied = impliedOwners(pr);
  if (implied === null) return outstanding;
  return outstanding.filter((who) => implied.has(lower(who)));
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
 * When the newest row in this rollup last reported, or `null` when nothing in
 * it carries a parseable timestamp.
 *
 * Shared by the settle floor below and by `judgeableAgeHours`, because the two
 * are the same clock read at opposite ends: the floor refuses a rollup that
 * reported too RECENTLY to be believed, and the stale-hold report names one
 * that has reported nothing SINCE, for long enough that the hold cannot still
 * be in flight. Deriving them from one function is what keeps "the moment this
 * head became judgeable" a single definition rather than two that drift.
 */
export function newestCheckStamp(rollup) {
  const stamps = (rollup ?? [])
    .map((c) => Date.parse(c?.completedAt || c?.startedAt || c?.createdAt || ""))
    .filter((at) => Number.isFinite(at));
  return stamps.length === 0 ? null : Math.max(...stamps);
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
  const newest = newestCheckStamp(rollup);
  if (newest === null) return { settled: true };
  const ageMinutes = (now - newest) / 60_000;
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
 * Timeline events that mean "the head moved", newest wins.
 *
 * `removed_from_merge_queue` carries `commit_id: null` (verified on #3089's
 * three merge-queue events, 2026-10-29), so an ejection cannot be attributed
 * to a sha directly. It has to be dated against the head instead, and these
 * are the events that date a head: `committed` for an ordinary push,
 * `head_ref_force_pushed` for a rebase or amend. Anything older than the
 * newest of them happened to a head that no longer exists.
 *
 * Returns `null` when the timeline carries neither — which is the unreadable
 * case, not the "head is infinitely old" case, and `ejectionsAtHead` treats it
 * as such.
 */
export function headMovedAt(timeline) {
  const stamps = (Array.isArray(timeline) ? timeline : [])
    .filter((event) => event?.event === "committed" || event?.event === "head_ref_force_pushed")
    // `committed` is a raw git object: it carries `committer.date`, not the
    // `created_at` every issue-event has. Reading only `created_at` would drop
    // every ordinary push and leave force-pushes as the sole clock.
    .map((event) => Date.parse(event?.created_at ?? event?.committer?.date ?? ""))
    .filter((ms) => Number.isFinite(ms));
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * How many times GitHub ejected this PR at its CURRENT head, and whether it is
 * sitting out of the queue right now.
 *
 * Counts only ejections newer than `headMovedAt`, which is what makes the hold
 * self-clearing: a push resets the count to zero with no state to store and
 * nothing to expire.
 *
 * ⚠ An ejection with NO datable head is counted. The alternative — ignore what
 * you cannot date — fails open into the re-enqueue loop this exists to stop,
 * on precisely the PRs whose timeline is odd. Over-counting costs a hold the
 * next push clears; under-counting costs every entry in the queue a rebuild.
 *
 * `requeued` is read separately from the count because the two answer
 * different questions: the count asks whether this head keeps failing, and
 * `requeued` asks whether acting now would double-enqueue. `classifyPr` needs
 * both — a PR already back in the queue is not a candidate whatever its count.
 */
export function ejectionsAtHead(timeline) {
  const events = (Array.isArray(timeline) ? timeline : []).filter(
    (event) =>
      event?.event === "removed_from_merge_queue" || event?.event === "added_to_merge_queue",
  );
  const movedAt = headMovedAt(timeline);
  const atHead = events.filter((event) => {
    if (movedAt === null) return true;
    const at = Date.parse(event?.created_at ?? "");
    return !Number.isFinite(at) || at >= movedAt;
  });
  const removals = atHead.filter((event) => event.event === "removed_from_merge_queue");
  const newest = (list) =>
    list.reduce((max, event) => {
      const at = Date.parse(event?.created_at ?? "");
      return Number.isFinite(at) && at > max ? at : max;
    }, -Infinity);
  const lastRemoved = newest(removals);
  const lastAdded = newest(atHead.filter((event) => event.event === "added_to_merge_queue"));
  return {
    count: removals.length,
    // Strictly greater, and the tie is broken toward the HOLD on purpose.
    // Timeline stamps have one-second resolution, so an add and a removal in
    // the same second are genuinely unordered — nothing here can tell which
    // happened first, and I have not measured which GitHub emits first. The
    // two directions are not symmetric: calling a tie `requeued` suppresses
    // the hold and re-enters the loop this rule exists to stop, while calling
    // it held costs one deferred enqueue that the next fire takes. Pinned by
    // the `same second` test; do not relax to `>=`.
    requeued: lastAdded > lastRemoved,
    lastRemovedAt: Number.isFinite(lastRemoved) ? lastRemoved : null,
  };
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

  // One filtered set for BOTH check rules. `failingChecks` strips the Ally
  // verdict mirrors on the stated grounds that they are not CI checks; handing
  // `checkSettlement` the raw rollup made the two rules disagree about what a
  // check is, in both directions. Fail-open: a rollup carrying only mirror rows
  // is non-empty, so the `checks:none` stop never fired on a head no CI had
  // attested. Fail-closed: `Math.max` over the unfiltered stamps let a mirror
  // row posted minutes ago reset the settle clock on CI that finished hours
  // ago — and since the normal ordering is CI -> review -> mirror, that fired
  // routinely.
  const checks = withoutAllyVerdictMirrors(pr?.statusCheckRollup);

  const failing = failingChecks(checks);
  if (failing.length > 0) {
    return row("skip", `checks:${failing[0].split("=")[1]}`, failing.join(", "));
  }

  const settlement = checkSettlement(checks, { now, settleMinutes });
  if (!settlement.settled) return row("skip", `checks:${settlement.reason}`, settlement.detail);

  const { verdict } = allyVerdictAtHead(pr);
  if (verdict !== "clean") return row("skip", `review:${verdict}`);

  const owners = unsatisfiedOwners(pr);
  if (owners.length > 0) {
    return row("codeowner-review-requested", "owner-approval-pending", owners.join(", "));
  }

  if (UNLANDABLE_MERGE_STATES.has(mergeState)) return row("skip", `mergestate:${mergeState}`);

  // LAST, and that position is the point. Every rule above reads the PR HEAD;
  // GitHub does not merge the PR head. On a REBASE/ALLGREEN queue it builds a
  // rebased queue head — a different commit — and that is the one whose
  // required `verify` decides. The two disagree systematically, and the PR
  // side is the one that looks green: when GitHub ejects, it deletes the
  // `gh-readonly-queue/...` branch, so the failing check runs stay attached to
  // a commit no PR-level query reaches and `mergeStateStatus` reverts to
  // CLEAN. After an ejection the PR reads not merely green but FRESHLY green.
  //
  // So this cannot be folded into the check rules above — there is nothing in
  // the rollup for them to see. Measured on #3089, 2026-10-29: `verify` was
  // `success` on PR head `d4f8aa38` and `failure` on queue head `15e7dcef` at
  // the same instant, and `classifyPr` returned `skip — checks:settling,
  // failing=[]` on a PR GitHub had ejected 20 minutes earlier. It re-enqueued
  // the unchanged head at 14:08:50Z, 21 minutes after a receipt on the PR had
  // named the failing jobs.
  //
  // ⚠ The repo already DETECTS this twice — `report-merge-queue-ejection.yml`
  // posted the failing job names at 13:48:01Z and
  // `merge-queue-eviction-detector.yml` posted "Cause: failing required check"
  // at 13:52:22Z, both correct and both on time. Neither was an input to the
  // enqueue decision. This rule is the wiring, not a new detector.
  const ejections = ejectionsAtHead(pr?.timeline);
  if (!ejections.requeued && ejections.count >= EJECTIONS_BEFORE_HOLD) {
    return row(
      "skip",
      "ejected-at-current-head",
      `GitHub ejected this head ${ejections.count}x; push a fix or rerun the queue build`,
    );
  }

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

/**
 * A `gh` failure that is specifically "this path does not exist".
 *
 * Deliberately narrow: `gh api` always spells the status as `(HTTP 404)`, and
 * a caller that falls through on anything looser would treat an outage as an
 * absence. Everything it cannot positively identify reads as unknown.
 */
export function isNotFoundGhError(message) {
  return /HTTP 404/i.test(String(message ?? ""));
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

/**
 * Hold reasons that are a deliberate "not this one" rather than a strand.
 *
 * A draft PR open for a fortnight, a `do-not-merge` label and a human-authored
 * PR are all states someone CHOSE, and the landing routine has no standing to
 * age them. Reporting them would also swamp the cohort: those three rows are
 * the common case on a busy repo, so a detector that counted them would be
 * read once and then ignored, which is the failure mode of every alarm that
 * fires on its own normal operation.
 *
 * `cap:` is here for that last reason rather than the first. It is not a
 * choice, it is `classifyAll` rewriting an over-budget `enqueue` into a skip —
 * a PR the NEXT fire takes. It ages like a strand because the budget is spent
 * on PRs whose CI finished more recently, so the deferred rows are precisely
 * the ones with the oldest check stamps. Aging it would fire this report
 * hardest exactly when the queue is deepest and the routine is working
 * normally.
 */
const DELIBERATE_HOLD_REASON_RE = /^(?:human-author|draft|label:|cap:)/;

/** Rows that are an action or a self-clearing wait, not a hold to be aged. */
const NON_HOLD_ACTIONS = new Set([
  "enqueue",
  "already-enqueued",
  // Has its own standing cohort (`reportRotted`) with its own semantics; aging
  // it here would report the same PR twice under two different names.
  "approval-rotted",
  // A wedged auto-merge request is already reported AS a staleness finding by
  // `classifyFromListing`, which has a better clock for it than this one: the
  // request's own `enabledAt`.
  "stale-enqueue",
]);

/**
 * Hours since this PR's head last became judgeable, or `null` when nothing
 * dates it.
 *
 * ## Why this clock and not the PR's age
 *
 * Creation time is the obvious choice and it is WRONG, in the direction that
 * costs most: it manufactures findings. Measured 2026-10-29 on
 * Blockcast/paperclip, #3089 and #3085 were 9.2h and 9.8h old against a
 * 2.2-6.8h create->merge spread, which reads as a flagrant strand. Both had
 * moved their heads that morning (08:05Z, 07:03Z) and their CI had finished
 * minutes before the measurement (09:27Z, 09:01Z) — they had been judgeable
 * for 2.3h and 2.7h, comfortably INSIDE the window, and both classified
 * `enqueue` at the next read. A creation clock names them; this one does not.
 *
 * That is not a tuning difference. A PR's age is the age of its oldest
 * abandoned attempt, and every push resets what the classifier is actually
 * looking at: the rollup, the review attestation and the merge state are all
 * properties of the CURRENT head. The honest question is "how long has this
 * verdict been available and unchanged", and the newest check stamp is the
 * only cheap answer to it — `checkSettlement` already computes it for the
 * settle floor, so this costs no extra API call.
 *
 * Uses the mirror-filtered rollup for the same reason `failingChecks` does: an
 * Ally verdict mirror posted after CI finished would otherwise reset this
 * clock on a hold that has not moved (the #1981 shape).
 */
export function judgeableAgeHours(pr, { now = Date.now() } = {}) {
  const newest = newestCheckStamp(withoutAllyVerdictMirrors(pr?.statusCheckRollup));
  return newest === null ? null : (now - newest) / 3_600_000;
}

/**
 * The held PRs whose hold has outlived the window in which this repo lands
 * anything, as `{ number, reason, ageHours }`.
 *
 * `ageHours` is `null` when the PR could not be dated, and such a row is
 * REPORTED rather than dropped. Dropping it is the §4l shape — an instrument
 * that cannot see something reporting clean — and the undatable case is
 * exactly the one worth hearing about, because a held PR whose rollup carries
 * no timestamp at all is a PR on which nothing ever ran.
 *
 * Takes both arrays rather than a field on the row because the row shape is
 * the receipt's contract and several callers deep-compare it; joining on
 * `number` keeps the classifier pure and this report additive.
 */
export function stalledHolds(prs, rows, { now = Date.now(), staleHours = STALE_HOLD_HOURS } = {}) {
  const byNumber = new Map((prs ?? []).map((pr) => [pr?.number, pr]));
  const held = [];
  for (const row of rows ?? []) {
    if (NON_HOLD_ACTIONS.has(row?.action)) continue;
    if (DELIBERATE_HOLD_REASON_RE.test(String(row?.reason ?? ""))) continue;
    const ageHours = judgeableAgeHours(byNumber.get(row?.number), { now });
    if (ageHours !== null && ageHours < staleHours) continue;
    held.push({ number: row?.number, reason: row?.reason, ageHours });
  }
  return held;
}

/** The stale-hold block for one repo's receipt, or "" when there is none. */
export function renderStalledHolds(repo, held, { staleHours = STALE_HOLD_HOURS } = {}) {
  if ((held ?? []).length === 0) return "";
  const line = ({ number, reason, ageHours }) =>
    `  ${repo}#${number} — \`${reason}\`, ` +
    (ageHours === null ? "age unknown (no dated check on this head)" : `${ageHours.toFixed(1)}h`);
  return (
    `stale-hold (judgeable >${staleHours}h, still held) — ${held.length}:\n` +
    held.map(line).join("\n") +
    "\nThe age is time since this head last reported, not time the hold has " +
    "stood — a hold acquired this fire on old CI still counts. Each row " +
    "already carries its reason above; what is new is that the reason has " +
    "stopped being a wait. Act on it or say why it stands."
  );
}

const PR_LIST_FIELDS =
  "number,headRefOid,author,labels,isDraft,autoMergeRequest,mergeStateStatus,reviewRequests";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The repo's CODEOWNERS rules, or `null` when none could be read.
 *
 * `null` must stay distinguishable from `[]`: a repo with no CODEOWNERS owes
 * nobody, while a repo whose CODEOWNERS could not be fetched is unknown, and
 * `impliedOwners` falls back to over-holding on the second. Reading it from
 * the DEFAULT branch rather than the PR head is deliberate — a PR must not be
 * able to edit its own ownership rules into a weaker hold.
 */
export function fetchCodeownerRules(repo, run = gh) {
  for (const path of CODEOWNERS_PATHS) {
    let response;
    try {
      response = JSON.parse(run(["api", `repos/${repo}/contents/${path}`]));
    } catch (error) {
      // ONLY "this location has no CODEOWNERS" may try the next one. A 5xx, a
      // 403 or a transport failure on a HIGHER-precedence path must not fall
      // through and silently adopt a lower-precedence file's rules, so
      // anything not positively identified as a 404 is unreadable => `null`.
      if (isNotFoundGhError(error?.stderr?.toString() || error?.message || String(error))) {
        continue;
      }
      return null;
    }
    const { content, encoding } = response ?? {};
    // A directory at this path answers with an array and no `content`; that is
    // not a CODEOWNERS file, so the next location still applies.
    if (typeof content !== "string") continue;
    // Blobs over 1 MB are not inlined: the API answers `content: ""` with
    // `encoding: "none"`. That decodes to `""` and parses to `[]` -- the
    // "measured, nobody is owed" value -- which would drop every outstanding
    // request and release every held PR at once. It is unread, not empty.
    if (encoding !== "base64") return null;
    return parseCodeowners(Buffer.from(content, "base64").toString("utf8"));
  }
  return null;
}

/** Changed paths for one PR, or `null` if the listing failed or GitHub truncated it. */
export function fetchPrFiles(repo, number, run = gh) {
  try {
    const files = JSON.parse(
      run(["api", `repos/${repo}/pulls/${number}/files`, "--paginate"]),
    ).map((file) => file?.filename);
    return files.length >= MAX_PR_FILES ? null : files;
  } catch {
    return null;
  }
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
  // One fetch per repo, not per PR: the rules are a property of the base branch.
  const codeownerRules = fetchCodeownerRules(repo);
  return rows.map((row) => {
    assertHeadSha(row, repo);
    if (classifyFromListing(row)) return row;
    return {
      ...row,
      codeownerRules,
      // Only PRs that actually carry a request can be scoped by ownership, so
      // the extra call is spent only where it can change a verdict.
      files: (row.reviewRequests ?? []).length > 0 ? fetchPrFiles(repo, row.number) : [],
      statusCheckRollup: JSON.parse(
        gh(["pr", "view", String(row.number), "--repo", repo, "--json", "statusCheckRollup"]),
      ).statusCheckRollup,
      reviews: JSON.parse(gh(["api", `repos/${repo}/pulls/${row.number}/reviews`, "--paginate"])),
      // The merge-queue ejection history, for the `ejected-at-current-head`
      // rule. Spent only on PRs that already survived `classifyFromListing`,
      // i.e. the ones that could still enqueue — on this repo a handful of the
      // open set, each already paying three calls.
      //
      // ⛔ `--paginate` is load-bearing. GitHub's default page size is 30 and
      // the events this reads are the NEWEST on the timeline, so a single-page
      // fetch drops exactly them on any PR with a normal amount of discussion
      // and reports `count: 0` — a confident all-clear, in the fail-open
      // direction.
      timeline: JSON.parse(
        gh(["api", `repos/${repo}/issues/${row.number}/timeline`, "--paginate"]),
      ),
    };
  });
}

/** Posts `body` unless a comment carrying `marker` is already on the PR. */
function commentOnce(repo, number, marker, body, run = gh) {
  const existing = JSON.parse(
    run(["api", `repos/${repo}/issues/${number}/comments`, "--paginate"]),
  );
  if (existing.some((comment) => String(comment?.body ?? "").includes(marker))) return "already-posted";
  run(["pr", "comment", String(number), "--repo", repo, "--body", `${marker}\n${body}`]);
  return "posted";
}

/**
 * The head SHA this PR carries RIGHT NOW, read at apply time.
 *
 * PEN-4887: `fetchOpenPrs` snapshots every open PR once per fire, and a head
 * can move between that snapshot and the enqueue. The case that made this
 * expensive is not a rare race — it is the deterministic consequence of
 * landing a STACKED child PR: merging the child into the parent's branch
 * replaces the parent's head with the merge commit, on which nothing has run
 * yet. Measured on Blockcast/paperclip#3060 (2026-10-28): head moved at
 * 07:46:13Z, enqueued at 07:46:17Z, ejected by the queue at 07:46:27Z, while
 * `ci/ally-head-attested` did not succeed until 07:48:37Z — 2m10s after the
 * removal, with `policy` gating the heavy matrix behind it for ~6 minutes more.
 *
 * Every gate in `classifyPr` — the settle floor, `checks:none`, the Ally
 * verdict at head, the owner set — was evaluated against the OLD head and says
 * nothing about the new one. Re-reading the SHA is what makes those verdicts
 * mean what the receipt claims they mean.
 *
 * `--auto` is not a substitute. On a queue-enabled base GitHub enqueues
 * immediately whenever it believes the requirements are met, and right after a
 * head moves that belief is briefly stale: #3060 carries an
 * `added_to_merge_queue` event with no `auto_merge_enabled` beside it.
 */
export function liveHeadSha(repo, number, run = gh) {
  const raw = JSON.parse(
    run(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid"]),
  )?.headRefOid;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : String(sha));

/**
 * `--rebase` is mandatory, not cosmetic. `gh pr merge --auto` only infers a
 * merge method when the PR's BASE BRANCH has a merge queue — `isMergeQueueEnabled`
 * is a property of the base ref, not of this PR's mergeability. A PR stacked on
 * a feature branch therefore falls back to classic auto-merge, and with all
 * three merge methods enabled on this repo `gh` refuses non-interactively with
 * "--merge, --rebase, or --squash required". That refusal landed in `detail`
 * while the row still reported `enqueue`, so #2020 read as enqueued across 9
 * consecutive fires having armed nothing (BLO-36804).
 *
 * Safe on the queue path: measured 2026-09-26 against a queue-enabled base, `gh`
 * prints "The merge strategy for master is set by the merge queue", exits 0, and
 * the queue's own REBASE wins — the flag is discarded, not honoured. So this
 * cannot change what already-working rows do. `--rebase` names that same method
 * and keeps stacked branches free of merge commits, which is what keeps them
 * rebaseable for the queue later (BLO-22300).
 *
 * NECESSARY BUT NOT SUFFICIENT, and deliberately so. Past `gh`'s client-side
 * check, GitHub still refuses auto-merge on a base with no protection rules:
 * "Protected branch rules not configured for this branch
 * (enablePullRequestAutoMerge)", measured the same day on #1906. Such a PR is
 * unenqueueable however clean it is. The classifier does NOT try to predict
 * that — whether a base is protected, queue-enabled, or neither is per-repo
 * server state, and this script is about to sweep repos whose default branch is
 * not even `master` (multicast is `main`). Modelling it here would mean a wrong
 * model silently skipping a whole repo, which is worse than the bug being fixed.
 * GitHub is the authority; we attempt, it rules, and `markFailure` puts the
 * verdict in the receipt's action column where it is visible.
 *
 * ## `--auto` does not always mean auto
 *
 * `gh` drops the auto-merge request and performs an IMMEDIATE merge when the PR
 * is already mergeable and the base has no queue to wait for — `--auto` is a
 * request to wait for gates, and a PR with no outstanding gates has nothing to
 * wait for. Measured 2026-09-26: this exact call landed #2020 on the spot,
 * `parents=1`, no `auto_merge_enabled` event. Supplying the method therefore
 * converts a permanently-failing no-op into a real merge for clean PRs on
 * unprotected bases.
 *
 * That is accepted on purpose: on such a base there is no queue to land through,
 * so merging IS landing, and this classifier is the gate — Ally clean at head,
 * every check green, owner approvals satisfied, mergestate CLEAN, capped at
 * MAX_ENQUEUES_PER_FIRE per fire. A queue-enabled base is unaffected, because
 * the queue path is chosen before the mergeability test. But the outcome string
 * must not claim "armed" for a merge that already happened — this whole defect
 * was a receipt reporting an action it had not taken.
 *
 * ponytail: that costs one doomed call per stacked PR per fire on an
 * unprotected base. Acceptable because it self-heals the moment the base is
 * protected or the PR is retargeted, and it needs no per-repo config. If the
 * noise ever matters, skip rows whose base is unprotected — one
 * `gh api repos/{repo}/branches/{base}` per distinct base, not per PR.
 */
export function applyRow(repo, row, run = gh) {
  if (row.action === "enqueue") {
    // PEN-4887: fail CLOSED on anything but a proven-unchanged head. An
    // unreadable or absent SHA is not permission to enqueue — it means we
    // cannot show the classification still applies, and the row simply
    // re-classifies on the next fire. The throw is caught by `runRepo` and
    // recorded as `enqueue-failed`, which is both visible in the receipt and
    // correctly excluded from the per-fire cap: no queue slot was spent.
    const live = liveHeadSha(repo, row.number, run);
    if (!row.headSha || !live || live !== row.headSha) {
      throw new Error(
        `head moved since classification (${short(row.headSha)} -> ${short(live)}); not enqueued — ` +
          "every check and review verdict in this row describes the previous head",
      );
    }
    // Ally review, 2nd pass: the re-read above narrows the window but is still
    // check-then-act — the head can move between `pr view` and `pr merge`.
    // `--match-head-commit` closes it on GitHub's side: the request carries the
    // SHA every gate in this row was evaluated against, and GitHub refuses the
    // merge outright if the head no longer matches. The re-read is kept in
    // front of it rather than replaced, because it is what produces the
    // attributable `enqueue-failed` message naming both SHAs; this flag's
    // refusal surfaces as a generic `gh` failure, which is the right backstop
    // but the poorer receipt.
    //
    // Verified against the live API on #3063 (2026-10-28) with a deliberately
    // non-matching SHA: GitHub answered `expected head oid does not match the
    // current head oid (enablePullRequestAutoMerge)` and auto-merge was NOT
    // armed. So the flag composes with `--auto` and is enforced server-side on
    // the auto-merge path, not just on an immediate merge.
    run([
      "pr", "merge", String(row.number), "--repo", repo,
      "--auto", "--rebase", "--match-head-commit", row.headSha,
    ]);
    // Deliberately not "armed": this call queues, arms, or merges outright
    // depending on the base, and the receipt must not name the one it guessed.
    return "merge requested";
  }
  if (row.action === "stale-enqueue") {
    run(["pr", "merge", String(row.number), "--repo", repo, "--disable-auto"]);
    return commentOnce(
      repo,
      row.number,
      STALE_ENQUEUE_MARKER,
      `Auto-merge had been armed for over ${STALE_ENQUEUE_HOURS}h without landing, so the landing ` +
        `routine disarmed it. It will re-arm on the next fire once this PR classifies clean.`,
      run,
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
      run,
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

/**
 * Records a non-fatal apply failure in the `action` column, not just `detail`.
 * `renderReceipt` tallies by action, so a failure left only in free text is
 * invisible to the summary line — which is how #2020 reported `enqueue` for 25
 * hours while arming nothing.
 *
 * Renaming the action also drops the row out of `sweepRepos`'s `spent` tally,
 * which counts `enqueue` rows against the per-fire cap. That is the wanted
 * reading: a failed enqueue consumed no queue slot.
 */
export function markFailure(row, message) {
  row.action = `${row.action}-failed`;
  row.detail = [row.detail, `failed: ${String(message).trim().split("\n")[0]}`]
    .filter(Boolean)
    .join(" — ");
  return row;
}

function runRepo(repo, apply, settleMinutes, spent, rotted) {
  const prs = fetchOpenPrs(repo);
  const rows = classifyAll(prs, { settleMinutes, spent });

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
      markFailure(row, message);
    }
  }

  // After the apply loop, so a row this fire just enqueued (or just renamed to
  // `enqueue-failed`) is aged on what it ENDED as, not on the classification
  // it entered with.
  const stalled = renderStalledHolds(repo, stalledHolds(prs, rows));
  console.log(`## ${repo}\n\n${renderReceipt(rows)}${stalled ? `\n\n${stalled}` : ""}`);
  return rows;
}

/**
 * Runs each repo with the enqueues already spent this fire, so the cap is per
 * fire (see MAX_ENQUEUES_PER_FIRE). Only rows still reading `enqueue` after
 * apply are spent; `enqueue-failed` is not. Extracted from `main` so the carry
 * and that reading are tested directly rather than by a copy of the loop.
 */
export function sweepRepos(repos, runOne) {
  let spent = 0;
  for (const repo of repos) {
    const rows = runOne(repo, spent);
    spent += rows.filter((row) => row.action === "enqueue").length;
  }
  return spent;
}

/**
 * `main`'s per-repo step for `sweepRepos`: hands the carried spend to
 * `runRepo`. Hoisted so a test can pin that carry (a literal `0` here makes
 * the cap per repo again) without running `main`. `run` is a test seam.
 */
export const repoRunner =
  (apply, settleMinutes, rotted, run = runRepo) =>
  (repo, spent) => {
    const rows = run(repo, apply, settleMinutes, spent, rotted);
    console.log("");
    return rows;
  };

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

  // `finally`, because the cohort is the expensive half of the output and the
  // likeliest thrower is `fetchOpenPrs` — outside `runRepo`'s try, one list
  // call plus two per undecided PR, multiplied by the repo count, and in a dry
  // run the only `gh` traffic there is. The explicit call before `process.exit`
  // in `runRepo` stays: `exit` does not unwind, so this block never runs there.
  try {
    sweepRepos(targetRepos(), repoRunner(apply, settleMinutes, rotted));
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
