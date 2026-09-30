import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_DISPATCH_DECLINED_METRIC,
  KNOWN_DISPATCH_DECLINE_REASONS,
  UNKNOWN_AGENT_ID,
  UNKNOWN_DISPATCH_DECLINE_REASON,
  normalizeDispatchDeclineReason,
  recordAgentDispatchDeclined,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-3607. Agent `bcba1cc7` held four `queued` runs for 73.6 h with no
 * `startedAt` while the periodic sweep reached it on every scheduler tick and
 * declined it. Nothing recorded the refusal: of the fifteen `return []` sites in
 * `startNextQueuedRunForAgent`, exactly one wrote a metric, and none wrote to the
 * run row or logged above `debug`. Two independent code-trace localizations of
 * the bail were both wrong, because narrowing by elimination is the only tool a
 * silent path leaves you and it is a bad one.
 *
 * The guard below is the durable half of the fix. The counter can be added once;
 * what has to hold over time is that a NEW decline path cannot be introduced
 * silently — which is precisely how the fifteen accumulated.
 */

const HEARTBEAT_SOURCE = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
);

/**
 * Slice `startNextQueuedRunForAgent` out of the service closure. Bounded at the
 * next same-indent declaration rather than by brace matching: the body contains
 * template literals and regexes, so a naive brace counter mis-terminates.
 */
function readDispatchFunctionSource(source: string): string {
  const start = source.indexOf("async function startNextQueuedRunForAgent(");
  expect(start, "startNextQueuedRunForAgent not found — was it renamed?").toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const nextDecl = rest.search(/\n {2}(?:async )?function /);
  expect(nextDecl, "no following declaration — the slice would run to EOF").toBeGreaterThan(-1);
  return rest.slice(0, nextDecl);
}

/**
 * Every `return []` in the slice whose IMMEDIATELY preceding line does not
 * record a decline.
 *
 * The window is exactly one line on purpose. A wider lookback was written first
 * and the negative control below refuted it: with a ~12-line window, a newly
 * added silent `return []` sitting a few lines under an instrumented one is
 * masked by its neighbour, so the scan reports clean on the exact defect it
 * exists to catch. One line makes the convention unambiguous and the guard
 * sound — put the record immediately above the return, with logging above that.
 */
function findUninstrumentedReturns(functionSource: string): number[] {
  const lines = functionSource.split("\n");
  const offenders: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/^\s*return \[\];\s*$/.test(line)) continue;
    const previous = index > 0 ? lines[index - 1]! : "";
    if (!previous.includes("noteDispatchDeclined(")) offenders.push(index + 1);
  }
  return offenders;
}

describe("recordAgentDispatchDeclined", () => {
  it("emits a bounded agent_id and reason, and appears in the Prometheus exposition", async () => {
    const agentId = "11111111-2222-3333-4444-555555555555";
    const labels = recordAgentDispatchDeclined({
      agentId,
      reason: "no_claimable_run",
      knownAgentIds: new Set([agentId]),
    });

    expect(labels).toEqual({ agent_id: agentId, reason: "no_claimable_run" });

    const { body } = await renderMetrics();
    expect(body).toMatch(
      new RegExp(
        `${AGENT_DISPATCH_DECLINED_METRIC}[^\\n]*agent_id="${agentId}"[^\\n]*reason="no_claimable_run"`,
      ),
    );
  });

  it("collapses an agent outside the known roster, so a stale id cannot inflate cardinality", () => {
    const labels = recordAgentDispatchDeclined({
      agentId: "99999999-9999-9999-9999-999999999999",
      reason: "agent_not_invokable",
      knownAgentIds: new Set(),
    });
    expect(labels.agent_id).toBe(UNKNOWN_AGENT_ID);
    expect(labels.reason).toBe("agent_not_invokable");
  });

  it("collapses a reason outside the allow-list rather than minting a new series", () => {
    expect(normalizeDispatchDeclineReason("not_a_real_reason")).toBe(
      UNKNOWN_DISPATCH_DECLINE_REASON,
    );
    expect(normalizeDispatchDeclineReason(null)).toBe(UNKNOWN_DISPATCH_DECLINE_REASON);
    for (const reason of KNOWN_DISPATCH_DECLINE_REASONS) {
      expect(normalizeDispatchDeclineReason(reason)).toBe(reason);
    }
  });
});

describe("startNextQueuedRunForAgent decline instrumentation", () => {
  const functionSource = readDispatchFunctionSource(HEARTBEAT_SOURCE);

  it("records a reason at every path that returns without claiming a run", () => {
    const returnCount = (functionSource.match(/^\s*return \[\];\s*$/gm) ?? []).length;
    // Guards the slice itself: if this drops to 0 the scan below passes
    // vacuously, which is the failure mode a source-level test must not have.
    expect(returnCount).toBeGreaterThanOrEqual(15);
    expect(findUninstrumentedReturns(functionSource)).toEqual([]);
  });

  it("would catch a newly added silent decline path (negative control)", () => {
    // Same scanner, run against a body carrying one instrumented and one silent
    // decline. Without this, a scan that silently matched nothing would look
    // identical to a clean pass.
    const withSilentPath = [
      "  async function fake() {",
      "    if (a) {",
      '      await noteDispatchDeclined(agentId, "dispatch_stopped", null);',
      "      return [];",
      "    }",
      "    if (b) {",
      "      return [];",
      "    }",
      "  }",
    ].join("\n");
    expect(findUninstrumentedReturns(withSilentPath)).toHaveLength(1);
  });

  it("uses only allow-listed reasons at the call sites", () => {
    const used = [...functionSource.matchAll(/noteDispatchDeclined\(\s*agentId,\s*"([a-z_]+)"/g)]
      .map((match) => match[1]!);
    expect(used.length).toBeGreaterThanOrEqual(15);
    for (const reason of used) {
      expect(KNOWN_DISPATCH_DECLINE_REASONS as readonly string[]).toContain(reason);
    }
  });
});
