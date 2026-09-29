import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLY_APP_REVIEWER_ID,
  ALLY_APP_REVIEWER_LOGIN,
  ALLY_USER_REVIEWER_ID,
  ALLY_USER_REVIEWER_LOGIN,
} from "./check-ally-review-consistency.mjs";
import { exactHeadAppReviews, selectDuplicateDismissals } from "./ally-review-de-dupe.mjs";

/** onprem-k8s#3281's head, the incident this module exists for (BLO-32837). */
const HEAD = "b108db2ff1e4c0a9d7b3e5148a27c6d90fe4318b";
const OTHER = "ff1c72dbfd18014c838cf1373b1640dd17378f3e";

function body(head = HEAD, criticals = 0, importants = 0) {
  return [
    "## Ally — Consolidated PR Review",
    "",
    `Reviewed head: ${head}`,
    "",
    `### Critical Issues (${criticals})`,
    `### Important Issues (${importants})`,
  ].join("\n");
}

function review(overrides = {}) {
  return {
    id: 1,
    state: "APPROVED",
    // Deliberately the WRONG head. `commit_id` is re-anchored forward on
    // APPROVED reviews (BLO-34581), so every fixture here carries a stale one
    // to prove selection never consults it.
    commit_id: OTHER,
    submitted_at: "2026-09-08T20:10:12Z",
    user: { login: ALLY_APP_REVIEWER_LOGIN, id: ALLY_APP_REVIEWER_ID, type: "Bot" },
    body: body(),
    ...overrides,
  };
}

/** The two reviews GitHub actually recorded on onprem-k8s#3281. */
const OLDER = review({ id: 5146530564, submitted_at: "2026-09-08T20:10:12Z" });
const NEWER = review({ id: 5146534396, submitted_at: "2026-09-08T20:10:36Z" });

