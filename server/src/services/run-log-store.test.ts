import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { createDurableRunLogStore, isRunLogUnwritableError } from "./run-log-store.js";
import {
  findTerminalResultEventInRunLogTail,
  readRunLogTerminalTail,
} from "./run-log-terminal-result.js";
import type { StorageProvider } from "../storage/types.js";

// In-memory StorageProvider stand-in: durable, survives the "pod roll" (local
// dir wipe) the same way Cubbit does. Records calls so we can assert behaviour.
function createMemoryProvider() {
  const objects = new Map<string, Buffer>();
  const calls = { put: 0, get: 0, head: 0 };
  const provider: StorageProvider = {
    id: "s3",
    async putObject(input) {
      calls.put++;
      if (Buffer.isBuffer(input.body)) {
        objects.set(input.objectKey, Buffer.from(input.body));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      objects.set(input.objectKey, Buffer.concat(chunks));
    },
    async getObject(input) {
      calls.get++;
      const buf = objects.get(input.objectKey);
      if (!buf) {
        const err = new Error("Object not found") as Error & { name: string };
        err.name = "NoSuchKey";
        throw err;
      }
      if (input.range) {
        // Faithful to S3, and load-bearing for the EOF tests below: a range
        // whose start is past the last valid byte is UNSATISFIABLE and real
        // providers answer 416. `Buffer.subarray` silently returns an empty
        // buffer instead, so a permissive stand-in here would let the
        // `bytes=total-total` bug (PEN-3129) pass every test in this file.
        if (input.range.start >= buf.length || input.range.start > input.range.end) {
          const err = new Error(
            `Range ${input.range.start}-${input.range.end} not satisfiable for ${buf.length} bytes`,
          ) as Error & { name: string; $metadata: { httpStatusCode: number } };
          err.name = "InvalidRange";
          err.$metadata = { httpStatusCode: 416 };
          throw err;
        }
      }
      const slice = input.range ? buf.subarray(input.range.start, input.range.end + 1) : buf;
      return { stream: Readable.from(slice), contentLength: slice.length };
    },
    async headObject(input) {
      calls.head++;
      const buf = objects.get(input.objectKey);
      return buf ? { exists: true, contentLength: buf.length } : { exists: false };
    },
    async deleteObject(input) {
      objects.delete(input.objectKey);
    },
  };
  return { provider, objects, calls };
}

let baseDir: string;
beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-store-test-"));
});
afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

const begin = { companyId: "co1", agentId: "ag1", runId: "run1" };

