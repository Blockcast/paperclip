import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, restoreWithheldPipelineStageConfig } from "../redaction.js";
import {
  WITHHELD_WORKSPACE_RUNTIME_VIEWER,
  publicPipelineStageConfig,
} from "../routes/workspace-response.js";

/**
 * PEN-3266 — unit coverage for the projection that closes the `pipeline_stages.config` carrier, and
 * for the write-side guard that keeps that projection from destroying the values it masks.
 *
 * The carrier is the same `issueExecutionWorkspaceSettingsSchema` PEN-3252 withholds, declared on both
 * `pipelineStageOnEnterSchema` and `pipelineStageAutomationSchema`. It crosses under a parent key in a
 * `jsonb` blob rather than in a column of its own, which is why the PEN-3252 sweep — scoped to the
 * `execution_workspace_settings` column — could not see it.
 *
 * Two properties are asserted here that a route fixture would not isolate cleanly:
 *
 *  1. BOTH keys are projected, and `onEnter` is the one that matters most. `withDerivedStageAutomation`
 *     returns the stored config verbatim when a stage has no backing routine, so the derived
 *     `automation` block is not reliably present while `onEnter` always is. A projection that covered
 *     only `automation` would mask the sometimes-absent copy and leak the always-present one.
 *  2. The rest of `config` survives byte-for-byte. Stage config holds unrelated operator prose —
 *     `variables`, `disabledReason`, breakdown templates — so masking the blob wholesale would be
 *     wrong in the opposite direction.
 *
 * ⛔ Every value below is invented. No real credential, command or path is quoted, per the parent
 * ticket's standing prohibition. Fixture names deliberately avoid the key/token/secret/password/
 * credential stems that `.github/scripts/check-pr-security.mjs` flags on 20+ character literals — a
 * security change whose own fixtures report as secrets costs a reviewer a triage every round.
 */

const COMMAND_SENTINEL = "sentinel-stage-provision-command-must-not-egress";
const RUNTIME_SENTINEL = "sentinel-stage-runtime-must-not-egress";
const ENTITLED_VIEWER = { revealRuntimeConfig: true };
const ENVIRONMENT_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function settings() {
  return {
    mode: "isolated_workspace",
    environmentId: ENVIRONMENT_ID,
    workspaceStrategy: {
      type: "git_worktree",
      baseRef: "main",
      provisionCommand: COMMAND_SENTINEL,
      teardownCommand: `${COMMAND_SENTINEL}-teardown`,
      worktreeParentDir: `${COMMAND_SENTINEL}-parent-dir`,
      runScope: "per_issue",
    },
    workspaceRuntime: {
      services: [{ name: "web", command: RUNTIME_SENTINEL }],
    },
  };
}

function stageConfig() {
  return {
    // Unrelated operator prose that must round-trip intact.
    variables: [{ name: "customer", label: "Customer name" }],
    disabledReason: "Paused while the intake form is rewritten",
    onEnter: { type: "run_routine", routineId: "r-1", executionWorkspaceSettings: settings() },
    automation: { routineId: "r-1", executionWorkspaceSettings: settings() },
  };
}

function withheld(config: unknown) {
  return publicPipelineStageConfig(config, WITHHELD_WORKSPACE_RUNTIME_VIEWER) as Record<string, any>;
}

describe("PEN-3266 pipeline stage config withholding", () => {
  it("masks the operator-authored commands under onEnter", () => {
    const strategy = withheld(stageConfig()).onEnter.executionWorkspaceSettings.workspaceStrategy;
    expect(strategy.provisionCommand).toBe(REDACTED_EVENT_VALUE);
    expect(strategy.teardownCommand).toBe(REDACTED_EVENT_VALUE);
    expect(strategy.worktreeParentDir).toBe(REDACTED_EVENT_VALUE);
  });

  it("masks the derived automation copy of the same bytes", () => {
    const strategy = withheld(stageConfig()).automation.executionWorkspaceSettings.workspaceStrategy;
    expect(strategy.provisionCommand).toBe(REDACTED_EVENT_VALUE);
  });

  it("does not egress the workspaceRuntime record through either key", () => {
    const projected = JSON.stringify(withheld(stageConfig()));
    expect(projected).not.toContain(RUNTIME_SENTINEL);
    expect(projected).not.toContain(COMMAND_SENTINEL);
  });

  it("leaves the non-workspace parts of the stage config byte-for-byte intact", () => {
    const projected = withheld(stageConfig());
    expect(projected.variables).toEqual(stageConfig().variables);
    expect(projected.disabledReason).toBe(stageConfig().disabledReason);
    // The routing keys the editor needs are not workspace-runtime material.
    expect(projected.onEnter.type).toBe("run_routine");
    expect(projected.onEnter.routineId).toBe("r-1");
    expect(projected.onEnter.executionWorkspaceSettings.mode).toBe("isolated_workspace");
    expect(projected.onEnter.executionWorkspaceSettings.environmentId).toBe(ENVIRONMENT_ID);
  });

  it("hands an entitled viewer the config unchanged", () => {
    const config = stageConfig();
    expect(publicPipelineStageConfig(config, ENTITLED_VIEWER)).toEqual(config);
  });

  it("passes through a stage config that is absent or not an object", () => {
    expect(withheld(null)).toBeNull();
    expect(withheld(undefined)).toBeUndefined();
    expect(publicPipelineStageConfig("not-an-object", WITHHELD_WORKSPACE_RUNTIME_VIEWER)).toBe("not-an-object");
  });

  it("is inert on a stage config that carries neither key", () => {
    const plain = { variables: [], requireApproval: true };
    expect(withheld(plain)).toEqual(plain);
  });
});

