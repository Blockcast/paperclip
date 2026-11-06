#!/usr/bin/env node

/**
 * Census: no merged PR carries a green commit status that admits nothing
 * reviewed the head (BLO-29711, PEN-5781).
 *
 * WHY THIS IS NOT SCOPED TO `review/*` ANY MORE (PEN-5781).
 *
 * It was, and that scoping silently voided the census. BLO-33657's mitigation
 * for this very defect was to move the live context OUT of the `review/`
 * namespace — it is `gate/ally-comment-findings` on the Blockcast deployment,
 * and as of 2026-11-06 it is the SOLE ruleset-required status context on
 * `master` (ruleset 25827389). A namespace filter keyed on `review/` cannot
 * see it. The detector for the defect was blinded by the mitigation for the
 * defect, and nothing failed, because a census that matches nothing passes.
 *
 * Measured 2026-11-06 over the 12 most recently merged PRs: the `review/`-only
 * predicate found 10 violations, ALL of them the retired mirror, and ZERO on
 * the required context. So the scoping did not merely narrow the census — it
 * pointed it exclusively at the row that gates nothing.
 *
 * The general rule this encodes: a rename-based mitigation voids every detector
 * keyed on the old name, so this predicate is keyed on WORDING THIS GATE OWNS
 * rather than on what the context is called. A future rename changes which
 * bucket a row lands in, never whether it is seen.
 *
 * `review/ally-comment` is written by the comment-shaped review gate in
 * `server/src/services/pr-comment-review-gate.ts`. That gate is fail-open by
 * construction and deliberately so: it observes only the comment surface, so a
 * PR reviewed via a formal `pull_request_review` legitimately has no comment to
 * find, and reporting `pending`/`failure` on absence would deadlock every
 * formally-reviewed PR. The defect this census guards is narrower — the
 * fail-open verdict is published as a green whose own description says the
 * opposite — under the `review/` namespace, where the name itself reads as
 * "reviewed and clean", and on the required context, where the green is what
 * the merge queue consumes.
 *
 * Why this reads status HISTORY rather than current status. GitHub commit
 * statuses are mutable after merge, and the combined-status endpoint returns
 * only the newest write per context. Measured 2026-08-22 on
 * Blockcast/penstock-llm-proxy-core: #1473 merged at 02:46:06Z and took its
 * first-ever `review/ally-complete` write at 02:46:07Z; #1390 took one at +6s.
 * A `success` landing seconds after an admin merge silently converts a
 * violation into a clean row, so a census over current status is biased toward
 * passing the later it runs. This one takes the latest write with
 * `updated_at <= mergedAt` from `repos/{o}/{r}/statuses/{sha}`, which is
 * deterministic and reconstructible after the fact.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "Blockcast/penstock-llm-proxy-core";
const DEFAULT_PR_LIMIT = 60;

/**
 * Contexts this gate publishes its live verdict to.
 *
 * This is a PINNED MIRROR of deployment config, not a derivation: the live
 * context comes from `PAPERCLIP_PR_COMMENT_REVIEW_GATE_STATUS_CONTEXT`, which
 * has no in-repo default, so the census cannot read it. That is precisely the
 * coupling that broke last time, so it is NOT load-bearing for detection —
 * `classifyAuditedContext` falls back to `unclassified` rather than to
 * silence, and an unclassified row is still a violation. This list only
 * decides which bucket a row is REPORTED in, and therefore which remedy the
 * reader is pointed at.
 */
const DEFAULT_GATE_CONTEXTS = ["gate/ally-comment-findings"];

export function parseGateContexts(raw, fallback = DEFAULT_GATE_CONTEXTS) {
  const parsed = String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return new Set(parsed.length > 0 ? parsed : fallback.map((entry) => entry.toLowerCase()));
}

