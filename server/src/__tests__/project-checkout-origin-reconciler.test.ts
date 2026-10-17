import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, projects, projectWorkspaces } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetMetricsForTest,
  PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC,
  PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC,
  PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC,
  renderMetrics,
} from "../services/metrics.js";
import {
  PROJECT_CHECKOUT_ORIGIN_PASS_BUDGET_MS,
  PROJECT_CHECKOUT_ORIGIN_RECONCILE_INTERVAL_MS,
  ProjectCheckoutOriginPassTimeoutError,
  reconcileProjectCheckoutOrigins,
  resolveProjectCheckoutDir,
  startProjectCheckoutOriginReconciler,
} from "../services/project-checkout-origin-reconciler.js";

/**
 * PEN-4188 (PEN-3633 item 5).
 *
 * The filesystem and `git` are injected; the DATABASE is real, because the
 * claim under test is partly a query claim -- "every project workspace that
 * expects a repository is probed, and each one yields at most one signal" --
 * and a mocked `select()` chain cannot fail the way a real `where` clause can.
 */

const HTTPS = "https://github.com/Blockcast/penstock-llm-proxy-core.git";
/** What `git config --get remote.origin.url` stores on a healthy Blockcast checkout. */
const HTTPS_STORED = HTTPS;
/** What `git remote -v` PRINTS for that same checkout, because of the shared `insteadOf`. */
const SSH_REWRITTEN = "git@github.com:Blockcast/penstock-llm-proxy-core.git";
/** The repository PEN-3628's checkout was actually pointed at. */
const WRONG = "https://github.com/Blockcast/paperclip.git";

function seriesValue(body: string, metric: string, labels: Record<string, string>): number | null {
  const labelPart = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const match = body.match(
    new RegExp(`^${metric}\\{${labelPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\} (\\S+)$`, "m"),
  );
  return match ? Number(match[1]) : null;
}

function unlabelledGauge(body: string, metric: string): number | null {
  const match = body.match(new RegExp(`^${metric} (\\S+)$`, "m"));
  return match ? Number(match[1]) : null;
}

