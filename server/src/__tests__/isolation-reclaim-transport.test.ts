import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISOLATION_RECLAIM_REPORT_MARKER,
  ISOLATION_RECLAIM_REPORT_VERSION,
  encodeIsolationReclaimReport,
  parseIsolationReclaimReport,
} from "../services/isolation-reclaim-report.js";
import {
  RECLAIM_PLAN_ENV,
  parseReclaimArgs,
  parseReclaimPlan,
  runReclaimExecutor,
} from "../cli/isolation-reclaim-executor.js";
import { REAPABLE_LAYOUT } from "../services/isolation-workspace-reaper.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let root: string;

/** A directory with the exact `{home, session}` top level the reaper requires. */
async function makeReapable(id: string): Promise<void> {
  for (const leaf of REAPABLE_LAYOUT) {
    await fs.mkdir(path.join(root, id, leaf), { recursive: true });
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "reclaim-transport-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("reclaim report wire format (PEN-5151)", () => {
  it("round-trips an inventory report through an interleaved pod log", async () => {
    await makeReapable(UUID_A);
    const report = await runReclaimExecutor({ argv: ["inventory", "--root", root], env: {} });

    // The log the server actually reads: fd 1 and fd 2 share one view, so the
    // report arrives surrounded by output from everything else in the pod.
    const podLog = [
      "WARNING: data pool is nearing quota",
      encodeIsolationReclaimReport(report),
      "stream closed EOF for paperclip/reclaim-abc (executor)",
    ].join("\n");

    const parsed = parseIsolationReclaimReport(podLog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.kind).toBe("inventory");
    expect(parsed.report.ok).toBe(true);
    if (parsed.report.kind !== "inventory" || !parsed.report.ok) return;
    expect(parsed.report.inventory.map((e) => e.name)).toEqual([UUID_A]);
    expect(Number.isFinite(parsed.report.inventory[0]?.mtimeMs)).toBe(true);
  });

  it("never emits a newline inside the report line", async () => {
    // The recovery rule is "exactly one line carries the marker". A payload
    // that could split itself across two lines would lose its own remainder.
    const encoded = encodeIsolationReclaimReport({
      v: ISOLATION_RECLAIM_REPORT_VERSION,
      kind: "execute",
      ok: false,
      error: "line one\nline two\r\nline three",
    });
    expect(encoded.split("\n")).toHaveLength(1);
    const parsed = parseIsolationReclaimReport(`noise\n${encoded}\nmore noise`);
    expect(parsed.ok).toBe(true);
  });

  it("tells absent, duplicate, malformed and version-skew apart", () => {
    expect(parseIsolationReclaimReport("just some pod noise\n")).toMatchObject({
      ok: false,
      failure: "absent",
    });

    // Two markers: the executor is not the only thing that can produce one, so
    // choosing between them is a guess this module refuses to make.
    const good = encodeIsolationReclaimReport({
      v: ISOLATION_RECLAIM_REPORT_VERSION,
      kind: "inventory",
      ok: true,
      inventory: [],
    });
    expect(parseIsolationReclaimReport(`${good}\n${good}`)).toMatchObject({
      ok: false,
      failure: "duplicate",
    });

    // A kubelet rotation landing mid-line. Must not read as an empty inventory.
    expect(parseIsolationReclaimReport(good.slice(0, good.length - 12))).toMatchObject({
      ok: false,
      failure: "malformed",
    });

    expect(
      parseIsolationReclaimReport(`${ISOLATION_RECLAIM_REPORT_MARKER}{"v":99,"kind":"inventory","ok":true}`),
    ).toMatchObject({ ok: false, failure: "unsupported_version" });
  });

  it("separates an empty inventory from a report that could not be read", () => {
    // The distinction this whole module exists for: "nothing to reclaim" is a
    // valid answer, and must never be producible by a transport fault.
    const empty = parseIsolationReclaimReport(
      encodeIsolationReclaimReport({
        v: ISOLATION_RECLAIM_REPORT_VERSION,
        kind: "inventory",
        ok: true,
        inventory: [],
      }),
    );
    expect(empty.ok).toBe(true);
    if (empty.ok && empty.report.kind === "inventory" && empty.report.ok) {
      expect(empty.report.inventory).toEqual([]);
    }
    expect(parseIsolationReclaimReport("")).toMatchObject({ ok: false, failure: "absent" });
  });

  it("refuses an inventory entry that is not {name, mtimeMs}", () => {
    // A non-string name would otherwise reach the plan's UUID check as a
    // non-string and be counted as an unsafe name — a transport fault
    // misreported as a directory nobody should have created.
    const bad = `${ISOLATION_RECLAIM_REPORT_MARKER}{"v":${ISOLATION_RECLAIM_REPORT_VERSION},"kind":"inventory","ok":true,"inventory":[{"name":42,"mtimeMs":1}]}`;
    expect(parseIsolationReclaimReport(bad)).toMatchObject({ ok: false, failure: "malformed" });
  });
});

