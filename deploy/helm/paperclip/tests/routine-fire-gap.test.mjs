/**
 * BLO-32638 — run the routine fire-gap incident replay through promtool.
 *
 * The companion `routine-fire-gap.promtool.yaml` is the issue's binding
 * verifying signal: the alert-delivery bridge watchdog's measured history
 * (BLO-31881 — 11 gaps > 12h, largest 47.5h, one 30.7h window that hid a real
 * outage) replayed against the rendered rule, plus the negative control across
 * that same history's healthy intervals. A fixture nobody executes is a
 * comment, so this harness executes it.
 *
 * promtool is NOT installed in the job that runs this chart's other tests —
 * the sibling `prometheus-rule.test.mjs` says so explicitly, and that is why
 * its own checks are hand-rolled structural guards rather than a parse. So
 * this test SKIPS when promtool is missing rather than failing. Stated
 * honestly: in a job without promtool this contributes nothing, and the
 * structural guards next door remain the only automated cover. It is written
 * this way so the replay runs for anyone who has the binary (every SRE
 * workstation, and any job that installs it) instead of running nowhere.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../../../..");

const hasPromtool = spawnSync("promtool", ["--version"], { stdio: "ignore" }).status === 0;

test("the measured incident replay passes against the rendered rule (BLO-32638)", { skip: hasPromtool ? false : "promtool not installed" }, () => {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--set",
      "prometheusRule.enabled=true",
      "--show-only",
      "templates/prometheusrule.yaml",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  // promtool wants a bare `groups:` document; the chart renders a
  // PrometheusRule wrapper. Pull the groups block out by dedenting it rather
  // than taking a YAML dependency this package does not have.
  const lines = rendered.split("\n");
  const start = lines.findIndex((line) => line === "  groups:");
  assert.notEqual(start, -1, "expected a `  groups:` key in the rendered PrometheusRule");
  const body = lines
    .slice(start)
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");

  // The positive control. Without it an absent or renamed rule renders an
  // empty match set, every scenario trivially agrees, and the replay reports
  // SUCCESS while testing nothing — which is exactly how a sibling sweep of
  // this rule produced four confident false results.
  assert.match(
    body,
    /alert: PaperclipRoutineFireGap$/m,
    "PaperclipRoutineFireGap is absent from the render; the replay below would pass vacuously",
  );

  const tmp = mkdtempSync(path.join(os.tmpdir(), "routine-fire-gap-"));
  try {
    writeFileSync(path.join(tmp, "rendered-rules.yaml"), body);
    // promtool resolves `rule_files:` relative to the TEST FILE's directory,
    // not the process cwd, so the fixture has to sit beside the render it
    // names. It warns (`no file match pattern ...`) rather than failing when
    // it cannot find one, and then every alert expectation reports `got:[]` —
    // a mis-sited fixture looks exactly like a rule that never fires.
    const fixture = path.join(tmp, "routine-fire-gap.promtool.yaml");
    copyFileSync(path.join(testsDir, "routine-fire-gap.promtool.yaml"), fixture);
    const result = spawnSync("promtool", ["test", "rules", fixture], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.doesNotMatch(
      result.stdout,
      /no file match pattern/,
      `promtool found no rule file to test against:\n${result.stdout}`,
    );
    assert.equal(
      result.status,
      0,
      `promtool test rules failed:\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
