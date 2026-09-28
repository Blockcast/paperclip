import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY } from "../services/ccrotate-capacity-retry.js";

/**
 * Pins the fourth copy of `penstockAdvertisedResumeAt` (BLO-35263).
 *
 * The key is named in four places that must agree, and only the TS constant
 * is rename-safe. Exporting it lets `queued-run-age-metrics.ts` and the
 * `parked-agents` route read through it rather than repeat the literal, which
 * makes three of the four rename-safe. The on-call triage query lives in a Helm
 * template and cannot import a TS constant, so the fourth copy is pinned here
 * instead -- by the test rather than by the compiler, because there is nothing
 * else that can hold it.
 *
 * Without this, a rename compiles clean and no existing test fails: the metrics
 * suite writes the literal into `result_json` itself, so it moves with the
 * writer instead of pinning agreement with the consumers. The failure would be
 * silent and in the paging direction -- `greatest` ignores the NULL from the
 * now-unmatched key, the gauge degrades to the bare `scheduled_retry_at`
 * column, and it resumes paging on exactly the capacity-clamped population
 * BLO-34782 removed. The triage query the responder reaches for to check the
 * alert degrades at the same moment and in the same direction, so the
 * instrument corroborates the false page rather than exposing it.
 */
/** Vitest is run from both the repo root and `server/`; resolve either way. */
const REPO_ROOT = basename(process.cwd()) === "server" ? resolve(process.cwd(), "..") : process.cwd();
const PROMETHEUS_RULE = join(REPO_ROOT, "deploy/helm/paperclip/templates/prometheusrule.yaml");

/** The alert whose `description` embeds the overdue-scheduled-retry triage query. */
const ALERT_NAME = "PaperclipOverdueScheduledRetry";

/**
 * Slice one alert out of the rendered rule file: from its `- alert: <name>`
 * line to the next `- alert:`. Scoped rather than matched file-wide so an
 * unrelated alert that legitimately reads a different `result_json` key later
 * cannot fail this test -- and so the assertion stays about *this* query.
 */
function readAlertBlock(name: string): string {
  const yaml = readFileSync(PROMETHEUS_RULE, "utf8");
  const start = yaml.indexOf(`- alert: ${name}\n`);
  expect(start, `alert ${name} not found in ${PROMETHEUS_RULE}`).toBeGreaterThanOrEqual(0);
  const next = yaml.indexOf("- alert: ", start + 1);
  return next === -1 ? yaml.slice(start) : yaml.slice(start, next);
}

describe("prometheusrule.yaml result_json keys (BLO-35263)", () => {
  it(`pins every result_json key in the ${ALERT_NAME} triage query to its TS constant`, () => {
    const block = readAlertBlock(ALERT_NAME);
    const keys = [...block.matchAll(/result_json\s*->>\s*'([^']+)'/g)].map((m) => m[1]);

    // Non-empty is the load-bearing half. Every other assertion here passes
    // vacuously on zero matches, which is the exact defect this guards: a test
    // that extracts nothing reports agreement it never checked.
    expect(keys.length, "no result_json key found -- did the triage query move or change shape?")
      .toBeGreaterThan(0);

    // Compares EVERY occurrence, not the first. Pinning one and ignoring the
    // rest would reproduce the drift, since the query reads the key three times.
    expect(keys).toEqual(keys.map(() => CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY));
  });
});
