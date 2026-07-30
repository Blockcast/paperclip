// BLO-14395: webhook-triggered wakes (github-webhook.ts) call heartbeat.wakeup()
// synchronously and always 200 the delivery back to GitHub regardless of the
// dispatch outcome, so GitHub never redelivers on our behalf. Before this fix,
// any exception out of enqueueWakeup for a webhook wake was logged and dropped
// forever with no retry and no durable record -- a transient hiccup silently
// ate a review request (or any other webhook-driven wake) with nothing left to
// investigate or recover. These tests cover the two halves of the fix:
//   - wakeupWithDispatchRetry: business-rule HttpErrors (already durably
//     logged via writeSkippedRequest) pass straight through with no added
//     retry delay and no `dispatch_failed` record; only a genuinely
//     unexpected (non-HttpError) failure gets retried and, on exhaustion,
//     durably recorded.
//   - reconcileFailedWakeDispatches: the periodic sweep that retries
//     `dispatch_failed` rows, recovering them once the underlying condition
//     clears, or marking them `dispatch_superseded` if a retry now resolves
//     into a business-rule outcome instead.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  GITHUB_REVIEW_REQUEST_DELIVERY_METRIC,
  GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC,
  __resetMetricsForTest,
  getMetricsRegistry,
} from "../services/metrics.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-dispatch-retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wake dispatch retry (BLO-14395)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wake-dispatch-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  // BLO-18859: the delivery counter is process-global, so each test starts from
  // a clean registry rather than inheriting another test's increments.
  beforeEach(() => {
    __resetMetricsForTest();
  });

  /**
   * Sum {@link GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} across every `reason`
   * series for one funnel state. Summing (rather than reading a single series)
   * keeps these assertions independent of which wake reason the fixture used
   * and of the zero-initialized grid.
   */
  async function deliveryCount(state: string): Promise<number> {
    const metric = getMetricsRegistry().getSingleMetric(GITHUB_REVIEW_REQUEST_DELIVERY_METRIC);
    expect(metric, `${GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} must be registered`).toBeTruthy();
    const data = (await metric!.get()) as { values: Array<{ labels: Record<string, string>; value: number }> };
    return data.values
      .filter((entry) => entry.labels.state === state)
      .reduce((sum, entry) => sum + entry.value, 0);
  }

  /**
   * Sum {@link GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC} for one suppression
   * cause, or across every cause when `cause` is omitted. The all-causes sum is
   * what pins the cross-counter invariant these two metrics exist to keep:
   * `sum(suppression_total) == delivery_total{state="suppressed"}`.
   */
  async function suppressionCount(cause?: string): Promise<number> {
    const metric = getMetricsRegistry().getSingleMetric(GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC);
    expect(metric, `${GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC} must be registered`).toBeTruthy();
    const data = (await metric!.get()) as { values: Array<{ labels: Record<string, string>; value: number }> };
    return data.values
      .filter((entry) => cause === undefined || entry.labels.cause === cause)
      .reduce((sum, entry) => sum + entry.value, 0);
  }

  /**
   * Wrap a drizzle db so the next `failures` inserts throw a plain Error —
   * the non-HttpError class that wakeupWithDispatchRetry treats as a transient
   * dispatch failure and retries. `enqueueWakeup` performs its durable write
   * inside `db.transaction`, so the transaction callback's `tx` is wrapped too;
   * intercepting only the outer db would never see the insert that matters.
   *
   * `failures: 1` models a transient blip (first attempt fails, retry
   * succeeds); a large value models a hard outage that exhausts the chain.
   */
  function dbWithFailingInserts(target: typeof db, failures: number) {
    let remaining = failures;
    const wrap = (obj: object): typeof db => new Proxy(obj, {
      get(rawTarget, prop) {
        if (prop === "insert") {
          return (...args: unknown[]) => {
            if (remaining > 0) {
              remaining -= 1;
              throw new Error("simulated transient dispatch failure (BLO-18859)");
            }
            return (rawTarget as Record<string, (...a: unknown[]) => unknown>).insert(...args);
          };
        }
        if (prop === "transaction") {
          return (callback: (tx: unknown) => unknown, ...rest: unknown[]) =>
            (rawTarget as Record<string, (...a: unknown[]) => unknown>).transaction(
              (tx: object) => callback(wrap(tx)),
              ...rest,
            );
        }
        const value = Reflect.get(rawTarget, prop);
        // Bind to the raw target, not the proxy: drizzle methods reach for
        // private internals and break if `this` is the Proxy.
        return typeof value === "function" ? value.bind(rawTarget) : value;
      },
    }) as unknown as typeof db;
    return wrap(target as unknown as object);
  }

  const GITHUB_REVIEW_PAYLOAD = {
    taskKey: "pr_review:Blockcast/paperclip#18859",
    source: "github",
    reviewKind: "pr_review",
  } as const;

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts?: { agentStatus?: string; companyStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      ...(opts?.companyStatus ? { status: opts.companyStatus } : {}),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: opts?.agentStatus ?? "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("still enqueues normally on the happy path (no behavior change when nothing fails)", async () => {
    const { agentId } = await seedCompanyAndAgent();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_opened",
      payload: { taskKey: "pr_review:Blockcast/test#1" },
    });
    expect(run).not.toBeNull();

    const dispatchFailedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "dispatch_failed")));
    expect(dispatchFailedRows).toHaveLength(0);
  });

  it("passes a business-rule HttpError straight through with no retry delay and no durable dispatch_failed record", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentStatus: "paused" });

    const startedAt = Date.now();
    await expect(
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_opened",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const elapsedMs = Date.now() - startedAt;
    // The bounded in-process retry backoff is 300ms + 1200ms; a paused-agent
    // conflict must bypass it entirely (HttpErrors are never retried).
    expect(elapsedMs).toBeLessThan(1000);

    const dispatchFailedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "dispatch_failed")));
    expect(dispatchFailedRows).toHaveLength(0);

    // enqueueWakeup's own gate durably records the business-rule skip.
    const skippedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "skipped")));
    expect(skippedRows.length).toBeGreaterThan(0);
  });

  it("retries a genuinely unexpected (non-HttpError) dispatch failure and persists a durable dispatch_failed record on exhaustion", async () => {
    const { agentId } = await seedCompanyAndAgent();

    // A circular payload cannot be JSON-serialized by the underlying pg
    // driver -- a deterministic, non-HttpError failure deep inside
    // enqueueWakeup's insert, standing in for a transient DB hiccup.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_review_requested",
        payload: circular,
      }),
    ).rejects.toThrow();

    const dispatchFailedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "dispatch_failed")));
    expect(dispatchFailedRows).toHaveLength(1);
    const row = dispatchFailedRows[0]!;
    expect(row.reason).toBe("github_pr_review_requested");
    const dispatchRetry = (row.payload as Record<string, unknown>).dispatchRetry as Record<string, unknown>;
    expect(dispatchRetry.attempts).toBe(0);
    expect(typeof dispatchRetry.nextAttemptAt).toBe("string");
    expect(dispatchRetry.originalOpts).toMatchObject({ reason: "github_pr_review_requested" });
  });

  it("reconcileFailedWakeDispatches recovers a dispatch_failed row once the underlying condition clears", async () => {
    const { agentId } = await seedCompanyAndAgent();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_opened",
      payload: {
        dispatchRetry: {
          attempts: 1,
          nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
          originalOpts: {
            source: "automation",
            triggerDetail: "system",
            reason: "github_pr_opened",
            payload: { taskKey: "pr_review:Blockcast/test#42" },
          },
        },
      },
      status: "dispatch_failed",
    });

    const result = await heartbeat.reconcileFailedWakeDispatches(now);
    expect(result.recovered).toBe(1);

    const [updated] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(updated?.status).toBe("dispatch_recovered");

    const queuedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "queued")));
    expect(queuedRows.length).toBeGreaterThan(0);
  });

  it("reconcileFailedWakeDispatches leaves a not-yet-due row untouched", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_opened",
      payload: {
        dispatchRetry: {
          attempts: 1,
          nextAttemptAt: new Date(now.getTime() + 60_000).toISOString(),
          originalOpts: { source: "automation", triggerDetail: "system", reason: "github_pr_opened" },
        },
      },
      status: "dispatch_failed",
    });

    const result = await heartbeat.reconcileFailedWakeDispatches(now);
    expect(result.recovered).toBe(0);
    expect(result.superseded).toBe(0);
    expect(result.exhausted).toBe(0);
    expect(result.stillFailing).toBe(0);

    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(row?.status).toBe("dispatch_failed");
  });

  it("reconcileFailedWakeDispatches marks a row dispatch_superseded when the retry now resolves to a business-rule outcome", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent({ agentStatus: "paused" });
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_opened",
      payload: {
        dispatchRetry: {
          attempts: 1,
          nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
          originalOpts: { source: "automation", triggerDetail: "system", reason: "github_pr_opened" },
        },
      },
      status: "dispatch_failed",
    });

    const result = await heartbeat.reconcileFailedWakeDispatches(now);
    expect(result.superseded).toBe(1);

    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(row?.status).toBe("dispatch_superseded");
  });

  // BLO-18859: the four-state delivery counter. These assert the two states
  // that live on the heartbeat side of the funnel (`retried`, `dead_lettered`);
  // `received`/`queued` are emitted by the receiver route and covered in
  // github-webhook.test.ts.
  describe("GitHub review-request delivery counters (BLO-18859)", () => {
    it("counts one `retried` per re-dispatch attempt and does not dead-letter while a durable row survives", async () => {
      const { agentId } = await seedCompanyAndAgent();
      const circular: Record<string, unknown> = { ...GITHUB_REVIEW_PAYLOAD };
      circular.self = circular;

      await expect(
        heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "github_pr_review_requested",
          payload: circular,
        }),
      ).rejects.toThrow();

      // The in-process backoff is [300ms, 1200ms] => two re-dispatch attempts
      // after the initial one. Pinning 2 (not >= 1) catches an off-by-one that
      // double-counts the first attempt as a retry.
      expect(await deliveryCount("retried")).toBe(2);
      // A durable dispatch_failed row exists, so reconciliation still owns this
      // wake — it is retry-pending, NOT terminally lost.
      expect(await deliveryCount("dead_lettered")).toBe(0);
      const failedRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "dispatch_failed")));
      expect(failedRows).toHaveLength(1);
    });

    it("leaves the counter untouched for a non-GitHub wake that fails the same way", async () => {
      const { agentId } = await seedCompanyAndAgent();
      // Same failure, but no source/reviewKind markers: wakeupWithDispatchRetry
      // is the generic wake path, so without scoping this would count every
      // issue-assigned and monitor wake as a review-request delivery.
      const circular: Record<string, unknown> = { taskKey: "issue:BLO-1" };
      circular.self = circular;

      await expect(
        heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: circular,
        }),
      ).rejects.toThrow();

      expect(await deliveryCount("retried")).toBe(0);
      expect(await deliveryCount("dead_lettered")).toBe(0);
    });

    it("counts exactly one `retried` for a transient failure that recovers, with no duplicate run", async () => {
      const { agentId, companyId } = await seedCompanyAndAgent();
      const wakeupRequestId = randomUUID();
      const now = new Date();
      // A due dispatch_failed row is exactly what a transient dispatch failure
      // leaves behind; one reconcile pass is one re-dispatch attempt.
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_review_requested",
        payload: {
          dispatchRetry: {
            attempts: 1,
            nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
            originalOpts: {
              source: "automation",
              triggerDetail: "system",
              reason: "github_pr_review_requested",
              payload: GITHUB_REVIEW_PAYLOAD,
            },
          },
        },
        status: "dispatch_failed",
      });

      const result = await heartbeat.reconcileFailedWakeDispatches(now);
      expect(result.recovered).toBe(1);
      expect(result.exhausted).toBe(0);

      expect(await deliveryCount("retried")).toBe(1);
      expect(await deliveryCount("dead_lettered")).toBe(0);
      // The delivery reached the queued state, just via the reconciler rather
      // than inline — so the funnel closes instead of showing phantom loss.
      expect(await deliveryCount("queued")).toBe(1);

      const [reconciled] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId));
      expect(reconciled?.status).toBe("dispatch_recovered");

      // "No duplicate run": the recovery produced exactly one queued wake, not
      // one per retry attempt.
      const queuedRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "queued")));
      expect(queuedRows).toHaveLength(1);
    });

    it("marks a scheduling-gate-declined re-dispatch superseded, not recovered, and counts suppressed instead of queued", async () => {
      // A paused company makes the reconciler's enqueueWakeup call resolve
      // *null* instead of throwing. The pre-fix code treated any non-throwing
      // return as success: it stamped `dispatch_recovered` and incremented
      // `queued`, so a permanently undelivered review read as recovered and the
      // funnel invariant (received = queued + suppressed + dead_lettered +
      // in-flight) silently balanced on a run that never existed.
      const { agentId, companyId } = await seedCompanyAndAgent({ companyStatus: "paused" });
      const wakeupRequestId = randomUUID();
      const now = new Date();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_review_requested",
        payload: {
          dispatchRetry: {
            attempts: 1,
            nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
            originalOpts: {
              source: "automation",
              triggerDetail: "system",
              reason: "github_pr_review_requested",
              payload: GITHUB_REVIEW_PAYLOAD,
            },
          },
        },
        status: "dispatch_failed",
      });

      const result = await heartbeat.reconcileFailedWakeDispatches(now);
      expect(result.recovered).toBe(0);
      expect(result.superseded).toBe(1);
      expect(result.exhausted).toBe(0);

      // The pass itself is still a re-dispatch attempt, so `retried` moves.
      expect(await deliveryCount("retried")).toBe(1);
      // ...but the delivery did NOT reach the queued state.
      expect(await deliveryCount("queued")).toBe(0);
      expect(await deliveryCount("suppressed")).toBe(1);
      // The cause is the literal skip reason enqueueWakeup wrote on the durable
      // skipped row, so an operator can join the firing series straight back to
      // `agent_wakeup_requests where status = 'skipped'`. A paused company is an
      // EXPECTED decline, so this cause is excluded from the outage alert.
      expect(await suppressionCount("company.inactive")).toBe(1);
      expect(await suppressionCount()).toBe(1);
      // Suppressed is a deliberate decline, not a dispatch failure.
      expect(await deliveryCount("dead_lettered")).toBe(0);

      const [reconciled] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId));
      expect(reconciled?.status).toBe("dispatch_superseded");

      // No run was queued for this agent by the recovery attempt.
      const queuedRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "queued")));
      expect(queuedRows).toHaveLength(0);
    });

    it("dead-letters exactly once when the retry chain exhausts, alongside exactly one dispatch_failed_exhausted row", async () => {
      const { agentId, companyId } = await seedCompanyAndAgent();
      const wakeupRequestId = randomUUID();
      const now = new Date();
      // attempts: 4 => this pass computes attempts = 5 = DISPATCH_RETRY_MAX_ATTEMPTS,
      // so it is the pass that exhausts the chain.
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_review_requested",
        payload: {
          dispatchRetry: {
            attempts: 4,
            nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
            originalOpts: {
              source: "automation",
              triggerDetail: "system",
              reason: "github_pr_review_requested",
              payload: GITHUB_REVIEW_PAYLOAD,
            },
          },
        },
        status: "dispatch_failed",
      });

      // Seeded with the real db above; the reconcile pass runs against a db
      // whose inserts all fail, so the re-dispatch throws a non-HttpError while
      // the status update itself still commits.
      const failingHeartbeat = heartbeatService(dbWithFailingInserts(db, Number.MAX_SAFE_INTEGER), {
        skipQueuedRunDispatch: true,
      });
      const result = await failingHeartbeat.reconcileFailedWakeDispatches(now);
      expect(result.exhausted).toBe(1);
      expect(result.recovered).toBe(0);

      expect(await deliveryCount("dead_lettered")).toBe(1);
      // The exhausting pass is still a re-dispatch attempt.
      expect(await deliveryCount("retried")).toBe(1);

      const exhaustedRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "dispatch_failed_exhausted"),
          ),
        );
      expect(exhaustedRows).toHaveLength(1);
      expect(exhaustedRows[0]!.id).toBe(wakeupRequestId);
    });

    // The two HttpError holes Ally's review of 901a4009 found. Both are
    // *durable business-rule skips*: enqueueWakeup writes a status="skipped" row
    // and then throws, so the delivery is terminally undelivered while the
    // pre-fix accounting -- which only handled `enqueueWakeup` resolving null --
    // left it at `received = 1` with no terminal state, forever. The funnel
    // invariant `received == queued + suppressed + dead_lettered` is the thing
    // being restored here, so each test pins the whole terminal row, not just
    // the state that moved.
    describe("terminal HttpError refusals (BLO-18859 review follow-up)", () => {
      it("counts `suppressed` when the agent goes non-invokable during inline dispatch", async () => {
        // A paused agent makes getAgentInvokability decline: enqueueWakeup
        // writes the durable agent.not_invokable skipped row and then throws a
        // 409. wakeupWithDispatchRetry rethrows an HttpError without retrying,
        // so the *only* record of this delivery's fate used to be that row.
        const { agentId } = await seedCompanyAndAgent({ agentStatus: "paused" });

        await expect(
          heartbeat.wakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "github_pr_review_submitted",
            payload: GITHUB_REVIEW_PAYLOAD,
          }),
        ).rejects.toThrow();

        expect(await deliveryCount("suppressed")).toBe(1);
        // Labelled with the real gate, not a generic bucket -- this is what the
        // outage alert filters on, and `agent.not_invokable` is an expected
        // decline (an operator paused the reviewer) so it must NOT page.
        expect(await suppressionCount("agent.not_invokable")).toBe(1);
        expect(await suppressionCount()).toBe(1);
        // An HttpError is a business-rule refusal, never a transient dispatch
        // failure: nothing is retried and nothing is dead-lettered.
        expect(await deliveryCount("retried")).toBe(0);
        expect(await deliveryCount("dead_lettered")).toBe(0);
        expect(await deliveryCount("queued")).toBe(0);

        // The durable evidence the cause label points at.
        const skipped = await db
          .select()
          .from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "skipped")));
        expect(skipped).toHaveLength(1);
        expect(skipped[0]!.reason).toBe("agent.not_invokable");
        // No run was queued for a delivery that reported as suppressed.
        const queuedRows = await db
          .select()
          .from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "queued")));
        expect(queuedRows).toHaveLength(0);
      });

      it("falls back to `dispatch_rejected` when the refusal wrote no durable skipped row", async () => {
        // An unresolvable agent throws notFound before any gate can write a
        // skipped row, so there is no reason to read off the sink. The delivery
        // is still terminal, and `dispatch_rejected` IS pageable: the receiver
        // resolved a reviewer that the dispatch path then refused, which no
        // amount of waiting fixes.
        await expect(
          heartbeat.wakeup(randomUUID(), {
            source: "automation",
            triggerDetail: "system",
            reason: "github_pr_review_submitted",
            payload: GITHUB_REVIEW_PAYLOAD,
          }),
        ).rejects.toThrow();

        expect(await deliveryCount("suppressed")).toBe(1);
        expect(await suppressionCount("dispatch_rejected")).toBe(1);
        expect(await suppressionCount()).toBe(1);
        expect(await deliveryCount("dead_lettered")).toBe(0);
        expect(await deliveryCount("retried")).toBe(0);
      });

      it("counts `suppressed` when the agent goes non-invokable before reconciliation", async () => {
        // Same refusal, other dispatch site: the reconciler's HttpError branch
        // stamps dispatch_superseded, which its own query never picks up again.
        // Terminal, and previously uncounted.
        const { agentId, companyId } = await seedCompanyAndAgent({ agentStatus: "paused" });
        const wakeupRequestId = randomUUID();
        const now = new Date();
        await db.insert(agentWakeupRequests).values({
          id: wakeupRequestId,
          companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "github_pr_review_submitted",
          payload: {
            dispatchRetry: {
              attempts: 1,
              nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
              originalOpts: {
                source: "automation",
                triggerDetail: "system",
                reason: "github_pr_review_submitted",
                payload: GITHUB_REVIEW_PAYLOAD,
              },
            },
          },
          status: "dispatch_failed",
        });

        const result = await heartbeat.reconcileFailedWakeDispatches(now);
        expect(result.superseded).toBe(1);
        expect(result.recovered).toBe(0);
        expect(result.exhausted).toBe(0);

        // The pass is a re-dispatch attempt, so `retried` still moves...
        expect(await deliveryCount("retried")).toBe(1);
        // ...and now the terminal outcome is recorded too.
        expect(await deliveryCount("suppressed")).toBe(1);
        expect(await suppressionCount("agent.not_invokable")).toBe(1);
        expect(await deliveryCount("queued")).toBe(0);
        expect(await deliveryCount("dead_lettered")).toBe(0);

        const [reconciled] = await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId));
        expect(reconciled?.status).toBe("dispatch_superseded");
      });

      it("leaves both counters untouched for a non-GitHub wake refused the same way", async () => {
        // The scoping guard, on the new code path: without it every paused-agent
        // issue-assigned and monitor wake in the fleet would show up as a
        // suppressed review-request delivery.
        const { agentId } = await seedCompanyAndAgent({ agentStatus: "paused" });

        await expect(
          heartbeat.wakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_assigned",
            payload: { taskKey: "issue:BLO-1" },
          }),
        ).rejects.toThrow();

        expect(await deliveryCount("suppressed")).toBe(0);
        expect(await suppressionCount()).toBe(0);
      });
    });
  });
});
