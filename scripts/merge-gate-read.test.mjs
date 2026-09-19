import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const READER = fileURLToPath(new URL("./merge-gate-read.sh", import.meta.url));

/** Run the canonical reader's verdict pipeline over fixture rows. */
function read(rows, dead = "__none__") {
  const stdin = rows.length ? rows.map((r) => r.join("\t")).join("\n") + "\n" : "";
  const out = execFileSync("bash", [READER, "--rows", dead], { input: stdin, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
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
          ["276438379", "35249848781", "cancelled"], // sole run of its workflow
          ["294511598", "35249846479", "success"],
          ["315805904", "35249848741", "skipped"],
        ]),
        "",
      );
    });

    it("drops a cancelled run that a newer run of the same workflow replaced", () => {
      // penstock-llm-proxy-core#1948 @ 157589a6 — BLO-34114's own control.
      assert.equal(
        dead([
          ["286504427", "34542908750", "cancelled"],
          ["286504427", "34542929394", "success"], // 16s later, same workflow
        ]),
        "34542908750",
      );
    });

    it("keeps the newest run of a workflow even when it is itself cancelled", () => {
      // A chain of cancel-in-progress: only the last one still speaks for the head.
      assert.equal(
        dead([
          ["10", "100", "cancelled"],
          ["10", "200", "cancelled"],
        ]),
        "100",
      );
    });

    // "Newest" is per workflow, not per head. The cancelled run must carry the
    // LOWER run id: "newest" is max id, so a global (ungrouped) newest-check
    // spares whichever run id is highest at the head and would mark this one
    // stale. With the ids the other way round both implementations agree and the
    // fixture passes on broken code — it did, until a mutation run caught it.
    it("scopes the newest-run check to one workflow", () => {
      assert.equal(
        dead([
          ["20", "200", "success"], // unrelated workflow, higher id
          ["10", "100", "cancelled"], // sole run of workflow 10 — not superseded
        ]),
        "",
      );
    });

    it("is silent when no run was cancelled at all", () => {
      assert.equal(dead([["10", "100", "success"]]), "");
    });

    // DO NOT WIDEN THIS FILTER TO "newest run id per workflow wins". It is the
    // obvious fix for a reported false RED (a workflow that re-runs at an
    // UNCHANGED head on a later event leaves a stale `failure` behind —
    // pim-multicast-gateway#3215 @ a8934c8e, review-gate on pull_request_target
    // 16:34:36Z failure, then on pull_request_review 16:43:36Z success). It was
    // implemented, measured, and REVERTED: it is BLO-34114's masking moved from
    // the name dimension to the run dimension, and it cost 15 STOPs on 34114's
    // own control including secret-scan and redaction-tests.
    //
    // The premise that killed it: `pull_request` and `pull_request_target` are
    // NOT different workflow files. penstock-llm-proxy-core/.github/workflows/
    // security.yml declares BOTH triggers, so one workflow_id fans out to two
    // CONCURRENT lanes with identical check-run names and opposite verdicts —
    // and the failing one is the secrets-bearing lane, because the pull_request
    // lane cannot reach secrets and passes vacuously. Higher run id does not
    // mean later: both are dispatched from one push and the ordering between
    // them is arbitrary.
    //
    // Those two shapes are indistinguishable in this function's input: both are
    // one workflow_id, two events, pull_request_target failed, something else
    // succeeded. No predicate over (workflow_id, run id, conclusion) separates
    // them, so the false RED is ACCEPTED — it costs a wait, the widening costs a
    // merge-authorizing false GREEN on security checks.
    it("keeps BOTH lanes when one workflow file fans out to two events", () => {
      // penstock-llm-proxy-core#1992 @ fbdb3477 — BLO-34114's control.
      assert.equal(
        dead([
          ["286504429", "34868322890", "failure"], // security, pull_request_target
          ["286504429", "34868326080", "success"], // security, pull_request
          ["286504427", "34868322979", "failure"], // ci, pull_request_target
          ["286504427", "34868326159", "success"], // ci, pull_request
        ]),
        "",
      );
    });

    it("keeps a stale failure its own workflow later re-ran and passed", () => {
      // The accepted false RED. Deliberate, not an oversight: see above.
      assert.equal(
        dead([
          ["315978042", "35369288224", "failure"],
          ["315978042", "35370168113", "success"],
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
      ["276438379", "35249848781", "cancelled"],
      ["294511598", "35249846479", "success"],
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
  });
});

