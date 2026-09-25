import { describe, expect, it } from "vitest";
import { aggregateKeyForAlert } from "../aggregate-key.js";
import type { AlertmanagerAlert } from "../types.js";

const alert = (fingerprint: string, domain?: string): AlertmanagerAlert => ({
  status: "firing",
  labels: {
    alertname: "HindsightConsolidationStalled",
    severity: "warning",
    ...(domain ? { paperclip_dedupe_domain: domain } : {}),
  },
  annotations: {},
  startsAt: "2026-08-03T00:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  fingerprint,
});

describe("aggregateKeyForAlert", () => {
  it("groups distinct series by alertname", () => {
    expect(aggregateKeyForAlert(alert("series-1"))).toBe(
      aggregateKeyForAlert(alert("series-2")),
    );
  });

  it("keeps explicit dedupe domains distinct", () => {
    expect(aggregateKeyForAlert(alert("series-1", "cluster-a"))).not.toBe(
      aggregateKeyForAlert(alert("series-2", "cluster-b")),
    );
  });
});