describe("selectDuplicateDismissals", () => {
  it("regression BLO-32837: retains the NEWER duplicate and never dismisses it", () => {
    for (const order of [
      [OLDER, NEWER],
      [NEWER, OLDER],
    ]) {
      const decision = selectDuplicateDismissals(order, HEAD);

      assert.equal(decision.reason, "duplicate");
      assert.equal(decision.retain.id, NEWER.id);
      assert.deepEqual(
        decision.dismiss.map((r) => r.id),
        [OLDER.id],
        "the older review is the only dismissal target",
      );
      assert.ok(
        !decision.dismiss.some((r) => r.id === NEWER.id),
        "dismissing the newest is what left #3281 at reviewDecision=REVIEW_REQUIRED",
      );
    }
  });

  it("keeps the retained review operative and opinionated", () => {
    const { retain } = selectDuplicateDismissals([OLDER, NEWER], HEAD);
    assert.equal(retain.state, "APPROVED");
    assert.ok(!["DISMISSED", "PENDING"].includes(retain.state));
  });

  it("retains only the newest when more than two duplicates exist", () => {
    const newest = review({ id: 3, submitted_at: "2026-09-08T20:11:00Z" });
    const decision = selectDuplicateDismissals([OLDER, newest, NEWER], HEAD);

    assert.equal(decision.retain.id, newest.id);
    assert.deepEqual(decision.dismiss.map((r) => r.id).sort(), [NEWER.id, OLDER.id].sort());
  });

  it("breaks a submitted_at tie on id so the choice is never order-dependent", () => {
    const a = review({ id: 10, submitted_at: "2026-09-08T20:10:12Z" });
    const b = review({ id: 11, submitted_at: "2026-09-08T20:10:12Z" });

    assert.equal(selectDuplicateDismissals([a, b], HEAD).retain.id, 11);
    assert.equal(selectDuplicateDismissals([b, a], HEAD).retain.id, 11);
  });

  it("refuses to pick a winner when the verdicts conflict", () => {
    const blocking = review({
      id: 2,
      state: "COMMENTED",
      submitted_at: "2026-09-08T20:10:36Z",
      body: body(HEAD, 1, 0),
    });
    const decision = selectDuplicateDismissals([OLDER, blocking], HEAD);

    assert.equal(decision.reason, "conflicting-verdicts");
    assert.deepEqual(decision.dismiss, [], "supersession is a blocker decision, not a de-dupe");
    assert.equal(decision.retain, null);
  });

  // App-authored PRs: GitHub bars the author from APPROVE, so a clean and a
  // blocking self-review are BOTH COMMENTED and a state-only comparison sees
  // one verdict. The dismissal target was the review carrying the blockers.
  it("refuses when two COMMENTED reviews disagree on blocking findings", () => {
    const blocking = review({
      id: 111,
      state: "COMMENTED",
      submitted_at: "2026-09-08T20:10:12Z",
      body: body(HEAD, 2, 0),
    });
    const clean = review({ id: 222, state: "COMMENTED", submitted_at: "2026-09-08T20:10:36Z" });

    for (const order of [
      [blocking, clean],
      [clean, blocking],
    ]) {
      const decision = selectDuplicateDismissals(order, HEAD);
      assert.equal(decision.reason, "conflicting-verdicts");
      assert.deepEqual(decision.dismiss, [], "the review carrying the blockers must survive");
      assert.equal(decision.retain, null);
    }
  });

  it("treats a still-present prior disposition as a blocking verdict", () => {
    const stillPresent = review({
      id: 111,
      state: "COMMENTED",
      submitted_at: "2026-09-08T20:10:12Z",
      body: `${body()}\n\n- **prior: guard keys on state** - still-present - not fixed at this head`,
    });
    const clean = review({ id: 222, state: "COMMENTED", submitted_at: "2026-09-08T20:10:36Z" });

    assert.equal(selectDuplicateDismissals([stillPresent, clean], HEAD).reason, "conflicting-verdicts");
  });

  it("emits no dismissal for an all-COMMENTED duplicate pair", () => {
    // A COMMENTED review carries no reviewDecision weight, so dismissing one
    // repairs nothing; the documented procedure dismisses whatever `dismiss`
    // lists, so it must stay empty rather than rely on the API refusing it.
    const older = review({ id: 111, state: "COMMENTED", submitted_at: "2026-09-08T20:10:12Z" });
    const newer = review({ id: 222, state: "COMMENTED", submitted_at: "2026-09-08T20:10:36Z" });

    for (const order of [
      [older, newer],
      [newer, older],
    ]) {
      const decision = selectDuplicateDismissals(order, HEAD);
      assert.equal(decision.reason, "commented-only");
      assert.deepEqual(decision.dismiss, []);
      assert.equal(decision.retain, null);
    }
  });

  it("never dismisses a canonical review in favour of a newer non-canonical one", () => {
    const genuine = review({ id: 555, submitted_at: "2026-09-08T20:10:12Z" });
    const doubleAttested = review({
      id: 444,
      submitted_at: "2026-09-08T20:10:36Z",
      body: `${body()}\n\n\`\`\`\nReviewed head: ${HEAD}\n\`\`\``,
    });
    const decision = selectDuplicateDismissals([genuine, doubleAttested], HEAD);

    assert.equal(decision.reason, "no-duplicate");
    assert.equal(decision.retain.id, genuine.id);
    assert.deepEqual(decision.dismiss, []);
  });

  it("refuses when a candidate cannot be ordered", () => {
    const undated = review({ id: 2, submitted_at: null });
    const decision = selectDuplicateDismissals([OLDER, undated], HEAD);

    assert.equal(decision.reason, "unorderable");
    assert.deepEqual(decision.dismiss, []);
  });

  it("reports no duplicate for a single review, and none for an empty list", () => {
    assert.equal(selectDuplicateDismissals([OLDER], HEAD).reason, "no-duplicate");
    assert.deepEqual(selectDuplicateDismissals([OLDER], HEAD).dismiss, []);
    assert.equal(selectDuplicateDismissals([], HEAD).reason, "none");
    assert.equal(selectDuplicateDismissals(undefined, HEAD).reason, "none");
  });

  it("dismisses nothing when the head is not a full 40-hex SHA", () => {
    // An abbreviated head is the likely caller mistake, and guessing which
    // full SHA it meant is the one thing this module must never do.
    for (const bad of ["b108db2", "", null, undefined, `${HEAD}00`]) {
      assert.equal(selectDuplicateDismissals([OLDER, NEWER], bad).reason, "none");
    }
  });

  it("normalizes an upper-case head rather than failing closed on it", () => {
    assert.equal(selectDuplicateDismissals([OLDER, NEWER], HEAD.toUpperCase()).retain.id, NEWER.id);
  });
});