/**
 * The half of the fix without which the half above would be a regression.
 *
 * The pipeline editor round-trips this field, so a caller that read the stage WITHOUT
 * `workspace_runtime:read` holds the sentinel where the command is. Saving any unrelated field would
 * otherwise persist the sentinel over the real command — a silent destructive write, not a disclosure.
 */
describe("PEN-3266 pipeline stage config write-back guard", () => {
  const stored = stageConfig();

  it("restores a masked command instead of persisting the sentinel", () => {
    const roundTripped = withheld(stageConfig());
    roundTripped.disabledReason = "Edited something unrelated";

    const restored = restoreWithheldPipelineStageConfig(roundTripped, stored) as Record<string, any>;
    expect(restored.onEnter.executionWorkspaceSettings.workspaceStrategy.provisionCommand).toBe(COMMAND_SENTINEL);
    expect(restored.onEnter.executionWorkspaceSettings.workspaceStrategy.teardownCommand)
      .toBe(`${COMMAND_SENTINEL}-teardown`);
    expect(restored.automation.executionWorkspaceSettings.workspaceStrategy.provisionCommand).toBe(COMMAND_SENTINEL);
    // The genuine edit still lands.
    expect(restored.disabledReason).toBe("Edited something unrelated");
  });

  it("restores the nested workspaceRuntime record the mask walked", () => {
    const roundTripped = withheld(stageConfig());
    const restored = restoreWithheldPipelineStageConfig(roundTripped, stored) as Record<string, any>;
    expect(restored.onEnter.executionWorkspaceSettings.workspaceRuntime)
      .toEqual(stored.onEnter.executionWorkspaceSettings.workspaceRuntime);
  });

  it("does not resurrect a value the caller genuinely changed", () => {
    const edited = withheld(stageConfig());
    edited.onEnter.executionWorkspaceSettings.workspaceStrategy.provisionCommand = "a-real-new-command";
    edited.onEnter.executionWorkspaceSettings.mode = "shared_workspace";

    const restored = restoreWithheldPipelineStageConfig(edited, stored) as Record<string, any>;
    expect(restored.onEnter.executionWorkspaceSettings.workspaceStrategy.provisionCommand).toBe("a-real-new-command");
    expect(restored.onEnter.executionWorkspaceSettings.mode).toBe("shared_workspace");
  });

  it("catches a sentinel embedded in a longer string, not only an exact match", () => {
    const edited = withheld(stageConfig());
    edited.onEnter.executionWorkspaceSettings.workspaceStrategy.provisionCommand =
      `https://user:${REDACTED_EVENT_VALUE}@example.invalid/provision`;

    const restored = restoreWithheldPipelineStageConfig(edited, stored) as Record<string, any>;
    expect(restored.onEnter.executionWorkspaceSettings.workspaceStrategy.provisionCommand).toBe(COMMAND_SENTINEL);
  });

  it("is inert when there is no stored config to restore from", () => {
    const incoming = { onEnter: { type: "run_routine", routineId: "r-2" } };
    expect(restoreWithheldPipelineStageConfig(incoming, null)).toEqual(incoming);
  });

  it("passes through an incoming config that is not an object", () => {
    expect(restoreWithheldPipelineStageConfig(null, stored)).toBeNull();
    expect(restoreWithheldPipelineStageConfig("x", stored)).toBe("x");
  });
});
