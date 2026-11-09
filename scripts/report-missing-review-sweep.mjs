#!/usr/bin/env node
/**
 * Render a sweep report (PEN-6352) as a job summary, and emit `findings=<n>`
 * for the workflow to branch on.
 *
 * Usage: node scripts/report-missing-review-sweep.mjs sweep.json >> "$GITHUB_OUTPUT"
 */

import { appendFileSync, readFileSync } from "node:fs";

export function renderSummary(report) {
  const lines = [];
  lines.push(`## Missing \`${report.checkName}\` verdict sweep`);
  lines.push("");
  lines.push(`Scanned **${report.scanned}** open pull requests at ${report.measuredAt}.`);

  if (report.partialErrorTypes.length) {
    lines.push("");
    lines.push("> [!WARNING]");
    lines.push(
      `> Partial GraphQL errors (${report.partialErrorTypes.join(", ")}). Some heads could not be read` +
        " whole and are reported as UNPROVEN, never as clean. Treat this run as incomplete.",
    );
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
}
