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

  it("masks a SHORT structured credential under a secret-ish key", () => {
    // #1746 review, Important. The first version of this fix scrubbed string
    // leaves only, so it never evaluated the key a value sits under, and a
    // short structured credential walked straight through: measured
    // `{api_key:"hunter2"} -> {api_key:"hunter2"}`. No text heuristic can
    // catch these -- `hunter2` is a word, not a credential shape -- so the
    // key name is the ONLY available signal. Values here are deliberately
    // short and vendor-prefix-free: the point is that nothing but the key
    // name identifies them.
    const scrubbed = sanitizeRunResultJsonForStorage({
      api_key: "hunter2",
      password: "hunter2",
      nested: { accessToken: "hunter2" },
      viaArray: [{ authorization: "hunter2" }],
    }) as Record<string, unknown>;
    expect(scrubbed).toEqual({
      api_key: "***REDACTED***",
      password: "***REDACTED***",
      nested: { accessToken: "***REDACTED***" },
      viaArray: [{ authorization: "***REDACTED***" }],
    });
  });

  it("still masks credentials in PROSE under a NEUTRAL key", () => {
    // The other half of the union, and the reason the fix is not simply
    // `sanitizeRecord`. Key-name classification never inspects a neutral key,
    // so it returns this fixture UNCHANGED (measured). `resultJson.result` /
    // `summary` / `message` / `stdout` / `stderr` are all neutral keys holding
    // model- and CLI-authored free text, and that is the class actually
    // observed occupied in this column. Deleting the leaf-text half to "just
    // use the key tiers" would reopen exactly what this row was filed for.
    const scrubbed = sanitizeRunResultJsonForStorage({
      summary: `ran with PEN3153_FIXTURE_TOKEN=${FIXTURE_SECRET}`,
      result: `then set PEN3153_FIXTURE_TOKEN=${FIXTURE_SECRET}`,
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(FIXTURE_SECRET);
    expect(serialized).toContain("***REDACTED***");
  });

  it("exempts the terminal-claim token by PATH, not by key name", () => {
    // The allowlist is root-anchored. A `terminalClaimToken` appearing
    // anywhere other than under `externalLifecycleRecovery` is not control
    // metadata and must still be masked, or the exemption becomes a
    // laundering channel for any value a caller chooses to park under that
    // key name.
    expect(sanitizeRunResultJsonForStorage({ terminalClaimToken: CONTROL_CLAIM_TOKEN })).toEqual({
      terminalClaimToken: "***REDACTED***",
    });
  });

  it("keeps the missing-binding secret REFERENCE readable for triage", () => {
    // Caught by this row's own CI (server shard 2/4, run 34547653433): the
    // key-tier half masked `secretId`/`secretName` inside
    // `configurationIncomplete`, breaking
    // `heartbeat-process-recovery.test.ts` > "blocks before dispatch when a
    // declared secret ref has no binding instead of emitting an opaque setup
    // failure".
    //
    // Both keys tokenize to two tokens containing `secret`, so
    // `promotesTier2ToTier1` promotes them to Tier 1. But they are the secret
    // REFERENCE (a `secrets` row UUID and its operator-chosen name), not the
    // value -- and the value cannot be present, because this payload is raised
    // by the pre-dispatch gate precisely because the binding is MISSING.
    // Masking them protected nothing and reduced a "create THIS binding"
    // instruction to the opaque failure the gate exists to replace.
    const missingBinding = {
      configPath: "env.UNBOUND_API_KEY",
      consumerId: "1becd8a5-3512-460f-ac6e-abfb341c50a4",
      consumerType: "agent",
      envKey: "UNBOUND_API_KEY",
      secretId: "b41f0b0b-daba-4341-8301-27bf71cc9e98",
      secretName: "unbound-runtime-3d9c878d",
    };
    const controlShape = {
      configurationIncomplete: {
        reason: "secret_binding_missing",
        missingBindings: [missingBinding],
      },
    };
    // An array index contributes no path segment, so the single allowlist
    // entry has to cover every element -- not just the first.
    const twoEntries = {
      configurationIncomplete: {
        reason: "secret_binding_missing",
        missingBindings: [missingBinding, { ...missingBinding, envKey: "OTHER_API_KEY" }],
      },
    };
    expect(sanitizeRunResultJsonForStorage(controlShape)).toEqual(controlShape);
    expect(sanitizeRunResultJsonForStorage(twoEntries)).toEqual(twoEntries);
  });

  it("exempts the missing-binding reference by PATH, not by key name", () => {
    // Same root-anchoring rule as the claim token. `secretName` is only a
    // reference where the SERVER writes it; the same key elsewhere in the tree
    // is adapter-reachable and must still mask, or the carve-out becomes a
    // laundering channel.
    expect(
      sanitizeRunResultJsonForStorage({
        secretId: "b41f0b0b-daba-4341-8301-27bf71cc9e98",
        secretName: "unbound-runtime-3d9c878d",
        missingBindings: [{ secretName: "unbound-runtime-3d9c878d" }],
      }),
    ).toEqual({
      secretId: "***REDACTED***",
      secretName: "***REDACTED***",
      missingBindings: [{ secretName: "***REDACTED***" }],
    });
  });

  it("still text-scrubs a credential planted at an exempt control path", () => {
    // Defense in depth for BOTH allowlist entries. The exemption suppresses
    // key-name masking only; `redactSensitiveText` still runs on the leaf. A
    // UUID and a binding name match no credential shape and survive, but a
    // real credential parked at the same path does not -- so the carve-out
    // cannot be used to launder one.
    const scrubbed = sanitizeRunResultJsonForStorage({
      externalLifecycleRecovery: {
        terminalClaimToken: `PEN3153_FIXTURE_TOKEN=${FIXTURE_SECRET}`,
      },
      configurationIncomplete: {
        missingBindings: [{ secretName: `PEN3153_FIXTURE_PASSWORD=${FIXTURE_SECRET}` }],
      },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(FIXTURE_SECRET);
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
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Fail loudly rather than returning a still-running row. Handing a `queued`/
  // `running` row back to the caller turns "the run never executed" into a
  // confusing assertion failure about column contents — or, worse, lets a
  // future case pass without ever exercising terminal persistence, which is
  // the only thing these tests are here to check (#1746 review).
  const last = await heartbeat.getRun(runId);
  throw new Error(
    `waitForRunToFinish: run ${runId} did not reach a terminal status within ${timeoutMs}ms `
      + `(last status: ${last?.status ?? "<missing>"}). The scrub assertions below never ran.`,
  );
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