function countSeries(body: string, metric: string): number {
  return body.split("\n").filter((line) => line.startsWith(`${metric}{`)).length;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileProjectCheckoutOrigins (PEN-4188)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-origin-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE project_workspaces, projects, companies CASCADE`);
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let companyCounter = 0;

  async function seedWorkspace(input: { repoUrl: string | null; cwd?: string | null }) {
    companyCounter += 1;
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Checkout Co ${companyCounter}`,
      issuePrefix: `CHK${companyCounter}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Checkout Project" });
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "primary checkout",
      sourceType: "git_repo",
      repoUrl: input.repoUrl,
      cwd: input.cwd ?? null,
      isPrimary: true,
    });
    return { companyId, projectId, projectWorkspaceId };
  }

  /** Every directory exists; `git config` answers from the map, keyed by cwd. */
  function fakeProbes(originByCwd: Record<string, string | null>) {
    return {
      directoryExists: async (cwd: string) => cwd in originByCwd,
      readOriginUrl: async (cwd: string) => originByCwd[cwd] ?? null,
    };
  }

  /**
   * THE NON-NEGOTIABLE NEGATIVE CONTROL.
   *
   * The shared `/paperclip/.gitconfig` rewrites `https://github.com/Blockcast/`
   * to SSH at transport time, so `git remote -v` disagrees with the stored
   * config on every healthy Blockcast checkout. A reconciler that fired here
   * would page on all 565 issues of a healthy project. Asserted against BOTH
   * forms, because the reconciler must survive a checkout whose config really
   * does hold the SSH form as well as one that merely prints it.
   */
  it.each([
    ["the stored HTTPS form", HTTPS_STORED],
    ["the SSH form `git remote -v` prints under insteadOf", SSH_REWRITTEN],
  ])("does NOT fire on a healthy Blockcast checkout reporting %s", async (_label, actualUrl) => {
    const { projectWorkspaceId } = await seedWorkspace({ repoUrl: HTTPS, cwd: "/co/healthy" });

    const outcome = await reconcileProjectCheckoutOrigins(
      db,
      fakeProbes({ "/co/healthy": actualUrl }),
    );

    expect(outcome.mismatches).toEqual([]);
    expect(outcome.compared).toBe(1);

    const { body } = await renderMetrics();
    expect(countSeries(body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC)).toBe(0);
    expect(
      seriesValue(body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, {
        project_workspace_id: projectWorkspaceId,
      }),
    ).toBeNull();
    // The positive control: zero mismatches is only evidence because one
    // checkout was actually compared.
    expect(unlabelledGauge(body, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC)).toBe(1);
    expect(
      unlabelledGauge(body, PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC),
    ).toBe(1);
  });

  it("fires one project-scoped series on the PEN-3628 repointing", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedWorkspace({
      repoUrl: HTTPS,
      cwd: "/co/broken",
    });

    const outcome = await reconcileProjectCheckoutOrigins(db, fakeProbes({ "/co/broken": WRONG }));

    expect(outcome.mismatches).toEqual([
      {
        projectWorkspaceId,
        companyId,
        projectId,
        cwd: "/co/broken",
        actualUrl: WRONG,
        expectedRepoUrl: HTTPS,
      },
    ]);

    const { body } = await renderMetrics();
    expect(
      seriesValue(body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, {
        project_workspace_id: projectWorkspaceId,
        company_id: companyId,
        project_id: projectId,
      }),
    ).toBe(1);
    // One checkout, one series -- not one per issue and not one per run. The
    // measured fan-out was 565 issues across ~86 executionWorkspaceIds, all
    // resolving to this single cwd.
    expect(countSeries(body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC)).toBe(1);
  });

  it("isolates a broken checkout from a healthy one in the same pass", async () => {
    const healthy = await seedWorkspace({ repoUrl: HTTPS, cwd: "/co/healthy" });
    const broken = await seedWorkspace({ repoUrl: HTTPS, cwd: "/co/broken" });

    const outcome = await reconcileProjectCheckoutOrigins(
      db,
      fakeProbes({ "/co/healthy": SSH_REWRITTEN, "/co/broken": WRONG }),
    );

    expect(outcome.compared).toBe(2);
    expect(outcome.mismatches.map((entry) => entry.projectWorkspaceId)).toEqual([
      broken.projectWorkspaceId,
    ]);

    const { body } = await renderMetrics();
    expect(
      seriesValue(body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, {
        project_workspace_id: healthy.projectWorkspaceId,
      }),
    ).toBeNull();
    expect(countSeries(body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC)).toBe(1);
  });

  it("clears a mismatch series once the checkout is repaired", async () => {
    const { projectWorkspaceId } = await seedWorkspace({ repoUrl: HTTPS, cwd: "/co/broken" });

    await reconcileProjectCheckoutOrigins(db, fakeProbes({ "/co/broken": WRONG }));
    expect(countSeries((await renderMetrics()).body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC))
      .toBe(1);

    await reconcileProjectCheckoutOrigins(db, fakeProbes({ "/co/broken": HTTPS }));
    const { body } = await renderMetrics();
    expect(
      seriesValue(body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, {
        project_workspace_id: projectWorkspaceId,
      }),
    ).toBeNull();
    expect(unlabelledGauge(body, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC)).toBe(1);
  });

  it("counts an unprovisioned checkout as absent, never as agreement", async () => {
    await seedWorkspace({ repoUrl: HTTPS, cwd: "/co/not-cloned-yet" });

    const readOriginUrl = vi.fn(async () => HTTPS);
    const outcome = await reconcileProjectCheckoutOrigins(db, {
      directoryExists: async () => false,
      readOriginUrl,
    });

    expect(outcome).toMatchObject({ compared: 0, absent: 1, unreadable: 0, mismatches: [] });
    // One `stat` stands in for one spawn: ~1,850 of 2,515 managed directories on
    // the production PVC hold no checkout at all.
    expect(readOriginUrl).not.toHaveBeenCalled();
    // And the positive control reads 0, so an empty mismatch set here is NOT
    // eligible to be read as health.
    expect(unlabelledGauge((await renderMetrics()).body, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC))
      .toBe(0);
  });

  it("counts an unreadable origin as unreadable, never as agreement", async () => {
    await seedWorkspace({ repoUrl: HTTPS, cwd: "/co/no-origin" });

    const outcome = await reconcileProjectCheckoutOrigins(
      db,
      fakeProbes({ "/co/no-origin": null }),
    );

    expect(outcome).toMatchObject({ compared: 0, absent: 0, unreadable: 1, mismatches: [] });
    expect(unlabelledGauge((await renderMetrics()).body, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC))
      .toBe(0);
  });

  it.each([
    ["null", null],
    ["empty", ""],
  ])("skips a workspace whose repo_url is %s rather than probing it", async (_label, repoUrl) => {
    await seedWorkspace({ repoUrl, cwd: "/co/no-repo" });

    const readOriginUrl = vi.fn(async () => HTTPS);
    const outcome = await reconcileProjectCheckoutOrigins(db, {
      directoryExists: async () => true,
      readOriginUrl,
    });

    expect(outcome).toMatchObject({ compared: 0, absent: 0, unreadable: 0, mismatches: [] });
    expect(readOriginUrl).not.toHaveBeenCalled();
  });

  it("probes the managed checkout directory when the workspace has no explicit cwd", async () => {
    const { companyId, projectId } = await seedWorkspace({ repoUrl: HTTPS, cwd: null });

    const probed: string[] = [];
    await reconcileProjectCheckoutOrigins(db, {
      directoryExists: async (cwd) => {
        probed.push(cwd);
        return false;
      },
      readOriginUrl: async () => null,
    });

    expect(probed).toHaveLength(1);
    // Resolved by the runtime's own deriver, so the reconciler probes the
    // directory the dispatcher would actually bind.
    expect(probed[0]).toBe(
      resolveProjectCheckoutDir({
        id: "ignored",
        companyId,
        projectId,
        cwd: null,
        repoUrl: HTTPS,
      }),
    );
    expect(probed[0]).toContain(companyId);
    expect(probed[0]).toContain(projectId);
    expect(probed[0]).toMatch(/penstock-llm-proxy-core$/);
  });

  it("marks the refresh failed rather than publishing synthetic zeros", async () => {
    await seedWorkspace({ repoUrl: HTTPS, cwd: "/co/broken" });
    await reconcileProjectCheckoutOrigins(db, fakeProbes({ "/co/broken": WRONG }));
    expect(countSeries((await renderMetrics()).body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC))
      .toBe(1);

    const boom = new Error("probe exploded");
    await expect(
      reconcileProjectCheckoutOrigins(db, {
        directoryExists: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    const { body } = await renderMetrics();
    // The mismatch survives: zeroing it would read as "the checkout was
    // repaired", the one conclusion a failed pass cannot support.
    expect(countSeries(body, PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC)).toBe(1);
    expect(
      unlabelledGauge(body, PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC),
    ).toBe(0);
  });

  it("fails the pass on its budget rather than wedging the reconciler forever", async () => {
    // The non-overlap guard means a pass that never settles stops the
    // reconciler for good, while every gauge keeps its last value and the
    // freshness gauge keeps reading 1 -- dead and indistinguishable from
    // healthy. `fs.stat` on a wedged network mount has no timeout of its own,
    // so the budget is the only thing standing between that and a silent stop.
    await seedWorkspace({ repoUrl: HTTPS, cwd: "/co/wedged" });

    await expect(
      reconcileProjectCheckoutOrigins(db, {
        passBudgetMs: 25,
        // Never settles, exactly like a stat against a dead mount.
        directoryExists: () => new Promise<boolean>(() => {}),
      }),
    ).rejects.toBeInstanceOf(ProjectCheckoutOriginPassTimeoutError);

    // Reported as a FAILED pass, so the mismatch alert is gated off rather than
    // reading an empty snapshot as "every checkout agrees".
    expect(
      unlabelledGauge(
        (await renderMetrics()).body,
        PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC,
      ),
    ).toBe(0);
  });

  it("budgets a pass well above the measured full-estate sweep", () => {
    // ~4.5s strictly serial for the whole production estate (2,515 managed
    // directories, 665 with a .git, ~6.8ms per probe), and the budget must stay
    // comfortably inside the interval so a timed-out pass cannot collide with
    // its successor.
    expect(PROJECT_CHECKOUT_ORIGIN_PASS_BUDGET_MS).toBeGreaterThan(30_000);
    expect(PROJECT_CHECKOUT_ORIGIN_PASS_BUDGET_MS).toBeLessThan(
      PROJECT_CHECKOUT_ORIGIN_RECONCILE_INTERVAL_MS,
    );
  });

  it("respects the probe concurrency bound", async () => {
    for (let i = 0; i < 6; i += 1) {
      await seedWorkspace({ repoUrl: HTTPS, cwd: `/co/ws-${i}` });
    }

    let inFlight = 0;
    let peak = 0;
    await reconcileProjectCheckoutOrigins(db, {
      probeConcurrency: 2,
      directoryExists: async () => true,
      readOriginUrl: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return HTTPS;
      },
    });

    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("startProjectCheckoutOriginReconciler", () => {
  it("runs immediately, re-arms on its own interval, and unrefs the timer", () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalFn = vi.fn(() => timer) as unknown as typeof setInterval;
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;
    const readOriginUrl = vi.fn(async () => null);

    const stop = startProjectCheckoutOriginReconciler(
      { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) } as never,
      {
        setInterval: setIntervalFn,
        clearInterval: clearIntervalFn,
        directoryExists: async () => false,
        readOriginUrl,
      },
    );

    expect(setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      PROJECT_CHECKOUT_ORIGIN_RECONCILE_INTERVAL_MS,
    );
    expect(unref).toHaveBeenCalled();
    stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });

  it("skips ticks while a timed-out pass's probe phase is still running", async () => {
    // The pass budget releases the non-overlap guard on time, which is what
    // stops a wedged mount from killing the detector outright. But the probes
    // it walked away from keep running, and the `fs.stat` in front of each one
    // has no timeout: on a dead mount it holds a libuv threadpool thread, of
    // which there are 4 by default. Without this skip every later tick piles on
    // up to PROBE_CONCURRENCY more, so the reconciler would progressively
    // starve unrelated `fs`, `dns.lookup` and zlib work in the same process.
    __resetMetricsForTest();

    const row = {
      id: randomUUID(),
      companyId: randomUUID(),
      projectId: randomUUID(),
      cwd: "/co/wedged",
      repoUrl: HTTPS,
    };
    const stubDb = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [row] }) }) }),
      }),
    } as never;

    let releaseStat!: (value: boolean) => void;
    const wedged = new Promise<boolean>((resolve) => {
      releaseStat = resolve;
    });
    // First pass answers immediately so it SUCCEEDS; every later pass hangs,
    // exactly like a stat against a mount that died in between. That ordering
    // is what makes the freshness gauge an edge-triggered 1 -> 0 signal below,
    // rather than a value that was 0 all along and proves nothing.
    const directoryExists = vi.fn(() => (directoryExists.mock.calls.length === 1
      ? Promise.resolve(false)
      : wedged));

    const freshness = async () =>
      unlabelledGauge(
        (await renderMetrics()).body,
        PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC,
      );

    let intervalCallback!: () => void;
    const setIntervalFn = vi.fn((cb: () => void) => {
      intervalCallback = cb;
      return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const stop = startProjectCheckoutOriginReconciler(stubDb, {
      setInterval: setIntervalFn,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
      passBudgetMs: 10,
      directoryExists,
    });

    // Pass 1 completes normally.
    await vi.waitFor(async () => expect(await freshness()).toBe(1));
    expect(directoryExists).toHaveBeenCalledTimes(1);

    // Pass 2 hangs on the stat and is cut off by its budget. Waiting on the
    // 1 -> 0 transition -- not on a sleep -- is what proves the budget actually
    // fired and released `ticking`, so what the next two ticks hit is THIS
    // guard and not the ordinary non-overlap one.
    intervalCallback();
    await vi.waitFor(async () => expect(await freshness()).toBe(0));
    expect(directoryExists).toHaveBeenCalledTimes(2);

    // Two more ticks while that stat is still hung: neither may add a probe.
    intervalCallback();
    intervalCallback();
    // A full timer turn, not a single microtask. With the guard removed, an
    // unguarded pass today reaches `statDir` after exactly one microtask --
    // the stub's `limit` resolves immediately and `mapWithConcurrency` calls
    // `fn` synchronously -- so `await Promise.resolve()` was only just enough.
    // One more `await` anywhere ahead of that stat and this check would still
    // read 2 with the guard gone, and the final count-of-3 wait below would
    // then be satisfied by the unguarded pass itself: green, and no longer
    // testing anything. Yielding past a timer does not depend on that count.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(directoryExists).toHaveBeenCalledTimes(2);

    // The skip is not a silent stop -- freshness is still 0 throughout, so the
    // ...ReconcileMetricsRefreshFailed alert goes on paging for its duration.
    expect(await freshness()).toBe(0);

    // Mount recovers: the orphan settles and the next tick sweeps again.
    releaseStat(false);
    await vi.waitFor(() => {
      intervalCallback();
      expect(directoryExists).toHaveBeenCalledTimes(3);
    });

    stop();
  });

  it("polls far more often than the ~3h manual sweep PEN-3628 needed", () => {
    expect(PROJECT_CHECKOUT_ORIGIN_RECONCILE_INTERVAL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});
