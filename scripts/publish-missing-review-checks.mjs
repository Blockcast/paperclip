#!/usr/bin/env node
/**
 * Publish one `review/verdict-present` check-run per head that the PEN-6352
 * sweep found to be missing its verdict.
 *
 * Two deliberate choices, both of which a reviewer should be able to challenge
 * on their own terms:
 *
 * 1. NOT published under the watched gate's own name. Two writers of one check
 *    name is how a sweep row ends up masking a real verdict under the
 *    latest-per-name collapse every merge gate performs. The absence is
 *    reported BESIDE the gate, never in place of it.
 *
 * 2. Conclusion is `neutral`, not `failure`. This is a DETECTION signal, and
 *    the automated lander declines to land a PR carrying a red at its head. A
 *    detector that published red would convert "nobody measured this" into
 *    "this pull request cannot land" -- inventing blockage across every head it
 *    touches at a stroke, which is strictly worse than the silence it replaces.
 *    `neutral` is visibly not-green to a reader and is inert to every gate.
 *
 * 3. The row is RETIRED, not merely stopped. A check-run does not expire: the
 *    `neutral` row posted while the verdict was absent stays at that SHA
 *    forever, and once the real verdict arrives every latest-per-name reader
 *    sees it sitting beside a green `review` and reads the head as unproven.
 *    "We stop publishing new rows" is not the same as "the old row stops being
 *    read", and the difference is stale false evidence aimed squarely at the
 *    readers this exists to serve. So the sweep reports `resolutions` and we
 *    post a `success` row under the SAME NAME, which supersedes the finding
 *    under the same collapse the readers already perform. A head that is still
 *    carrying an open finding is skipped rather than re-posted, so one head
 *    cannot accumulate one row per hour.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { SELF_CHECK_NAME } from "./sweep-missing-review.mjs";

export const CHECK_NAME = SELF_CHECK_NAME;

export function buildCheckRun(finding, report) {
  return {
    name: CHECK_NAME,
    head_sha: finding.head,
    status: "completed",
    conclusion: "neutral",
    output: {
      title: `NOT MEASURED: no \`${report.checkName}\` check-run at this head`,
      summary: [
        `The \`${report.checkName}\` gate published no check-run for \`${finding.head.slice(0, 8)}\`,` +
          ` while ${finding.checkNamesPresent} other checks did report there.`,
        "",
        "A `startup_failure` of `commitperclip PR Review` creates no job, no annotation and no" +
          " check-run, so the verdict is ABSENT rather than red and an enumeration of this head looks" +
          " complete. See PEN-6352.",
        "",
        "**Re-trigger:** edit this pull request's body or title. `edited` is a declared trigger of the" +
          " gate, so it re-runs without moving the head — unlike a push, which voids in-flight reviews" +
          " and re-burns the green check set.",
        "",
        "Re-running the failed run is not available: `POST /actions/runs/:id/rerun` answers `403 This" +
          " workflow run cannot be retried` for a `startup_failure`.",
        "",
        "This row is `neutral` on purpose — it reports that nothing measured this head and must not" +
          " itself block the pull request. When the verdict arrives, the next sweep supersedes this row" +
          " with a `success` one under this same name, so a latest-per-name reader stops seeing it.",
      ].join("\n"),
    },
  };
}

/**
 * Supersede a standing finding once the watched verdict is present.
 *
 * Published under the SAME name on purpose: that is what makes it supersede
 * rather than accompany. Every merge gate and reader collapses a head's checks
 * latest-per-name, so a newer `success` under this name is what actually
 * retires the `neutral` one. A differently-named row would leave the stale
 * finding standing and add a second thing to read.
 */
export function buildResolvedCheckRun(resolution, report) {
  return {
    name: CHECK_NAME,
    head_sha: resolution.head,
    status: "completed",
    conclusion: "success",
    output: {
      title: `\`${report.checkName}\` verdict is present at this head`,
      summary: [
        `A \`${report.checkName}\` check-run is now reported for \`${resolution.head.slice(0, 8)}\`.`,
        "",
        "This supersedes the earlier `NOT MEASURED` finding at this head, which this sweep published" +
          " while the verdict was absent. A check-run never expires on its own, so the detector has to" +
          " clear its own marker — otherwise it keeps reading as `NOT-EVALUATED` to every reader that" +
          " takes the latest row per check name, long after the head was in fact reviewed.",
        "",
        "This row says nothing about WHAT the verdict was. Read the" +
          ` \`${report.checkName}\` row itself for that. See PEN-6352.`,
      ].join("\n"),
    },
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const report = JSON.parse(readFileSync(process.argv[2] ?? "sweep.json", "utf8"));
  const repo = process.env.REPO;
  if (!repo) throw new Error("REPO is required");

  const post = (payload, label, entry) => {
    execFileSync("gh", ["api", "-X", "POST", `/repos/${repo}/check-runs`, "--input", "-"], {
      input: JSON.stringify(payload),
      stdio: ["pipe", "ignore", "inherit"],
    });
    process.stderr.write(`${label} ${CHECK_NAME} for #${entry.number} @ ${entry.head.slice(0, 8)}\n`);
  };

  let published = 0;
  let retired = 0;
  let skipped = 0;

  for (const finding of report.findings) {
    // Already carrying an open finding at this exact head: re-posting would
    // add one identical row per hour and change nothing a reader can see.
    if (finding.alreadyPublished) {
      skipped += 1;
      process.stderr.write(`already reported #${finding.number} @ ${finding.head.slice(0, 8)}\n`);
      continue;
    }
    post(buildCheckRun(finding, report), "published", finding);
    published += 1;
  }

  for (const resolution of report.resolutions ?? []) {
    post(buildResolvedCheckRun(resolution, report), "retired", resolution);
    retired += 1;
  }

  process.stderr.write(
    `published ${published} finding row(s), retired ${retired}, skipped ${skipped} already reported\n`,
  );
}
