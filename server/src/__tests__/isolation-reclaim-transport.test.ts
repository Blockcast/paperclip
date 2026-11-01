import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISOLATION_RECLAIM_REPORT_MARKER,
  ISOLATION_RECLAIM_REPORT_VERSION,
  RECLAIM_PLAN_ENV,
  encodeIsolationReclaimReport,
  parseIsolationReclaimReport,
} from "../services/isolation-reclaim-report.js";
import {
  parseReclaimArgs,
  parseReclaimPlan,
  runReclaimExecutor,
} from "../cli/isolation-reclaim-executor.js";
import { REAPABLE_LAYOUT } from "../services/isolation-workspace-reaper.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const here = path.dirname(fileURLToPath(import.meta.url));
const executorEntry = path.resolve(here, "..", "cli", "isolation-reclaim-executor.ts");

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

  it("refuses an execute result whose counters never arrived", () => {
    // `{"result":{}}` is an object, so a container-only check passes it, and
    // every counter is then `undefined` downstream. Nothing is deleted on the
    // strength of it — the executor has already finished — but it is the whole
    // of what an operator learns, and "said nothing" must not read as "deleted
    // nothing". The same collapse the empty-inventory test above forbids.
    const hollow = `${ISOLATION_RECLAIM_REPORT_MARKER}{"v":${ISOLATION_RECLAIM_REPORT_VERSION},"kind":"execute","ok":true,"result":{}}`;
    expect(parseIsolationReclaimReport(hollow)).toMatchObject({ ok: false, failure: "malformed" });

    // Complete but for `stopReason`, which is the field that says whether the
    // executor finished or refused. An unknown value is refused, not coerced.
    const counters = {
      requested: 1,
      deleted: 0,
      wouldDelete: 1,
      skippedUnsafeName: 0,
      skippedLayout: 0,
      retainedNestedCheckout: 0,
      vanished: 0,
      failed: 0,
      notAttempted: 0,
      capped: false,
    };
    const unknownStop = `${ISOLATION_RECLAIM_REPORT_MARKER}${JSON.stringify({
      v: ISOLATION_RECLAIM_REPORT_VERSION,
      kind: "execute",
      ok: true,
      result: { ...counters, stopReason: "finished-ish" },
    })}`;
    expect(parseIsolationReclaimReport(unknownStop)).toMatchObject({ ok: false, failure: "malformed" });

    // And the same payload with a known one is accepted, so the check above is
    // rejecting the field rather than the shape.
    const good = encodeIsolationReclaimReport({
      v: ISOLATION_RECLAIM_REPORT_VERSION,
      kind: "execute",
      ok: true,
      result: { ...counters, stopReason: "complete" },
    });
    expect(parseIsolationReclaimReport(good)).toMatchObject({ ok: true });
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

  it("refuses an inventory root that is not there, instead of reporting it empty", async () => {
    // The executor's own version of the collapse the parser refuses above.
    // `collectIsolationWorkspaceInventory` answers `[]` for a missing root,
    // which is right for the mounted sweep — a deployment may have no isolation
    // tree yet — and wrong here, where something mounted a volume at `--root`
    // precisely to reclaim it. An absent root means the manifest's mount path
    // and the flag disagree, or the PVC never attached. Reported as `[]` it is
    // a valid "nothing to reclaim", so nothing is deleted and nothing is wrong
    // anywhere: a reclaimer blind forever with every signal green.
    const missing = path.join(root, "not-mounted");
    const report = await runReclaimExecutor({ argv: ["inventory", "--root", missing], env: {} });
    expect(report.ok).toBe(false);
    expect(report.kind).toBe("inventory");
    if (!report.ok) expect(report.error).toContain(missing);

    // A root that exists but is not a directory is the same misconfiguration
    // wearing different clothes, and `readdir` would have thrown ENOTDIR.
    const file = path.join(root, "a-file");
    await fs.writeFile(file, "");
    const onFile = await runReclaimExecutor({ argv: ["inventory", "--root", file], env: {} });
    expect(onFile.ok).toBe(false);

    // The control: a real, empty root still reports an empty inventory, which
    // is the valid answer this check must not have swallowed.
    const empty = await runReclaimExecutor({ argv: ["inventory", "--root", root], env: {} });
    expect(empty.ok).toBe(true);
    if (empty.kind === "inventory" && empty.ok) expect(empty.inventory).toEqual([]);
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

describe("reclaim executor as a real entrypoint (PEN-5151)", () => {
  // The guard that decides whether `main` runs at all is `c8 ignore`d and
  // nothing else in this file executes it. Its failure mode is silent — a
  // mismatch means no output and exit 0, which the parser can only call
  // `absent` under a green Job — so the only test that can see it is one that
  // actually starts the process. (Ally, review of #3189.)
  it("runs main and puts exactly one marked report on stdout", async () => {
    await makeReapable(UUID_A);

    // A sibling of the sweep root, never a child of it. The module graph opens
    // `server.log` under `PAPERCLIP_HOME` at import whether or not anything
    // logs — see the executor's output contract — so a home inside `root`
    // would materialize a directory the inventory then reports, and this test
    // would be asserting against its own side effect.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "reclaim-home-"));

    try {
      const result = await runEntrypoint(root, home);

      expect(result.code).toBe(0);

      // The test name says "on stdout", and until now nothing held that: the
      // parse below reads the INTERLEAVED view, which would pass just as well
      // with the report on fd 2. These two lines are what pin the split that
      // the executor's `pino.destination({dest: 2, sync: true})` exists to
      // create. (Ally, review of #3189.)
      expect(result.stdout).toContain(ISOLATION_RECLAIM_REPORT_MARKER);
      expect(result.stderr).not.toContain(ISOLATION_RECLAIM_REPORT_MARKER);

      // Parsed from the interleaved view, because that is what `pods/log` gives
      // the server — and it is also how this test notices a second marked line.
      const parsed = parseIsolationReclaimReport(`${result.stdout}\n${result.stderr}`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.report.kind).toBe("inventory");
      if (parsed.report.kind !== "inventory" || !parsed.report.ok) return;
      expect(parsed.report.inventory.map((e) => e.name)).toEqual([UUID_A]);
    } finally {
      // `finally`, so a failed assertion above does not leak the tmpdir into
      // the runner's /tmp for the rest of the suite. (Ally, review of #3189.)
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * Spawn the executor entrypoint, collecting its two streams SEPARATELY.
 *
 * Kept apart rather than merged, because the fd split is itself under test:
 * a helper that returned one interleaved string could not express the
 * assertion above.
 */
function runEntrypoint(
  sweepRoot: string,
  home: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", executorEntry, "inventory", "--root", sweepRoot],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PAPERCLIP_HOME: home },
      },
    );
    let stdout = "";
    let stderr = "";
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("reclaim executor entrypoint timed out"));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({ code, stdout, stderr });
    });
  });
}