describe("reclaim executor argument and plan parsing (PEN-5151)", () => {
  it("requires a subcommand and an absolute root", () => {
    expect(() => parseReclaimArgs([])).toThrow(/subcommand/);
    expect(() => parseReclaimArgs(["sweep", "--root", "/x"])).toThrow(/subcommand/);
    // No default root: falling back to the server's own tree would point the
    // Job at the claim the mounted sweep already owns.
    expect(() => parseReclaimArgs(["inventory"])).toThrow(/--root is required/);
    expect(() => parseReclaimArgs(["inventory", "--root", "relative/path"])).toThrow(/absolute/);
    expect(() => parseReclaimArgs(["inventory", "--root", "/a", "--force"])).toThrow(/unrecognized/);
    expect(parseReclaimArgs(["execute", "--root=/a/b"])).toEqual({ mode: "execute", root: "/a/b" });
  });

  it("defaults to a dry run unless the plan says JSON false", () => {
    const base = { planBuiltAtMs: 1, eligibleIds: [] };
    expect(parseReclaimPlan(JSON.stringify(base)).dryRun).toBe(true);
    expect(parseReclaimPlan(JSON.stringify({ ...base, dryRun: "false" })).dryRun).toBe(true);
    expect(parseReclaimPlan(JSON.stringify({ ...base, dryRun: null })).dryRun).toBe(true);
    expect(parseReclaimPlan(JSON.stringify({ ...base, dryRun: false })).dryRun).toBe(false);
  });

  it("refuses an envelope that never arrived, rather than reporting a result", () => {
    expect(() => parseReclaimPlan(undefined)).toThrow(new RegExp(RECLAIM_PLAN_ENV));
    expect(() => parseReclaimPlan("{not json")).toThrow(/not valid JSON/);
    expect(() => parseReclaimPlan(JSON.stringify({ eligibleIds: [] }))).toThrow(/planBuiltAtMs/);
    expect(() => parseReclaimPlan(JSON.stringify({ planBuiltAtMs: 1, eligibleIds: [7] }))).toThrow(
      /eligibleIds/,
    );
  });
});

describe("reclaim executor end to end over a real tree (PEN-5151)", () => {
  it("previews by default and deletes only on an explicit JSON false", async () => {
    await makeReapable(UUID_A);

    const preview = await runReclaimExecutor({
      argv: ["execute", "--root", root],
      env: { [RECLAIM_PLAN_ENV]: JSON.stringify({ planBuiltAtMs: Date.now(), eligibleIds: [UUID_A] }) },
    });
    expect(preview.ok).toBe(true);
    if (preview.kind === "execute" && preview.ok) {
      expect(preview.result.wouldDelete).toBe(1);
      expect(preview.result.deleted).toBe(0);
    }
    // Still there: the preview is the whole point of defaulting to it.
    await expect(fs.stat(path.join(root, UUID_A))).resolves.toBeDefined();

    const live = await runReclaimExecutor({
      argv: ["execute", "--root", root],
      env: {
        [RECLAIM_PLAN_ENV]: JSON.stringify({
          planBuiltAtMs: Date.now(),
          eligibleIds: [UUID_A],
          dryRun: false,
        }),
      },
    });
    expect(live.ok).toBe(true);
    if (live.kind === "execute" && live.ok) {
      expect(live.result.deleted).toBe(1);
      expect(live.result.stopReason).toBe("complete");
    }
    await expect(fs.stat(path.join(root, UUID_A))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-asks the layout question at the unlink, on a tree the plan never saw", async () => {
    // The plan cannot answer layout — it has no filesystem. A planned id whose
    // top level is not {home, session} must survive, and be counted.
    await fs.mkdir(path.join(root, UUID_B, "wt-blo-19094"), { recursive: true });
    const report = await runReclaimExecutor({
      argv: ["execute", "--root", root],
      env: {
        [RECLAIM_PLAN_ENV]: JSON.stringify({
          planBuiltAtMs: Date.now(),
          eligibleIds: [UUID_B],
          dryRun: false,
        }),
      },
    });
    expect(report.ok).toBe(true);
    if (report.kind === "execute" && report.ok) {
      expect(report.result.skippedLayout).toBe(1);
      expect(report.result.deleted).toBe(0);
    }
    await expect(fs.stat(path.join(root, UUID_B))).resolves.toBeDefined();
  });

  it("reports a bad invocation instead of throwing, so the pod log can say why", async () => {
    const report = await runReclaimExecutor({ argv: ["execute", "--root", root], env: {} });
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.error).toContain(RECLAIM_PLAN_ENV);

    // And it survives the channel: a failure report is still a parseable one.
    const parsed = parseIsolationReclaimReport(encodeIsolationReclaimReport(report));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.report.ok).toBe(false);
  });

  it("reports an unusable plan as a result, not as a crash", async () => {
    // A unit mismatch at the transport: microseconds where ms were meant lands
    // decades ahead, and the age bound's false branch is the permissive one.
    const report = await runReclaimExecutor({
      argv: ["execute", "--root", root],
      env: {
        [RECLAIM_PLAN_ENV]: JSON.stringify({
          planBuiltAtMs: Date.now() * 1000,
          eligibleIds: [UUID_A],
          dryRun: false,
        }),
      },
    });
    expect(report.ok).toBe(true);
    if (report.kind === "execute" && report.ok) {
      expect(report.result.stopReason).toBe("plan_unusable");
      expect(report.result.notAttempted).toBe(1);
      expect(report.result.deleted).toBe(0);
    }
  });
});
