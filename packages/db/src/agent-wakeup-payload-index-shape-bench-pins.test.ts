/**
 * PEN-6104: two pins on `agent-wakeup-payload-index-shape.bench.ts`, both for
 * defects that have already happened and would recur silently.
 *
 * The bench is a `.bench.ts`, so it is OUTSIDE the vitest glob and CI never
 * runs it. That is the point: nothing else in the tree executes the file, so a
 * regression in it is invisible until someone re-runs it by hand months later
 * and quotes the result. These are source-text assertions, which is weak
 * evidence in general -- but the two properties below are properties of the
 * TEXT, and the text is what the next reader acts on.
 *
 * ⭐ Both pins are written as POSITIVE assertions about what the file now says,
 * never as a grep for the defective string. A `-` on a carrier proves deletion
 * and never repair, and a grep for the old wording cannot tell a repaired file
 * apart from one where someone deleted the wrong line without writing the right
 * one -- nor from a file that quotes the defect as a negative example, which
 * this bench's header now deliberately does in both places.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BENCH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "agent-wakeup-payload-index-shape.bench.ts",
);
const source = fs.readFileSync(BENCH, "utf8");

describe("agent_wakeup_requests payload index-shape bench", () => {
  /**
   * PIN 1 -- the write probe must `VACUUM` what it `DELETE`s.
   *
   * Without it each candidate's `EXPLAIN` runs over the accumulated dead
   * tuples of every candidate measured before it (0 for the baseline, 100k/200k
   * for C1/C1b, 300k for C2/C2b, 0 again for C3/C4 whose `ADD COLUMN ... STORED`
   * rewrite compacts the heap). The handicap is UNEVEN BETWEEN THE CANDIDATES
   * BEING COMPARED, and a comparison is the only thing this file produces.
   *
   * Measured consequence, which is why this is pinned rather than commented:
   * the bias did not merely inflate the milliseconds, it changed which PLAN the
   * planner chose for C4, moving its dense figure by 24x. A reviewer re-reading
   * the numbers cannot see that; only the plan shows it.
   */
  it("VACUUMs after the write probe's DELETE, inside the probe itself", () => {
    const probeStart = source.indexOf("const writeProbe = async");
    expect(probeStart, "writeProbe helper not found -- has it been renamed?").toBeGreaterThan(-1);
    const probeEnd = source.indexOf("const results:", probeStart);
    expect(probeEnd, "could not bound the writeProbe body").toBeGreaterThan(probeStart);

    const probe = source.slice(probeStart, probeEnd);
    const deleteAt = probe.indexOf("DELETE FROM agent_wakeup_requests");
    const vacuumAt = probe.indexOf("VACUUM (ANALYZE) agent_wakeup_requests");

    expect(deleteAt, "the probe no longer deletes its rows").toBeGreaterThan(-1);
    expect(
      vacuumAt,
      "the write probe DELETEs with no VACUUM -- every candidate after this one " +
        "is scored over the dead tuples this probe left behind",
    ).toBeGreaterThan(-1);
    expect(
      vacuumAt,
      "the VACUUM must follow the DELETE it is reclaiming",
    ).toBeGreaterThan(deleteAt);
  });

  /**
   * PIN 2 -- `successful-run-handoff-state.ts` must be named as an ATTRIBUTION
   * site, never as one of the five MEMBERSHIP sites.
   *
   * `coalesce(...)` answers "which single issue owns this wake"; the four-arm
   * disjunction answers "does this wake target issue X". A wake whose
   * `_paperclipWakeContext.issueId` names a different issue from its top-level
   * `issueId` is a MEMBER of both and ATTRIBUTED to only the first -- measured
   * in `agent-wakeup-payload-target-semantics.test.ts`. The two expressions read
   * alike at a glance, so a reader who trusts a membership list that includes
   * the handoff site rewrites an attribution `coalesce` into the disjunction and
   * changes behaviour.
   *
   * This exact confusion has now been made three times in this work -- twice in
   * PEN-6104's own description and once in this bench's header, each time by
   * someone who had just read the correction. That recurrence is the whole
   * argument for pinning the carrier instead of warning the reader again.
   */
  it("names the handoff site as attribution, and counts task-watchdogs twice", () => {
    const mention = source.indexOf("successful-run-handoff-state.ts");
    expect(mention, "the header no longer mentions the handoff site at all").toBeGreaterThan(-1);

    // Bound the claim to the paragraph that mentions it, so a correct statement
    // elsewhere in the file cannot stand in for a defective list here.
    const paragraph = source.slice(mention, mention + 700);
    expect(
      paragraph,
      "the handoff site is mentioned without being marked as an ATTRIBUTION " +
        "expression -- a reader will take it for a membership site",
    ).toMatch(/ATTRIBUTION/);

    // The fifth MEMBERSHIP site is task-watchdogs.ts's SECOND one, so the
    // enumeration has to say the file is counted twice or the count of five
    // cannot be reconstructed from it.
    expect(
      source,
      "the membership enumeration does not record that task-watchdogs.ts " +
        "contributes TWO of the five sites",
    ).toMatch(/`services\/task-watchdogs\.ts` TWICE/);
  });

  /**
   * PIN 3 -- the production row count is recorded, with its provenance.
   *
   * The header asserted for a day that the count was "UNKNOWN to this seat" and
   * carried a "re-run if a real count lands" trigger that had already fired.
   * Pinning the CITATION rather than the figure: the number moves every hour
   * (~690 rows/h) and pinning it would buy pure churn, while the thing that
   * actually went stale was the claim that no instrument existed.
   */
  it("cites the instrument that published the production row count", () => {
    expect(
      source,
      "the header does not cite PEN-6165, the row that published " +
        "pg_paperclip_table_mvcc_n_live_tup for this table",
    ).toMatch(/PEN-6165/);
  });
});
