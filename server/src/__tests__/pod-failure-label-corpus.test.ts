import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * BLO-33503: the server test corpus re-types the claude-k8s adapter's pod-failure
 * labels as string literals, and nothing links the two.
 *
 * `POD_FAILURE_LABELS` in `vendor/paperclip-adapter-claude-k8s/src/server/execute.ts`
 * holds six of these strings, and the call site adds a seventh, the
 * `"Pod failure (unclassified)"` fallback for an error that is not a `PodWaitError`.
 * Both go through the same `` `${label}: ${msg}` `` template, so both are emittable.
 * Server fixtures that stand in for an adapter failure hand-write that whole wire
 * string, across a package boundary — vendor/ sits outside the pnpm workspace and
 * ships as a packed tarball, so a direct import is unavailable. This file reads
 * the vendored source as text instead, the same way
 * `mcp-seed-scrub-coverage.test.ts` and `github-egress-outbound-coverage.test.ts`
 * bind to that package.
 *
 * Why it is worth a test. The drift it catches is invisible to every other check:
 * `reclassifyK8sReplacementLaunchFailureAfterThrottle` gates on `errorCode`
 * (`heartbeat.ts`) and only ever interpolates `errorMessage` into a string — it
 * never parses it. So a fixture naming a label the adapter cannot emit is inert,
 * every suite stays green, and the corpus quietly teaches a wire shape that does
 * not exist. It happened twice inside one PR (introduced at `651cb9ce`, re-created
 * at `d9cf6285` while renaming the label), and both times it was found by reading.
 * This makes the next rename a test failure instead.
 *
 * Scope: this asserts the label *prefix* of a fixture's wire string is a label the
 * adapter can actually emit. It does not check the remainder of the message, and
 * it cannot see fixtures that carry a failure message in some other shape.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const executePath = path.join(
  repoRoot,
  "vendor/paperclip-adapter-claude-k8s/src/server/execute.ts",
);
const testsDir = path.join(repoRoot, "server/src/__tests__");

/** Pull the label values out of the `POD_FAILURE_LABELS` object literal. */
function readAdapterLabels(): Set<string> {
  const src = readFileSync(executePath, "utf8");
  const block =
    /const POD_FAILURE_LABELS: Record<PodFailureKind, string> = \{([\s\S]*?)\n\};/.exec(
      src,
    );
  if (!block) {
    throw new Error(
      `Could not find POD_FAILURE_LABELS in ${executePath}. If it was renamed or ` +
        `restructured, update this test — do not delete it.`,
    );
  }
  const labels = [...block[1].matchAll(/^\s*\w+:\s*"([^"]+)"/gm)].map(
    (m) => m[1],
  );
  // The fallback label is read from source like the other six, so renaming it is
  // caught too. Anchored on the `: "` of the ternary's else-arm.
  const fallback = /: "(Pod failure \([^"]+\))"/.exec(src);
  if (!fallback) {
    throw new Error(
      `Could not find the "Pod failure (...)" fallback label in ${executePath}. ` +
        `If it was renamed or restructured, update this test -- do not delete it.`,
    );
  }
  labels.push(fallback[1]);
  // Six `PodFailureKind` members plus the non-`PodWaitError` fallback. A regex that
  // silently matched fewer would shrink the oracle and let a stale fixture pass.
  expect(labels.length).toBe(7);
  return new Set(labels);
}

/**
 * Fixture wire strings, one pattern per adapter message shape. Each tail is the
 * adapter's own label-independent text, which is what makes it specific enough
 * not to match unrelated prose:
 * - `"<label>: Pod <name> reached phase=..."`, `describePodTerminatedError`'s output;
 * - `"<label>: Timed out waiting for pod containers to start (..."`, the
 *   `startup` throw in `waitForPod`.
 */
const FIXTURE_PATTERNS = [
  /"([A-Z][^":]{3,60}): Pod [^"]*reached phase=[^"]*"/g,
  /"([A-Z][^":]{3,60}): Timed out waiting for pod containers to start \([^"]*"/g,
];

function findFixtureLabels(): { file: string; label: string; pattern: number }[] {
  const found: { file: string; label: string; pattern: number }[] = [];
  for (const entry of readdirSync(testsDir)) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(path.join(testsDir, entry), "utf8");
    FIXTURE_PATTERNS.forEach((re, pattern) => {
      for (const m of src.matchAll(re)) {
        found.push({ file: entry, label: m[1], pattern });
      }
    });
  }
  return found;
}

describe("pod-failure label corpus (BLO-33503)", () => {
  it("every hand-written pod-failure label in the server corpus is one the adapter emits", () => {
    const labels = readAdapterLabels();
    const fixtures = findFixtureLabels();

    // Negative control. An empty scan would pass vacuously and this guard would
    // be decoration — the same failure shape as a filter that matches nothing.
    // Checked per pattern, so a shape whose pattern stops matching is loud too,
    // not hidden behind another shape's hits. If a shape's fixtures are
    // legitimately removed, drop its pattern with them.
    FIXTURE_PATTERNS.forEach((re, pattern) => {
      expect(
        fixtures.filter((f) => f.pattern === pattern).length,
        `no fixture matched ${re}`,
      ).toBeGreaterThan(0);
    });

    const stale = fixtures.filter((f) => !labels.has(f.label));
    expect(
      stale.map((f) => `${f.file}: "${f.label}"`),
      `Fixture label(s) the adapter cannot emit. POD_FAILURE_LABELS has: ${[
        ...labels,
      ]
        .map((l) => `"${l}"`)
        .join(", ")}`,
    ).toEqual([]);
  });
});
