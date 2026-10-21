import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// BLO-47034/BLO-48178: an unfiltered `.from(issues)` in the webhook hot path
// read the whole issues table on every delivery (~3s each) and starved the
// api DB pool during check_run bursts. Every issues read here must be filtered.
describe("github-webhook issue lookups", () => {
  it("never selects from issues without a where clause", () => {
    const src = readFileSync(new URL("../routes/github-webhook.ts", import.meta.url), "utf8")
      .replace(/^\s*\/\/.*$/gm, "");
    const reads = [...src.matchAll(/\.from\(issues\)\s*(\S)/g)];
    expect(reads.length).toBeGreaterThan(0);
    for (const m of reads) expect(src.slice(m.index!, m.index! + 40)).toMatch(/\.from\(issues\)\s*\.(where|innerJoin|leftJoin)\(/);
  });
});
