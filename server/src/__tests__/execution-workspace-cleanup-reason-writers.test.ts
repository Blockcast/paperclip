import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PEN-3692, found by Ally on PR #2175.
 *
 * `cleanup_reason` records WHY a row became collector-eligible, and PR #2175
 * made that column load-bearing: the collector maps it to the `cleanup_reason`
 * metric label, which is the run-attribution split the whole row depends on.
 * Before that it fed a log line and a census, so nulling it was harmless and
 * one writer did exactly that — `executeRun`'s reuse-mismatch demotion set
 * `cleanupReason: null` while leaving `cleanupEligibleAt` set, stripping the
 * origin off a still-eligible row. A `run_ended` row demoted that way reported
 * as idle reclamation on every pass that touched it afterwards.
 *
 * The invariant that makes such a write safe, regardless of which file it is
 * in: a row left WITHOUT a reason must also be left UNSELECTABLE, because
 * `selectEligible` filters on `cleanupEligibleAt is not null` and
 * `ne(status, "archived")`. So nulling the reason has to come with either
 *
 *   - `cleanupEligibleAt: null` — un-stamps the row coherently (what the
 *     realization write does), or
 *   - `status: "archived"` — takes it out of the collector's scope entirely
 *     (what the operator close path does).
 *
 * Scans all of `server/src` rather than the two files that do this today: the
 * regression this guards against is a THIRD writer added somewhere else, which
 * is precisely how the original one arrived. Test sources are excluded because
 * this asserts about production code — and because fixtures legitimately seed
 * `cleanupReason: null` on rows with no stamp at all.
 */
describe("writers that null cleanup_reason", () => {
  it("never leave a row collector-eligible with no recorded reason", async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const sources: Array<{ file: string; text: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          await walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          sources.push({ file: path.relative(root, full), text: await fs.readFile(full, "utf8") });
        }
      }
    };
    await walk(root);

    /**
     * The innermost `{ … }` enclosing `at`. Scanning backwards for the first
     * unmatched `{` and forwards for its partner is enough for the update
     * payloads this applies to; anything larger than a payload is reported as
     * unverifiable rather than silently passed, so a structure this cannot
     * read fails the test instead of slipping through it.
     */
    const enclosingObjectLiteral = (text: string, at: number): string | null => {
      let depth = 0;
      let open = -1;
      for (let i = at; i >= 0; i -= 1) {
        if (text[i] === "}") depth += 1;
        else if (text[i] === "{") {
          if (depth === 0) { open = i; break; }
          depth -= 1;
        }
      }
      if (open < 0) return null;
      depth = 0;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") {
          depth -= 1;
          if (depth === 0) return text.slice(open, i + 1);
        }
      }
      return null;
    };

    const offenders: string[] = [];
    let found = 0;
    for (const { file, text } of sources) {
      const pattern = /cleanupReason:\s*null/g;
      for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
        found += 1;
        const line = text.slice(0, m.index).split("\n").length;
        const literal = enclosingObjectLiteral(text, m.index);
        if (literal === null || literal.length > 2000) {
          offenders.push(`${file}:${line} — could not read the enclosing object literal; check it by hand`);
          continue;
        }
        const unstamped = /cleanupEligibleAt:\s*null/.test(literal);
        const archived = /status:\s*"archived"/.test(literal);
        if (!unstamped && !archived) {
          offenders.push(`${file}:${line} — nulls cleanup_reason but leaves the row selectable`);
        }
      }
    }

    // Guards the guard: if the write shape is ever renamed, this test must stop
    // passing vacuously.
    expect(found).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
