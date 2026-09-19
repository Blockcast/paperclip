import { describe, expect, it, vi, beforeEach } from "vitest";

// PEN-3205: the workspace-operation write path applied only `redactCurrentUserText`
// (username censoring) to captured command output, so a secret-shaped chunk reached
// BOTH durable sinks in the clear: the `stdoutExcerpt`/`stderrExcerpt` columns and the
// log-store body. The amplifier is `buildWorkspaceCommandEnv`, which hands operator
// commands `{ ...process.env }` wholesale — a command under `set -x`, or any tool that
// dumps its environment on failure, writes the server environment into a durable
// company-readable channel.
//
// These tests assert BOTH sinks on purpose. Scrubbing one and not the other is the
// exact half-control this row exists to close, and a test that only reads the excerpt
// would have passed against a fix that left the log body unscrubbed.

const capturedAppends: { stream: string; chunk: string }[] = [];
const capturedUpdates: Record<string, unknown>[] = [];
const capturedInserts: Record<string, unknown>[] = [];

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../services/workspace-operation-log-store.js", () => ({
  getWorkspaceOperationLogStore: () => ({
    begin: async () => ({ store: "local_file", logRef: "test/log.ndjson" }),
    append: async (_handle: unknown, event: { stream: string; chunk: string }) => {
      capturedAppends.push({ stream: event.stream, chunk: event.chunk });
    },
    finalize: async () => ({ bytes: 0, sha256: "sha", compressed: false }),
    read: async () => ({ content: "" }),
  }),
}));

const { workspaceOperationService } = await import("../services/workspace-operations.js");

function makeFakeDb() {
  const thenableWhere = (payload: Record<string, unknown>) => {
    const row = {
      id: "op-1",
      companyId: "company-1",
      phase: "provision",
      status: "succeeded",
      logCompressed: false,
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...payload,
    };
    return {
      returning: () => Promise.resolve([row]),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve([row]).then(resolve),
    };
  };

  return {
    insert: () => ({
      values: async (payload: Record<string, unknown>) => {
        capturedInserts.push(payload);
      },
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        capturedUpdates.push(payload);
        return { where: () => thenableWhere(payload) };
      },
    }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  } as never;
}

const SECRET = "fake-pen3205-workspace-op-secret";
const SECRET_CHUNK = `PAPERCLIP_SYNTHETIC_TOKEN=${SECRET}\nSAFE_ENV_NAME=visible\n`;

async function runOperation(result: { stdout?: string; stderr?: string }) {
  capturedAppends.length = 0;
  capturedUpdates.length = 0;
  capturedInserts.length = 0;

  const svc = workspaceOperationService(makeFakeDb());
  const recorder = svc.createRecorder({ companyId: "company-1" });
  await recorder.recordOperation({
    phase: "provision" as never,
    command: "bash -lc 'set -x; env'",
    cwd: "/workspace",
    run: async () => ({ stdout: result.stdout ?? null, stderr: result.stderr ?? null }),
  });

  const finalUpdate = capturedUpdates.at(-1) ?? {};
  return {
    stdoutExcerpt: (finalUpdate.stdoutExcerpt as string | null) ?? "",
    stderrExcerpt: (finalUpdate.stderrExcerpt as string | null) ?? "",
    logBody: capturedAppends.map((a) => a.chunk).join(""),
  };
}

describe("workspace-operation captured output is secret-scrubbed at write time", () => {
  beforeEach(() => {
    capturedAppends.length = 0;
    capturedUpdates.length = 0;
    capturedInserts.length = 0;
  });

  it("scrubs a secret-shaped stdout chunk in the excerpt column", async () => {
    const { stdoutExcerpt } = await runOperation({ stdout: SECRET_CHUNK });

    expect(stdoutExcerpt).not.toContain(SECRET);
    expect(stdoutExcerpt).toContain("PAPERCLIP_SYNTHETIC_TOKEN=***REDACTED***");
  });

  it("scrubs the same chunk in the durable log-store body", async () => {
    const { logBody } = await runOperation({ stdout: SECRET_CHUNK });

    expect(logBody).not.toContain(SECRET);
    expect(logBody).toContain("PAPERCLIP_SYNTHETIC_TOKEN=***REDACTED***");
  });

  it("scrubs secret-shaped stderr too — the failure path is where env dumps land", async () => {
    const { stderrExcerpt, logBody } = await runOperation({ stderr: SECRET_CHUNK });

    expect(stderrExcerpt).not.toContain(SECRET);
    expect(logBody).not.toContain(SECRET);
  });

  // Discriminates scrubbing from blanking: a fix that simply dropped the output
  // would satisfy every "not.toContain" above. This is the control that fails it.
  it("passes a non-secret chunk through unchanged in both sinks", async () => {
    const benign = "Cloning into 'repo'...\nremote: Enumerating objects: 42, done.\n";
    const { stdoutExcerpt, logBody } = await runOperation({ stdout: benign });

    expect(stdoutExcerpt).toBe(benign);
    expect(logBody).toBe(benign);
  });

  it("keeps the non-secret line beside a scrubbed one", async () => {
    const { stdoutExcerpt } = await runOperation({ stdout: SECRET_CHUNK });

    expect(stdoutExcerpt).toContain("SAFE_ENV_NAME=visible");
  });
});
