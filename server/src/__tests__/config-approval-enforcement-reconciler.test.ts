/**
 * Config parsing for the approval-enforcement reconciler (BLO-24631).
 *
 * The grace window is the one knob where `0` is a meaningful setting — "report
 * drift on the first pass after the decision" — so it must survive parsing
 * rather than be folded into the default the way `Number(x) || 6` folds it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("PAPERCLIP_APPROVAL_ENFORCEMENT_RECONCILER_GRACE_HOURS", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAPERCLIP_APPROVAL_ENFORCEMENT_RECONCILER_GRACE_HOURS;
    process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to a 6h grace when unset", () => {
    expect(loadConfig().approvalEnforcementReconcilerGraceHours).toBe(6);
  });

  it("honours an explicit zero instead of folding it into the default", () => {
    process.env.PAPERCLIP_APPROVAL_ENFORCEMENT_RECONCILER_GRACE_HOURS = "0";

    expect(loadConfig().approvalEnforcementReconcilerGraceHours).toBe(0);
  });

  it("accepts an explicit non-zero override", () => {
    process.env.PAPERCLIP_APPROVAL_ENFORCEMENT_RECONCILER_GRACE_HOURS = "24";

    expect(loadConfig().approvalEnforcementReconcilerGraceHours).toBe(24);
  });

  it("falls back to the default for blank or non-numeric values", () => {
    process.env.PAPERCLIP_APPROVAL_ENFORCEMENT_RECONCILER_GRACE_HOURS = "   ";
    expect(loadConfig().approvalEnforcementReconcilerGraceHours).toBe(6);

    process.env.PAPERCLIP_APPROVAL_ENFORCEMENT_RECONCILER_GRACE_HOURS = "soon";
    expect(loadConfig().approvalEnforcementReconcilerGraceHours).toBe(6);
  });

  it("clamps a negative grace to zero rather than reaching back in time", () => {
    process.env.PAPERCLIP_APPROVAL_ENFORCEMENT_RECONCILER_GRACE_HOURS = "-5";

    expect(loadConfig().approvalEnforcementReconcilerGraceHours).toBe(0);
  });
});
