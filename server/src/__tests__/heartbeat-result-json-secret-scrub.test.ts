import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService, sanitizeRunResultJsonForStorage } from "../services/heartbeat.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

/**
 * PEN-3153: `resultJson` reached the column with no secret scrub on the path,
 * while `stdoutExcerpt`/`stderrExcerpt` and run-event payloads written in the
 * same `UPDATE` were both scrubbed. These tests drive a real adapter through a
 * real run and assert on the PERSISTED row, so they cover the wiring and not
 * just the scrub helper — a fix that is deleted from the call site fails here.
 *
 * The fixtures deliberately use only generic credential shapes (env
 * assignment, JSON field, URI userinfo). A realistic vendor token format would
 * be rejected outright by GitHub push protection, so the shapes below carry no
 * vendor prefix and an obviously-synthetic value.
 */
const SUCCESS_ADAPTER = "pen3153_result_scrub_success_test";
const FAILURE_ADAPTER = "pen3153_result_scrub_failure_test";

/** Present in every fixture value; must never survive into the database. */
const FIXTURE_SECRET = "pen3153-synthetic-not-a-real-secret";

/**
 * A `randomUUID()` written by the server into
 * `resultJson.externalLifecycleRecovery.terminalClaimToken`, which decides
 * which caller owns a terminal transition. It must survive the scrub verbatim:
 * `token` is a Tier-1 key stem, so both a key-name scrub and a scrub applied to
 * the serialized JSON text mask it -- and masking BOTH sides of that comparison
 * makes them compare equal, so every racing pass would believe it won the claim.
 */
const CONTROL_CLAIM_TOKEN = "0c8f3a52-6b1e-4a77-9f3d-2b7c19a5e401";
const BENIGN_PROSE = "Reviewed 3 files and opened a pull request.";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Ungated on purpose. The suite below needs embedded Postgres and
 * `describeEmbeddedPostgres` degrades to `describe.skip` SILENTLY when the probe
 * cannot start one, so on a runner without it the whole file would report green
 * while exercising nothing. These cases pin the scrub primitive itself — and in
 * particular the design constraint that is most likely to be "simplified" away
 * by a later contributor reaching for `redactEventPayload`.
 */
