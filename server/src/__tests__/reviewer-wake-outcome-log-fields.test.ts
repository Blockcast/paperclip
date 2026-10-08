import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard on the reviewer-wake outcome log lines (BLO-22758).
 *
 * BLO-22758 was filed because a dropped PR review was undiagnosable: a served
 * PR and a PR whose wake was never enqueued emitted a byte-identical webhook
 * trail. Its first fix added the success-side `reviewer wake enqueued` line.
 * Its second acceptance criterion is stricter, and is what this guard holds:
 * given a PR with no Ally response, the logs ALONE must say which terminal
 * state the wake reached (served / failed / skipped / still queued).
 *
 * That only works if every outcome line can be joined back to the same PR by
 * the same field. Three could not, and each failed in the direction that
 * reads as silence:
 *
 *   - `no_reviewer` logged neither a delivery id nor an idempotency key.
 *   - `failed` logged no delivery id — and `failed` is one of the four states
 *     the acceptance criterion names by name.
 *   - `declined` logged the delivery id as `githubDeliveryId`.
 *
 * The last one is the subtle one and the reason this guard is static rather
 * than behavioural. `githubDeliveryId` is the correct spelling for persisted
 * wake-METADATA payloads, where every sibling key genuinely is `github*`
 * prefixed (`githubEvent`, `githubPrNumber`, `githubRepoFullName`); there are
 * five such payloads in this file and renaming their keys would be a breaking
 * change for anything reading them. It was wrong only inside a LOGGER object,
 * whose other keys are unprefixed. So an investigator filtering the trail on
 * `deliveryId` — the field the enqueue, duplicate and deferred lines all use
 * — saw no `declined` line at all, which reproduces this issue's own defect
 * one layer down.
 *
 * A behavioural test would need Postgres and could drive only one branch at a
 * time; `declined` and `failed` need an injected gate refusal and an injected
 * throw respectively. This scans all of them at once, and is the check that
 * fails if a new outcome branch is added without a join key.
 */

const WEBHOOK_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "routes",
  "github-webhook.ts",
);

/**
 * Comments are stripped before any key is tested. Without this the guard
 * scores comment PROSE as code: the sentence above explaining that
 * `githubDeliveryId` is wrong would itself trip the prefixed-spelling check,
 * and a comment mentioning `idempotencyKey` would satisfy the key check for a
 * line that does not log one. Verified both ways while writing this — an
 * uncommented-stripped run reports a violation on the very line it describes.
 */
function strippedSource(): string {
  return readFileSync(WEBHOOK_SOURCE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

interface OutcomeLine {
  message: string;
  logsDeliveryId: boolean;
  logsPrefixedDeliveryId: boolean;
}

/**
 * Every `logger.*` call in the webhook whose message names a reviewer-wake
 * outcome, paired with the fields its object literal carries. The region
 * between a `logger.` and its message string IS that object literal, so
 * walking back from the message to the nearest preceding `logger.` bounds the
 * scan to one call without needing a TypeScript parse.
 */
function outcomeLines(): OutcomeLine[] {
  const source = strippedSource();
  const lines: OutcomeLine[] = [];
  for (const match of source.matchAll(/"github webhook reviewer wake[^"]*"/g)) {
    const loggerStart = source.slice(0, match.index).lastIndexOf("logger.");
    if (loggerStart === -1) continue;
    const call = source.slice(loggerStart, match.index);
    lines.push({
      message: match[0].slice(1, -1),
      // Word-boundary on the left too: `githubDeliveryId` must not satisfy
      // the unprefixed check, or the guard's two arms collapse into one.
      logsDeliveryId: /(^|[^a-zA-Z])deliveryId\b/.test(call),
      logsPrefixedDeliveryId: /githubDeliveryId\b/.test(call),
    });
  }
  return lines;
}

describe("reviewer-wake outcome log fields (BLO-22758)", () => {
  // Guards the guard. If the walk-back or the message pattern ever stops
  // matching, every arm below degrades to vacuously true and this file goes
  // on reporting success while checking nothing — the exact failure shape
  // that makes a clean negative worth distrusting. Asserted as a floor, not
  // an exact count, so adding an outcome branch does not fail the suite
  // spuriously; it was 15 when this was written.
  it("finds the reviewer-wake outcome log lines at all", () => {
    const lines = outcomeLines();
    expect(lines.length).toBeGreaterThanOrEqual(15);
    expect(lines.map((line) => line.message)).toContain(
      "github webhook reviewer wake enqueued",
    );
  });

  it("gives every outcome line a deliveryId to join on", () => {
    const missing = outcomeLines()
      .filter((line) => !line.logsDeliveryId)
      .map((line) => line.message);
    expect(missing).toEqual([]);
  });

  it("never spells it githubDeliveryId in a logger call", () => {
    const prefixed = outcomeLines()
      .filter((line) => line.logsPrefixedDeliveryId)
      .map((line) => line.message);
    expect(prefixed).toEqual([]);
  });
});