describe("createDurableRunLogStore", () => {
  it("keeps store id 'local_file' so downstream coupling (feedback, casts) is unchanged", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    expect(handle.store).toBe("local_file");
  });

  it("appends locally and reads back during a run WITHOUT hitting S3 (fast live tail)", async () => {
    const { provider, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "hello", ts: "t1" });
    const res = await store.read(handle);
    expect(res.content).toContain("hello");
    expect(calls.get).toBe(0); // local file present -> no S3 read
  });

  it("uploads the complete log to S3 on finalize", async () => {
    const { provider, objects, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "run-logs" } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "line-A", ts: "t1" });
    await store.append(handle, { stream: "stdout", chunk: "line-B", ts: "t2" });
    const summary = await store.finalize(handle);
    expect(calls.put).toBe(1);
    expect(summary.bytes).toBeGreaterThan(0);
    // keyed by prefix + the handle's logRef so read can find it later
    const key = `run-logs/${handle.logRef}`;
    expect(objects.has(key)).toBe(true);
    expect(objects.get(key)!.toString("utf8")).toContain("line-A");
    expect(objects.get(key)!.toString("utf8")).toContain("line-B");
  });

  it("falls back to S3 when the local file is gone (the pod-roll case that caused 'Run log not found')", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "run-logs" } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "persisted-line", ts: "t1" });
    await store.finalize(handle);
    // Simulate a pod restart wiping the emptyDir.
    await fs.rm(baseDir, { recursive: true, force: true });
    const res = await store.read(handle);
    expect(res.content).toContain("persisted-line");
  });

  it("S3 fallback honours offset/limitBytes (range read) and reports nextOffset", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "p" } });
    const handle = await store.begin(begin);
    // one line; persisted bytes = JSON line + "\n"
    await store.append(handle, { stream: "stdout", chunk: "0123456789", ts: "t" });
    await store.finalize(handle);
    const full = await store.read(handle); // from local, to learn total size
    const total = Buffer.byteLength(full.content, "utf8");
    await fs.rm(baseDir, { recursive: true, force: true }); // force S3 path
    const firstHalf = await store.read(handle, { offset: 0, limitBytes: 5 });
    expect(Buffer.byteLength(firstHalf.content, "utf8")).toBe(5);
    expect(firstHalf.nextOffset).toBe(5);
    const tail = await store.read(handle, { offset: total - 3, limitBytes: 100 });
    expect(Buffer.byteLength(tail.content, "utf8")).toBe(3);
    expect(tail.nextOffset).toBeUndefined();
  });

  it("S3 fallback answers an at-EOF read as empty instead of an unsatisfiable range", async () => {
    // The revalidation read `readRunLogTerminalTail` issues for a log that fits
    // in the tail window: offset === totalBytes, asking "did anything land after
    // the size probe?". Both backends floored `end` at `start`, so this built
    // `bytes=total-total` -- one byte past the end -- which S3 answers with 416
    // (PEN-3129). Local files tolerated it; S3 did not, and the heartbeat turned
    // the throw into a silently skipped 429 recovery.
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "p" } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "terminal-line", ts: "t" });
    await store.finalize(handle);
    const full = await store.read(handle);
    const total = full.totalBytes!;
    await fs.rm(baseDir, { recursive: true, force: true }); // force the S3 path

    const atEof = await store.read(handle, { offset: total, limitBytes: 256 });
    expect(atEof.content).toBe("");
    expect(atEof.totalBytes).toBe(total);
    expect(atEof.nextOffset).toBeUndefined(); // nothing left to resume from
    // Past EOF too -- the same clamp produced the same unsatisfiable range.
    const pastEof = await store.read(handle, { offset: total + 99, limitBytes: 256 });
    expect(pastEof.content).toBe("");
    expect(pastEof.totalBytes).toBe(total);
    expect(pastEof.nextOffset).toBeUndefined();
  });

  it("local read answers an at-EOF read as empty, identically to the S3 path", async () => {
    // Same invariant on the backend that tolerated the bad range by accident.
    // Asserted so the two cannot drift apart again -- that divergence is what
    // kept the defect invisible to every local-file test.
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "line", ts: "t" });
    const full = await store.read(handle);
    const total = full.totalBytes!;
    const atEof = await store.read(handle, { offset: total, limitBytes: 256 });
    expect(atEof.content).toBe("");
    expect(atEof.totalBytes).toBe(total);
    expect(atEof.nextOffset).toBeUndefined();
  });

  it("recovers a terminal verdict from a SMALL S3-backed log (the PEN-3129 end-to-end case)", async () => {
    // The population the fix exists for: a 429 refusal dies at num_turns 1, so
    // its log is far under the tail window, and after an API pod roll the local
    // file is gone and S3 is the only source. With the unsatisfiable range this
    // threw, the heartbeat logged a warning and booked `job_failed` anyway.
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "p" } });
    const handle = await store.begin(begin);
    const result = JSON.stringify({
      type: "result",
      is_error: true,
      api_error_status: 429,
      result: "API Error: Request rejected (429)",
    });
    await store.append(handle, { stream: "stdout", chunk: `${result}\n`, ts: "2026-09-10T00:00:00Z" });
    await store.finalize(handle);
    await fs.rm(baseDir, { recursive: true, force: true }); // pod roll -> S3 only

    const tailRead = await readRunLogTerminalTail((range) => store.read(handle, range));
    expect(tailRead.kind).toBe("tail");
    const terminal = findTerminalResultEventInRunLogTail(
      tailRead.kind === "tail" ? tailRead.tail : "",
    );
    expect(terminal?.event.api_error_status).toBe(429);
  });

  it("falls back to S3 when the local file vanishes between stat() and open (TOCTOU race)", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "run-logs" } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "raced-line", ts: "t1" });
    await store.finalize(handle);
    // Delete the local file DURING stat(), i.e. after it reports the file
    // present but before createReadStream opens it -> the open hits ENOENT.
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => {
      const result = await realStat(target as Parameters<typeof realStat>[0], ...(rest as []));
      if (String(target).endsWith(".ndjson")) {
        await fs.rm(target as string, { force: true });
      }
      return result;
    });
    try {
      const res = await store.read(handle);
      expect(res.content).toContain("raced-line");
    } finally {
      statSpy.mockRestore();
    }
  });

  it("throws notFound when neither local nor S3 has the log (pre-S3 run after a roll)", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await fs.rm(baseDir, { recursive: true, force: true }); // never finalized -> never uploaded
    await expect(store.read(handle)).rejects.toThrow(/not found/i);
  });

  it("without S3 configured behaves exactly like the local-only store (safe degrade)", async () => {
    const store = createDurableRunLogStore({ basePath: baseDir });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "local-only", ts: "t1" });
    await store.finalize(handle);
    const res = await store.read(handle);
    expect(res.content).toContain("local-only");
    // and a roll loses it (documented limitation; this is the pre-fix behaviour)
    await fs.rm(baseDir, { recursive: true, force: true });
    await expect(store.read(handle)).rejects.toThrow(/not found/i);
  });
});