describe("CLI", () => {
  // The first cut called a bare `isMainModule()`. Its default `import.meta.url`
  // is evaluated in the module that DEFINES it, so it compared argv[1] against
  // check-ally-review-consistency's URL, never matched, and the CLI exited 0
  // having printed nothing — a silent no-op that library tests cannot see.
  it("emits a decision on stdout", () => {
    const run = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./ally-review-de-dupe.mjs", import.meta.url)), HEAD],
      { input: JSON.stringify([OLDER, NEWER]), encoding: "utf8" },
    );

    assert.equal(run.status, 0, run.stderr);
    const decision = JSON.parse(run.stdout);
    assert.equal(decision.reason, "duplicate");
    assert.equal(decision.retain.id, NEWER.id);
    assert.deepEqual(decision.dismiss.map((r) => r.id), [OLDER.id]);
  });

  it("decodes stdin as one UTF-8 stream, not per chunk", () => {
    // Node reads a stdin pipe in 64 KiB chunks. Decoding each chunk on its own
    // turns a multi-byte character split across a boundary into U+FFFD, and
    // every Ally body carries em-dashes in its heading and disposition markers.
    // Each case starts a 3-byte em-dash 2 bytes before the first boundary.
    const boundary = 64 * 1024;
    const stillPresent = review({
      id: 111,
      body: `${body()}\n\n- **prior: guard keys on state** \u2014 still-present \u2014 not fixed at this head`,
    });
    const clean = review({ id: 222, submitted_at: "2026-09-08T20:10:36Z" });
    const cases = [
      // Fails open: the corrupted marker merges two verdicts and dismisses the blocker.
      { reviews: [stillPresent, clean], needle: "\u2014 still-present", reason: "conflicting-verdicts", dismiss: [] },
      // Fails closed: the corrupted heading drops the newer review from the candidates.
      { reviews: [OLDER, NEWER], needle: "\u2014 Consolidated", occurrence: 1, reason: "duplicate", dismiss: [OLDER.id] },
    ];

    for (const { reviews, needle, occurrence = 0, reason, dismiss } of cases) {
      // A non-Ally review ahead of the fixture pads the needle onto the boundary.
      const filler = (length) => ({ id: 1, state: "COMMENTED", user: { login: "octocat", id: 583231 }, body: "x".repeat(length) });
      const offsetOf = (json) => {
        let at = -1;
        for (let i = 0; i <= occurrence; i += 1) at = Buffer.from(json).indexOf(needle, at + 1);
        return at;
      };
      const input = JSON.stringify([filler(boundary - 2 - offsetOf(JSON.stringify([filler(0), ...reviews]))), ...reviews]);
      assert.equal(offsetOf(input), boundary - 2);

      const run = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./ally-review-de-dupe.mjs", import.meta.url)), HEAD],
        { input, encoding: "utf8" },
      );

      assert.equal(run.status, 0, run.stderr);
      const decision = JSON.parse(run.stdout);
      assert.equal(decision.reason, reason, needle);
      assert.deepEqual(decision.dismiss.map((r) => r.id), dismiss, needle);
    }
  });

  it("refuses without a head argument", () => {
    const run = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./ally-review-de-dupe.mjs", import.meta.url))],
      { input: "[]", encoding: "utf8" },
    );
    assert.equal(run.status, 2);
  });
});

describe("exactHeadAppReviews", () => {
  it("matches on the body attestation, not the mutable commit_id", () => {
    // Re-anchored onto HEAD by a branch update, but it read OTHER.
    const reAnchored = review({ id: 2, commit_id: HEAD, body: body(OTHER) });
    // Attests HEAD while commit_id still points at the tree before the update.
    const attestsHead = review({ id: 3, commit_id: OTHER, body: body(HEAD) });

    assert.deepEqual(
      exactHeadAppReviews([reAnchored, attestsHead], HEAD).map((r) => r.id),
      [attestsHead.id],
    );
  });

  it("excludes dismissed and pending reviews", () => {
    const candidates = exactHeadAppReviews(
      [
        review({ id: 2, state: "DISMISSED" }),
        review({ id: 3, state: "PENDING" }),
        review({ id: 4 }),
      ],
      HEAD,
    );
    assert.deepEqual(candidates.map((r) => r.id), [4]);
  });

  it("excludes the User seat, which R4 bars from reviewing at all", () => {
    const seat = review({
      id: 2,
      user: { login: ALLY_USER_REVIEWER_LOGIN, id: ALLY_USER_REVIEWER_ID, type: "User" },
    });
    assert.deepEqual(exactHeadAppReviews([seat], HEAD), []);
  });

  it("excludes a lookalike that copies the login but not the REST id", () => {
    const lookalike = review({
      id: 2,
      user: { login: ALLY_APP_REVIEWER_LOGIN, id: 1, type: "Bot" },
    });
    assert.deepEqual(exactHeadAppReviews([lookalike], HEAD), []);
  });

  it("excludes a body that I3 would report as not canonical", () => {
    const twoAttestations = review({
      id: 2,
      body: `${body()}\n\n\`\`\`\nReviewed head: ${HEAD}\n\`\`\``,
    });
    const noHeading = review({ id: 3, body: `Reviewed head: ${HEAD}\n\n### Critical Issues (0)` });

    assert.deepEqual(exactHeadAppReviews([twoAttestations, noHeading, review({ id: 4 })], HEAD).map((r) => r.id), [4]);
  });

  it("ignores a body with no attestation at all", () => {
    assert.deepEqual(exactHeadAppReviews([review({ id: 2, body: "looks good" })], HEAD), []);
  });
});
