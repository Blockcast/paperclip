import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildTerminalGateHumanOnlyComment,
  buildTerminalGateResolvedComment,
  listResolvedTerminalGates,
  parseHumanGateSubject,
  parseTerminalGateSignal,
  readIssueMonitorGateSignals,
  reconcileTerminalGates,
  resolveTerminalGate,
  terminalGateHeldIdempotencyKey,
  terminalGateHumanOnlyIdempotencyKey,
  terminalGateResolutionIdempotencyKey,
  type ReadPullRequestGate,
} from "../services/terminal-gate-reconciler.js";

// BLO-27515. Worked example these tests replay: BLO-24166's monitor last polled
// `merged=NO` at 2026-08-12T23:20:27.842Z; Blockcast/paperclip#1281 merged
// 16 minutes later at 23:36:22Z; polling had already stopped, so nothing ever
// re-read the gate and the issue sat complete-but-open for 2d8h.
const LAST_POLL_AT = new Date("2026-08-12T23:20:27.842Z");
const MERGED_AT = new Date("2026-08-12T23:36:22.000Z");
const NOW = new Date("2026-08-15T08:00:00.000Z");

function mergedReader(mergedPrs: ReadonlySet<string>): ReadPullRequestGate {
  return async ({ repoFullName, prNumber }) =>
    mergedPrs.has(`${repoFullName}#${prNumber}`)
      ? { state: "closed", merged: true }
      : { state: "open", merged: false };
}

describe("parseTerminalGateSignal", () => {
  it("parses a pull-request gate token in the convention the validator documents", () => {
    // Signals are lowercased by `normalizeGateToken` before they are stored, so
    // the parser sees the lowercased form of `pr:Blockcast/paperclip#1281:merged`.
    expect(parseTerminalGateSignal("pr:blockcast/paperclip#1281:merged")).toEqual({
      kind: "pull_request",
      raw: "pr:blockcast/paperclip#1281:merged",
      repoFullName: "blockcast/paperclip",
      prNumber: 1281,
      aspect: "merged",
    });
  });

  it("parses the other documented aspects", () => {
    for (const aspect of ["checks", "review", "merged"]) {
      const parsed = parseTerminalGateSignal(`pr:example/repo#7:${aspect}`);
      expect(parsed).toMatchObject({ kind: "pull_request", aspect, prNumber: 7 });
    }
  });

  it("reports anything that is not a pull-request gate as unresolvable rather than guessing", () => {
    for (const token of ["deploy:paperclip-api", "pr:blockcast/paperclip:merged", "pr:nope#1:merged", ""]) {
      const parsed = parseTerminalGateSignal(token);
      expect(parsed === null || parsed.kind === "unresolvable").toBe(true);
    }
  });

  // PEN-4545. A human-gate token is no more *readable* than an infra token —
  // the split is about who can ever clear it, because that decides whether
  // waiting is a strategy or is itself the failure.
  it("classifies a token naming a human decision as `human_gate`, not `unresolvable`", () => {
    expect(parseTerminalGateSignal("omar-go:#2686")).toEqual({
      kind: "human_gate",
      raw: "omar-go:#2686",
      subjectPullRequestNumber: 2686,
      holdProtocol: true,
    });
    for (const token of [
      "omar-go",
      "hold-lift:#2688",
      "human-go:pen-4475",
      "approval:dcb2b957",
      "board-approval:6b0a2bff",
      "card:dcb2b957",
      "signoff:security",
      "cto-ruling:pen-4545",
      // PEN-2619's live token — the `hold:` prefix the first cut of the
      // allowlist left out while claiming to be drawn from measured tokens.
      "hold:f35d6c:pr-2655:omar-go",
    ]) {
      expect(parseTerminalGateSignal(token)).toMatchObject({ kind: "human_gate" });
    }
  });

  // The hold protocol is a strict subset of the human-gate allowlist, and the
  // split is what licenses the two inferences the subject join feeds. A token
  // misfiled into the hold subset would be discharged by a merge it has no
  // relationship to.
  it("marks only hold-protocol tokens as hold-protocol", () => {
    for (const token of [
      "omar-go:#2686",
      "hold:f35d6c:pr-2655:omar-go",
      "hold-lift:#2688",
      "hold-lifted:#2688",
      "human-go:pen-4475",
      "founder-go:#1",
    ]) {
      expect(parseTerminalGateSignal(token)).toMatchObject({ holdProtocol: true });
    }
    // A decision a person must make, with no claim that it precedes any merge.
    for (const token of [
      "approval:dcb2b957",
      "board-approval:6b0a2bff",
      "card:dcb2b957",
      "signoff:pr-2686",
      "sign-off:pr-2686",
      "cto-ruling:pen-4545",
      "ceo-ruling:pen-4545",
    ]) {
      expect(parseTerminalGateSignal(token)).toMatchObject({
        kind: "human_gate",
        holdProtocol: false,
      });
    }
  });

  // The join that lets the resolver tell "this person gates THIS pull request"
  // from "this person gates something else". Both spellings are live: PEN-4475
  // writes `#2686`, PEN-2619 writes `pr-2655`.
  it("reads the pull request a human-gate token names, in both spellings the fleet writes", () => {
    expect(parseHumanGateSubject("omar-go:#2686")).toBe(2686);
    expect(parseHumanGateSubject("hold:f35d6c:pr-2655:omar-go")).toBe(2655);
    expect(parseHumanGateSubject("hold-lift:#6493")).toBe(6493);
  });

  it("refuses to guess a subject it cannot read unambiguously", () => {
    for (const token of [
      "omar-go", // names nothing
      "approval:dcb2b957", // an opaque card id, not a pull request
      "human-go:pen-4475", // an issue key, not a pull request
      "hold:f35d6c", // a session id whose digits are not a pull request
      "omar-go:#2686:#2688", // two subjects — ambiguous, so neither
    ]) {
      expect(parseHumanGateSubject(token)).toBeNull();
    }
  });

  it("keeps machine-resolvable infra tokens OUT of the human-gate class", () => {
    // These are unparseable *here* but the assignee's own poll does resolve
    // them, and no human is expected to clear them. Announcing "waiting on a
    // person" over one would be a false claim, so the allowlist must not widen
    // to "anything unparseable". Census from `listCandidateIssues`.
    for (const token of [
      "mq:drained",
      "heap:stable",
      "argo:synced",
      "cron:nightly",
      "insync:true",
      "deploy:landed",
      "deploy:paperclip-api",
    ]) {
      expect(parseTerminalGateSignal(token)).toMatchObject({ kind: "unresolvable" });
    }
  });
});

