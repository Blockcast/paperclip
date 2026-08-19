import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const { logActivity } = await import("../services/activity-log.js");
const {
  findMissingHookCommandPaths,
  auditHookCommands,
  auditConfiguredHookCommandsOnBoot,
  describeHookCommandFinding,
  LIFECYCLE_HOOK_COMMAND_SETTINGS,
  LIFECYCLE_HOOK_COMMAND_UNRESOLVED_ACTION,
} = await import("../services/lifecycle-hook-command-audit.js");

const fakeDb = {} as unknown as Db;

/** Only the paths listed here "exist"; everything else is missing. */
function fsWith(...present: string[]) {
  const set = new Set(present);
  return { fileExists: (p: string) => set.has(p) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("findMissingHookCommandPaths", () => {
  it("flags the exact BLO-28782 production command", () => {
    // The literal string that was stored in instance_settings.general and
    // produced 500/500 MODULE_NOT_FOUND fires between 2026-07-05 and
    // 2026-08-18 across 11 agents.
    const missing = findMissingHookCommandPaths(
      "node /app/server/dist/cli/ccrotate-relogin-trigger.js",
      fsWith("/app/server/dist/cli/ccrotate-state-hook.js"),
    );
    expect(missing).toEqual(["/app/server/dist/cli/ccrotate-relogin-trigger.js"]);
  });

  it("passes a command whose script does exist", () => {
    const missing = findMissingHookCommandPaths(
      "node /app/server/dist/cli/ccrotate-state-hook.js export",
      fsWith("/app/server/dist/cli/ccrotate-state-hook.js"),
    );
    expect(missing).toEqual([]);
  });

  it("treats an unset or blank command as configured-off, not broken", () => {
    expect(findMissingHookCommandPaths(null, fsWith())).toEqual([]);
    expect(findMissingHookCommandPaths(undefined, fsWith())).toEqual([]);
    expect(findMissingHookCommandPaths("   ", fsWith())).toEqual([]);
  });

  it("does not flag bare argv[0] resolved via PATH", () => {
    // `ccrotate` is on PATH inside the runtime image; we cannot and must not
    // decide its existence from here.
    expect(findMissingHookCommandPaths("ccrotate refresh-one", fsWith())).toEqual([]);
  });

  it("does not flag relative paths (cwd-dependent at spawn time)", () => {
    expect(findMissingHookCommandPaths("node ./scripts/hook.js", fsWith())).toEqual([]);
  });

  it("does not flag shell-interpolated paths", () => {
    expect(
      findMissingHookCommandPaths("node $PAPERCLIP_HOME/cli/hook.js", fsWith()),
    ).toEqual([]);
  });

  it("does not flag absolute non-script arguments", () => {
    // /var/log/hook.log is created by the command, not required to pre-exist.
    expect(
      findMissingHookCommandPaths(
        "node /app/hook.js --log /var/log/hook.log",
        fsWith("/app/hook.js"),
      ),
    ).toEqual([]);
  });

  it("unquotes paths and reports each missing path once", () => {
    const missing = findMissingHookCommandPaths(
      `node "/app/a.js" && node '/app/a.js' && node /app/b.sh`,
      fsWith(),
    );
    expect(missing).toEqual(["/app/a.js", "/app/b.sh"]);
  });
});

describe("auditHookCommands", () => {
  it("audits all three hook settings", () => {
    expect(LIFECYCLE_HOOK_COMMAND_SETTINGS).toEqual([
      "preRunCmd",
      "postRunCmd",
      "quotaExhaustedCmd",
    ]);

    const findings = auditHookCommands(
      {
        preRunCmd: "node /app/server/dist/cli/ccrotate-state-hook.js import",
        postRunCmd: "node /app/server/dist/cli/ccrotate-state-hook.js export",
        quotaExhaustedCmd: "node /app/server/dist/cli/ccrotate-relogin-trigger.js",
      },
      fsWith("/app/server/dist/cli/ccrotate-state-hook.js"),
    );

    expect(findings).toEqual([
      {
        setting: "quotaExhaustedCmd",
        command: "node /app/server/dist/cli/ccrotate-relogin-trigger.js",
        missingPaths: ["/app/server/dist/cli/ccrotate-relogin-trigger.js"],
      },
    ]);
    expect(describeHookCommandFinding(findings[0])).toContain(
      "ccrotate-relogin-trigger.js",
    );
  });

  it("returns no findings when every hook resolves", () => {
    expect(
      auditHookCommands(
        {
          preRunCmd: "node /app/ok.js",
          postRunCmd: null,
          quotaExhaustedCmd: null,
        },
        fsWith("/app/ok.js"),
      ),
    ).toEqual([]);
  });
});

describe("auditConfiguredHookCommandsOnBoot", () => {
  it("records one activity row per company per finding", async () => {
    const findings = await auditConfiguredHookCommandsOnBoot({
      db: fakeDb,
      getGeneral: async () => ({
        preRunCmd: null,
        postRunCmd: null,
        quotaExhaustedCmd: "node /app/server/dist/cli/ccrotate-relogin-trigger.js",
      }),
      listCompanyIds: async () => ["company-a", "company-b"],
      deps: fsWith(),
    });

    expect(findings).toHaveLength(1);
    expect(vi.mocked(logActivity)).toHaveBeenCalledTimes(2);
    const [, payload] = vi.mocked(logActivity).mock.calls[0];
    expect(payload).toMatchObject({
      companyId: "company-a",
      action: LIFECYCLE_HOOK_COMMAND_UNRESOLVED_ACTION,
      entityType: "instance_settings",
      entityId: "quotaExhaustedCmd",
      details: {
        setting: "quotaExhaustedCmd",
        missingPaths: ["/app/server/dist/cli/ccrotate-relogin-trigger.js"],
        detectedAt: "boot",
      },
    });
  });

  it("stays quiet when hooks resolve", async () => {
    const findings = await auditConfiguredHookCommandsOnBoot({
      db: fakeDb,
      getGeneral: async () => ({
        preRunCmd: "node /app/ok.js",
        postRunCmd: null,
        quotaExhaustedCmd: null,
      }),
      listCompanyIds: async () => ["company-a"],
      deps: fsWith("/app/ok.js"),
    });

    expect(findings).toEqual([]);
    expect(vi.mocked(logActivity)).not.toHaveBeenCalled();
  });

  it("never throws when instance settings cannot be read", async () => {
    await expect(
      auditConfiguredHookCommandsOnBoot({
        db: fakeDb,
        getGeneral: async () => {
          throw new Error("db down");
        },
        listCompanyIds: async () => [],
      }),
    ).resolves.toEqual([]);
  });

  it("still returns findings when activity persistence fails", async () => {
    vi.mocked(logActivity).mockRejectedValueOnce(new Error("write failed"));
    const findings = await auditConfiguredHookCommandsOnBoot({
      db: fakeDb,
      getGeneral: async () => ({
        preRunCmd: null,
        postRunCmd: null,
        quotaExhaustedCmd: "node /app/gone.js",
      }),
      listCompanyIds: async () => ["company-a"],
      deps: fsWith(),
    });
    expect(findings).toHaveLength(1);
  });
});
