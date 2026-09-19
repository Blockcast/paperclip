import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const READER = fileURLToPath(new URL("./merge-gate-read.sh", import.meta.url));

/**
 * Run the canonical reader's verdict pipeline over fixture rows.
 * Returns { rc, lines }. `--rows` propagates the pipeline status, so a nonzero
 * exit is an expected outcome here and must not be read as a harness failure —
 * the VERDICT IS THE LINES. Use `read()` unless you are asserting on rc itself.
 */
function readRc(rows, dead = "__none__") {
  const stdin = rows.length ? rows.map((r) => r.join("\t")).join("\n") + "\n" : "";
  const opts = { input: stdin, encoding: "utf8" };
  let rc = 0;
  let out;
  try {
    out = execFileSync("bash", [READER, "--rows", dead], opts);
  } catch (e) {
    rc = e.status;
    out = e.stdout;
  }
  return { rc, lines: out.split("\n").filter(Boolean) };
}

/** Run the verdict pipeline and return only its lines. */
function read(rows, dead = "__none__") {
  return readRc(rows, dead).lines;
}

/** Classify workflow runs at a head into the stale-run alternation. */
function dead(runs) {
  const stdin = runs.map((r) => r.join("\t")).join("\n") + "\n";
  const out = execFileSync("bash", [READER, "--dead"], { input: stdin, encoding: "utf8" });
  return out.trim();
}