/**
 * Descriptions the gate emits when it established no review of the head.
 *
 * Every alternative quotes a sentence `pr-comment-review-gate.ts` owns, long
 * enough to be unique to it. This predicate runs against EVERY green
 * `review/`-namespaced status on a merged PR, not only this gate's context, so
 * a short generic substring couples the census to any wording another repo's
 * review script happens to use. The shorter the alternative, the more of the
 * org it silently claims.
 *
 * `independent` is optional inside the first alternative — one alternative,
 * not two — because exactly two sites render that sentence and they disagree
 * on the qualifier: the unqualified fallback reason in `verdict` ("No Ally
 * consolidated-review comment attests to reviewing this head.") and the
 * qualified retirement wording in `commentReviewGateRetirementDescription`
 * ("Retired. No independent Ally consolidated-review comment attests this
 * head; …"). It is NOT what catches a self-attested head: that renders "The
 * only comment attesting this head is the PR author's own", which this
 * alternative never matches and the PR-author alternative does.
 *
 * `attesting this head is a plain issue comment` is the PEN-4431 sibling of
 * that PR-author alternative: a head whose only attestation arrived on the
 * issue-comment surface rather than as a review submission. It is a fourth
 * distinct `not_evaluated` description, and like the others it is quoted long
 * enough to be unique to this gate. Adding a `not_evaluated` reason WITHOUT
 * adding its alternative here is silent — the census simply stops seeing that
 * population — which is why `pr-comment-review-gate.test.ts` pins each one
 * against this predicate rather than against a copy of it.
 *
 * Two alternatives quote the gate's sentence in full rather than its opening
 * clause, and that length is load-bearing (PEN-5565). The predicate used to
 * read `no head SHA was supplied` and `The PR author is unknown` — the two
 * shortest alternatives, and both generic enough that another team's status
 * could say them by coincidence. That was tolerable only while this predicate
 * was confined to the `review/` namespace. It no longer is: PEN-5781 widened
 * the audit to every namespace, so a foreign green borrowing either phrase now
 * lands in `unclassified`, the bucket whose whole purpose is to shout RENAME.
 * A false rename alarm on a job that reds is worse than a missed row, because
 * it is the alarm nobody can act on and therefore the one that gets muted.
 *
 * Lengthening costs no coverage. `No head SHA was supplied to evaluate
 * against.` and `The PR author is unknown, so this head's attestation cannot
 * be shown to be independent.` are what `pr-comment-review-gate.ts` posts
 * verbatim (`description: verdict.reason`), at 45 and 87 characters against
 * the 140-character commit-status cap, so neither is ever truncated into the
 * short form. Measured 2026-11-06 over 1,876 statuses on 544 pull requests in
 * `paperclip`, `onprem-k8s` and `penstock-llm-proxy-core`: the old and new
 * predicates match the same 724 rows, nothing lost and nothing gained, and
 * NEITHER short fragment appears in a single live status — both branches are
 * ones this gate almost never reaches. The long forms are strictly narrower on
 * foreign wording and identical on our own.
 */
const NOT_EVALUATED_DESCRIPTION_PATTERN =
  /no (?:independent )?Ally consolidated-review comment attests|No head SHA was supplied to evaluate against|attesting this head is the PR author's own|attesting this head is a plain issue comment|this head's attestation cannot be shown to be independent/i;

/**
 * Retained as the BLO-29711 assertion point. It no longer ADMITS a row — it
 * classifies one. Keeping it exported keeps the "a green under `review/` reads
 * as reviewed-and-clean" claim pinned by its own test, so a future change
 * cannot quietly decide that namespace stopped mattering.
 */
export function isReviewNamespacedContext(context) {
  return typeof context === "string" && context.trim().toLowerCase().startsWith("review/");
}

/**
 * Which population a violating row belongs to. The two must never be summed
 * into one number: they are different defects with different owners.
 *
 *   `required-gate`     The context the merge queue actually requires was green
 *                       on a non-evaluation. This is the merge-authorising
 *                       failure (PEN-5565, PEN-5485).
 *
 *   `review-namespace`  A `review/`-namespaced green claims more than the gate
 *                       knows (BLO-29711). On today's deployment this is the
 *                       retirement row, which MIRRORS the live verdict by
 *                       construction (`commentReviewGateRetirementStatus`) — so
 *                       it is a second VIEW of the same PR's verdict, not a
 *                       second PR in trouble. It stays a violation, deliberately:
 *                       BLO-34742 worded the not-evaluated retirement to trip
 *                       this pattern on the reasoning that "the retired mirror
 *                       of a not-evaluated verdict always was one".
 *
 *   `unclassified`      Green, and carrying wording only this gate emits, under
 *                       a name in neither set. Overwhelmingly likely to be a
 *                       rename — the exact event that blinded this census once
 *                       already. Still a violation (the row is real whatever it
 *                       is called); reported separately so the remedy named is
 *                       "update DEFAULT_GATE_CONTEXTS", not "go fix the gate".
 */