// PEN-5424. A run log that cannot be opened used to surface as a bare errno
// raised inside run startup, which reaches a developer only as a downstream
// assertion about scheduling. These pin the message that makes it name itself.
describe("createDurableRunLogStore permission diagnostics", () => {
  // root ignores the mode bits, so the unwritable-directory setup below proves
  // nothing there. CI and the agent sandbox both run as a non-root uid.
  const asNonRoot = typeof process.getuid === "function" && process.getuid() !== 0 ? it : it.skip;

  asNonRoot("names the path, the uid and the RUN_LOG_BASE_PATH remedy when mkdir is refused", async () => {
    const readOnlyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-store-noperm-"));
    await fs.chmod(readOnlyRoot, 0o555);
    try {
      const store = createDurableRunLogStore({ basePath: readOnlyRoot });
      const err = await store.begin(begin).then(
        () => null,
        (caught: unknown) => caught as NodeJS.ErrnoException,
      );
      expect(err).not.toBeNull();
      const message = String(err?.message);
      // The three facts the bare errno withheld.
      expect(message).toContain(readOnlyRoot);
      expect(message).toContain(`uid ${process.getuid!()}`);
      expect(message).toContain("RUN_LOG_BASE_PATH");
      // And the disambiguation that stops the next reader bisecting a diff.
      expect(message).toContain("not a run-scheduling fault");
      // Callers that branch on the errno must still see it.
      expect(err?.code).toBe("EACCES");
      expect((err as { cause?: NodeJS.ErrnoException }).cause?.code).toBe("EACCES");
      // The brand is what lets executeRun record `run_log_unwritable` instead
      // of blaming an adapter that never started.
      expect(isRunLogUnwritableError(err)).toBe(true);
    } finally {
      await fs.chmod(readOnlyRoot, 0o755);
      await fs.rm(readOnlyRoot, { recursive: true, force: true });
    }
  });

  it("leaves a non-permission failure exactly as raised", async () => {
    const store = createDurableRunLogStore({ basePath: baseDir });
    // A plain file where the per-company directory must go: mkdir answers
    // ENOTDIR/EEXIST, which already names itself and must not be re-described
    // as a permission problem.
    await fs.writeFile(path.join(baseDir, begin.companyId), "not-a-directory", "utf8");
    const err = await store.begin(begin).then(
      () => null,
      (caught: unknown) => caught as NodeJS.ErrnoException,
    );
    expect(err).not.toBeNull();
    expect(err?.message).not.toContain("RUN_LOG_BASE_PATH");
    expect(["ENOTDIR", "EEXIST"]).toContain(err?.code);
    expect(isRunLogUnwritableError(err)).toBe(false);
  });

  it("does not claim an unrelated EACCES as a run-log fault", () => {
    // The guard is branded rather than errno-sniffed: an EACCES raised anywhere
    // else in a run must not be recorded as `run_log_unwritable`.
    const foreign = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    expect(isRunLogUnwritableError(foreign)).toBe(false);
    expect(isRunLogUnwritableError(null)).toBe(false);
    expect(isRunLogUnwritableError("EACCES")).toBe(false);
  });
});
