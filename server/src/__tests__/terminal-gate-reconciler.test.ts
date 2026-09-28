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
  buildTerminalGateResolvedComment,
  listResolvedTerminalGates,
  parseTerminalGateSignal,
  readIssueMonitorGateSignals,
  reconcileTerminalGates,
  resolveTerminalGate,
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

  it("fails closed when the gate read errors", async () => {
    const verdict = await resolveTerminalGate({
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
  }) {
    const id = randomUUID();
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
      monitorLastTriggeredAt: LAST_POLL_AT,
      monitorAttemptCount: 3,
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
          status: "triggered",
          nextCheckAt: null,
          lastTriggeredAt: LAST_POLL_AT.toISOString(),
          attemptCount: 3,
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

  it("exposes the recorded resolution to the productivity-review detector, keyed on the current signal set", async () => {
    const { companyId, agentId } = await createCompany("TG7");
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
