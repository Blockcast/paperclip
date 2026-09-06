import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";

// Regression lock on the `acpx` dependency floor (PEN-1995 / PEN-1990).
//
// `createRuntimeStore` returns acpx's `FileSessionStore`. Its `save()` writes to a
// temp path and renames it over the target. Up to and including acpx@0.12.1 that
// temp path was derived from `${pid}.${Date.now()}` only, so two concurrent saves
// for the same session key inside one worker process could derive the *same* temp
// path: both writes land, the first rename consumes the file, and the second
// rename fails `ENOENT`. acpx@0.13.0 added `randomUUID()` to the temp name.
//
// This matters here because `stateDir` is resolved per *agent*, not per run
// (see `defaultStateDir` in ./execute.ts), so concurrent runs of one agent sharing
// a `taskKey` + fingerprint all target one session file. Two production heartbeat
// runs died this way. These tests fail against acpx < 0.13.0 and are what keeps
// the `packages/adapter-utils` range from being walked back below that floor.
//
// Scope note: `packages/adapters/acpx-local` and `server` still pin acpx ^0.6.1,
// which carries the same entropy-free temp path. That is the `acpx_local` adapter
// type, not `claude_local`, and is not the path the observed failures came from;
// it is left alone here deliberately rather than swept into this fix.

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-session-store-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function sessionRecord(sessionId: string): AcpSessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
    acpSessionId: "acp-session-1",
    agentCommand: "claude",
    cwd: "/tmp",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    lastSeq: 1,
    eventLog: {
      active_path: "events.jsonl",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 4,
    },
    messages: [],
    updated_at: "2026-01-01T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
  };
}

// Shaped like the real key: `paperclip:${companyId}:${agentId}:${taskKey}:${fingerprint}`.
const HEARTBEAT_SESSION_KEY = "paperclip:company-1:agent-1:__heartbeat__:fingerprint-1";

async function saveConcurrently(
  store: ReturnType<typeof createRuntimeStore>,
  sessionIds: string[],
): Promise<PromiseRejectedResult[]> {
  const results = await Promise.allSettled(sessionIds.map((id) => store.save(sessionRecord(id))));
  return results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
}

describe("acpx runtime session store concurrency", () => {
  it("saves a single session record and reads it back", async () => {
    // Control: proves the record fixture is valid, so rejections below are the
    // race and not a rejected record shape.
    const store = createRuntimeStore({ stateDir: await makeTempRoot() });

    await expect(store.save(sessionRecord(HEARTBEAT_SESSION_KEY))).resolves.toBeUndefined();
    await expect(store.load(HEARTBEAT_SESSION_KEY)).resolves.toBeDefined();
  });

  it("tolerates concurrent saves of the same session key without losing the temp file", async () => {
    const store = createRuntimeStore({ stateDir: await makeTempRoot() });
    const keys = Array.from({ length: 8 }, () => HEARTBEAT_SESSION_KEY);

    const rejections: PromiseRejectedResult[] = [];
    for (let trial = 0; trial < 25; trial += 1) {
      rejections.push(...(await saveConcurrently(store, keys)));
    }

    expect(rejections.map((rejection) => String(rejection.reason))).toEqual([]);
    // The last writer through still leaves a readable record behind.
    await expect(store.load(HEARTBEAT_SESSION_KEY)).resolves.toBeDefined();
  });

  it("tolerates concurrent saves of distinct session keys", async () => {
    // Control on the stratification: concurrency alone was never the trigger —
    // only concurrency on a shared session key was.
    const store = createRuntimeStore({ stateDir: await makeTempRoot() });
    const keys = Array.from({ length: 8 }, (_unused, index) => `${HEARTBEAT_SESSION_KEY}:${index}`);

    const rejections = await saveConcurrently(store, keys);

    expect(rejections.map((rejection) => String(rejection.reason))).toEqual([]);
    for (const key of keys) {
      await expect(store.load(key)).resolves.toBeDefined();
    }
  });
});
