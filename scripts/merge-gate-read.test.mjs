import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const READER = fileURLToPath(new URL("./merge-gate-read.sh", import.meta.url));

/** Run the canonical reader's verdict pipeline over fixture rows. */
function read(rows, dead = "__none__") {
  const stdin = rows.map((r) => r.join("\t")).join("\n") + "\n";
  const out = execFileSync("bash", [READER, "--rows", dead], { input: stdin, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

const stops = (lines) => lines.filter((l) => l.startsWith("STOP\t"));

describe("merge-gate reader", () => {
  // BLO-34263. A workflow run cancelled with nothing superseding it (ARC eviction,
  // external cancel, job killed mid-step) puts EVERY real check-run in DEAD. Without
  // the END clause the reader prints nothing, which is indistinguishable from
  // all-green. Measured on Blockcast/paperclip#1846 @ 6b840f14c, run 35100490811
  // attempt 1: verify was `failure` and the un-guarded reader emitted 0 STOP lines.
  it("reports ABSENT when the dead-run filter eats every check-run", () => {
    const lines = read(
      [
        ["policy", "cancelled", "2026-09-16T13:15Z", "35100490811"],
        ["verify", "failure", "2026-09-16T13:20Z", "35100490811"],
        ["Typecheck", "skipped", "2026-09-16T13:20Z", "35100490811"],
        ["security-review", "neutral", "2026-09-16T13:14Z", "app"],
      ],
      "35100490811",
    );
    assert.ok(stops(lines).length >= 1, `expected >=1 STOP, got ${JSON.stringify(lines)}`);
    assert.match(lines.join("\n"), /ABSENT/);
  });

  // The guard must not manufacture a false RED. Both of these are genuinely fine.
  it("stays silent on an all-green head", () => {
    assert.deepEqual(
      read([
        ["verify", "success", "2026-09-16T13:20Z", "999"],
        ["Build", "success", "2026-09-16T13:21Z", "999"],
      ]),
      [],
    );
  });

  it("stays silent on an all-green head that also has an unrelated cancelled run", () => {
    assert.deepEqual(
      read(
        [
          ["verify", "success", "2026-09-16T14:00Z", "222"],
          ["Storybook", "cancelled", "2026-09-16T13:00Z", "111"],
        ],
        "111",
      ),
      [],
    );
  });

  // A legitimately superseded cancel: stale rows still get dropped, and because a
  // live run survives, the ABSENT guard must NOT fire.
  it("drops stale rows but does not fire ABSENT when a live run survives", () => {
    assert.deepEqual(
      read(
        [
          ["verify", "failure", "2026-09-16T13:00Z", "111"],
          ["verify", "success", "2026-09-16T14:00Z", "222"],
          ["Build", "success", "2026-09-16T14:01Z", "222"],
        ],
        "111",
      ),
      [],
    );
  });

  // Survivor count excludes `neutral`: BLO-33657's "nothing attested this head"
  // verdict is not evidence that the check-run surface survived. Counting it would
  // suppress the guard on exactly the measured #1846 shape.
  it("does not count a neutral row as a surviving verdict", () => {
    const lines = read(
      [
        ["verify", "failure", "2026-09-16T13:20Z", "111"],
        ["gate/ally-comment-findings", "neutral", "2026-09-16T13:14Z", "app"],
      ],
      "111",
    );
    assert.match(lines.join("\n"), /ABSENT/);
  });

  // ...and excludes legacy `status` rows: a surviving commit status says nothing
  // about whether the check-run surface survived.
  it("does not count a legacy status row as a surviving check-run", () => {
    const lines = read(
      [
        ["ci-gate", "success", "2026-09-16T13:00Z", "status"],
        ["verify", "failure", "2026-09-16T13:00Z", "111"],
      ],
      "111",
    );
    assert.match(lines.join("\n"), /ABSENT/);
  });

  // BLO-34035: `neutral` is labelled, never filtered. It is non-blocking for merge
  // but must stay visible — it is positive evidence that a review at this head is
  // unproven.
  it("labels neutral as NOT-EVALUATED rather than dropping it", () => {
    const lines = read([
      ["verify", "success", "2026-09-16T13:20Z", "999"],
      ["gate/ally-comment-findings", "neutral", "2026-09-16T13:14Z", "app"],
    ]);
    assert.deepEqual(lines, ["NOT-EVALUATED\tgate/ally-comment-findings\tneutral\trun=app"]);
    assert.equal(stops(lines).length, 0);
  });

  // BLO-34114: `name` is not unique per head. Two workflow lanes publish identical
  // names, so deduping on name alone keeps just one of them and can hide a genuine
  // security failure — measured on penstock-llm-proxy-core#1992, where
  // `redaction-tests` and `secrets-controls-static-check` were hidden entirely.
  //
  // Both run-id orderings are asserted deliberately. Dedup-by-name drops whichever
  // row sorts second, so a single ordering only catches the mutation half the time:
  // with the red lane first it survives by luck and the test passes on broken code.
  for (const [redRun, greenRun] of [
    ["888", "777"],
    ["777", "888"],
  ]) {
    it(`keys dedup on name+run so one lane cannot mask another (red=${redRun})`, () => {
      const lines = read([
        ["secret-scan", "failure", "2026-09-16T13:00Z", redRun],
        ["secret-scan", "success", "2026-09-16T13:03Z", greenRun],
      ]);
      assert.deepEqual(lines, [`STOP\tsecret-scan\tfailure\trun=${redRun}`]);
    });
  }

  // A re-run replaces its check-runs under the same run id, so latest-per-key still
  // drops the superseded attempt.
  it("keeps only the latest attempt within one run", () => {
    assert.deepEqual(
      read([
        ["verify", "failure", "2026-09-16T13:00Z", "777"],
        ["verify", "success", "2026-09-16T14:00Z", "777"],
      ]),
      [],
    );
  });

  it("treats an in-flight check as a stop", () => {
    const lines = read([["General tests", "in_progress", "2026-09-16T13:00Z", "999"]]);
    assert.deepEqual(lines, ["STOP\tGeneral tests\tin_progress\trun=999"]);
  });
});
