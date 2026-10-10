import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// BLO-34510 / PEN-3916. The release-namespace Role grants Secrets
// `create`, `get`, `patch`, `delete` — and NOT `update`. `@kubernetes/client-node`'s
// `replaceNamespacedSecret` issues an HTTP PUT, which the RBAC authorizer maps
// to `secrets: update`, so a single call site anywhere in production source is
// a 403 at runtime in the one code path that adopts a pre-existing Secret.
//
// This assertion used to live OUTSIDE this package, in
// `scripts/check-opencode-k8s-pin-reachable.mjs`: the adapter was cloned from a
// fork at a pinned SHA, so the only way to check the property was to clone the
// pinned tree over the network and `git grep` it. That script is retired with
// the pin (PEN-3916) and the check moves here, where it is an ordinary in-tree
// test that needs no network and runs on every change to this directory.
//
// Kept as a source scan rather than a behavioural mock, deliberately: the
// property is "no call site exists", which a mock can only demonstrate for the
// paths it happens to drive. The claude_k8s sibling asserts the behavioural
// half for its own adoption path in `secret-adopt.test.ts`; this adapter has no
// adoption path to drive, so the scan is the whole of it.
const SECRET_PUT_SYMBOL = "replaceNamespacedSecret";

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Conventional test/spec files and __tests__/__mocks__ directories. Their
 * stubs can legitimately name the symbol while asserting it is never called. */
function isTestPath(relPath: string): boolean {
  return /(?:^|\/)__(?:tests|mocks)__\/|\.(?:test|spec)\.[cm]?tsx?$/.test(relPath);
}

function productionSources(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...productionSources(join(dir, entry.name), rel));
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !isTestPath(rel)) {
      out.push(rel);
    }
  }
  return out;
}

describe("RBAC Secret verbs (BLO-34510)", () => {
  const sources = productionSources(SRC_DIR);

  // POSITIVE CONTROL, and it is load-bearing. An empty scan produces the same
  // "no hits" result as a clean tree, so a layout move (src/ reorganised, this
  // file relocated) would silently turn the assertion below into a no-op that
  // still reports green. The retired script carried the identical control as
  // `srcFileCount`, which routed an inert search to `inconclusive` rather than
  // letting it read as clean.
  it("actually reads this adapter's production sources", () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(sources).toContain("server/execute.ts");
    expect(sources).toContain("server/job-manifest.ts");
    // The scan must be capable of producing a hit: a filter that excluded
    // everything interesting would pass the count check above and still be
    // blind. `createNamespacedSecret` is the sibling verb this adapter DOES
    // use, so finding it proves the reader reaches real Secret call sites.
    const bodies = sources.map((rel) => readFileSync(join(SRC_DIR, rel), "utf8"));
    expect(bodies.some((body) => body.includes("createNamespacedSecret"))).toBe(true);
  });

  it("names no PUT-verb Secret call site in production source", () => {
    const offenders = sources.filter((rel) =>
      readFileSync(join(SRC_DIR, rel), "utf8").includes(SECRET_PUT_SYMBOL),
    );
    expect(offenders).toEqual([]);
  });
});
