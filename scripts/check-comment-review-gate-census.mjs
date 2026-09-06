#!/usr/bin/env node

/**
 * Census: no merged PR carries a green `review/*` status that admits nothing
 * reviewed the head (BLO-29711).
 *
 * `review/ally-comment` is written by the comment-shaped review gate in
 * `server/src/services/pr-comment-review-gate.ts`. That gate is fail-open by
 * construction and deliberately so: it observes only the comment surface, so a
 * PR reviewed via a formal `pull_request_review` legitimately has no comment to
 * find, and reporting `pending`/`failure` on absence would deadlock every
 * formally-reviewed PR. The defect this census guards is narrower — the
 * fail-open verdict is published under the `review/` namespace, where a green
 * reads as "reviewed and clean" while its own description says the opposite.
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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "Blockcast/penstock-llm-proxy-core";
const DEFAULT_PR_LIMIT = 60;

/** Descriptions the gate emits when it established no review of the head. */
const NOT_EVALUATED_DESCRIPTION_PATTERN =
  /no Ally consolidated-review comment attests|no head SHA was supplied/i;

export function isReviewNamespacedContext(context) {
  return typeof context === "string" && context.trim().toLowerCase().startsWith("review/");
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

export function findPrViolations(pr) {
  const asOfMerge = statusesAsOfMerge(pr.statuses, pr.mergedAt);
  const violations = [];

  for (const status of asOfMerge) {
    if (!isReviewNamespacedContext(status.context)) continue;
    if (status.state !== "success") continue;
    if (!admitsNothingEvaluated(status.description)) continue;

    violations.push({
      number: pr.number,
      headSha: pr.headRefOid,
      context: status.context,
      description: status.description,
      detail:
        `#${pr.number} ${status.context} was green at merge while admitting ` +
        `nothing attested ${String(pr.headRefOid).slice(0, 7)}: "${status.description}"`,
    });
  }
  return violations;
}

export function findViolations(prs) {
  return (prs ?? []).flatMap((pr) => findPrViolations(pr));
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

function main() {
  const repo = process.env.CENSUS_REPO || DEFAULT_REPO;
  const limit = Number(process.env.CENSUS_PR_LIMIT || DEFAULT_PR_LIMIT);

  const prs = fetchMergedPrs(repo, limit);
  const violations = findViolations(prs);

  for (const violation of violations) console.error(`VIOLATION: ${violation.detail}`);

  if (violations.length > 0) {
    console.error(
      `\n${violations.length} of ${prs.length} merged PRs in ${repo} carried a green review/* ` +
        "status that admitted nothing evaluated the head.",
    );
    process.exit(1);
  }
  console.log(`OK: ${prs.length} merged PRs in ${repo} carry no fail-open green review/* status.`);
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) main();
