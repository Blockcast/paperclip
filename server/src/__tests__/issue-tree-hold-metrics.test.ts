import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetMetricsForTest, renderMetrics } from "../services/metrics.js";
import {
  ISSUE_TREE_ACTIVE_PAUSE_HOLDS_METRIC as M,
  startIssueTreeHoldCollector,
} from "../services/issue-tree-hold-metrics.js";

afterEach(() => __resetMetricsForTest());

const NOW = Date.parse("2026-10-20T00:00:00Z");
const DAY = 86_400_000;

async function tickWith(rows: Array<{ createdAt: Date; rootStatus: string }>) {
  const stop = startIssueTreeHoldCollector({} as never, {
    listActivePauseHolds: vi.fn().mockResolvedValue(rows),
    setInterval: vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as typeof setInterval,
    clearInterval: vi.fn(),
    now: () => NOW,
  });
  await Promise.resolve();
  await Promise.resolve();
  stop();
  return (await renderMetrics()).body;
}

describe("paperclip_issue_tree_active_pause_holds (BLO-32137)", () => {
  it("counts a stale hold on an ANCESTOR root that is done into >7d / root_terminal=true", async () => {
    // Shape of hold 87558a2a: rooted at BLO-14045 (done), several levels above the
    // stranded BLO-18686. The census keys on the hold's root, never on the member.
    const body = await tickWith([
      { createdAt: new Date(NOW - 82 * DAY), rootStatus: "done" },
      { createdAt: new Date(NOW - 2 * DAY), rootStatus: "in_progress" },
      { createdAt: new Date(NOW - 60_000), rootStatus: "cancelled" },
    ]);
    expect(body).toContain(`${M}{age_bucket=">7d",root_terminal="true"} 1`);
    expect(body).toContain(`${M}{age_bucket="1-7d",root_terminal="false"} 1`);
    expect(body).toContain(`${M}{age_bucket="<1d",root_terminal="true"} 1`);
    expect(body).toContain(`${M}{age_bucket=">7d",root_terminal="false"} 0`);
  });

  it("publishes all six cells at 0 when no hold is active, so count() returns a series", async () => {
    const body = await tickWith([]);
    expect(body.match(new RegExp(`^${M}\\{.*\\} 0$`, "gm"))).toHaveLength(6);
  });

  it("re-zeroes a cell when the hold is released between ticks", async () => {
    await tickWith([{ createdAt: new Date(NOW - 30 * DAY), rootStatus: "done" }]);
    const body = await tickWith([]);
    expect(body).toContain(`${M}{age_bucket=">7d",root_terminal="true"} 0`);
  });
});
