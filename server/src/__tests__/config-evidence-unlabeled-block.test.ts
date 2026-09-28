import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

// The env -> config hop for the Track B truth-gate flag (BLO-32239). Every
// evidence-gate wiring test injects `unlabeledTruthBlock` directly, so this
// one link is otherwise untested: if it breaks, flipping
// PAPERCLIP_EVIDENCE_UNLABELED_BLOCK is a silent no-op and the seven-day
// measurement window returns a null result that reads as "no effect".
describe("PAPERCLIP_EVIDENCE_UNLABELED_BLOCK", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAPERCLIP_EVIDENCE_UNLABELED_BLOCK;
    process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('enables the unlabeled truth block on exactly "1"', () => {
    process.env.PAPERCLIP_EVIDENCE_UNLABELED_BLOCK = "1";

    expect(loadConfig().evidenceGateUnlabeledTruthBlock).toBe(true);
  });

  it("stays off when unset", () => {
    expect(loadConfig().evidenceGateUnlabeledTruthBlock).toBe(false);
  });

  // "0" is the shipped Helm default; "true" is the plausible operator typo.
  // Both must read as off, so a misconfigured flip fails closed. " 1" and
  // "yes" are tripwires, not redundant cases: " 1" fails a coercing guard
  // (`Number(e) === 1`, `parseInt`) and "yes" fails an allowlist
  // (`["1", "yes", "on"].includes(e)`). Together they also catch a denylist
  // (`e && e !== "0" && e !== "true"`), which fails OPEN on "false" or "off".
  it.each(["0", "true", "yes", " 1"])("stays off for %o", (value) => {
    process.env.PAPERCLIP_EVIDENCE_UNLABELED_BLOCK = value;

    expect(loadConfig().evidenceGateUnlabeledTruthBlock).toBe(false);
  });
});
