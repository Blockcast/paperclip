import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * BLO-33503: the server test corpus re-types the claude-k8s adapter's pod-failure
 * labels as string literals, and nothing links the two.
 *
 * `POD_FAILURE_LABELS` in `vendor/paperclip-adapter-claude-k8s/src/server/execute.ts`
 * is the sole source of these strings; the adapter emits `` `${label}: ${msg}` ``.
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
  // The declared union has six members; a regex that silently matched fewer would
  // shrink the oracle and let a stale fixture pass.
  expect(labels.length).toBe(6);
  return new Set(labels);
}

/**
 * Fixture wire strings: `"<label>: Pod <name> reached phase=..."`. The
 * `reached phase=` tail is `describePodTerminatedError`'s own output, which is
 * what makes this specific enough not to match unrelated prose.
 */
function findFixtureLabels(): { file: string; label: string }[] {
  const found: { file: string; label: string }[] = [];
  for (const entry of readdirSync(testsDir)) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(path.join(testsDir, entry), "utf8");
    for (const m of src.matchAll(
      /"([A-Z][^":]{3,60}): Pod [^"]*reached phase=[^"]*"/g,
    )) {
      found.push({ file: entry, label: m[1] });
    }
  }
  return found;
}

describe("pod-failure label corpus (BLO-33503)", () => {
  it("every hand-written pod-failure label in the server corpus is one the adapter emits", () => {
    const labels = readAdapterLabels();
    const fixtures = findFixtureLabels();

    // Negative control. An empty scan would pass vacuously and this guard would
    // be decoration — the same failure shape as a filter that matches nothing.
    // If the fixtures are legitimately removed, delete this file with them.
    expect(fixtures.length).toBeGreaterThan(0);

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
