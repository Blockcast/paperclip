/**
 * PEN-6556: a cancel destroys the assignee's deliberate park and tells nobody.
 *
 * The park half of the asymmetry `heartbeat-cancelled-monitor-recovery.test.ts` pins for
 * the monitor. Both edges are destroyed by the same cancel on the same rows, but only the
 * monitor is detected, recorded, recovered and documented. PEN-4729 carries the whole gap
 * on one row from one cancel: its monitor was handed to PEN-6538 and worked, while its
 * park is still unfired 16.9 days later.
 *
 * The case this suite exists to pin above all others is the one three earlier runs got
 * wrong on paper — `does not hand back a park that is not yet due`. A cancelled MONITOR is
 * destroyed at clear time and can never be delivered; a cancelled PARK is NOT destroyed,
 * all four columns survive, and a row the alertmanager plugin reopens before `parkedUntil`
 * fires its park normally (measured on PEN-4881: it fired 15 s after the restore). Copying
 * the monitor half's trigger would therefore hand off an obligation that is still
 * perfectly deliverable — a false carrier on every flapping alert in the fleet.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres destroyed-park recovery tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The whole record of what the park was owed, and the reason the carrier quotes it
 * verbatim: on PEN-4881 this prose was the obligation. The monitor half's exemption test
 * (`sourceOwnsOpenWorkProduct`) misses exactly this shape, which is why the park half
 * carries no horizon.
 */
const PARK_REASON = "sfo12 has served zero anthropic routes since 10-29; the alert being quiet is NOT evidence it recovered.";

/** RELATIVE on purpose: a fixed literal would silently flip every case as the clock moved. */
const PARKED_AT = () => new Date(Date.now() - 3 * DAY_MS);
const LAPSED_UNTIL = () => new Date(Date.now() - 2 * DAY_MS);
const FUTURE_UNTIL = () => new Date(Date.now() + 2 * DAY_MS);

