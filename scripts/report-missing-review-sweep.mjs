#!/usr/bin/env node
/**
 * Render a sweep report (PEN-6352) as a job summary, and emit the counts the
 * workflow branches on.
 *
 *   findings=<n>  heads carrying no verdict, whether or not already reported
 *   publish=<n>   rows the publish step would actually POST -- new findings
 *                 plus retirements. The publish step gates on THIS, not on
 *                 `findings`: a sweep can have zero new findings and still owe
 *                 a retirement row, and gating on `findings` would strand the
 *                 stale `neutral` marker on exactly the heads that recovered.
 *
 * Usage: node scripts/report-missing-review-sweep.mjs sweep.json >> "$GITHUB_OUTPUT"
 */

import { appendFileSync, readFileSync } from "node:fs";

/** Rows the publish step will actually POST. */
export function publishableCount(report) {
  const fresh = report.findings.filter((finding) => !finding.alreadyPublished).length;
  return fresh + (report.resolutions?.length ?? 0);
}

export function renderSummary(report) {
  const lines = [];
  lines.push(`## Missing \`${report.checkName}\` verdict sweep`);
  lines.push("");
  lines.push(`Scanned **${report.scanned}** open pull requests at ${report.measuredAt}.`);

  // An UNPROVEN head is the one skip reason that means "this sweep did not
  // measure", and it must be visible WITHOUT opening a <details>. A guard that
  // went quietly blind over half the repo renders, collapsed, exactly like a
  // clean run.
  const unproven = report.skipped.filter((entry) => /UNPROVEN/.test(entry.reason));
  if (report.partialErrorTypes.length || unproven.length) {
    lines.push("");
    lines.push("> [!WARNING]");
    if (report.partialErrorTypes.length) {
      lines.push(`> Partial GraphQL errors (${report.partialErrorTypes.join(", ")}).`);
    }
    lines.push(
      `> **${unproven.length}** of ${report.scanned} head(s) could not be read whole and are reported as` +
        " UNPROVEN, never as clean. This sweep did not measure them, so a zero above is a floor on the" +
        " real count, not the count. Treat this run as incomplete.",
    );
    if (unproven.length) {
      lines.push(`> Unproven: ${unproven.map((entry) => `#${entry.number}`).join(", ")}`);
    }
  }

  lines.push("");
  if (report.findings.length === 0) {
    lines.push(`No open pull request head is missing \`${report.checkName}\`.`);
  } else {
    lines.push(
      `**${report.findings.length}** open head(s) carry no \`${report.checkName}\` check-run while other` +
        " checks reported there, so the absence is selective rather than in-flight.",
    );
    lines.push("");
    lines.push("| PR | head | checks at head | head age | author |");
    lines.push("|---|---|---|---|---|");
    for (const finding of report.findings) {
      lines.push(
        `| #${finding.number} | \`${finding.head.slice(0, 8)}\` | ${finding.checkNamesPresent} |` +
          ` ${finding.headAgeMinutes ?? "?"}m | ${finding.author} |`,
      );
    }
    lines.push("");
    lines.push(
      "**Re-trigger with a PR body or title edit.** `edited` is a declared trigger of" +
        " `commitperclip-review.yml`, so it re-runs the gate without moving the head.",
    );
    lines.push("");
    lines.push(
      "Re-running the failed workflow run is NOT an option: `POST /actions/runs/:id/rerun` answers" +
        " `403 This workflow run cannot be retried` for a `startup_failure` (measured 2026-11-09 on run" +
        " `42667753206`), and that gate declares no `workflow_dispatch`. Prefer the body edit to a push," +
        " which voids any in-flight review and re-burns the whole green check set to buy the same thing.",
    );
  }

  if (report.resolutions?.length) {
    lines.push("");
    lines.push(
      `**${report.resolutions.length}** head(s) now carry a \`${report.checkName}\` verdict and had a` +
        ` standing \`${report.selfCheckName ?? "review/verdict-present"}\` finding, which this run` +
        " supersedes with a `success` row under the same name:" +
        ` ${report.resolutions.map((entry) => `#${entry.number}`).join(", ")}.`,
    );
  }

  const alreadyReported = report.findings.filter((finding) => finding.alreadyPublished);
  if (alreadyReported.length) {
    lines.push("");
    lines.push(
      `${alreadyReported.length} of the above already carry this sweep's finding at the same head and are` +
        " not re-posted: " +
        `${alreadyReported.map((finding) => `#${finding.number}`).join(", ")}.`,
    );
  }

  if (report.skipped.length) {
    lines.push("");
    lines.push(`<details><summary>${report.skipped.length} head(s) skipped as in-flight or unproven</summary>`);
    lines.push("");
    for (const entry of report.skipped) lines.push(`- #${entry.number} — ${entry.reason}`);
    lines.push("");
    lines.push("</details>");
  }

  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const report = JSON.parse(readFileSync(process.argv[2] ?? "sweep.json", "utf8"));
  const summary = renderSummary(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } else {
    process.stderr.write(`${summary}\n`);
  }
  process.stdout.write(`findings=${report.findings.length}\n`);
  process.stdout.write(`publish=${publishableCount(report)}\n`);
}