describe("sanitizeRunResultJsonForStorage (PEN-3153)", () => {
  it("masks credential shapes in strings at any depth", () => {
    const scrubbed = sanitizeRunResultJsonForStorage({
      summary: `${BENIGN_PROSE} PEN3153_FIXTURE_PASSWORD=${FIXTURE_SECRET}`,
      nested: { deeper: [`export PEN3153_FIXTURE_CREDENTIAL='${FIXTURE_SECRET}'`] },
      viaUri: `https://pen3153user:${FIXTURE_SECRET}@example.invalid/repo.git`,
      viaJsonField: `wrote {"api_key": "${FIXTURE_SECRET}"} to disk`,
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(FIXTURE_SECRET);
    expect(serialized).toContain("***REDACTED***");
    expect(serialized).toContain("Reviewed 3 files");
  });

  it("leaves the terminal-claim token intact", () => {
    // `token` is a Tier-1 key stem, so BOTH `redactEventPayload` (key-name
    // tiers) and `redactSensitiveText(JSON.stringify(...))` mask this --
    // JSON_SECRET_FIELD_TEXT_RE matches `"<key>": "<value>"` in the serialized
    // text, so serializing smuggles the key name into the scrubbed string.
    // Masking it is not cosmetic: setRunStatusIfCurrentStatus compares the
    // patch's token against the stored one to decide who owns the terminal
    // transition, and two `***REDACTED***` values compare EQUAL, so every
    // racing pass would believe it won the claim.
    const controlShape = {
      externalLifecycleRecovery: { terminalClaimToken: CONTROL_CLAIM_TOKEN },
      stopReason: "cancelled",
      pipelineStageExitCancellationRequestedAt: "2026-09-10T12:00:00.000Z",
    };
    expect(sanitizeRunResultJsonForStorage(controlShape)).toEqual(controlShape);
  });

  it("passes through values that are not plain objects or arrays", () => {
    expect(sanitizeRunResultJsonForStorage(null)).toBeNull();
    expect(sanitizeRunResultJsonForStorage(undefined)).toBeUndefined();
  });

  it("is idempotent, so scrubbing at two chokepoints cannot corrupt", () => {
    const once = sanitizeRunResultJsonForStorage({
      stdout: `PEN3153_FIXTURE_PASSWORD=${FIXTURE_SECRET}`,
    });
    expect(sanitizeRunResultJsonForStorage(once)).toEqual(once);
  });
});

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat resultJson secret scrub (PEN-3153)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pen3153-scrub-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    const testEnvironment = (adapterType: string) => async () => ({
      adapterType,
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });

    // Success branch: model-authored prose carrying credential shapes, plus the
    // server-owned control metadata that must survive.
    registerServerAdapter({
      type: SUCCESS_ADAPTER,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        resultJson: {
          summary: `${BENIGN_PROSE} PEN3153_FIXTURE_PASSWORD=${FIXTURE_SECRET}`,
          result: `wrote {"api_key": "${FIXTURE_SECRET}"} to the config`,
          nested: {
            deeper: [`export PEN3153_FIXTURE_CREDENTIAL='${FIXTURE_SECRET}'`],
          },
          externalLifecycleRecovery: { terminalClaimToken: CONTROL_CLAIM_TOKEN },
        },
      }),
      testEnvironment: testEnvironment(SUCCESS_ADAPTER),
    });

    // Failure branch: the raw `proc.stdout` / `proc.stderr` dump shape that
    // `server/src/adapters/process/execute.ts` and `claude-local` both write,
    // plus a credential-bearing `errorMessage` for the `error` column.
    registerServerAdapter({
      type: FAILURE_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          `fatal: could not read from https://pen3153user:${FIXTURE_SECRET}@example.invalid/repo.git`,
        errorCode: "adapter_failed",
        resultJson: {
          stdout: `starting\nPEN3153_FIXTURE_PASSWORD=${FIXTURE_SECRET}\n`,
          stderr: `fatal: authentication failed for https://pen3153user:${FIXTURE_SECRET}@example.invalid/repo.git`,
          exitCode: 1,
        },
      }),
      testEnvironment: testEnvironment(FAILURE_ADAPTER),
    });
  }, 120_000);

  afterAll(async () => {
    unregisterServerAdapter(SUCCESS_ADAPTER);
    unregisterServerAdapter(FAILURE_ADAPTER);
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "PEN-3153 resultJson scrub cleanup",
      drainTimeoutMs: 30_000,
    });
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PEN-3153 scrub test",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `PEN-3153 scrub ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: { timeoutSec: 300 },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  /** Read the column directly, not the API projection, which truncates by size. */
  async function readStoredColumns(runId: string) {
    return await db
      .select({ resultJson: heartbeatRuns.resultJson, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("does not persist a credential shape from a successful adapter result", async () => {
    const agentId = await seedAgent(SUCCESS_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const persistedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(persistedRun?.status).toBe("succeeded");

    const stored = await readStoredColumns(run!.id);
    const serialized = JSON.stringify(stored?.resultJson ?? {});
    expect(serialized).not.toContain(FIXTURE_SECRET);
    // The scrub ran rather than the field being dropped or emptied.
    expect(serialized).toContain("***REDACTED***");
    // Readability is preserved: only the credential is masked.
    expect(serialized).toContain("Reviewed 3 files");
  });

  it("scrubs the nested and array-valued parts of an adapter result", async () => {
    const agentId = await seedAgent(SUCCESS_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const persistedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(persistedRun?.status).toBe("succeeded");

    const stored = await readStoredColumns(run!.id);
    const nested = (stored?.resultJson as Record<string, any> | null)?.nested;
    expect(JSON.stringify(nested)).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(nested)).toContain("***REDACTED***");
  });

  it("preserves the terminal-claim token, which a key-name scrub would mask", async () => {
    const agentId = await seedAgent(SUCCESS_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    await waitForRunToFinish(heartbeat, run!.id);

    const stored = await readStoredColumns(run!.id);
    const recovery = (stored?.resultJson as Record<string, any> | null)?.externalLifecycleRecovery;
    expect(recovery?.terminalClaimToken).toBe(CONTROL_CLAIM_TOKEN);
  });

  it("covers the failure branch that dumps raw proc.stdout / proc.stderr", async () => {
    const agentId = await seedAgent(FAILURE_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const persistedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(persistedRun?.status).toBe("failed");

    const stored = await readStoredColumns(run!.id);
    const resultJson = stored?.resultJson as Record<string, any> | null;
    expect(JSON.stringify(resultJson ?? {})).not.toContain(FIXTURE_SECRET);
    expect(String(resultJson?.stdout)).toContain("***REDACTED***");
    expect(String(resultJson?.stderr)).toContain("***REDACTED***");
  });

  it("secret-scrubs the error column while keeping it readable", async () => {
    const agentId = await seedAgent(FAILURE_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    await waitForRunToFinish(heartbeat, run!.id);

    const stored = await readStoredColumns(run!.id);
    expect(stored?.error).toBeTruthy();
    expect(stored?.error ?? "").not.toContain(FIXTURE_SECRET);
    // PEN-3149 keeps `error` company-readable on purpose: the diagnosis stays.
    expect(stored?.error ?? "").toContain("could not read from");
  });
});