describeEmbeddedPostgres("heartbeat reconcileDestroyedIssueParkRecoveries", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-destroyed-park-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  }, 120_000);

  afterEach(async () => {
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "destroyed-park recovery test cleanup",
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(companyStatus = "active") {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: companyStatus,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Devops",
      role: "devops",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5, concurrencyEnabled: true },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  /**
   * The row as the alertmanager plugin leaves it: cancelled, with all four park columns
   * intact. That survival is exactly what makes the loss invisible — a dead park is
   * byte-identical to a healthy one on every surface.
   */
  async function seedCancelledPark(
    companyId: string,
    assigneeAgentId: string | null,
    overrides: {
      status?: string;
      parkedUntil?: Date | null;
      parkedAt?: Date | null;
      parkedByAgentId?: string | null;
      parkedReason?: string | null;
      parkedRecoveryEmittedAt?: Date | null;
      originKind?: string;
      /** Pins selection order: the pass reads `asc(updatedAt), asc(id)`. */
      updatedAt?: Date;
    } = {},
  ) {
    const issueId = randomUUID();
    const status = overrides.status ?? "cancelled";
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "[Alert] LLMProxyProviderDarkAndDrainedOnNode on blockcast-sfo12",
      status,
      priority: "medium",
      assigneeAgentId,
      originKind: overrides.originKind ?? "plugin:paperclip-plugin-alertmanager",
      parkedUntil: overrides.parkedUntil === undefined ? LAPSED_UNTIL() : overrides.parkedUntil,
      parkedAt: overrides.parkedAt === undefined ? PARKED_AT() : overrides.parkedAt,
      parkedByAgentId:
        overrides.parkedByAgentId === undefined ? assigneeAgentId : overrides.parkedByAgentId,
      parkedReason: overrides.parkedReason === undefined ? PARK_REASON : overrides.parkedReason,
      parkedRecoveryEmittedAt: overrides.parkedRecoveryEmittedAt ?? null,
      ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
      cancelledAt: status === "cancelled" ? new Date(Date.now() - 2.5 * DAY_MS) : null,
    });
    return issueId;
  }

  function readPark(issueId: string) {
    return db
      .select({
        status: issues.status,
        parkedUntil: issues.parkedUntil,
        parkedAt: issues.parkedAt,
        parkedReason: issues.parkedReason,
        parkedByAgentId: issues.parkedByAgentId,
        parkedRecoveryEmittedAt: issues.parkedRecoveryEmittedAt,
        parkedWakeFiredAt: issues.parkedWakeFiredAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
  }

  function readCarriers(issueId: string) {
    return db
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        originKind: issues.originKind,
        originFingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(and(eq(issues.originId, issueId), eq(issues.originKind, "stranded_issue_recovery")));
  }

  it("hands a destroyed park to a carrier that quotes the park reason verbatim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId);

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.scanned).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.unowned).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const carriers = await readCarriers(issueId);
    expect(carriers).toHaveLength(1);
    const carrier = carriers[0]!;
    expect(carrier.status).toBe("todo");
    expect(carrier.priority).toBe("high");
    expect(carrier.parentId).toBe(issueId);
    expect(carrier.assigneeAgentId).toBe(agentId);
    expect(carrier.originFingerprint).toBe("issue_park:cancelled");
    expect(carrier.title).toContain("Carry forward the park destroyed on");
    // The park reason is the obligation. A carrier that does not carry it forward is a
    // pointer to a row whose own record of what was owed is prose nobody will re-read.
    expect(carrier.description).toContain(PARK_REASON);

    const park = await readPark(issueId);
    expect(park.parkedRecoveryEmittedAt).not.toBeNull();
    // ⛔ The four park columns are NOT cleared. The handoff records that the obligation was
    // carried; it does not erase the park, which is still the source's own record.
    expect(park.parkedUntil).not.toBeNull();
    expect(park.parkedReason).toBe(PARK_REASON);
  });

  it("⛔ does NOT hand back a cancelled park that is not yet due (the monitor half's trigger is wrong here)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId, { parkedUntil: FUTURE_UNTIL() });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    // Selected by nothing: the SQL predicate already excludes it, so this is not merely
    // "skipped at the decision".
    expect(result.scanned).toBe(0);
    expect(result.recovered).toBe(0);
    expect(await readCarriers(issueId)).toHaveLength(0);
    expect((await readPark(issueId)).parkedRecoveryEmittedAt).toBeNull();
  });

  it("hands it back once the not-yet-due park's deadline passes", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId, {
      parkedUntil: new Date(Date.now() + HOUR_MS),
    });

    expect((await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId })).recovered).toBe(0);

    // Same row, same park, `now` moved past the deadline. The pass is a sweep, so nothing
    // needs to re-trigger it.
    const later = new Date(Date.now() + 2 * HOUR_MS);
    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId, now: later });

    expect(result.recovered).toBe(1);
    expect(await readCarriers(issueId)).toHaveLength(1);
  });

  it("is idempotent: a second pass does not re-emit", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId);

    expect((await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId })).recovered).toBe(1);
    const second = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(second.scanned).toBe(0);
    expect(second.recovered).toBe(0);
    expect(await readCarriers(issueId)).toHaveLength(1);
  });

  it("self-heals a crash between the emit and the stamp without duplicating the carrier", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId);

    // Emit, then lose the stamp — the exact window `emit first, stamp second` trades for.
    await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });
    await db.update(issues).set({ parkedRecoveryEmittedAt: null }).where(eq(issues.id, issueId));

    const replay = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(replay.recovered).toBe(1);
    // Reused, not rebuilt.
    expect(await readCarriers(issueId)).toHaveLength(1);
    expect((await readPark(issueId)).parkedRecoveryEmittedAt).not.toBeNull();
  });

  it("does not clobber a park re-parked between selection and the stamp", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId);
    const reparkedAt = new Date();

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({
      companyId,
      // Lands between selection and the stamp, exactly as a concurrent re-park would.
      beforeRecover: async () => {
        await db
          .update(issues)
          .set({ parkedAt: reparkedAt, parkedUntil: FUTURE_UNTIL(), parkedRecoveryEmittedAt: null })
          .where(eq(issues.id, issueId));
      },
    });

    // The carrier landed — the obligation it carries was real when selected.
    expect(result.recovered).toBe(1);
    expect(await readCarriers(issueId)).toHaveLength(1);

    // But the stamp CAS failed, so the NEW park is left unstamped and will be evaluated on
    // its own terms. Marking the new park discharged is the failure this guard exists for.
    const park = await readPark(issueId);
    expect(park.parkedAt?.toISOString()).toBe(reparkedAt.toISOString());
    expect(park.parkedRecoveryEmittedAt).toBeNull();
  });

  it("refuses to stamp a source it cannot hand to anyone, and reports it owed", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, null, { parkedByAgentId: null });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.scanned).toBe(1);
    expect(result.unowned).toBe(1);
    expect(result.recovered).toBe(0);
    expect(await readCarriers(issueId)).toHaveLength(0);
    // Still owed, and still selectable the moment somebody owns it.
    expect((await readPark(issueId)).parkedRecoveryEmittedAt).toBeNull();
  });

  it("falls back to the PARKER when the source has lost its assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // The park records who wrote the obligation — information the monitor half never had.
    const issueId = await seedCancelledPark(companyId, null, { parkedByAgentId: agentId });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.recovered).toBe(1);
    expect(result.unowned).toBe(0);
    const carriers = await readCarriers(issueId);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]!.assigneeAgentId).toBe(agentId);
  });

  it("hands back for real once an unowned source gets an owner", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, null, { parkedByAgentId: null });

    expect((await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId })).unowned).toBe(1);

    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    const second = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(second.recovered).toBe(1);
    expect(await readCarriers(issueId)).toHaveLength(1);
  });

  it("⛔ leaves `done` and `blocked` parks alone — the scope the measurement refused to widen", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // 55 of the 84 dead parks measured 2026-11-12. Benign: the work finished before the
    // deadline, and waking it is the BLO-23206 shape.
    const doneId = await seedCancelledPark(companyId, agentId, { status: "done" });
    // 22 of them. DORMANT, not dead: the stranded-blocked reconciler drains such a row to
    // `todo`, after which the release sweep covers it there.
    const blockedId = await seedCancelledPark(companyId, agentId, { status: "blocked" });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.scanned).toBe(0);
    expect(await readCarriers(doneId)).toHaveLength(0);
    expect(await readCarriers(blockedId)).toHaveLength(0);
  });

  it("leaves a lapsed park alone on a status that can still wake it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // `todo` is inside `ISSUE_PARK_EXPIRY_WAKE_STATUSES`, so the RELEASE edge covers this
    // row. The two predicates are mutually exclusive by construction and this pins it.
    const issueId = await seedCancelledPark(companyId, agentId, { status: "todo" });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.scanned).toBe(0);
    expect(await readCarriers(issueId)).toHaveLength(0);
  });

  it("leaves a cancelled row with no park at all alone", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId, {
      parkedUntil: null,
      parkedAt: null,
      parkedReason: null,
      parkedByAgentId: null,
    });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.scanned).toBe(0);
    expect(await readCarriers(issueId)).toHaveLength(0);
  });

  it("⛔ is NOT narrowed by originKind — a future canceller is covered too", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // The monitor half measured two of its own cancelled rows coming from
    // `stale_active_run_evaluation` rather than from any plugin: the defect lives at the
    // status transition, not in one canceller.
    const issueId = await seedCancelledPark(companyId, agentId, { originKind: "manual" });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.recovered).toBe(1);
    expect(await readCarriers(issueId)).toHaveLength(1);
  });

  it("leaves an archived company's rows alone", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("archived");
    const issueId = await seedCancelledPark(companyId, agentId);

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.scanned).toBe(0);
    expect(await readCarriers(issueId)).toHaveLength(0);
  });

  it("treats a stamp older than the park as unstamped, so a forgetful writer degrades to a late handoff", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // The independent backstop: a re-park that did not reset the marker must not be
    // permanently silenced. `parkedAt` is newer than the stamp.
    const issueId = await seedCancelledPark(companyId, agentId, {
      parkedAt: new Date(Date.now() - HOUR_MS),
      parkedRecoveryEmittedAt: new Date(Date.now() - 5 * DAY_MS),
    });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.recovered).toBe(1);
    expect(await readCarriers(issueId)).toHaveLength(1);
  });

  it("respects the emission budget and walks past rows it cannot discharge", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // An unowned row sorts first and emits nothing. With `asc(updatedAt)` selection it
    // would sit at the head of every page forever; the page walk is what bounds that.
    await seedCancelledPark(companyId, null, {
      parkedByAgentId: null,
      updatedAt: new Date(Date.now() - 10 * DAY_MS),
    });
    const healthyId = await seedCancelledPark(companyId, agentId, {
      updatedAt: new Date(Date.now() - 9 * DAY_MS),
    });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId, limit: 1 });

    // The budget is an EMISSION budget, not a scan budget: the unowned row is scanned and
    // reported without spending it, so the healthy row behind it is still reached.
    expect(result.unowned).toBe(1);
    expect(result.recovered).toBe(1);
    expect(await readCarriers(healthyId)).toHaveLength(1);
  });

  it("re-arms the handoff edge when the park writer re-parks the row", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId);

    await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });
    expect((await readPark(issueId)).parkedRecoveryEmittedAt).not.toBeNull();

    // What `services/issues.ts` does on every `parkedDisposition` write: a new park, and
    // both park edges re-armed. The marker describes a PARK, never a row.
    await db
      .update(issues)
      .set({
        parkedAt: new Date(),
        parkedUntil: new Date(Date.now() - HOUR_MS),
        parkedWakeFiredAt: null,
        parkedRecoveryEmittedAt: null,
      })
      .where(eq(issues.id, issueId));

    const second = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });
    expect(second.recovered).toBe(1);
    expect((await readPark(issueId)).parkedRecoveryEmittedAt).not.toBeNull();
  });

  it("reports the oldest deadline it touched, so the backfill's age is readable from the log", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldUntil = new Date(Date.now() - 30 * DAY_MS);
    await seedCancelledPark(companyId, agentId, {
      parkedUntil: oldUntil,
      parkedAt: new Date(Date.now() - 31 * DAY_MS),
    });
    await seedCancelledPark(companyId, agentId);

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.recovered).toBe(2);
    expect(result.oldestParkedUntil).toBe(oldUntil.toISOString());
  });

  it("stays silent when there was nothing to hand back", async () => {
    const { companyId } = await seedCompanyAndAgent();

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result).toMatchObject({ scanned: 0, recovered: 0, skipped: 0, unowned: 0, failed: 0 });
  });

  it("gives one carrier, not two, to a source whose monitor and park were both destroyed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId);
    // A carrier the monitor half already built for the same source.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Carry forward the wake cancelled on T-1",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      parentId: issueId,
      originKind: "stranded_issue_recovery",
      originId: issueId,
      originFingerprint: "issue_monitor:cancelled",
    });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.recovered).toBe(1);
    // Reused. Two rows pointing at the same work is worse than one row carrying both
    // obligations — PEN-4729 is exactly that source.
    expect(await readCarriers(issueId)).toHaveLength(1);
    expect((await readPark(issueId)).parkedRecoveryEmittedAt).not.toBeNull();
  });

  it("does not select a row whose park was stamped for THIS park", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const parkedAt = new Date(Date.now() - 3 * DAY_MS);
    const issueId = await seedCancelledPark(companyId, agentId, {
      parkedAt,
      parkedRecoveryEmittedAt: new Date(parkedAt.getTime() + HOUR_MS),
    });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.scanned).toBe(0);
    expect(await readCarriers(issueId)).toHaveLength(0);
  });

  it("scopes to one company when asked", async () => {
    const a = await seedCompanyAndAgent();
    const b = await seedCompanyAndAgent();
    const mine = await seedCancelledPark(a.companyId, a.agentId);
    const theirs = await seedCancelledPark(b.companyId, b.agentId);

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId: a.companyId });

    expect(result.recovered).toBe(1);
    expect(await readCarriers(mine)).toHaveLength(1);
    expect(await readCarriers(theirs)).toHaveLength(0);
  });

  it("sweeps every active company when no companyId is given", async () => {
    const a = await seedCompanyAndAgent();
    const b = await seedCompanyAndAgent();
    const first = await seedCancelledPark(a.companyId, a.agentId);
    const second = await seedCancelledPark(b.companyId, b.agentId);

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries();

    expect(result.recovered).toBeGreaterThanOrEqual(2);
    expect(await readCarriers(first)).toHaveLength(1);
    expect(await readCarriers(second)).toHaveLength(1);
  });

  it("names a park with no reason recorded rather than emitting an empty quote", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId, { parkedReason: null });

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({ companyId });

    expect(result.recovered).toBe(1);
    const carriers = await readCarriers(issueId);
    expect(carriers[0]!.description).toContain("(none recorded)");
  });

  it("counts a stamp that loses its CAS as recovered, not failed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledPark(companyId, agentId);

    const result = await heartbeat.reconcileDestroyedIssueParkRecoveries({
      companyId,
      // Un-parks the row entirely between selection and the stamp.
      beforeRecover: async () => {
        await db
          .update(issues)
          .set({ parkedAt: null, parkedUntil: null, parkedReason: null })
          .where(eq(issues.id, issueId));
      },
    });

    // The carrier is real and landed; only the bookkeeping lost. Counting this as `failed`
    // would make a harmless, self-correcting race read as a defect in the log line both
    // call sites gate on.
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(await readCarriers(issueId)).toHaveLength(1);
  });
});