describe("resolveTerminalGate", () => {
  it("is satisfied when every declared pull-request gate is merged", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });
    expect(verdict).toEqual({
      kind: "satisfied",
      signals: ["pr:blockcast/paperclip#1281:merged"],
      mergedPullRequests: ["blockcast/paperclip#1281"],
      dischargedHumanGates: [],
    });
  });

  it("treats merge as satisfying a :checks gate — merge is strictly stronger than any PR sub-gate", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#1281:checks"],
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });
    expect(verdict.kind).toBe("satisfied");
  });

  it("is unresolved while the pull request is still open", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "pull_request_open" });
  });

  it("does NOT treat a pull request closed without merging as satisfied", async () => {
    // Terminal, but the work did not land. It must not read as "done, go close
    // the issue" and must not suppress oversight.
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      readPullRequestGate: async () => ({ state: "closed", merged: false }),
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "pull_request_closed_unmerged" });
  });

  it("refuses to partially resolve: one unparseable signal leaves the whole issue unresolved", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#1281:merged", "deploy:paperclip-api"],
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "unresolvable_signal" });
  });

  // PEN-4545: the verdict between "satisfied" and "unresolved". The human gate
  // here names an artifact that is NOT among the declared pull requests, so
  // nothing discharges it and a person really is all that remains.
  it("reports `human_gate_only` when the machine half is satisfied and a person is all that remains", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["approval:dcb2b957", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      readPullRequestGate: mergedReader(new Set(["blockcast/penstock-llm-proxy-core#2686"])),
    });
    expect(verdict).toEqual({
      kind: "human_gate_only",
      signals: ["approval:dcb2b957", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      humanGates: ["approval:dcb2b957"],
      heldPullRequests: [],
      mergedPullRequests: ["blockcast/penstock-llm-proxy-core#2686"],
    });
  });

  // ---------------------------------------------------------------------
  // The ordering defect caught reviewing #2974, and the reason the two tests
  // below assert the opposite of what the first cut asserted.
  //
  // `omar-go:#2686` beside `pr:...#2686:merged` is one statement, not two: a
  // person must release THAT pull request. The first cut read the two tokens
  // independently, which inverted the notice end to end. While #2686 was open
  // — the entire time the row was blocked on a person — the resolver returned
  // `unresolved/pull_request_open` and the sweep skipped it in silence. The
  // notice could fire only once #2686 merged, which under the hold protocol
  // means the go had already been given, and it then told the owner to
  // "escalate the ask" for a decision already made.
  // ---------------------------------------------------------------------

  it("announces the human gate WHILE the pull request it names is open — the live wait", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(verdict).toEqual({
      kind: "human_gate_only",
      signals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      humanGates: ["omar-go:#2686"],
      heldPullRequests: ["blockcast/penstock-llm-proxy-core#2686"],
      mergedPullRequests: [],
    });
  });

  it("treats the merge of the named pull request as discharging the gate, not as the moment to chase it", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      readPullRequestGate: mergedReader(new Set(["blockcast/penstock-llm-proxy-core#2686"])),
    });
    expect(verdict).toEqual({
      kind: "satisfied",
      signals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      mergedPullRequests: ["blockcast/penstock-llm-proxy-core#2686"],
      dischargedHumanGates: ["omar-go:#2686"],
    });
  });

  it("discharges PEN-2619's `hold:` spelling the same way", async () => {
    const signals = [
      "hold:f35d6c:pr-2655:omar-go",
      "pr:blockcast/penstock-llm-proxy-core#2655:merged",
    ];
    expect(
      await resolveTerminalGate({
        gateSignals: signals,
        readPullRequestGate: mergedReader(new Set()),
      }),
    ).toMatchObject({
      kind: "human_gate_only",
      heldPullRequests: ["blockcast/penstock-llm-proxy-core#2655"],
    });
    expect(
      await resolveTerminalGate({
        gateSignals: signals,
        readPullRequestGate: mergedReader(new Set(["blockcast/penstock-llm-proxy-core#2655"])),
      }),
    ).toMatchObject({
      kind: "satisfied",
      dischargedHumanGates: ["hold:f35d6c:pr-2655:omar-go"],
    });
  });

  // The discharge inference is "the merge could not have preceded the go", and
  // that is a property of the HOLD PROTOCOL, not of human gates generally. A
  // `signoff:`/`approval:`/`card:`/`*-ruling:` token can name a decision due
  // AFTER the merge — `signoff:pr-2686:rollout`, `approval:prod-deploy` — so
  // discharging it would resolve a still-standing human gate to `satisfied`
  // and post "nothing left to chase" over a decision nobody has made.
  it("does NOT discharge a standing human gate when the pull request it names merges", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#2686:merged", "signoff:pr-2686"],
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#2686"])),
    });
    expect(verdict).toEqual({
      kind: "human_gate_only",
      signals: ["pr:blockcast/paperclip#2686:merged", "signoff:pr-2686"],
      humanGates: ["signoff:pr-2686"],
      heldPullRequests: [],
      mergedPullRequests: ["blockcast/paperclip#2686"],
    });
  });

  it("covers every standing prefix, so none can be moved into the hold subset unnoticed", async () => {
    for (const token of [
      "approval:pr-2686",
      "board-approval:pr-2686",
      "card:pr-2686",
      "signoff:pr-2686",
      "sign-off:pr-2686",
      "cto-ruling:pr-2686",
      "ceo-ruling:pr-2686",
    ]) {
      expect(
        await resolveTerminalGate({
          gateSignals: ["pr:blockcast/paperclip#2686:merged", token],
          readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#2686"])),
        }),
      ).toMatchObject({ kind: "human_gate_only", humanGates: [token] });
    }
  });

  // The other half of the same restriction: "this pull request is open because
  // a person has not released it" is a claim about WHY it is open, and only
  // the hold protocol establishes it. Everything else keeps the fail-closed
  // silence it had before the join existed.
  it("does NOT read a pull request as held open by a standing human gate", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#2686:merged", "signoff:pr-2686"],
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "pull_request_open" });
  });

  it("discharges the hold gate and keeps a standing gate on the same row", async () => {
    // Mixed set: the merge proves the go arrived, and says nothing at all
    // about the signoff. The row is announced for the signoff alone.
    const verdict = await resolveTerminalGate({
      gateSignals: [
        "omar-go:#2686",
        "pr:blockcast/paperclip#2686:merged",
        "signoff:security",
      ],
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#2686"])),
    });
    expect(verdict).toMatchObject({
      kind: "human_gate_only",
      humanGates: ["signoff:security"],
      mergedPullRequests: ["blockcast/paperclip#2686"],
    });
  });

  it("holds open only the pull request the gate NAMES, never a co-declared one", async () => {
    // #2686 is held by the person; #1281 is open on its own account, so the
    // row IS still waiting on something a re-check can change and must stay
    // silent. Getting this wrong would announce over the whole polling fleet.
    const verdict = await resolveTerminalGate({
      gateSignals: [
        "omar-go:#2686",
        "pr:blockcast/penstock-llm-proxy-core#2686:merged",
        "pr:blockcast/paperclip#1281:merged",
      ],
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "pull_request_open" });
  });

  it("refuses to discharge a bare number two repositories both declare", async () => {
    // `#2686` carries no repository. With two candidates the join is
    // ambiguous, so the gate stays unjoined and the row keeps the behaviour it
    // had before the join existed.
    const verdict = await resolveTerminalGate({
      gateSignals: [
        "omar-go:#2686",
        "pr:blockcast/paperclip#2686:merged",
        "pr:blockcast/penstock-llm-proxy-core#2686:merged",
      ],
      readPullRequestGate: mergedReader(
        new Set(["blockcast/paperclip#2686", "blockcast/penstock-llm-proxy-core#2686"]),
      ),
    });
    expect(verdict).toMatchObject({ kind: "human_gate_only", humanGates: ["omar-go:#2686"] });
  });

  it("does NOT read a closed-unmerged pull request as one a person is holding open", async () => {
    // The work did not land. "A person is holding this open" would be false,
    // and the fail-closed rule for an abandoned pull request must survive the
    // held-open branch.
    const verdict = await resolveTerminalGate({
      gateSignals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      readPullRequestGate: async () => ({ state: "closed", merged: false }),
    });
    expect(verdict).toMatchObject({
      kind: "unresolved",
      reason: "pull_request_closed_unmerged",
    });
  });

  it("reports `human_gate_only` for a gate set that is nothing BUT a human decision", async () => {
    // The literal PEN-4545 specimen: a monitor whose whole declared gate is a
    // go from one person. Vacuously "every machine gate satisfied", and the
    // row most in need of the notice — nothing it waits on is pollable.
    let reads = 0;
    const verdict = await resolveTerminalGate({
      gateSignals: ["hold-lift:#6493"],
      readPullRequestGate: async () => {
        reads += 1;
        return { state: "open", merged: false };
      },
    });
    expect(verdict).toMatchObject({ kind: "human_gate_only", humanGates: ["hold-lift:#6493"] });
    expect(reads).toBe(0);
  });

  it("does NOT announce a human gate while a declared pull request is still open", async () => {
    // The machine half is genuinely outstanding, so the row IS waiting on
    // something a re-check can change. Claiming "only a person is left" here
    // would be false and would mis-route the escalation.
    const verdict = await resolveTerminalGate({
      gateSignals: ["omar-go:#2686", "pr:blockcast/paperclip#1281:merged"],
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "pull_request_open" });
  });

  it("does NOT announce a human gate when a closed-unmerged pull request is in the set", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["approval:dcb2b957", "pr:blockcast/paperclip#1281:merged"],
      readPullRequestGate: async () => ({ state: "closed", merged: false }),
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "pull_request_closed_unmerged" });
  });

  it("an infra token alongside a human gate still fails closed, and still costs zero reads", async () => {
    // The parse loop must run to completion before any read, so the documented
    // "unparseable tokens cost zero network calls" property survives PEN-4545.
    let reads = 0;
    const verdict = await resolveTerminalGate({
      gateSignals: [
        "omar-go:#2686",
        "deploy:paperclip-api",
        "pr:blockcast/paperclip#1281:merged",
      ],
      readPullRequestGate: async () => {
        reads += 1;
        return { state: "closed", merged: true };
      },
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "unresolvable_signal" });
    expect(reads).toBe(0);
  });

  it("fails closed when the gate read errors", async () => {    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      readPullRequestGate: async () => ({ error: "missing_github_app_credentials" }),
    });
    expect(verdict).toMatchObject({ kind: "unresolved", reason: "gate_read_failed" });
  });

  it("requires every declared pull request, not just one", async () => {
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#1281:merged", "pr:blockcast/paperclip#1312:merged"],
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });
    expect(verdict.kind).toBe("unresolved");
  });

  it("reads each distinct pull request once even when several signals cite it", async () => {
    let reads = 0;
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:blockcast/paperclip#1281:merged", "pr:blockcast/paperclip#1281:checks"],
      readPullRequestGate: async () => {
        reads += 1;
        return { state: "closed", merged: true };
      },
    });
    expect(verdict.kind).toBe("satisfied");
    expect(reads).toBe(1);
  });

  it("stops inside one issue when the shared PR read cap is exhausted", async () => {
    let reads = 0;
    const verdict = await resolveTerminalGate({
      gateSignals: ["pr:example/repo#1:merged", "pr:example/repo#2:merged"],
      maxPullRequestReads: 1,
      readPullRequestGate: async () => {
        reads += 1;
        return { state: "closed", merged: true };
      },
    });

    expect(verdict).toEqual({ kind: "unresolved", reason: "pull_request_read_cap" });
    expect(reads).toBe(1);
  });
});

