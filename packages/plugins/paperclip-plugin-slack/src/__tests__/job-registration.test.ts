import { describe, expect, it, vi } from "vitest";
import plugin from "../worker.js";
import manifest from "../manifest.js";

// BLO-20959: setup() used to early-return (on a missing slackTokenRef) before
// reaching any `ctx.jobs.register(...)` call, so the scheduler was left with
// no handler for any Slack job — forever, since there is no onConfigChanged
// to replay setup(). Handlers must now register unconditionally, before the
// slackTokenRef check.
const MANIFEST_JOB_KEYS = manifest.jobs?.map((job) => job.jobKey) ?? [];

const mkCtx = (config: Record<string, unknown> = {}) => {
  const registeredJobs = new Map<string, (...args: unknown[]) => unknown>();
  const ctx: any = {
    config: { get: vi.fn(async () => config) },
    jobs: {
      register: vi.fn((jobKey: string, fn: (...args: unknown[]) => unknown) => {
        registeredJobs.set(jobKey, fn);
      }),
    },
    events: { on: vi.fn() },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
  return { ctx, registeredJobs };
};

describe("worker setup() job registration (BLO-20959)", () => {
  it("declares at least the four scheduled jobs in manifest.ts", () => {
    expect(MANIFEST_JOB_KEYS).toEqual(
      expect.arrayContaining([
        "daily-digest",
        "check-escalation-timeouts",
        "check-watches",
        "commit-pending-approvals",
      ]),
    );
  });

  it("registers a handler for every manifest jobKey even when slackTokenRef is missing", async () => {
    const { ctx, registeredJobs } = mkCtx({});

    await plugin.definition.setup(ctx);

    expect(ctx.config.get).toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No slackTokenRef configured"),
    );
    for (const jobKey of MANIFEST_JOB_KEYS) {
      expect(registeredJobs.has(jobKey)).toBe(true);
    }
  });

  it("a job invoked with no token resolved warns once and no-ops instead of throwing", async () => {
    const { ctx, registeredJobs } = mkCtx({});
    await plugin.definition.setup(ctx);

    ctx.logger.warn.mockClear();
    const commitJob = registeredJobs.get("commit-pending-approvals");
    expect(commitJob).toBeTypeOf("function");

    await expect(commitJob!()).resolves.toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Slack job "commit-pending-approvals" skipped'),
    );
  });
});
