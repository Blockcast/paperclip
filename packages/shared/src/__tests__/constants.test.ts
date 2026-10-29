import { describe, it, expect } from "vitest";
import {
  DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
  ENVIRONMENT_DRIVERS,
  MAX_ISSUE_MONITOR_MAX_ATTEMPTS,
  renewedIssueMonitorMaxAttempts,
} from "../constants.js";

describe("ENVIRONMENT_DRIVERS", () => {
  it("includes k8s alongside local, ssh, sandbox, plugin", () => {
    expect(ENVIRONMENT_DRIVERS).toEqual(
      expect.arrayContaining(["local", "ssh", "sandbox", "plugin", "k8s"]),
    );
  });
});

/**
 * PEN-3803: `renewedIssueMonitorMaxAttempts` is the only exit left from a spent
 * monitor budget other than giving up, so its boundaries are load-bearing. It
 * must always propose a value STRICTLY GREATER than the attempts already made
 * (otherwise the arm it is feeding is refused again) and never above the
 * schema's `.max(100)` (otherwise the arm is refused by validation instead).
 */
describe("renewedIssueMonitorMaxAttempts", () => {
  it("grants a fresh default-sized leash above the attempts already made", () => {
    expect(renewedIssueMonitorMaxAttempts(0)).toBe(DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS);
    expect(renewedIssueMonitorMaxAttempts(DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS)).toBe(
      DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS * 2,
    );
  });

  it("never proposes a value the arm would refuse as already exhausted", () => {
    for (let attemptCount = 0; attemptCount < MAX_ISSUE_MONITOR_MAX_ATTEMPTS; attemptCount += 1) {
      const renewal = renewedIssueMonitorMaxAttempts(attemptCount);
      expect(renewal).not.toBeNull();
      expect(renewal!).toBeGreaterThan(attemptCount);
      expect(renewal!).toBeLessThanOrEqual(MAX_ISSUE_MONITOR_MAX_ATTEMPTS);
    }
  });

  it("returns null once no representable renewal is left", () => {
    expect(renewedIssueMonitorMaxAttempts(MAX_ISSUE_MONITOR_MAX_ATTEMPTS)).toBeNull();
    expect(renewedIssueMonitorMaxAttempts(MAX_ISSUE_MONITOR_MAX_ATTEMPTS + 50)).toBeNull();
  });

  it("clamps a dirty attempt count rather than proposing an invalid bound", () => {
    expect(renewedIssueMonitorMaxAttempts(-5)).toBe(DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS);
    expect(renewedIssueMonitorMaxAttempts(Number.NaN)).toBe(DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS);
    expect(renewedIssueMonitorMaxAttempts(12.7)).toBe(12 + DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS);
  });
});
