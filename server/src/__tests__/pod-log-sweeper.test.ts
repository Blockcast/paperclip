import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sweepTerminalRunPodLogs } from "../services/pod-log-sweeper.js";

/**
 * BLO-48193. A run finalized server-side after a `paperclip-0` restart never
 * passes through the adapter's `finally`, so its `.pod.ndjson` survives. These
 * pin the sweeper's three gates: DB-terminal, older than retention, and not
 * part of the pre-cutoff backlog.
 */
const silent = { info() {}, warn() {}, error() {} } as never;
const HOUR = 60 * 60 * 1000;
const now = new Date("2026-11-10T00:00:00Z");
const notBefore = new Date("2026-10-22T00:00:00Z");

async function seed(root: string, ageMs: number, opts?: { isolationKey?: string }) {
  const runId = randomUUID();
  const base = path.join(root, randomUUID(), randomUUID());
  const dir = opts?.isolationKey ? path.join(base, "isolated", opts.isolationKey) : base;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}.pod.ndjson`);
  await fs.writeFile(file, "{}\n");
  const t = new Date(now.getTime() - ageMs);
  await fs.utimes(file, t, t);
  return { runId, file };
}

const exists = (f: string) => fs.stat(f).then(() => true, () => false);

describe("sweepTerminalRunPodLogs", () => {
  it("reaps a server-finalized run's log, and leaves non-terminal, young, backlog and unknown-run logs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pod-log-sweep-"));
    // The BLO-48193 shape: run finalized `succeeded` server-side, log left behind.
    const finalized = await seed(root, 72 * HOUR);
    const isolated = await seed(root, 72 * HOUR, { isolationKey: "ws1" });
    const running = await seed(root, 72 * HOUR);
    const young = await seed(root, 24 * HOUR);
    const backlog = await seed(root, 30 * 24 * HOUR); // mtime before notBefore
    const unknown = await seed(root, 72 * HOUR);
    const notALog = path.join(path.dirname(finalized.file), `${finalized.runId}.ndjson`);
    await fs.writeFile(notALog, "{}\n");
    await fs.utimes(notALog, new Date(now.getTime() - 72 * HOUR), new Date(now.getTime() - 72 * HOUR));

    const statuses = new Map([
      [finalized.runId, "succeeded"],
      [isolated.runId, "failed"],
      [running.runId, "running"],
      [young.runId, "succeeded"],
      [backlog.runId, "succeeded"],
    ]);
    const res = await sweepTerminalRunPodLogs({
      root, now, notBefore, logger: silent,
      lookupRunStatuses: async (ids) => new Map(ids.filter((id) => statuses.has(id)).map((id) => [id, statuses.get(id)!])),
    });

    expect(await exists(finalized.file)).toBe(false);
    expect(await exists(isolated.file)).toBe(false);
    expect(await exists(running.file)).toBe(true);
    expect(await exists(young.file)).toBe(true);
    expect(await exists(backlog.file)).toBe(true);
    expect(await exists(unknown.file)).toBe(true);
    expect(await exists(notALog)).toBe(true);
    expect(res).toEqual({ candidates: 4, deleted: 2, skippedNonTerminal: 2 });
  });

  it("does not follow a symlink named like a pod log", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pod-log-sweep-"));
    const target = await seed(root, 72 * HOUR);
    const runId = randomUUID();
    const link = path.join(path.dirname(target.file), `${runId}.pod.ndjson`);
    await fs.symlink(target.file, link);
    // Age the link itself, so only the lstat gate can save the target.
    const t = new Date(now.getTime() - 72 * HOUR);
    await fs.lutimes(link, t, t);
    await sweepTerminalRunPodLogs({
      root, now, notBefore, logger: silent,
      lookupRunStatuses: async () => new Map([[runId, "succeeded"]]),
    });
    expect(await exists(target.file)).toBe(true);
    expect(await fs.lstat(link).then(() => true, () => false)).toBe(true);
  });

  it("respects maxDeletes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pod-log-sweep-"));
    const runs = await Promise.all([1, 2, 3].map(() => seed(root, 72 * HOUR)));
    const res = await sweepTerminalRunPodLogs({
      root, now, notBefore, maxDeletes: 2, logger: silent,
      lookupRunStatuses: async (ids) => new Map(ids.map((id) => [id, "succeeded"])),
    });
    expect(res.deleted).toBe(2);
    expect((await Promise.all(runs.map((r) => exists(r.file)))).filter(Boolean)).toHaveLength(1);
  });
});