describe("terminalGateResolutionIdempotencyKey", () => {
  it("is order-insensitive but signal-set-sensitive, so a re-arm on new gates stops matching", () => {
    const a = terminalGateResolutionIdempotencyKey(["pr:o/r#1:merged", "pr:o/r#2:merged"]);
    const b = terminalGateResolutionIdempotencyKey(["pr:o/r#2:merged", "pr:o/r#1:merged"]);
    const c = terminalGateResolutionIdempotencyKey(["pr:o/r#3:merged"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("readIssueMonitorGateSignals", () => {
  it("normalizes the stored monitor gate signals and tolerates every absent shape", () => {
    expect(readIssueMonitorGateSignals({ monitor: { gateSignals: [" PR:O/R#1:Merged ", "pr:o/r#1:merged"] } }))
      .toEqual(["pr:o/r#1:merged"]);
    expect(readIssueMonitorGateSignals(null)).toEqual([]);
    expect(readIssueMonitorGateSignals({})).toEqual([]);
    expect(readIssueMonitorGateSignals({ monitor: { gateSignals: null } })).toEqual([]);
  });
});

describe("buildTerminalGateResolvedComment", () => {
  it("names the resolved gate so the issue can be closed without re-deriving the thread", () => {
    const body = buildTerminalGateResolvedComment({
      signals: ["pr:blockcast/paperclip#1281:merged"],
      mergedPullRequests: ["blockcast/paperclip#1281"],
    });
    expect(body).toContain("blockcast/paperclip#1281");
    expect(body).toContain("merged");
    expect(body).toContain("BLO-27515");
  });

  it("does not claim nothing is polling an armed monitor", () => {
    // BLO-36289. This comment is system-authored and read by agents deciding
    // whether a row is stranded, and the documented repair for a stranded row
    // DESTROYS the wake path it already had. So on a row admitted by the
    // never-polled arm — armed, first check still in the future — the stranded
    // copy is not merely imprecise, it is the 86%-false-positive strand signal.
    // Reverting either branch in the builder must fail this test.
    const nextCheckAt = new Date("2026-09-25T21:30:00.000Z");
    const armed = buildTerminalGateResolvedComment({
      signals: ["pr:blockcast/paperclip#1281:checks"],
      mergedPullRequests: ["blockcast/paperclip#1281"],
      armedNextCheckAt: nextCheckAt,
    });
    expect(armed).not.toContain("nothing is polling it");
    expect(armed).not.toContain("The monitor stopped re-checking");
    expect(armed).not.toContain("re-arm the monitor");
    expect(armed).toContain(nextCheckAt.toISOString());
    expect(armed).toContain("live wake path");

    // The stranded population keeps its copy: an omitted/null armedNextCheckAt
    // is the "polling stopped" case and must still say so.
    const stranded = buildTerminalGateResolvedComment({
      signals: ["pr:blockcast/paperclip#1281:merged"],
      mergedPullRequests: ["blockcast/paperclip#1281"],
    });
    expect(stranded).toContain("nothing is polling it");
    expect(stranded).toContain("re-arm the monitor");
    expect(stranded).not.toContain("live wake path");
  });
});

describe("buildTerminalGateHumanOnlyComment", () => {
  it("names the human gate and states plainly that it is not a resolution", () => {
    const body = buildTerminalGateHumanOnlyComment({
      signals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      humanGates: ["omar-go:#2686"],
      mergedPullRequests: ["blockcast/penstock-llm-proxy-core#2686"],
    });
    expect(body).toContain("omar-go:#2686");
    expect(body).toContain("blockcast/penstock-llm-proxy-core#2686");
    expect(body).toContain("PEN-4545");
    // The whole point: an agent reading this must not act on it as a closure.
    expect(body).toContain("nothing here closes the issue");
    expect(body).not.toContain("Terminal gate resolved");
  });

  it("tells an armed row its next check cannot help, without calling it stranded", () => {
    // Same hazard as BLO-36289 on the resolved builder: the documented repair
    // for a stranded row destroys the wake path it already has. A human-gated
    // row usually IS armed — that is exactly what made PEN-4545's six rows
    // read as attended — so this branch carries more traffic than its sibling.
    const nextCheckAt = new Date("2026-10-26T09:00:00.000Z");
    const armed = buildTerminalGateHumanOnlyComment({
      signals: ["omar-go:#2686"],
      humanGates: ["omar-go:#2686"],
      mergedPullRequests: [],
      armedNextCheckAt: nextCheckAt,
    });
    expect(armed).toContain(nextCheckAt.toISOString());
    expect(armed).toContain("live wake path");
    expect(armed).not.toContain("has stopped re-checking");

    const stranded = buildTerminalGateHumanOnlyComment({
      signals: ["omar-go:#2686"],
      humanGates: ["omar-go:#2686"],
      mergedPullRequests: [],
    });
    expect(stranded).toContain("has stopped re-checking");
    expect(stranded).not.toContain("live wake path");
  });

  it("does not claim satisfied machine gates on a row that declared none", () => {
    // With no `pr:` token, "every machine-checkable gate is satisfied" is
    // vacuously true and reads as a statement about landed work that nothing
    // here checked. A freshly-armed monitor declaring only `omar-go` must not
    // be told its work is done.
    const body = buildTerminalGateHumanOnlyComment({
      signals: ["omar-go:#2686"],
      humanGates: ["omar-go:#2686"],
      mergedPullRequests: [],
    });
    expect(body).not.toContain("every machine-checkable gate on this issue is satisfied");
    expect(body).toContain("Nothing here is machine-checkable");
    expect(body).toContain("says nothing about whether the work is finished");

    // The satisfied-machine-half wording stays for the case that earned it.
    const withPr = buildTerminalGateHumanOnlyComment({
      signals: ["omar-go:#2686", "pr:blockcast/paperclip#2686:merged"],
      humanGates: ["omar-go:#2686"],
      mergedPullRequests: ["blockcast/paperclip#2686"],
    });
    expect(withPr).toContain("every machine-checkable gate on this issue is satisfied");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-gate reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reconcileTerminalGates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-gate-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "TGR") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  /**
   * An issue in exactly BLO-24166's post-strand shape: a monitor that fired,
   * recorded an unsatisfied gate, and has no next check — so nothing will ever
   * poll it again.
   */
  async function insertStrandedGateIssue(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    gateSignals: string[];
    /** Overrides what is STORED in the JSONB, to seed malformed shapes. */
    storedGateSignals?: unknown;
    status?: string;
    monitorNextCheckAt?: Date | null;
    /** BLO-36289: armed and never evaluated, vs armed-and-already-polling. */
    neverTriggered?: boolean;
    /**
     * Independent overrides for the two halves of the never-polled conjunct.
     * `neverTriggered` alone correlates them perfectly, so with it as the only
     * lever no fixture can produce `(attemptCount >= 1, lastTriggeredAt null)`
     * or `(attemptCount 0, lastTriggeredAt set)` — and then either conjunct can
     * be deleted with the suite green. TG15/TG16 use these to make each half
     * independently mutation-killable.
     */
    monitorAttemptCount?: number;
    monitorLastTriggeredAt?: Date | null;
    /** BLO-36289: the monitor's own horizon, independent of `nextCheckAt`. */
    monitorTimeoutAt?: Date | null;
    /** PEN-4545: the monitor's own attempt ceiling, read by `exhaustedMonitorClearReason`. */
    monitorMaxAttempts?: number | null;
  }) {
    const id = randomUUID();
    const lastTriggeredAt = "monitorLastTriggeredAt" in input
      ? (input.monitorLastTriggeredAt ?? null)
      : (input.neverTriggered ? null : LAST_POLL_AT);
    const attemptCount = input.monitorAttemptCount ?? (input.neverTriggered ? 0 : 3);
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: input.status ?? "todo",
      priority: "high",
      assigneeAgentId: input.agentId,
      originKind: "manual",
      originFingerprint: "default",
      monitorNextCheckAt: input.monitorNextCheckAt ?? null,
      monitorLastTriggeredAt: lastTriggeredAt,
      monitorAttemptCount: attemptCount,
      monitorScheduledBy: "assignee",
      monitorNotes: `gate re-check: ${input.gateSignals.join(", ")} merged=NO`,
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          // Keyed on BOTH halves, not on `lastTriggeredAt` alone: TG15 exists to
          // prove the two columns can disagree, and deriving this from one of
          // them silently re-correlates them inside the fixture.
          status: attemptCount === 0 && lastTriggeredAt === null ? "scheduled" : "triggered",
          nextCheckAt: input.monitorNextCheckAt?.toISOString() ?? null,
          lastTriggeredAt: lastTriggeredAt?.toISOString() ?? null,
          timeoutAt: input.monitorTimeoutAt?.toISOString() ?? null,
          maxAttempts: input.monitorMaxAttempts ?? null,
          attemptCount,
          notes: "merged=NO",
          scheduledBy: "assignee",
          gateSignals: "storedGateSignals" in input ? input.storedGateSignals : input.gateSignals,
          gateSource: "gates",
          convergenceCount: 3,
          clearedAt: null,
          clearReason: null,
        },
      } as never,
    });
    for (const signal of input.gateSignals) {
      const match = /^pr:([^:]+):[a-z0-9_-]+$/.exec(signal);
      if (!match) continue;
      await db.insert(issueWorkProducts).values({
        companyId: input.companyId,
        issueId: id,
        type: "pull_request",
        provider: "github",
        externalId: match[1],
        title: match[1],
        status: "ready_for_review",
        metadata: { source: "github_pull_request_webhook" },
        sourceTrust: {
          preset: "standard",
          disposition: "promoted",
          promotedByActorType: "system",
          promotedByActorId: "github_pull_request_webhook",
        },
      });
    }
    return id;
  }

  async function commentsFor(issueId: string) {
    return db
      .select({ body: issueComments.body, key: issueComments.idempotencyKey, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  /**
   * Back-date an announcement out of its re-check window, rather than
   * advancing `now`, so no assertion depends on wall-clock time.
   *
   * Both columns move together because the suppression test reads
   * `coalesce(idempotency_processed_at, created_at)`: ageing only `created_at`
   * would leave a fresh `idempotency_processed_at` behind and silently keep
   * the row suppressed, so the test would pass for the wrong reason.
   */
  async function ageHeldAnnouncement(issueId: string, byMs: number) {
    const agedTo = new Date(NOW.getTime() - byMs);
    await db
      .update(issueComments)
      .set({ createdAt: agedTo, idempotencyProcessedAt: agedTo })
      .where(eq(issueComments.issueId, issueId));
  }

  it("records a gate that resolved after the last poll, and dispatches no run to do it", async () => {
    const { companyId, agentId } = await createCompany("TG1");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG1-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });

    // The PR merged 16 minutes after the monitor's last poll. Nothing re-checked.
    expect(MERGED_AT.getTime()).toBeGreaterThan(LAST_POLL_AT.getTime());

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 1, pullRequestReads: 1 });

    const comments = await commentsFor(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain("blockcast/paperclip#1281");
    expect(comments[0]!.body.match(/Declared gate signals:/g)).toHaveLength(1);
    expect(comments[0]!.key).toBe(
      terminalGateResolutionIdempotencyKey(["pr:blockcast/paperclip#1281:merged"]),
    );

    // The verifying signal for BLO-27515: the resolved gate is recorded WITHOUT
    // a run being dispatched. Dispatching a run and having it close the issue is
    // the expensive path this exists to remove, so assert on the absence of the
    // run, not merely on the final state. `agentWakeupRequests` is checked too —
    // an enqueued wake that has not yet become a run is the same expense one
    // step earlier, and would not show up in `heartbeat_runs`.
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(0);
    const wakeups = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests);
    expect(wakeups).toHaveLength(0);

    // It also claims no wake and changes no status: this reports, it does not act.
    const [row] = await db
      .select({
        status: issues.status,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row).toMatchObject({
      status: "todo",
      monitorNextCheckAt: null,
      monitorWakeRequestedAt: null,
    });
  });

  it("survives a malformed `gateSignals` (object or scalar) and still reconciles the valid candidate", async () => {
    const { companyId, agentId } = await createCompany("TGM");
    // Hand-edited or legacy execution state. The candidate query must not call
    // `jsonb_array_length` on these — that raises and aborts the entire pass,
    // taking the healthy row below with it.
    await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGM-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      storedGateSignals: { "pr:blockcast/paperclip#1281:merged": true },
    });
    await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGM-2",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      storedGateSignals: "pr:blockcast/paperclip#1281:merged",
    });
    const healthyId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGM-3",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    // Skipped, not scanned-and-failed: the malformed rows never become candidates.
    expect(result).toMatchObject({ scanned: 1, resolved: 1 });
    expect(await commentsFor(healthyId)).toHaveLength(1);
  });

  it("is idempotent — a second pass neither re-comments nor re-reads GitHub", async () => {
    const { companyId, agentId } = await createCompany("TG2");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG2-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });

    let reads = 0;
    const countingReader: ReadPullRequestGate = async () => {
      reads += 1;
      return { state: "closed", merged: true };
    };

    await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: countingReader });
    const second = await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: countingReader });

    expect(reads).toBe(1);
    // `scanned: 0` is the load-bearing half: it pins that the *SQL* anti-join
    // excluded the row, not merely that the JS key filter dropped it. Asserting
    // only `resolved`/`pullRequestReads` holds either way and would not notice
    // an announced row silently re-entering the scan window.
    expect(second).toMatchObject({ scanned: 0, resolved: 0, pullRequestReads: 0 });
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  it("keeps an announced issue out of the scan window after a later unrelated write", async () => {
    // The announcing INSERT bumps `issues.last_activity_at` (migration 0076's
    // AFTER INSERT trigger on issue_comments) but never `updated_at`. So any
    // later write that does bump `updated_at` — a restore sweep flipping
    // blocked->todo, a priority or assignee change — moves it past the
    // comment's `created_at`. An anti-join correlated on that comparison
    // inverts permanently: the row is a candidate on every subsequent pass,
    // can never be re-announced (the exact-key filter drops it, and the
    // idempotency index would reject the insert anyway), and so camps on a
    // SCAN_LIMIT slot forever. `updatedAt ASC` then ages these rows toward the
    // front of the window, starving real candidates behind them.
    const { companyId, agentId } = await createCompany("TG2B");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG2B-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });

    const reader = mergedReader(new Set(["blockcast/paperclip#1281"]));
    expect(await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: reader })).toMatchObject({
      scanned: 1,
      resolved: 1,
    });

    // Bump `updated_at` past the announcement's real `created_at` (a DB
    // `now()` default, not the injected `now`), which is what an ordinary later
    // write does. Deriving it from the stored row rather than from `NOW` is
    // load-bearing: the fixture timestamps are historical, so a `NOW`-relative
    // bump lands *before* the comment and fails to reproduce anything.
    const [announced] = await db
      .select({ createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const announcedAt = announced!.createdAt;

    await db
      .update(issues)
      .set({ priority: "high", updatedAt: new Date(announcedAt.getTime() + 1_000) })
      .where(eq(issues.id, issueId));

    const after = await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: reader });
    expect(after).toMatchObject({ scanned: 0, resolved: 0, pullRequestReads: 0 });
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  it("keeps an announced MULTI-signal issue out of the scan window", async () => {
    // Pins the separator, ordering and dedup of the SQL digest against the TS.
    // A single-signal fixture cannot: `string_agg` emits no separator for one
    // element, so the digest is identical under any separator and a drift
    // between `gateSignalDigestSql` and `terminalGateResolutionIdempotencyKey`
    // stays invisible. Two signals is the smallest case that discriminates.
    const { companyId, agentId } = await createCompany("TG2D");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG2D-1",
      // Deliberately not in sorted order, so the digest's ORDER BY is exercised.
      gateSignals: ["pr:blockcast/paperclip#1400:merged", "pr:blockcast/paperclip#1281:merged"],
    });

    const reader = mergedReader(
      new Set(["blockcast/paperclip#1281", "blockcast/paperclip#1400"]),
    );
    expect(await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: reader })).toMatchObject({
      scanned: 1,
      resolved: 1,
    });

    const second = await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: reader });
    expect(second).toMatchObject({ scanned: 0, resolved: 0, pullRequestReads: 0 });
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  it("re-announces after the monitor is re-armed on a different gate set", async () => {
    // The property the removed `created_at >= updated_at` correlation was
    // protecting: suppression must key on the *current* signal set, so a
    // re-arm on new gates is announceable again. A bare prefix anti-join would
    // silence this issue permanently.
    const { companyId, agentId } = await createCompany("TG2C");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG2C-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });

    const reader = mergedReader(
      new Set(["blockcast/paperclip#1281", "blockcast/paperclip#1400"]),
    );
    expect(await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: reader })).toMatchObject({
      resolved: 1,
    });

    const [row] = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    const state = row!.executionState as { monitor: Record<string, unknown> };
    await db
      .update(issues)
      .set({
        executionState: {
          ...state,
          monitor: { ...state.monitor, gateSignals: ["pr:blockcast/paperclip#1400:merged"] },
        },
      })
      .where(eq(issues.id, issueId));

    expect(await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: reader })).toMatchObject({
      scanned: 1,
      resolved: 1,
    });
    expect(await commentsFor(issueId)).toHaveLength(2);
  });

  it("covers the outage-strand shape: a `blocked` issue is still reconciled", async () => {
    // The population this exists for is precisely the one an outage moved off
    // `in_progress`. Restricting to the statuses a monitor can be *armed* on
    // would exclude the worked example.
    const { companyId, agentId } = await createCompany("TG3");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG3-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      status: "blocked",
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result.resolved).toBe(1);
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  it("leaves an issue alone while its monitor is still polling", async () => {
    const { companyId, agentId } = await createCompany("TG4");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG4-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      status: "in_progress",
      monitorNextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 0, resolved: 0 });
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("resolves a monitor armed on an already-satisfied gate without waiting for nextCheckAt", async () => {
    // BLO-36289. Same shape as TG4 — armed, next check an hour out — except this
    // monitor has never been evaluated (attemptCount 0, lastTriggeredAt null),
    // i.e. it was armed on a gate that was already satisfied. TG4 is the control
    // that keeps the "still polling" exclusion honest: reverting the never-polled
    // arm of the candidate predicate must fail THIS test and leave TG4 green.
    const { companyId, agentId } = await createCompany("TG14");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG14-1",
      gateSignals: ["pr:blockcast/paperclip#1281:checks"],
      status: "in_progress",
      monitorNextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      neverTriggered: true,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 1 });
    const posted = await commentsFor(issueId);
    expect(posted).toHaveLength(1);
    // The DB path must select the ARMED copy, not just any copy: this row has a
    // live wake path, and the stranded wording would invite a repair that
    // destroys it.
    expect(posted[0]!.body).not.toContain("nothing is polling it");
    expect(posted[0]!.body).toContain("live wake path");
  });

  it("does not admit a monitor that has polled without recording a trigger", async () => {
    // Kills the `attemptCount = 0` half of the never-polled conjunct on its own.
    // `(attemptCount 1, lastTriggeredAt null)` — a monitor that fired but left no
    // trigger timestamp — passes the `lastTriggeredAt is null` half, so dropping
    // the attemptCount half admits it and this test fails. TG4 cannot cover this:
    // its attemptCount is 3, so it stays excluded under that same mutation.
    const { companyId, agentId } = await createCompany("TG15");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG15-1",
      gateSignals: ["pr:blockcast/paperclip#1281:checks"],
      status: "in_progress",
      monitorNextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      monitorAttemptCount: 1,
      monitorLastTriggeredAt: null,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 0, resolved: 0 });
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("does not admit a monitor that recorded a trigger without incrementing its attempt count", async () => {
    // Kills the `lastTriggeredAt is null` half on its own, the mirror of TG15.
    // `(attemptCount 0, lastTriggeredAt set)` passes the attemptCount half, so
    // dropping the lastTriggeredAt half admits it and this test fails.
    //
    // Together TG15/TG16 are what makes the bound a guard rather than a comment:
    // re-arming preserves attemptCount, so a re-armed monitor stays out of the
    // candidate set, and that is what keeps this off the "every armed monitor in
    // the fleet" cost BLO-29856 rejected.
    const { companyId, agentId } = await createCompany("TG16");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG16-1",
      gateSignals: ["pr:blockcast/paperclip#1281:checks"],
      status: "in_progress",
      monitorNextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      monitorAttemptCount: 0,
      monitorLastTriggeredAt: LAST_POLL_AT,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 0, resolved: 0 });
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("uses the stranded copy for a never-polled monitor whose first check is already overdue", async () => {
    // The armed copy claims a live wake path. An OVERDUE first check is by
    // definition a wake that did not happen, so claiming it there would be the
    // mirror of the false signal the armed branch exists to avoid. Reverting the
    // `> now` gate at the call site must fail this test.
    const { companyId, agentId } = await createCompany("TG17");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG17-1",
      gateSignals: ["pr:blockcast/paperclip#1281:checks"],
      status: "in_progress",
      monitorNextCheckAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      neverTriggered: true,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 1 });
    const posted = await commentsFor(issueId);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("nothing is polling it");
    expect(posted[0]!.body).not.toContain("live wake path");
  });

  it("uses the stranded copy for a never-polled monitor on a row the scheduler will not fire", async () => {
    // TG14's shape (never evaluated, first check an hour out) on a `todo` row.
    // The candidate query admits every status but done/cancelled by design, but
    // the scheduler only fires rows `issueAllowsMonitor` admits, so this future
    // check is a wake that will never happen. Claiming "live wake path" here
    // suppresses the repair on a row that has none. Dropping the eligibility
    // conjunct at the call site must fail this test and leave TG14 green.
    const { companyId, agentId } = await createCompany("TG18");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG18-1",
      gateSignals: ["pr:blockcast/paperclip#1281:checks"],
      status: "todo",
      monitorNextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      neverTriggered: true,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 1 });
    const posted = await commentsFor(issueId);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("nothing is polling it");
    expect(posted[0]!.body).not.toContain("live wake path");
  });

  it("uses the stranded copy for a never-polled monitor already past its own timeout", async () => {
    // TG14's shape (eligible row, never evaluated, first check an hour out) with
    // a `timeoutAt` already behind us — "check in 1h, give up 1h ago". Nothing
    // constrains `nextCheckAt <= timeoutAt`, and `buildInitialIssueMonitorFields`
    // only rejects a monitor exhausted AT ARM TIME, so this arms fine and the
    // scheduler's next evaluation clears it `timeout_exceeded` rather than firing
    // it. Selection eligibility cannot see that — it is a bounds question — so
    // dropping the `exhaustedMonitorClearReason` conjunct at the call site must
    // fail this test and leave TG14 green.
    const { companyId, agentId } = await createCompany("TG19");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG19-1",
      gateSignals: ["pr:blockcast/paperclip#1281:checks"],
      status: "in_progress",
      monitorNextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      monitorTimeoutAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      neverTriggered: true,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 1 });
    const posted = await commentsFor(issueId);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("nothing is polling it");
    expect(posted[0]!.body).not.toContain("live wake path");
  });

  it("still claims a live wake path when the monitor's timeout is ahead of its first check", async () => {
    // The negative control for TG19: same shape, `timeoutAt` in the FUTURE. A
    // declared timeout is the common case, so a conjunct that rejected every
    // bounded monitor would silently delete the armed branch — TG14 alone cannot
    // catch that, because it leaves `timeoutAt` null.
    const { companyId, agentId } = await createCompany("TG20");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG20-1",
      gateSignals: ["pr:blockcast/paperclip#1281:checks"],
      status: "in_progress",
      monitorNextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      monitorTimeoutAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
      neverTriggered: true,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 1 });
    const posted = await commentsFor(issueId);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("live wake path");
  });

  it("does not resolve an issue that still has an unresolved blocker edge", async () => {
    // BLO-18294 folds unresolved blockers into the monitor's gate set, so a live
    // blocker means the gate is not satisfied however the PRs read.
    const { companyId, agentId } = await createCompany("TG5");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG5-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });
    const blockerId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG5-2",
      gateSignals: ["pr:blockcast/paperclip#9999:merged"],
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("skips issues whose gate has not resolved and never comments on them", async () => {
    const { companyId, agentId } = await createCompany("TG6");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG6-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 0 });
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // PEN-4545: the human-gate announcement.
  //
  // Worked example these replay: PEN-4475 / #2686 and PEN-4304 / #2688 sat
  // `in_review` for ~24h behind "do not merge until Omar gives an explicit go",
  // declared on the monitor as an `omar-go` gate signal. Each had an armed
  // `monitorNextCheckAt`, so every dashboard read them as attended. The sweep
  // that would have seen them dropped each one at `unresolvable_signal` — the
  // same silent branch an infra token takes — so the one board-side audit that
  // reads `gateSignals` was structurally blind to the gate class that most
  // needs a reader.
  // ---------------------------------------------------------------------

  it("announces a row whose declared PR merged but whose human gate still stands", async () => {
    const { companyId, agentId } = await createCompany("TG8");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG8-1",
      // The human gate names a card, not the declared pull request, so the
      // merge cannot discharge it and a person really is all that is left.
      gateSignals: ["approval:dcb2b957", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/penstock-llm-proxy-core#2686"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 0, humanGateOnly: 1 });
    const comments = await commentsFor(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.key).toBe(
      terminalGateHumanOnlyIdempotencyKey([
        "approval:dcb2b957",
        "pr:blockcast/penstock-llm-proxy-core#2686:merged",
      ]),
    );
    expect(comments[0]!.body).toContain("approval:dcb2b957");
    // Must never read as a closure: `resolved` stayed 0 and the copy says so.
    expect(comments[0]!.body).toContain("nothing here closes the issue");
  });

  // The post-merge half of the ordering defect, at the sweep level: once the
  // held pull request merges the go has necessarily been given, so the row
  // must get the verify-and-close notice and must NOT be told to escalate.
  it("does not tell the owner to escalate a go the merge already proves was given", async () => {
    const { companyId, agentId } = await createCompany("TGE");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGE-1",
      gateSignals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/penstock-llm-proxy-core#2686"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 1, humanGateOnly: 0 });
    const comments = await commentsFor(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("discharged");
    expect(comments[0]!.body).not.toContain("Escalate the ask");
    expect(comments[0]!.body).not.toContain("waiting on a person");
    // Still not a closure — the gate resolved, the acceptance criteria did not.
    expect(comments[0]!.body).toContain("Nothing here closes the issue");
  });

  it("announces a row whose whole gate is a human go, which is the shape that was invisible", async () => {
    const { companyId, agentId } = await createCompany("TG9");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG9-1",
      gateSignals: ["omar-go:#2688"],
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });

    // Zero GitHub reads: there is no PR gate to read, so the notice is free.
    expect(result).toMatchObject({ scanned: 1, humanGateOnly: 1, pullRequestReads: 0 });
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  // ⭐ The population PEN-4545 actually measured, and the one the first cut of
  // this feature missed (caught in review on #2974). The six reported rows did
  // not have terminated or never-polled monitors — they were *actively
  // re-checking*, which is exactly what made them read as attended. Those rows
  // have `monitorAttemptCount > 0` AND a future `monitorNextCheckAt`, so both
  // pre-existing candidate arms exclude them by construction. Without the
  // human-gate arm the notice would fire only before the first poll or after
  // the monitor had already converged to a stall (~3 polls later) — i.e. only
  // once the row was already stranded, never while it still looked healthy.
  //
  // ⚠️ The pull request is OPEN here, and that is the fixture's whole point.
  // Every row the issue reported was `OPEN`, `draft`, `MERGEABLE`, carrying a
  // hold that read "do not merge until Omar gives an explicit go". The first
  // cut of this test merged #2686, which is the one state in which those rows
  // were NOT waiting — it asserted the notice at the only moment the wait was
  // already over, and pinned silence over the ~24h the rows were unreachable.
  it("announces an ACTIVELY-POLLING armed monitor while the held pull request is still OPEN", async () => {
    const { companyId, agentId } = await createCompany("TGC");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGC-1",
      status: "in_review",
      gateSignals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
      // Three polls in, next check hours away: healthy on every dashboard.
      monitorAttemptCount: 3,
      monitorLastTriggeredAt: LAST_POLL_AT,
      monitorNextCheckAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 0, humanGateOnly: 1 });
    const comments = await commentsFor(issueId);
    expect(comments).toHaveLength(1);
    // Names the pull request AND the person holding it, and asks for the go.
    expect(comments[0]!.body).toContain("blockcast/penstock-llm-proxy-core#2686");
    expect(comments[0]!.body).toContain("omar-go:#2686");
    expect(comments[0]!.body).toContain("Escalate the ask");
    expect(comments[0]!.body).toContain("nothing here closes the issue");
    // Armed and able to fire, so it must NOT claim the row is stranded — the
    // documented repair for a stranded row destroys the wake path it has.
    expect(comments[0]!.body).toContain("live wake path");
    expect(comments[0]!.body).not.toContain("has stopped re-checking");
  });

  it("does NOT readmit an actively-polling row whose gates are all machine-readable", async () => {
    // The human-gate arm must stay narrow. An armed, polling row with only
    // `pr:` gates is the scheduler's business; readmitting it here would widen
    // the sweep to the whole polling fleet and spend a PR read per row per
    // pass. Deleting the `humanGateSignalExistsSql` guard from the third arm
    // must fail this.
    const { companyId, agentId } = await createCompany("TGD");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGD-1",
      status: "in_review",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
      monitorAttemptCount: 3,
      monitorLastTriggeredAt: LAST_POLL_AT,
      monitorNextCheckAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    expect(result).toMatchObject({ scanned: 0, resolved: 0, humanGateOnly: 0 });
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("does not match a human-gate prefix that is merely a prefix of a longer token", async () => {
    // `card` must not match `cardinality:ready`, and the SQL arm must agree
    // with the JS matcher — they are generated from one array precisely so a
    // row cannot be admitted by one and classified by the other.
    const { companyId, agentId } = await createCompany("TGE");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGE-1",
      status: "in_review",
      gateSignals: ["cardinality:ready", "approvals-done"],
      monitorAttemptCount: 3,
      monitorLastTriggeredAt: LAST_POLL_AT,
      monitorNextCheckAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });

    expect(result).toMatchObject({ scanned: 0, humanGateOnly: 0 });
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("does not promise a live wake path to a polling monitor that is out of attempts", async () => {
    // `armedMonitorNextCheckAt` used to hardcode `attemptCount: 0`, which was
    // the literal truth while only the never-polled arm could carry a non-null
    // `monitorNextCheckAt`. The human-gate arm admits polling rows, so a
    // hardcoded 0 would under-report `max_attempts_exhausted` and tell this row
    // it has a wake path the scheduler will never honour.
    const { companyId, agentId } = await createCompany("TGF");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGF-1",
      status: "in_review",
      gateSignals: ["omar-go:#2686"],
      monitorAttemptCount: 5,
      monitorLastTriggeredAt: LAST_POLL_AT,
      monitorNextCheckAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
      monitorMaxAttempts: 5,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });

    expect(result).toMatchObject({ scanned: 1, humanGateOnly: 1 });
    const comments = await commentsFor(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("has stopped re-checking");
    expect(comments[0]!.body).not.toContain("live wake path");
  });

  it("admits a human-gate token stored with surrounding whitespace", async () => {
    // `parseTerminalGateSignal` classifies `raw.trim()`, so an untrimmed SQL
    // matcher would classify this `human_gate` in TS and never admit it while
    // polling — fail-closed, but exactly the JS/SQL drift the shared array
    // exists to prevent. `normalizeIssueMonitorGateSignals` trims on write, so
    // only a legacy or hand-edited row reaches this; that is the case nobody
    // would think to check. Dropping `btrim` from the predicate must fail this.
    const { companyId, agentId } = await createCompany("TGG");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGG-1",
      status: "in_review",
      gateSignals: [" omar-go:#2686 "],
      monitorAttemptCount: 3,
      monitorLastTriggeredAt: LAST_POLL_AT,
      monitorNextCheckAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });

    expect(result).toMatchObject({ scanned: 1, humanGateOnly: 1 });
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  // TGS — the fail-open direction review caught on #2974. A standing human
  // gate naming a merged pull request must NOT become `satisfied`: that posts
  // "Terminal gate resolved ... nothing left to chase" over a decision nobody
  // has made. Every discharge fixture before this used `omar-go`/`hold*`, so
  // widening the discharge back to the whole allowlist passed the suite.
  it("does not resolve a row whose standing human gate names the merged pull request", async () => {
    const { companyId, agentId } = await createCompany("TGS");
    const gateSignals = ["pr:blockcast/paperclip#2686:merged", "signoff:pr-2686"];
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGS-1",
      gateSignals,
    });

    const result = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#2686"])),
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 0, humanGateOnly: 1 });
    const comments = await commentsFor(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.key).toBe(terminalGateHumanOnlyIdempotencyKey(gateSignals));
    expect(comments[0]!.body).toContain("signoff:pr-2686");
    expect(comments[0]!.body).toContain("nothing here closes the issue");
    // The resolved copy's two load-bearing phrases must be absent.
    expect(comments[0]!.body).not.toContain("Terminal gate resolved");
    expect(comments[0]!.body).not.toContain("nothing left to chase");
  });

  // TGH — the lost post-merge notice, also from #2974. The held finding is
  // PROVISIONAL: the merge that ends it writes nothing to the database, so a
  // permanent anti-join on the held key made the documented merged ->
  // verify-and-close transition unreachable for every row a sweep saw while
  // it was open. Which, for the PEN-4545 population, is all of them.
  it("re-admits a held-open row after its re-check window so the merge still gets the resolved notice", async () => {
    const { companyId, agentId } = await createCompany("TGH");
    const gateSignals = [
      "omar-go:#2686",
      "pr:blockcast/penstock-llm-proxy-core#2686:merged",
    ];
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGH-1",
      status: "in_review",
      gateSignals,
      // The measured shape: actively polling, held open, reads as attended.
      monitorAttemptCount: 3,
      monitorLastTriggeredAt: LAST_POLL_AT,
      monitorNextCheckAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    });

    const held = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(held).toMatchObject({ scanned: 1, resolved: 0, humanGateOnly: 1 });
    expect(await commentsFor(issueId)).toHaveLength(1);
    expect((await commentsFor(issueId))[0]!.key).toBe(
      terminalGateHeldIdempotencyKey(gateSignals),
    );

    // Inside the window the row is out of the scan set entirely — the held
    // notice still pays for itself, and a thrown reader proves no GitHub read.
    const insideWindow = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: async () => {
        throw new Error("a held row inside its re-check window must not re-read GitHub");
      },
    });
    expect(insideWindow).toMatchObject({ scanned: 0, pullRequestReads: 0 });

    // Age the announcement past the window. Back-dated rather than advancing
    // `now`, so the assertion does not depend on wall-clock time.
    await ageHeldAnnouncement(issueId, 7 * 60 * 60 * 1000);

    // Still held: one read, and NO second comment — the held key conflicts.
    const stillHeld = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(stillHeld).toMatchObject({ scanned: 1, resolved: 0, humanGateOnly: 0 });
    expect(await commentsFor(issueId)).toHaveLength(1);

    // ...and that re-check RESTARTS the window. Without this the interval
    // throttles only the first re-read: `created_at` is fixed at the first
    // announcement, so once it ages past the cutoff it stays past it and the
    // row is re-admitted on every pass until the merge — ~144 reads a day
    // against the ~4 the constant and the runbook promise, camped ahead of
    // the stranded population under `updatedAt ASC`. The thrown reader is the
    // assertion that matters; `scanned: 0` alone would pass on a JS-side
    // filter that still paid for the SQL window.
    const reHeldInsideWindow = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: async () => {
        throw new Error("a still-held re-check must restart the window, not re-read every pass");
      },
    });
    expect(reHeldInsideWindow).toMatchObject({ scanned: 0, pullRequestReads: 0 });

    // Age it again so the merge is visible on the next cadence tick.
    await ageHeldAnnouncement(issueId, 7 * 60 * 60 * 1000);

    // Merged: the verdict changes, so the key changes, so the row is admitted
    // and gets the verify-and-close notice the runbook promises.
    const merged = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/penstock-llm-proxy-core#2686"])),
    });
    expect(merged).toMatchObject({ scanned: 1, resolved: 1, humanGateOnly: 0 });
    const after = await commentsFor(issueId);
    expect(after).toHaveLength(2);
    const resolvedComment = after.find(
      (comment) => comment.key === terminalGateResolutionIdempotencyKey(gateSignals),
    );
    expect(resolvedComment).toBeDefined();
    expect(resolvedComment!.body).toContain("Terminal gate resolved");
    expect(resolvedComment!.body).toContain("discharged");
    expect(resolvedComment!.body).toContain("omar-go:#2686");
  });

  // A TERMINAL human-only finding is the opposite case and must still retire
  // the row for good: every declared pull request has merged, so no later
  // sweep can read anything different, and re-admitting it would camp on a
  // SCAN_LIMIT slot forever. Separating the two keys must not leak the held
  // key's cadence onto this one.
  it("never re-admits a terminal human-only row, however old the announcement", async () => {
    const { companyId, agentId } = await createCompany("TGT");
    const gateSignals = ["approval:dcb2b957", "pr:blockcast/paperclip#2686:merged"];
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGT-1",
      gateSignals,
    });
    const reader = mergedReader(new Set(["blockcast/paperclip#2686"]));

    expect(await reconcileTerminalGates(db, { now: NOW, readPullRequestGate: reader }))
      .toMatchObject({ scanned: 1, humanGateOnly: 1 });
    await ageHeldAnnouncement(issueId, 30 * 24 * 60 * 60 * 1000);

    const second = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: async () => {
        throw new Error("a terminal human-only row must never be re-read");
      },
    });
    expect(second).toMatchObject({ scanned: 0, resolved: 0, humanGateOnly: 0 });
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  it("is idempotent, and the SQL anti-join keeps an announced human-gate row out of the scan window", async () => {
    // Without the held prefix in the anti-join, this row would be re-admitted
    // on every pass — a SCAN_LIMIT slot and a GitHub read every 10 minutes for
    // a wait measured in days, which is the starvation vector the
    // resolved-side anti-join exists to remove, reached through the new door.
    // `scanned: 0` is the assertion that matters; `humanGateOnly: 0` alone
    // would pass on a JS-side filter. TGH covers the complement — that the
    // suppression is a 6h window and not permanent, so the merge is still
    // seen.
    const { companyId, agentId } = await createCompany("TGA");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGA-1",
      // Held open, not merged: the merged form discharges this hold-protocol
      // gate and takes the resolved path, which is a different anti-join.
      // This test is about the held key, so it has to stay on the held path.
      gateSignals: ["hold-lift:#2655", "pr:blockcast/penstock-llm-proxy-core#2655:merged"],
    });

    const first = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(first).toMatchObject({ scanned: 1, humanGateOnly: 1 });

    const second = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: async () => {
        throw new Error("a re-announced human gate must not re-read GitHub");
      },
    });
    expect(second).toMatchObject({ scanned: 0, resolved: 0, humanGateOnly: 0, pullRequestReads: 0 });
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  it("does NOT let a human-gate announcement suppress a productivity review", async () => {
    // A human-gated row is the case where oversight is MOST warranted: the
    // work is finished and unreachable, and nobody has been told. Folding it
    // into the resolution map would retire the accountability that is the only
    // remaining pressure on the gate.
    const { companyId, agentId } = await createCompany("TGB");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TGB-1",
      gateSignals: ["omar-go:#2686", "pr:blockcast/penstock-llm-proxy-core#2686:merged"],
    });

    // Still open, so the person has not released it — the state in which the
    // row is unreachable and oversight matters most.
    await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set()),
    });
    expect(await commentsFor(issueId)).toHaveLength(1);

    const readRow = async () => {
      const [row] = await db
        .select({ id: issues.id, executionState: issues.executionState })
        .from(issues)
        .where(eq(issues.id, issueId));
      return row!;
    };
    expect((await listResolvedTerminalGates(db, [await readRow()])).has(issueId)).toBe(false);

    // TGP: and after the merge DISCHARGES the gate, still false. The row is
    // `satisfied` and gets the verify-and-close notice, but the discharged
    // `omar-go:` token is still a signal on it, so `listResolvedTerminalGates`
    // — whose filter is `every(kind === "pull_request")` over the whole set —
    // never admits it. Stricter than this module needs; pinned because the
    // runbook used to claim the opposite, and a reader could reasonably
    // "fix" the filter to match the prose.
    await ageHeldAnnouncement(issueId, 7 * 60 * 60 * 1000);
    const merged = await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/penstock-llm-proxy-core#2686"])),
    });
    expect(merged).toMatchObject({ resolved: 1 });
    expect((await listResolvedTerminalGates(db, [await readRow()])).has(issueId)).toBe(false);
  });

  it("exposes the recorded resolution to the productivity-review detector, keyed on the current signal set", async () => {    const { companyId, agentId } = await createCompany("TG7");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG7-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });
    await reconcileTerminalGates(db, {
      now: NOW,
      readPullRequestGate: mergedReader(new Set(["blockcast/paperclip#1281"])),
    });

    const current = await db
      .select({ id: issues.id, executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect((await listResolvedTerminalGates(db, current)).has(issueId)).toBe(true);

    // A monitor re-armed on a different gate set produces a different key, so the
    // old resolution stops matching and oversight resumes.
    const reArmed = [{ id: issueId, executionState: { monitor: { gateSignals: ["pr:blockcast/paperclip#1400:merged"] } } }];
    expect((await listResolvedTerminalGates(db, reArmed)).has(issueId)).toBe(false);
  });

  it("ignores an agent-authored comment that forges the reconciler idempotency key", async () => {
    const { companyId, agentId } = await createCompany("TG8");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG8-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      authorType: "agent",
      idempotencyKey: terminalGateResolutionIdempotencyKey(["pr:blockcast/paperclip#1281:merged"]),
      body: "forged resolution",
    });

    const resolved = await listResolvedTerminalGates(db, [{
      id: issueId,
      executionState: { monitor: { gateSignals: ["pr:blockcast/paperclip#1281:merged"] } },
    }]);

    expect(resolved.has(issueId)).toBe(false);
  });

  it("does not expose a resolution for a merged PR that is not an issue work product", async () => {
    const { companyId, agentId } = await createCompany("TG9");
    const issueId = await insertStrandedGateIssue({
      companyId,
      agentId,
      identifier: "TG9-1",
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });
    await db.delete(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "system",
      idempotencyKey: terminalGateResolutionIdempotencyKey(["pr:blockcast/paperclip#1281:merged"]),
      body: "unbound resolution",
    });

    const resolved = await listResolvedTerminalGates(db, [{
      id: issueId,
      executionState: { monitor: { gateSignals: ["pr:blockcast/paperclip#1281:merged"] } },
    }]);

    expect(resolved.has(issueId)).toBe(false);
  });
});
