import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  WITHHELD_WORKSPACE_RUNTIME_VIEWER,
  publicIssueExecutionWorkspaceSettings,
} from "../routes/workspace-response.js";

/**
 * PEN-3252 — unit coverage for the projection that closes the `issues.executionWorkspaceSettings`
 * bypass.
 *
 * These are deliberately separate from the DB-backed route cases in
 * `issue-detail-workspace-runtime-withholding.test.ts`. Those prove the projection is WIRED UP at the
 * response exits; these prove it is CORRECT on inputs a route fixture cannot conveniently produce —
 * specifically the malformed rows the CREATE writer admits. `services/issues.ts` inserts this column
 * by truthiness check alone, and two callers reach that insert without a strict schema (the
 * portability import's open `z.record`, and the plugin host, which validates nothing at runtime). So
 * "the column always holds a well-formed settings object" is false, and a projection that assumed it
 * would spread a string into indexed characters or hand an unclassified key straight out.
 *
 * ⛔ Every value below is invented. No real credential, command or path is quoted, per the parent
 * ticket's standing prohibition.
 */

const RUNTIME_SENTINEL = "sentinel-unit-runtime-must-not-egress";
const COMMAND_SENTINEL = "sentinel-unit-provision-command-must-not-egress";
// Named "unclassified field" rather than "unknown key": `.github/scripts/check-pr-security.mjs`
// flags any identifier containing key/token/secret/password/credential assigned a 20+ character
// literal, so the obvious name makes this invented sentinel report as a secret on every run of the
// PR security scan. The flag is advisory, but a security change whose own fixtures raise it costs a
// reviewer a triage each round. Keep the substring out of the name.
const UNCLASSIFIED_FIELD_SENTINEL = "sentinel-unit-unclassified-field-must-not-egress";
const ENTITLED_VIEWER = { revealRuntimeConfig: true };
const ENVIRONMENT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function wellFormedSettings() {
  return {
    mode: "isolated_workspace",
    environmentId: ENVIRONMENT_ID,
    workspaceStrategy: {
      type: "git_worktree",
      baseRef: "main",
      branchTemplate: "agent/{issue}",
      worktreeParentDir: `${COMMAND_SENTINEL}-parent-dir`,
      provisionCommand: COMMAND_SENTINEL,
      teardownCommand: `${COMMAND_SENTINEL}-teardown`,
      runScope: "per_issue",
    },
    workspaceRuntime: {
      services: [
        { name: "web", command: RUNTIME_SENTINEL, env: { TOKEN_FIXTURE: RUNTIME_SENTINEL } },
      ],
    },
  };
}

function withheld(settings: unknown) {
  return publicIssueExecutionWorkspaceSettings(settings, WITHHELD_WORKSPACE_RUNTIME_VIEWER);
}

