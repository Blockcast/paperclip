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
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const CHECK_NAME = "review/verdict-present";

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
          " itself block the pull request. It stops being published once the verdict is present.",
      ].join("\n"),
    },
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const report = JSON.parse(readFileSync(process.argv[2] ?? "sweep.json", "utf8"));
  const repo = process.env.REPO;
  if (!repo) throw new Error("REPO is required");

  let published = 0;
  for (const finding of report.findings) {
    execFileSync("gh", ["api", "-X", "POST", `/repos/${repo}/check-runs`, "--input", "-"], {
      input: JSON.stringify(buildCheckRun(finding, report)),
      stdio: ["pipe", "ignore", "inherit"],
    });
    published += 1;
    process.stderr.write(`published ${CHECK_NAME} for #${finding.number} @ ${finding.head.slice(0, 8)}\n`);
  }
  process.stderr.write(`published ${published} row(s)\n`);
}