export function classifyAuditedContext(context, gateContexts = parseGateContexts(null)) {
  const normalized = typeof context === "string" ? context.trim().toLowerCase() : "";
  if (gateContexts.has(normalized)) return "required-gate";
  if (isReviewNamespacedContext(context)) return "review-namespace";
  return "unclassified";
}

export function admitsNothingEvaluated(description) {
  return typeof description === "string" && NOT_EVALUATED_DESCRIPTION_PATTERN.test(description);
}

/**
 * Latest write per context that GitHub had recorded at or before `mergedAt`.
 * A write with an unparseable or later timestamp is not what the merge saw.
 */
export function statusesAsOfMerge(statuses, mergedAt) {
  const mergedAtMs = Date.parse(mergedAt);
  if (!Number.isFinite(mergedAtMs)) {
    throw new Error(`Unparseable mergedAt: ${JSON.stringify(mergedAt)}`);
  }

  const latestByContext = new Map();
  for (const status of statuses ?? []) {
    const updatedAtMs = Date.parse(status?.updated_at ?? status?.created_at);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs > mergedAtMs) continue;

    const previous = latestByContext.get(status.context);
    if (!previous || updatedAtMs >= previous.updatedAtMs) {
      latestByContext.set(status.context, { status, updatedAtMs });
    }
  }
  return Array.from(latestByContext.values(), (entry) => entry.status);
}

export function findPrViolations(pr, gateContexts = parseGateContexts(null)) {
  const asOfMerge = statusesAsOfMerge(pr.statuses, pr.mergedAt);
  const violations = [];

  for (const status of asOfMerge) {
    // Admission is on STATE and WORDING only. The context name decides which
    // bucket this lands in, never whether it is looked at — see the header.
    if (status.state !== "success") continue;
    if (!admitsNothingEvaluated(status.description)) continue;

    const surface = classifyAuditedContext(status.context, gateContexts);
    violations.push({
      number: pr.number,
      headSha: pr.headRefOid,
      context: status.context,
      description: status.description,
      surface,
      detail:
        `[${surface}] #${pr.number} ${status.context} was green at merge while admitting ` +
        `nothing attested ${String(pr.headRefOid).slice(0, 7)}: "${status.description}"`,
    });
  }
  return violations;
}

export function findViolations(prs, gateContexts = parseGateContexts(null)) {
  return (prs ?? []).flatMap((pr) => findPrViolations(pr, gateContexts));
}

/**
 * Per-surface PR counts. Deliberately NOT a row count and deliberately not a
 * single total: one PR routinely contributes a `required-gate` row and its
 * `review-namespace` mirror, so summing the buckets double-counts every PR and
 * reports twice the trouble that exists.
 */
export function violationsBySurface(violations) {
  const bySurface = new Map();
  for (const violation of violations ?? []) {
    const bucket = bySurface.get(violation.surface) ?? { rows: 0, prs: new Set() };
    bucket.rows += 1;
    bucket.prs.add(violation.number);
    bySurface.set(violation.surface, bucket);
  }
  return bySurface;
}

/**
 * Distinct PRs behind a violation list. The per-row `VIOLATION:` lines are the
 * detail; the headline is reported as "N of M merged PRs", so it has to count
 * PRs. One PR can contribute several rows — on today's deployment a
 * not-evaluated verdict emits BOTH the live `required-gate` row and its
 * `review-namespace` retirement mirror, and every retired context takes its own
 * retirement write — so a row count can exceed M and read as more PRs than
 * exist. `violationsBySurface` is the per-surface counterpart, and it counts
 * PRs per bucket for the same reason rather than summing them.
 */