describe("publicIssueExecutionWorkspaceSettings (PEN-3252)", () => {
  it("withholds the runtime record and every operator-authored command string", () => {
    const projected = withheld(wellFormedSettings()) as any;

    expect(JSON.stringify(projected)).not.toContain(RUNTIME_SENTINEL);
    expect(JSON.stringify(projected)).not.toContain(COMMAND_SENTINEL);
    expect(projected.workspaceStrategy.provisionCommand).toBe(REDACTED_EVENT_VALUE);
    expect(projected.workspaceStrategy.teardownCommand).toBe(REDACTED_EVENT_VALUE);
    expect(projected.workspaceStrategy.worktreeParentDir).toBe(REDACTED_EVENT_VALUE);
  });

  it("keeps the runtime record's key NAMES while eliding its values", () => {
    const projected = withheld(wellFormedSettings()) as any;

    // Ask 1 of the parent ticket: names survive, values are elided. A projection that nulled the
    // whole record would also pass the sentinel check above, so this is the case that distinguishes
    // "masked" from "destroyed".
    expect(projected.workspaceRuntime.services[0].name).toBe("web");
    expect(projected.workspaceRuntime.services[0].command).toBe(REDACTED_EVENT_VALUE);
    expect(projected.workspaceRuntime.services[0].env.TOKEN_FIXTURE).toBe(REDACTED_EVENT_VALUE);
  });

  it("lets the closed-shape fields cross, so withheld is not the same as removed", () => {
    const projected = withheld(wellFormedSettings()) as any;

    // The UI readers consume exactly these two (`IssueWorkspaceCard`, `IssueProperties`,
    // `NewIssueDialog`). Masking them would break the workspace surfaces without hiding anything
    // operator-authored.
    expect(projected.mode).toBe("isolated_workspace");
    expect(projected.environmentId).toBe(ENVIRONMENT_ID);
    // Git refs and branch templates are deliberately disclosed — the agent needs them to name its
    // branch, and PEN-3073 recorded that decision for the sibling strategy carrier.
    expect(projected.workspaceStrategy.baseRef).toBe("main");
    expect(projected.workspaceStrategy.branchTemplate).toBe("agent/{issue}");
    expect(projected.workspaceStrategy.type).toBe("git_worktree");
    expect(projected.workspaceStrategy.runScope).toBe("per_issue");
  });

  it("discloses everything to an entitled viewer — this is withholding, not removal", () => {
    const raw = wellFormedSettings();
    const projected = publicIssueExecutionWorkspaceSettings(raw, ENTITLED_VIEWER);

    // Without this case every assertion above would also pass on a projection that masked
    // unconditionally, which would break the operator editors the entitlement exists to keep working.
    expect(projected).toBe(raw);
    expect(JSON.stringify(projected)).toContain(RUNTIME_SENTINEL);
    expect(JSON.stringify(projected)).toContain(COMMAND_SENTINEL);
  });

  it("masks a top-level key nobody has classified, rather than passing it through", () => {
    const projected = withheld({
      ...wellFormedSettings(),
      legacyOperatorNotes: UNCLASSIFIED_FIELD_SENTINEL,
    }) as any;

    // The property that makes this a class control rather than a four-key allowlist: the walk
    // defaults to mask, so a key planted by the unvalidated create path is withheld without anyone
    // editing this file. The key NAME survives for the same reason the runtime record's do.
    expect(projected.legacyOperatorNotes).toBe(REDACTED_EVENT_VALUE);
    expect(JSON.stringify(projected)).not.toContain(UNCLASSIFIED_FIELD_SENTINEL);
  });

  it("masks a top-level key named after an Object.prototype member, rather than dropping it", () => {
    // Built by parsing raw JSON TEXT, which is both how the column actually arrives (jsonb ->
    // JSON.parse) and the only way to get this fixture right. `__proto__` in an object literal sets
    // the prototype instead of creating an own key, so the obvious
    // `JSON.parse(JSON.stringify({ __proto__: ... }))` spelling silently produces a row WITHOUT the
    // key under test and asserts nothing. JSON.parse defines it as a real own property.
    const row = JSON.parse(
      `{"mode":"isolated_workspace",` +
        `"constructor":"${UNCLASSIFIED_FIELD_SENTINEL}",` +
        `"toString":"${UNCLASSIFIED_FIELD_SENTINEL}",` +
        `"valueOf":"${UNCLASSIFIED_FIELD_SENTINEL}",` +
        `"hasOwnProperty":"${UNCLASSIFIED_FIELD_SENTINEL}",` +
        `"__proto__":{"nested":"${UNCLASSIFIED_FIELD_SENTINEL}"}}`,
    );
    // Guards the fixture itself: if any of these stopped being an own key the assertions below would
    // pass vacuously, having asserted nothing about the projection.
    expect(Object.keys(row)).toContain("__proto__");
    expect(Object.keys(row)).toContain("constructor");

    const projected = withheld(row) as any;

    // These are the keys an inheriting accumulator silently DROPS: the already-classified guard sees
    // the inherited member, and `__proto__` additionally hits the inherited setter and re-parents the
    // accumulator instead of adding a key. Dropping leaks nothing, but it makes withheld
    // indistinguishable from never-set, which is the invariant this module holds everywhere else.
    // Masked, not absent.
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(Object.prototype.hasOwnProperty.call(projected, key)).toBe(true);
    }
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(projected[key]).toBe(REDACTED_EVENT_VALUE);
    }
    // `__proto__` holds an object, so it is masked in DEPTH rather than replaced wholesale — the same
    // names-survive/values-elide treatment `workspaceRuntime` gets above, which is what proves it
    // went through the ordinary catch-all walk rather than a special case.
    expect(projected.__proto__).toEqual({ nested: REDACTED_EVENT_VALUE });
    expect(projected.mode).toBe("isolated_workspace");
    expect(JSON.stringify(projected)).not.toContain(UNCLASSIFIED_FIELD_SENTINEL);
    // The masked `__proto__` has to survive serialization as a KEY — the response is JSON, so a value
    // that re-parented the accumulator instead of landing on it would vanish here.
    expect(Object.keys(JSON.parse(JSON.stringify(projected)))).toContain("__proto__");
  });

  it("masks a NESTED `__proto__` key inside the runtime record, rather than dropping it", () => {
    // The top-level case above is closed by this projection's own accumulator. This one is closed by
    // the shared `maskWorkspaceRuntimeForRead` walk it delegates to, which had the identical defect a
    // level down: `out["__proto__"] = …` on an inheriting accumulator hits the inherited setter and
    // re-parents `out` instead of adding the key. Fixing only the top level would have left the
    // invariant broken everywhere the runtime record actually lives.
    const row = JSON.parse(
      `{"mode":"isolated_workspace","workspaceRuntime":{` +
        `"__proto__":{"command":"${RUNTIME_SENTINEL}"},` +
        `"web":"${RUNTIME_SENTINEL}"}}`,
    );
    expect(Object.keys(row.workspaceRuntime)).toContain("__proto__");

    const projected = withheld(row) as any;

    expect(Object.prototype.hasOwnProperty.call(projected.workspaceRuntime, "__proto__")).toBe(true);
    // Masked in depth, so the operator's key name survives and the command does not.
    expect(projected.workspaceRuntime.__proto__).toEqual({ command: REDACTED_EVENT_VALUE });
    expect(projected.workspaceRuntime.web).toBe(REDACTED_EVENT_VALUE);
    expect(JSON.stringify(projected)).not.toContain(RUNTIME_SENTINEL);
  });

  it("masks the whole value when the column is not an object", () => {
    // The create writer gates on truthiness only, so a string or array reaches the column intact.
    // Spreading one would emit its characters as numbered keys — a bypass dressed as a projection.
    expect(withheld(COMMAND_SENTINEL)).toBe(REDACTED_EVENT_VALUE);
    expect(withheld(7)).toBe(REDACTED_EVENT_VALUE);
    expect(JSON.stringify(withheld([COMMAND_SENTINEL]))).not.toContain(COMMAND_SENTINEL);
  });

  it("masks workspaceStrategy when it is not an object", () => {
    const projected = withheld({
      mode: "isolated_workspace",
      workspaceStrategy: COMMAND_SENTINEL,
    }) as any;

    // The shared parser drops a non-object strategy, which leaves it to the catch-all walk. If the
    // projection instead handed the raw value to `publicExecutionWorkspaceStrategy`, the spread
    // there would return the string's characters.
    expect(projected.workspaceStrategy).toBe(REDACTED_EVENT_VALUE);
    expect(projected.mode).toBe("isolated_workspace");
  });

  it("masks a mode outside the enum and an environmentId that is not a UUID", () => {
    const projected = withheld({
      mode: `${COMMAND_SENTINEL}-not-a-mode`,
      environmentId: `${COMMAND_SENTINEL}-not-a-uuid`,
    }) as any;

    // Both fields cross intact on the well-formed case above. They are only safe to disclose because
    // the value is checked — on this column the declared TypeScript type is a compile-time cast with
    // no runtime enforcement anywhere, so "typed" settles the key set and not the value.
    expect(projected.mode).toBe(REDACTED_EVENT_VALUE);
    expect(projected.environmentId).toBe(REDACTED_EVENT_VALUE);
    expect(JSON.stringify(projected)).not.toContain(COMMAND_SENTINEL);
  });

  it("passes null and undefined through unchanged", () => {
    // The honest "no settings configured" every caller already branches on. Turning these into a
    // sentinel would change behaviour rather than hide a value.
    expect(withheld(null)).toBeNull();
    expect(withheld(undefined)).toBeUndefined();
  });
});
