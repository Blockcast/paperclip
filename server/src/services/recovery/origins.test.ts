import { describe, expect, it } from "vitest";

import {
  AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN,
  parseAgentHealthReceiptWindowKey,
} from "./origins.js";

/**
 * BLO-28871. The `agent-health:<windowKey>:<fingerprint>` convention belongs to
 * the routine's runbook, not to the platform, and it has already drifted once
 * (seconds precision -> milliseconds) on the live alert surface. The scheduler's
 * receipt-absence guard reads these keys, so it has to parse them rather than
 * string-match one snapshot of the convention -- the previous exact-string match
 * is why the guard was dead code in production for three weeks.
 */
describe("parseAgentHealthReceiptWindowKey", () => {
  it("reads both key formats observed on the live alert surface", () => {
    // Current convention, milliseconds + a named fingerprint.
    expect(
      parseAgentHealthReceiptWindowKey("agent-health:2026-08-19T00:00:00.000Z:missed_window")
        ?.toISOString(),
    ).toBe("2026-08-19T00:00:00.000Z");
    // Older convention, seconds precision + an opaque hash fingerprint.
    expect(
      parseAgentHealthReceiptWindowKey(
        "agent-health:2026-08-03T18:00:00Z:7bedaee78643280797da9151a9d5a08572aaa17d7e345c884069924f040fdc0c",
      )?.toISOString(),
    ).toBe("2026-08-03T18:00:00.000Z");
  });

  it("tolerates plausible drift the runbook could introduce", () => {
    // No fingerprint segment at all.
    expect(parseAgentHealthReceiptWindowKey("agent-health:2026-08-19T06:00:00.000Z")?.toISOString())
      .toBe("2026-08-19T06:00:00.000Z");
    // Minute precision.
    expect(parseAgentHealthReceiptWindowKey("agent-health:2026-08-19T06:00Z:x")?.toISOString())
      .toBe("2026-08-19T06:00:00.000Z");
    // An explicit numeric offset is honoured rather than read as UTC.
    expect(parseAgentHealthReceiptWindowKey("agent-health:2026-08-19T02:00:00+02:00:x")?.toISOString())
      .toBe("2026-08-19T00:00:00.000Z");
    // A bare local-time form is read as UTC, not as the server's timezone --
    // every observed convention stamps the UTC slot.
    expect(parseAgentHealthReceiptWindowKey("agent-health:2026-08-19T06:00:00.000:x")?.toISOString())
      .toBe("2026-08-19T06:00:00.000Z");
  });

  it("returns null for anything it cannot attribute to a window", () => {
    // The shape of every pre-2026-07-31 emission on the live alert surface.
    expect(parseAgentHealthReceiptWindowKey(null)).toBeNull();
    expect(parseAgentHealthReceiptWindowKey(undefined)).toBeNull();
    expect(parseAgentHealthReceiptWindowKey("")).toBeNull();
    expect(parseAgentHealthReceiptWindowKey("agent-health:")).toBeNull();
    expect(parseAgentHealthReceiptWindowKey("agent-health:not-a-date:x")).toBeNull();
    expect(parseAgentHealthReceiptWindowKey("agent-health:2026-13-45T99:00:00.000Z:x")).toBeNull();
    // The scheduler's own receipts must never read as a normal emission, or one
    // receipt would suppress the next sweep's.
    expect(
      parseAgentHealthReceiptWindowKey("scheduler-heartbeat:a03b2236:2026-08-02T12:07:15.190Z"),
    ).toBeNull();
  });

  it("scopes the SQL prefilter to the namespace, not to one window key", () => {
    expect(AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN).toBe("agent-health:%");
  });
});