/**
 * The predicate on its own. These need no database and so run everywhere, which matters:
 * the suite above is skipped wholesale on a host without embedded Postgres, and the
 * asymmetry that took three runs to find is exactly the thing that must not go unpinned
 * on such a host.
 */
describe("issueParkOwesDestroyedHandoff", () => {
  const NOW_MS = Date.parse("2026-11-13T00:00:00.000Z");
  const BASE = {
    status: "cancelled",
    parkedUntil: "2026-11-11T00:00:00.000Z",
    parkedAt: "2026-11-10T00:00:00.000Z",
    parkedRecoveryEmittedAt: null,
  };

  it("fires on a lapsed park on a cancelled row", async () => {
    const { issueParkOwesDestroyedHandoff } = await import("../services/issue-park-expiry.js");
    expect(issueParkOwesDestroyedHandoff(BASE, NOW_MS)).toBe(true);
  });

  it("does not fire while the park is still live", async () => {
    const { issueParkOwesDestroyedHandoff } = await import("../services/issue-park-expiry.js");
    expect(
      issueParkOwesDestroyedHandoff({ ...BASE, parkedUntil: "2026-11-20T00:00:00.000Z" }, NOW_MS),
    ).toBe(false);
  });

  it("fires only on `cancelled`, never on the other statuses a park can sit on", async () => {
    const { issueParkOwesDestroyedHandoff } = await import("../services/issue-park-expiry.js");
    for (const status of ["todo", "in_progress", "in_review", "backlog", "blocked", "done"]) {
      expect(issueParkOwesDestroyedHandoff({ ...BASE, status }, NOW_MS), status).toBe(false);
    }
  });

  it("does not fire with no park at all", async () => {
    const { issueParkOwesDestroyedHandoff } = await import("../services/issue-park-expiry.js");
    expect(issueParkOwesDestroyedHandoff({ ...BASE, parkedUntil: null }, NOW_MS)).toBe(false);
  });

  it("does not fire once stamped for this park, and fires again after a re-park", async () => {
    const { issueParkOwesDestroyedHandoff } = await import("../services/issue-park-expiry.js");
    const stamped = { ...BASE, parkedRecoveryEmittedAt: "2026-11-11T01:00:00.000Z" };
    expect(issueParkOwesDestroyedHandoff(stamped, NOW_MS)).toBe(false);
    // Re-parked after the stamp: the marker is scoped to the PARK, so the edge re-arms.
    expect(
      issueParkOwesDestroyedHandoff({ ...stamped, parkedAt: "2026-11-12T00:00:00.000Z" }, NOW_MS),
    ).toBe(true);
  });

  it("treats a marker with no parkedAt as emitted", async () => {
    const { issueParkOwesDestroyedHandoff } = await import("../services/issue-park-expiry.js");
    expect(
      issueParkOwesDestroyedHandoff(
        { ...BASE, parkedAt: null, parkedRecoveryEmittedAt: "2026-11-11T01:00:00.000Z" },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("is mutually exclusive with the release edge on every status", async () => {
    const { issueParkOwesDestroyedHandoff, issueParkOwesReleaseWake } = await import(
      "../services/issue-park-expiry.js"
    );
    const agentId = randomUUID();
    for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]) {
      const handoff = issueParkOwesDestroyedHandoff({ ...BASE, status }, NOW_MS);
      const release = issueParkOwesReleaseWake(
        {
          status,
          parkedUntil: BASE.parkedUntil,
          parkedAt: BASE.parkedAt,
          parkedWakeFiredAt: null,
          assigneeAgentId: agentId,
          assigneeUserId: null,
        },
        NOW_MS,
      );
      expect(handoff && release, status).toBe(false);
    }
  });
});