/** Turn a check-runs API body into reader rows. */
function extract(checkRuns) {
  const out = execFileSync("bash", [READER, "--extract"], {
    input: JSON.stringify({ check_runs: checkRuns }),
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

/** Turn one or more commit-status API pages into reader rows. */
function statusExtract(pages) {
  const out = execFileSync("bash", [READER, "--status-extract"], {
    input: pages.map((p) => JSON.stringify(p)).join("\n"),
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

/** Turn an actions/runs API body into run rows. */
function runExtract(workflowRuns) {
  const out = execFileSync("bash", [READER, "--runs-extract"], {
    input: JSON.stringify({ workflow_runs: workflowRuns }),
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

/** Validate a candidate head sha. Returns { rc, out }. */
function shaGuard(sha) {
  try {
    return { rc: 0, out: execFileSync("bash", [READER, "--sha-guard", sha], { encoding: "utf8" }) };
  } catch (e) {
    return { rc: e.status, out: e.stdout };
  }
}

const SOURCE = readFileSync(READER, "utf8");

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
        ["security-review", "neutral", "2026-09-16T13:14Z", "app:allyblockcast"],
      ],
      "35100490811",
    );
    assert.ok(stops(lines).length >= 1, `expected >=1 STOP, got ${JSON.stringify(lines)}`);
    assert.match(lines.join("\n"), /ABSENT/);
  });

  // Reviewer finding at 5532b1ab: the survivor count excluded legacy-status rows
  // but not App-published ones, and an App row is not a workflow verdict either.
  // So the fixture above passed only because its App row is `neutral`, which
  // $2!="neutral" removes before the App question is reached — one green App row
  // suppresses the guard and the reader prints nothing. Reachable, not
  // theoretical: pr.yml sets a PR-scoped concurrency group, and every head in
  // this repo carries `security-review` plus `gate/ally-comment-findings`, the
  // latter `success` whenever there are no unresolved findings.
  it("reports ABSENT when the only survivor is a green App-published row", () => {
    const lines = read(
      [
        ["Build", "failure", "2026-09-16T13:20Z", "111"],
        ["gate/ally-comment-findings", "success", "2026-09-16T13:14Z", "app:allyblockcast"],
      ],
      "111",
    );
    assert.match(lines.join("\n"), /ABSENT/);
  });

  // ...but an App-only head with nothing dropped is NOT absent. This is the
  // false-RED control on the arm above; without `dead=="__none__"` it fires.
  it("stays silent on an App-only head when nothing was dropped", () => {
    assert.deepEqual(
      read([["gate/ally-comment-findings", "success", "2026-09-16T13:14Z", "app:allyblockcast"]]),
      [],
    );
  });

  // The mandated procedure's one carve-out: a name containing `${{` is an
  // un-expanded workflow template, a malformed registration that can never
  // report. Labelled MALFORMED rather than STOP, and it must not count as a
  // surviving verdict either — otherwise it suppresses the ABSENT guard.
  it("labels an un-expanded workflow template as MALFORMED, not STOP", () => {
    const lines = read([
      ["verify", "success", "2026-09-16T13:20Z", "999"],
      ["build-${{ matrix.os }}", "failure", "2026-09-16T13:21Z", "999"],
    ]);
    assert.deepEqual(lines, ["MALFORMED\tbuild-${{ matrix.os }}\tfailure\trun=999"]);
    assert.equal(stops(lines).length, 0);
  });

  it("does not count a malformed check-run as a surviving verdict", () => {
    const lines = read(
      [
        ["verify", "failure", "2026-09-16T13:20Z", "111"],
        ["build-${{ matrix.os }}", "success", "2026-09-16T13:21Z", "222"],
      ],
      "111",
    );
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
        ["gate/ally-comment-findings", "neutral", "2026-09-16T13:14Z", "app:allyblockcast"],
      ],
      "111",
    );
    assert.match(lines.join("\n"), /ABSENT/);
  });

  // ...and the neutral row must carry a REAL run id in at least one fixture.
  // The App-published one above passes on broken code: an `app:` row is already
  // excluded from the survivor count by the BLO-34263 arm, so it masks the
  // neutral arm entirely and removing `$2!="neutral"` changes nothing. Found by
  // a mutation run — the guard survived, and it is genuinely load-bearing for a
  // workflow-published neutral check-run.
  it("does not count a workflow-published neutral row as a surviving verdict", () => {
    const lines = read(
      [
        ["verify", "failure", "2026-09-16T13:20Z", "111"],
        ["gate/ally-comment-findings", "neutral", "2026-09-16T13:14Z", "222"],
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
      ["gate/ally-comment-findings", "neutral", "2026-09-16T13:14Z", "app:allyblockcast"],
    ]);
    assert.deepEqual(lines, ["NOT-EVALUATED\tgate/ally-comment-findings\tneutral\trun=app:allyblockcast"]);
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

  // BLO-34367: `cancelled` at the RUN level conflates supersession with terminal
  // cancellation, and only one of them is stale. GitHub marks a run `cancelled`
  // when any job is cancelled, and a timeout-minutes expiry IS a cancellation —
  // so keying the filter on the conclusion deletes a real STOP every time a job
  // times out. Measured on Blockcast/paperclip @ 35e15bcc, run 35249848781: the
  // sole run of its workflow at that head, `verify` failure + `policy` cancelled,
  // both dropped. Supersession is the property the filter wants, so test for it.
  describe("stale-run classification", () => {
    it("keeps a cancelled run that nothing superseded", () => {
      assert.equal(
        dead([
          ["276438379", "pull_request", "35249848781", "cancelled", "2026-09-17T17:00:00Z"], // sole run of its workflow
          ["294511598", "pull_request_target", "35249846479", "success", "2026-09-17T17:00:00Z"],
          ["315805904", "pull_request", "35249848741", "skipped", "2026-09-17T17:00:00Z"],
        ]),
        "",
      );
    });

    it("drops a cancelled run whose sibling concluded success", () => {
      // penstock-llm-proxy-core#1948 @ 157589a6 — BLO-34114's own control.
      // run_started_at are live API values: the success starts 16s LATER, so it
      // is still stale under the time-ordered rule.
      assert.equal(
        dead([
          ["286504427", "pull_request", "34542908750", "cancelled", "2026-09-10T23:36:32Z"],
          ["286504427", "pull_request", "34542929394", "success", "2026-09-10T23:36:48Z"], // 16s later, same lane
        ]),
        "34542908750",
      );
    });

    // BLO-34619. Supersession used to be proxied through `max run id == the
    // survivor`. When a workflow fires several runs at one head in the same
    // second the arbiter's survivor is not reliably the highest id — measured on
    // trafficcontrol#1870 @ 39e233c3, where it is the THIRD of four. Max-id was
    // spared as "newest", so its cancelled row printed STOP while the real
    // `success` row was dropped as stale.
    //
    // The success MUST carry a lower id than at least one cancelled run, or the
    // fixture passes on the old code. All three cancelled ids are asserted: with
    // only the two below max, the old implementation agrees and proves nothing.
    //
    // run_started_at are live API values, and the TIE is load-bearing: the
    // survivor starts 00:04:04 and two of its casualties start 00:04:04 too.
    // Under `>` instead of `>=` those two are retained and BLO-34619 re-opens.
    it("drops a cancelled run that outranks its successful sibling by id", () => {
      assert.equal(
        dead([
          ["323092531", "pull_request_target", "35408038943", "cancelled", "2026-09-19T00:04:03Z"],
          ["323092531", "pull_request_target", "35408039732", "cancelled", "2026-09-19T00:04:04Z"], // ties the survivor
          ["323092531", "pull_request_target", "35408039808", "success", "2026-09-19T00:04:04Z"],
          ["323092531", "pull_request_target", "35408039945", "cancelled", "2026-09-19T00:04:04Z"], // max id, ties too
          ["297263658", "pull_request", "35408038865", "success", "2026-09-19T00:04:03Z"],
        ]),
        "35408038943|35408039732|35408039945",
      );
    });

    // ...and the sibling test is keyed on workflow AND EVENT. Dropping `event`
    // is the tempting simplification of the rule above and it is BLO-34114's
    // masking in the run dimension: one workflow file declaring both triggers
    // fans out to two concurrent lanes with identical check-run names, and the
    // `pull_request` lane cannot reach secrets, so it passes vacuously. Without
    // `event` that vacuous success deletes a terminally-cancelled secrets lane
    // and `secret-scan` reads green.
    it("does not let a vacuous pull_request pass delete a cancelled secrets lane", () => {
      assert.equal(
        dead([
          ["286504429", "pull_request_target", "34868322890", "cancelled", "2026-09-15T16:33:00Z"], // secrets lane, timed out
          ["286504429", "pull_request", "34868326080", "success", "2026-09-15T16:37:00Z"], // vacuous lane, and LATER
        ]),
        "",
      );
    });

    it("keeps every run of a workflow whose lane never passed", () => {
      // A chain of cancel-in-progress that never produced a verdict. Nothing in
      // the lane succeeded, so nothing is provably stale and both still STOP.
      // This is also the lane-with-no-success shape that lets the END clause
      // carry no `newest_pass[...] != ""` term: an unset newest_pass loses `>=`
      // against an ISO timestamp as strings ("" < "2026-…") AND numerically
      // (0 < 2026), so it fails closed under either compare mode.
      assert.equal(
        dead([
          ["10", "push", "100", "cancelled", "2026-09-19T01:00:00Z"],
          ["10", "push", "200", "cancelled", "2026-09-19T01:05:00Z"],
        ]),
        "",
      );
    });

    // Pins `$5 > newest_pass[key]`: newest_pass must be the MAX start among a
    // lane's successes, not merely the last one seen. actions/runs returns
    // NEWEST-FIRST, so an older success trailing a newer one is the default
    // ordering rather than an exotic one — and without the max, newest_pass ends
    // up holding the OLDEST success, which fails `>=` and resurrects a genuinely
    // superseded run as a STOP. Direction is RED, and it partially reverts
    // BLO-34114's suppression. Found by mutation sweep: replacing the comparison
    // with `1` left all 55 other tests green.
    it("takes the newest sibling success, not the last one in input order", () => {
      assert.equal(
        dead([
          ["10", "push", "300", "success", "2026-09-19T02:00:00Z"], // newest, first (API order)
          ["10", "push", "200", "cancelled", "2026-09-19T01:30:00Z"], // superseded by 300
          ["10", "push", "100", "success", "2026-09-19T01:00:00Z"], // older, trails it
        ]),
        "200",
      );
    });

    // The sibling check is per workflow, not per head: an unrelated workflow's
    // success must not retire this cancel. Its run id is deliberately HIGHER and
    // its start deliberately LATER, so neither a max-id nor a time-ordered
    // implementation that lost the workflow scoping would spare this row.
    it("scopes the sibling check to one workflow", () => {
      assert.equal(
        dead([
          ["20", "push", "200", "success", "2026-09-19T01:05:00Z"], // unrelated workflow, higher id, later
          ["10", "push", "100", "cancelled", "2026-09-19T01:00:00Z"], // sole run of workflow 10
        ]),
        "",
      );
    });

    it("is silent when no run was cancelled at all", () => {
      assert.equal(dead([["10", "push", "100", "success", "2026-09-19T01:00:00Z"]]), "");
    });

    // DO NOT WIDEN THIS FILTER TO DROP A STALE `failure`. Only `cancelled` rows
    // are ever candidates. Dropping a failure that a later run of the same
    // workflow re-ran and passed is the obvious fix for a reported false RED (a
    // workflow re-running at an UNCHANGED head on a later event leaves a stale
    // failure behind — pim-multicast-gateway#3215 @ a8934c8e, review-gate on
    // pull_request_target 16:34:36Z failure, then on pull_request_review
    // 16:43:36Z success). It was implemented, measured, and REVERTED: it is
    // BLO-34114's masking moved from the name dimension to the run dimension,
    // and it cost 15 STOPs on 34114's own control including secret-scan and
    // redaction-tests.
    //
    // The premise that killed it: `pull_request` and `pull_request_target` are
    // NOT different workflow files. penstock-llm-proxy-core/.github/workflows/
    // security.yml declares BOTH triggers, so one workflow_id fans out to two
    // CONCURRENT lanes with identical check-run names and opposite verdicts —
    // and the failing one is the secrets-bearing lane. Higher run id does not
    // mean later: both are dispatched from one push and the ordering between
    // them is arbitrary. So the false RED is ACCEPTED — it costs a wait, the
    // widening costs a merge-authorizing false GREEN on security checks.
    it("keeps BOTH lanes when one workflow file fans out to two events", () => {
      // penstock-llm-proxy-core#1992 @ fbdb3477 — BLO-34114's control.
      assert.equal(
        dead([
          ["286504429", "pull_request_target", "34868322890", "failure", "2026-09-15T16:33:00Z"],
          ["286504429", "pull_request", "34868326080", "success", "2026-09-15T16:37:00Z"],
          ["286504427", "pull_request_target", "34868322979", "failure", "2026-09-15T16:33:00Z"],
          ["286504427", "pull_request", "34868326159", "success", "2026-09-15T16:37:00Z"],
        ]),
        "",
      );
    });

    it("keeps a stale failure its own workflow later re-ran and passed", () => {
      // The accepted false RED. Deliberate, not an oversight: see above.
      assert.equal(
        dead([
          ["315978042", "pull_request_target", "35369288224", "failure", "2026-09-18T16:34:36Z"],
          ["315978042", "pull_request_review", "35370168113", "success", "2026-09-18T16:43:36Z"],
        ]),
        "",
      );
    });

    // BLO-34619, the other direction. Sibling-success is a SET test; supersession
    // is DIRECTIONAL in time. Without ordering, a success that ran BEFORE the
    // cancellation deletes it — so a lane that passed and was LATER terminally
    // cancelled reads green. Measured live on trafficcontrol @ be0a7003, lane
    // 323092531/issue_comment: success 10:29:56, cancelled 11:19:06, and the run
    // that actually superseded it had produced no verdict at all.
    //
    // The success MUST carry the LOWER id here, or a max-id implementation
    // agrees and the fixture proves nothing.
    it("keeps a cancelled run whose only sibling success ran BEFORE it", () => {
      assert.equal(
        dead([
          ["900", "pull_request", "111", "success", "2026-09-19T10:29:56Z"],
          ["900", "pull_request", "222", "cancelled", "2026-09-19T11:19:06Z"],
        ]),
        "",
      );
    });

    // `== "success"` must stay exact. Relaxing it to `!= "cancelled"` is silent
    // against every other fixture in this file: the suite has run rows carrying
    // `skipped`, but none where a non-`success`, non-`cancelled` sibling is the
    // ONLY candidate in its own lane, so the condition is never exercised. A
    // `failure` sibling deleting a terminal cancellation is the exact false
    // GREEN this rule exists to prevent, and a vacuously-`skipped` lane deleting
    // the secrets lane is the BLO-34114 hazard — reachable in the run dimension
    // whenever the two lanes share an event.
    for (const conclusion of ["failure", "skipped"]) {
      it(`does not let a same-lane \`${conclusion}\` sibling retire a cancelled run`, () => {
        assert.equal(
          dead([
            ["10", "push", "100", "cancelled", "2026-09-19T01:00:00Z"],
            ["10", "push", "200", conclusion, "2026-09-19T01:05:00Z"], // later, same lane, no verdict
          ]),
          "",
        );
      });
    }

    // The two degenerate branches this PR originally claimed were safe, and
    // which the reviewer falsified against the un-ordered rule: BOTH fail once
    // an OLDER sibling success exists, because the un-ordered test cannot see
    // that the success predates the cancellation. They hold again under the
    // time-ordered rule, so they are pinned rather than left as prose.
    it("keeps a cancelled run followed only by a failure, despite an older pass", () => {
      assert.equal(
        dead([
          ["900", "pull_request", "111", "success", "2026-09-19T10:00:00Z"],
          ["900", "pull_request", "222", "cancelled", "2026-09-19T11:00:00Z"],
          ["900", "pull_request", "333", "failure", "2026-09-19T12:00:00Z"],
        ]),
        "",
      );
    });

    it("keeps a cancelled run whose actual superseder is still in flight", () => {
      // trafficcontrol @ be0a7003, lane 323092531/issue_comment, live ids and
      // times. The run that really superseded 35439779269 started 1s later and
      // had produced NO verdict; the un-ordered rule retired the cancellation on
      // the strength of a success 50 minutes older.
      assert.equal(
        dead([
          ["323092531", "issue_comment", "35437563292", "success", "2026-09-19T10:29:56Z"],
          ["323092531", "issue_comment", "35439779269", "cancelled", "2026-09-19T11:19:06Z"],
          ["323092531", "issue_comment", "35439779707", "", "2026-09-19T11:19:07Z"], // in flight
        ]),
        "",
      );
    });

    // A missing run_started_at on either side must fail CLOSED — the run is
    // kept, i.e. STOP. An absent field is never evidence that a verdict exists;
    // reading it as one is the direction that ships a merge-authorizing green.
    it("keeps a cancelled run when a timestamp is missing on either side", () => {
      assert.equal(
        dead([
          ["10", "push", "100", "cancelled", ""],
          ["10", "push", "200", "success", "2026-09-19T01:05:00Z"],
        ]),
        "",
      );
      assert.equal(
        dead([
          ["10", "push", "100", "cancelled", "2026-09-19T01:00:00Z"],
          ["10", "push", "200", "success", ""],
        ]),
        "",
      );
    });
  });

  // End to end on the measured shape. The BLO-34263 ABSENT guard cannot catch
  // this one: unrelated workflows survive, so the survivor count is non-zero and
  // the guard stays suppressed while a genuine red is deleted. That is what makes
  // this a distinct defect rather than a repeat.
  it("prints the STOPs of a terminally-cancelled run that nothing superseded", () => {
    const runs = [
      ["276438379", "pull_request", "35249848781", "cancelled", "2026-09-17T17:00:00Z"],
      ["294511598", "pull_request_target", "35249846479", "success", "2026-09-17T17:00:00Z"],
    ];
    const rows = [
      ["verify", "failure", "2026-09-17T17:13:29Z", "35249848781"],
      ["policy", "cancelled", "2026-09-17T17:09:33Z", "35249848781"],
      ["Build", "skipped", "2026-09-17T17:09:33Z", "35249848781"],
      ["commitperclip", "success", "2026-09-17T17:00:00Z", "35249846479"],
    ];
    const lines = read(rows, dead(runs) || "__none__");
    assert.deepEqual(lines.sort(), [
      "STOP\tpolicy\tcancelled\trun=35249848781",
      "STOP\tverify\tfailure\trun=35249848781",
    ]);
    // The ABSENT guard is NOT what saved us here — prove it stayed quiet.
    assert.doesNotMatch(lines.join("\n"), /ABSENT/);
  });

  // BLO-34619 end to end, on the measured shape. Blockcast/trafficcontrol#1870 @
  // 39e233c3: `review-gate` fired four pull_request_target runs inside one
  // second, and the ONE that survived is the third of four. The old max-id proxy
  // got this exactly backwards in both directions at once — it spared the
  // cancelled max-id row (false STOP) AND put the real `success` row in DEAD, so
  // the genuine verdict was discarded. Rows and ids are live API values.
  it("keeps the surviving verdict when a workflow bursts several runs at one head", () => {
    const runs = [
      ["323092531", "pull_request_target", "35408038943", "cancelled", "2026-09-19T00:04:03Z"],
      ["323092531", "pull_request_target", "35408039732", "cancelled", "2026-09-19T00:04:04Z"],
      ["323092531", "pull_request_target", "35408039808", "success", "2026-09-19T00:04:04Z"],
      ["323092531", "pull_request_target", "35408039945", "cancelled", "2026-09-19T00:04:04Z"],
      ["297263658", "pull_request", "35408038865", "success", "2026-09-19T00:04:03Z"],
    ];
    const rows = [
      ["Ally review gate", "cancelled", "2026-09-19T00:04:04Z", "35408038943"],
      ["Ally review gate", "success", "2026-09-19T00:05:35Z", "35408039808"],
      ["Ally review gate", "cancelled", "2026-09-19T00:04:05Z", "35408039945"],
      ["Migration Timestamp Lint", "success", "2026-09-19T00:07:00Z", "35408038865"],
    ];
    assert.deepEqual(read(rows, dead(runs) || "__none__"), []);
  });

  // Reviewer finding on the BLO-34263 guard: it was gated on `dead != __none__`,
  // so a head that produced NO rows at all printed nothing — the same
  // "empty output reads as all-green" shape the clause exists to close, reached
  // by a different path. Live whenever both surfaces come back empty: no workflow
  // triggered (path filters, fork PR awaiting approval, unparseable workflow
  // file), or a transient gh failure.
  describe("ABSENT fires on any absence of surviving verdicts", () => {
    it("fires on no rows at all, with nothing cancelled", () => {
      assert.deepEqual(read([]), [
        "STOP\t<no check-run verdict at this head>\tABSENT\trun=-",
      ]);
    });

    it("does not count a blank line as a surviving verdict", () => {
      assert.match(read([[]]).join("\n"), /ABSENT/);
    });

    it("keeps the two causes distinguishable", () => {
      assert.match(
        read([["verify", "failure", "t", "111"]], "111").join("\n"),
        /dropped as superseded-run/,
      );
      assert.match(read([]).join("\n"), /no check-run verdict/);
    });
  });

  // The header used to claim the reader "exits 1 exactly when the ABSENT line
  // fires and 0 when real STOP lines print". The `exactly` half is FALSE in the
  // GREEN direction, and no fixture could catch it while every fixture entry
  // point hardcoded `exit 0` — the unobservability WAS the defect. rc is a
  // one-way signal: rc 1 implies ABSENT, never the converse.
  describe("exit status is one-way: rc 1 implies ABSENT, not the converse", () => {
    it("fires ABSENT at rc 0 when an excluded App row survives the drop", () => {
      // The falsifying case. `grep -v` sees a survivor so the pipeline succeeds,
      // while the survivor count excludes App rows once anything was dropped —
      // so ABSENT prints at rc 0. Every head in this repo carries two App rows.
      const { rc, lines } = readRc(
        [
          ["gate/x", "success", "t1", "app:ally"],
          ["verify", "success", "t1", "111"],
        ],
        "111",
      );
      assert.match(lines.join("\n"), /ABSENT/);
      assert.equal(rc, 0);
    });

    it("fires ABSENT at rc 1 when the drop leaves no row at all", () => {
      const { rc, lines } = readRc([["verify", "failure", "t1", "111"]], "111");
      assert.match(lines.join("\n"), /ABSENT/);
      assert.equal(rc, 1);
    });

    it("exits 0 while printing a real STOP, so rc 0 is not a merge signal", () => {
      const { rc, lines } = readRc([["verify", "failure", "t1", "111"]]);
      assert.equal(stops(lines).length, 1);
      assert.equal(rc, 0);
    });
  });

  // Reviewer finding: capture() RAISES on a null details_url rather than failing
  // to match, so `// "app"` never sees it. jq aborts mid-stream on the raise and
  // every check-run after the null is silently dropped — including reds.
  // details_url is nullable in the REST schema and is set by whichever App
  // published the run, not by this repo.
  describe("row extraction", () => {
    const run = (o) => ({ completed_at: "t", conclusion: "success", ...o });

    it("does not truncate the stream on a null details_url", () => {
      assert.deepEqual(
        extract([
          run({ name: "a", details_url: "https://x/runs/123/job/9" }),
          run({ name: "b", conclusion: "failure", details_url: null }),
          run({ name: "c", conclusion: "failure", details_url: "https://x/runs/456/job/1" }),
        ]),
        ["a\tsuccess\tt\t123", "b\tfailure\tt\tapp:?", "c\tfailure\tt\t456"],
      );
    });

    it("falls back to `app` for a details_url with no run id", () => {
      assert.deepEqual(extract([run({ name: "gate", details_url: "https://x/apps/ally" })]), [
        "gate\tsuccess\tt\tapp:?",
      ]);
    });

    it("uses status when conclusion is null, so an in-flight run still reports", () => {
      assert.deepEqual(
        extract([
          {
            name: "e2e",
            conclusion: null,
            status: "in_progress",
            completed_at: null,
            started_at: "t0",
            details_url: "https://x/runs/9/job/1",
          },
        ]),
        ["e2e\tin_progress\tt0\t9"],
      );
    });

    // Reviewer finding: a CONSTANT app fallback collapses the dedup key to
    // name-only for every App-published row — BLO-34114's masking, one surface
    // over. Two Apps publishing the same check-run name at one head would hide
    // each other, and the survivor is whichever sorts later. The red row must
    // survive from EITHER app slug, so neither ordering passes on broken code.
    for (const [redSlug, greenSlug] of [
      ["zz-scanner", "aa-linter"],
      ["aa-scanner", "zz-linter"],
    ]) {
      it(`keys the app fallback on .app.slug (red=${redSlug})`, () => {
        const rows = extract([
          run({ name: "secret-scan", conclusion: "failure", app: { slug: redSlug } }),
          run({ name: "secret-scan", app: { slug: greenSlug } }),
        ]);
        assert.deepEqual(read(rows.map((r) => r.split("\t"))), [
          `STOP\tsecret-scan\tfailure\trun=app:${redSlug}`,
        ]);
      });
    }
  });

  // The run-row jq used to be inline in the live path, so its field ORDER — the
  // contract with dead_runs() — was reached by no fixture at all. A transposition
  // there is invisible at runtime and silently empties DEAD.
  describe("run row extraction", () => {
    it("emits fields in the order dead_runs() reads them", () => {
      assert.deepEqual(
        runExtract([
          {
            workflow_id: 323092531,
            event: "pull_request_target",
            id: 35408039808,
            conclusion: "success",
            run_started_at: "2026-09-19T00:04:04Z",
          },
        ]),
        ["323092531\tpull_request_target\t35408039808\tsuccess\t2026-09-19T00:04:04Z"],
      );
    });

    // Composed across the seam: @tsv renders a null as the empty string, and
    // dead_runs() must read that as "no timestamp" and keep the run — not as a
    // timestamp that compares low enough to retire it.
    it("renders a null run_started_at as empty, and that fails closed", () => {
      const rows = runExtract([
        { workflow_id: 10, event: "push", id: 100, conclusion: "cancelled", run_started_at: null },
        {
          workflow_id: 10,
          event: "push",
          id: 200,
          conclusion: "success",
          run_started_at: "2026-09-19T01:05:00Z",
        },
      ]);
      assert.equal(rows[0], "10\tpush\t100\tcancelled\t");
      assert.equal(dead(rows.map((r) => r.split("\t"))), "");
    });
  });

  // Reviewer finding: the legacy-status surface was fetched with neither
  // per_page nor --paginate while the check-run surface one line below had
  // both. GitHub's default page size is 30, so a head with >30 contexts
  // silently loses the remainder, and a dropped `failure` prints no STOP.
  // The ABSENT guard cannot catch it — `:52` excludes status rows from the
  // survivor count, so one surviving check-run keeps it quiet. Direction: GREEN.
  describe("legacy status surface", () => {
    // Asserted over EVERY list fetch, not just the status one: the check-run and
    // actions/runs calls carry the same silent-truncation risk, and neither had a
    // guard until this finding. The single-object commit lookup is the only
    // exemption.
    it("treats an empty DEAD alternation as __none__", () => {
      // The live path pipes dead_runs() straight in and it prints NOTHING when
      // no run is stale, so the empty case is on the hot path. Normalising in
      // verdicts() rather than at the call site is what makes it reachable by a
      // fixture at all. Empty is not inert: `()` is an empty sub-expression,
      // read by GNU grep as "matches empty" and rejected outright by ugrep, and
      // either way `dead` then misses the `__none__` arm so the App-row
      // exclusion engages. The App-only row is the portable discriminator — it
      // turns on the awk arm rather than on the local grep's flavour.
      const appOnly = [["gate/ally-comment-findings", "success", "t1", "app:allyblockcast"]];
      assert.deepEqual(read(appOnly, ""), []);
      assert.deepEqual(read(appOnly, ""), read(appOnly, "__none__"));
    });

    it("paginates every list fetch", () => {
      const fetches = SOURCE.split("\n").filter(
        (l) => l.includes('gh api "repos/') && !l.includes("/commits/$2"),
      );
      assert.equal(fetches.length, 3, `unguarded fetch added? got ${JSON.stringify(fetches)}`);
      for (const call of fetches) {
        assert.match(call, /per_page=100/, call);
        assert.match(call, /--paginate/, call);
      }
    });

    // --paginate emits one object per page, so the extraction must stream every
    // status of every page. Two per page deliberately: with one, a truncating
    // extractor still emits one row per page and the fixture passes on broken code.
    it("extracts every row of every page", () => {
      assert.deepEqual(
        statusExtract([
          {
            statuses: [
              { context: "ci-gate", state: "success", updated_at: "t1" },
              { context: "build", state: "success", updated_at: "t2" },
            ],
          },
          {
            statuses: [
              { context: "review/ally", state: "failure", updated_at: "t3" },
              { context: "sign", state: "pending", updated_at: "t4" },
            ],
          },
        ]),
        [
          "ci-gate\tsuccess\tt1\tstatus",
          "build\tsuccess\tt2\tstatus",
          "review/ally\tfailure\tt3\tstatus",
          "sign\tpending\tt4\tstatus",
        ],
      );
    });
  });

  // Reviewer finding: `gh api` prints its error body to STDOUT, so a failed
  // commit lookup leaves H as a JSON blob rather than empty. It failed closed
  // by accident — the malformed URL broke both later calls and the reader said
  // ABSENT — but that misattributes a LOOKUP failure to an absent surface,
  // which is the one distinction the ABSENT wording was split to preserve.
  describe("head sha guard", () => {
    it("accepts a full 40-hex sha", () => {
      assert.equal(shaGuard("4e62193a169ece35ff5c7076362ecb1aaa53c1ee").rc, 0);
    });

    for (const [label, bad] of [
      ["a gh error body on stdout", '{"message":"No commit found for SHA: zzz"}'],
      ["an abbreviation", "4e62193"],
      ["an empty string", ""],
      ["41 hex chars", "4e62193a169ece35ff5c7076362ecb1aaa53c1eef"],
    ]) {
      it(`stops with LOOKUP-FAILED on ${label}`, () => {
        const { rc, out } = shaGuard(bad);
        assert.equal(rc, 1);
        assert.match(out, /^STOP\t.*\tLOOKUP-FAILED\trun=-$/m);
        assert.doesNotMatch(out, /ABSENT/);
      });
    }

    // The cases above exercise the FUNCTION; none of them exercises the CALL.
    // Deleting `require_sha "$H" || exit 1` from the live path left every one of
    // them green — found by a mutation run. The live path cannot be driven
    // without mocking `gh`, so assert the invocation on the source, in the same
    // style as the pagination check, and require it to precede the fetches that
    // interpolate $H.
    it("invokes the guard on the resolved head before any fetch uses it", () => {
      const lines = SOURCE.split("\n");
      const guarded = lines.findIndex((l) => /^require_sha "\$H" \|\| exit 1$/.test(l));
      const firstUse = lines.findIndex((l) => l.includes('gh api "repos/$R/') && l.includes("$H"));
      assert.ok(guarded > 0, "live path does not call require_sha on $H");
      assert.ok(firstUse > guarded, `a fetch at line ${firstUse} uses $H before the guard`);
    });
  });
});