export function violatingPrCount(violations) {
  return new Set((violations ?? []).map((violation) => violation.number)).size;
}

/**
 * Machine-readable verdict, for a caller that must act on ONE surface rather
 * than on the total.
 *
 * The scheduled job needs exactly this: the `required-gate` and
 * `review-namespace` populations are a known-open defect (PEN-5565), so a job
 * that redded on the total would be born permanently red and could never
 * signal anything new — the PEN-2847 failure this repo already carries on three
 * other guards. `unclassified` is the opposite: it means a RENAME has moved the
 * gate out from under this census again, which is actionable the day it
 * happens. Separating them in the data is what lets the job red on one and
 * merely report the other.
 */
export function summarizeViolations(violations, prsExamined) {
  const surfaces = {};
  for (const [surface, bucket] of violationsBySurface(violations)) {
    surfaces[surface] = { prs: bucket.prs.size, rows: bucket.rows };
  }
  return {
    prsExamined,
    violatingPrs: violatingPrCount(violations),
    surfaces,
    unclassifiedPrs: surfaces.unclassified?.prs ?? 0,
  };
}

function gh(args) {
  const stdout = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function fetchMergedPrs(repo, limit) {
  const rows = gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--limit",
    String(limit),
    "--json",
    "number,headRefOid,mergedAt",
  ]);

  return rows.map((row) => {
    if (!row.mergedAt) throw new Error(`#${row.number} is listed as merged with no mergedAt`);
    if (!/^[0-9a-f]{40}$/i.test(row.headRefOid ?? "")) {
      throw new Error(`#${row.number} has no usable headRefOid`);
    }
    // Full write history, not the collapsed combined status.
    const statuses = gh(["api", "--paginate", `repos/${repo}/statuses/${row.headRefOid}`]);
    return { ...row, statuses };
  });
}

const SURFACE_EXPLANATIONS = {
  "required-gate":
    "the context the merge queue REQUIRES was green on a non-evaluation, so the merge was " +
    "authorised by a check that admits it checked nothing (PEN-5565, PEN-5485)",
  "review-namespace":
    "a review/-namespaced green reads as \"reviewed and clean\" while its own description says " +
    "otherwise (BLO-29711). On today's deployment these mirror the required-gate row above " +
    "rather than being separate PRs in trouble",
  unclassified:
    "green, carrying wording only this gate emits, under a context in neither audited set — " +
    "almost certainly a RENAME, which is what blinded this census before (PEN-5781). If the " +
    "gate moved, add the new context to DEFAULT_GATE_CONTEXTS or set CENSUS_GATE_CONTEXTS",
};

function main() {
  const repo = process.env.CENSUS_REPO || DEFAULT_REPO;
  const limit = Number(process.env.CENSUS_PR_LIMIT || DEFAULT_PR_LIMIT);
  const gateContexts = parseGateContexts(process.env.CENSUS_GATE_CONTEXTS);

  const prs = fetchMergedPrs(repo, limit);
  const violations = findViolations(prs, gateContexts);

  const summaryPath = (process.env.CENSUS_SUMMARY_PATH ?? "").trim();
  if (summaryPath) {
    writeFileSync(summaryPath, `${JSON.stringify(summarizeViolations(violations, prs.length), null, 2)}\n`);
  }

  for (const violation of violations) console.error(`VIOLATION: ${violation.detail}`);

  if (violations.length > 0) {
    console.error(
      `\n${violatingPrCount(violations)} of ${prs.length} merged PRs in ${repo} carried a green ` +
        "status that admitted nothing evaluated the head.",
    );
    // Per surface, never summed. See violationsBySurface.
    for (const [surface, bucket] of violationsBySurface(violations)) {
      console.error(
        `  ${surface}: ${bucket.prs.size} of ${prs.length} PRs (${bucket.rows} rows) — ` +
          `${SURFACE_EXPLANATIONS[surface] ?? "unrecognized surface"}.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `OK: ${prs.length} merged PRs in ${repo} carry no fail-open green status. Audited gate ` +
      `contexts: ${[...gateContexts].join(", ")}.`,
  );
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) main();
