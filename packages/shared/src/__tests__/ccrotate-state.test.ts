import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { markAccountExhausted, withCcrotateLock } from "../ccrotate-state.js";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccrotate-state-test-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("withCcrotateLock", () => {
  it("creates the lockfile during fn() and removes it after", async () => {
    const lockPath = path.join(workDir, ".active-files.lock");
    let observedExisted = false;

    await withCcrotateLock(workDir, () => {
      observedExisted = fs.existsSync(lockPath);
    });

    expect(observedExisted).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("removes the lock even when fn throws", async () => {
    const lockPath = path.join(workDir, ".active-files.lock");
    await expect(
      withCcrotateLock(workDir, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims a stale lock older than staleMs", async () => {
    const lockPath = path.join(workDir, ".active-files.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: 0 }));
    // Backdate mtime so the lock looks stale.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    let ran = false;
    await withCcrotateLock(workDir, () => {
      ran = true;
    }, { staleMs: 1_000, timeout: 2_000 });
    expect(ran).toBe(true);
  });

  it("does not block the event loop while waiting for a contended lock", async () => {
    // Hold the lock for ~150ms in another flow and verify a second
    // withCcrotateLock can be queued AND a fully unrelated setImmediate
    // tick runs in between. With the previous busy-wait, setImmediate
    // would not fire until the lock was released.
    fs.writeFileSync(path.join(workDir, ".active-files.lock"), JSON.stringify({ pid: 1, at: Date.now() }));
    let immediateRan = false;
    setImmediate(() => { immediateRan = true; });

    const releaseAfter = 150;
    const startReleaseTimer = setTimeout(() => {
      try { fs.unlinkSync(path.join(workDir, ".active-files.lock")); } catch { /* ignore */ }
    }, releaseAfter);

    await withCcrotateLock(workDir, () => "done", { timeout: 2_000 });
    clearTimeout(startReleaseTimer);

    expect(immediateRan).toBe(true);
  });
});

describe("markAccountExhausted", () => {
  function readTierCache(target: "claude" | "codex" = "claude") {
    const file = target === "claude" ? "tier-cache.json" : "tier-cache.codex.json";
    return JSON.parse(fs.readFileSync(path.join(workDir, file), "utf8"));
  }

  it("creates a fresh tier-cache.json with serviceTier='exhausted' when none exists", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    await markAccountExhausted(workDir, "burned@example.com", { reset5h: reset });

    const cache = readTierCache();
    expect(cache.accounts).toHaveLength(1);
    expect(cache.accounts[0].email).toBe("burned@example.com");
    expect(cache.accounts[0].serviceTier).toBe("exhausted");
    expect(cache.accounts[0].rateLimits.reset5h).toBe(reset);
    expect(cache.accounts[0].rateLimits.snapshotCapturedAt).toBeTypeOf("string");
    expect(cache.updatedAt).toBeTypeOf("string");
  });

  it("preserves other accounts and overwrites the matching entry", async () => {
    fs.writeFileSync(
      path.join(workDir, "tier-cache.json"),
      JSON.stringify({
        updatedAt: "2026-05-01T00:00:00Z",
        accounts: [
          { email: "keep@x.com", serviceTier: "base", rateLimits: { utilization5h: 10 } },
          { email: "burn@x.com", serviceTier: "base", rateLimits: { utilization5h: 95 } },
        ],
      }),
    );

    const reset = Math.floor(Date.now() / 1000) + 1800;
    await markAccountExhausted(workDir, "burn@x.com", { reset5h: reset });

    const cache = readTierCache();
    expect(cache.accounts).toHaveLength(2);
    const keep = cache.accounts.find((a: { email: string }) => a.email === "keep@x.com");
    const burn = cache.accounts.find((a: { email: string }) => a.email === "burn@x.com");
    expect(keep.serviceTier).toBe("base");
    expect(keep.rateLimits.utilization5h).toBe(10);
    expect(burn.serviceTier).toBe("exhausted");
    expect(burn.rateLimits.reset5h).toBe(reset);
    // utilization carried over from prior entry.
    expect(burn.rateLimits.utilization5h).toBe(95);
  });

  it("uses tier-cache.codex.json for the codex target", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    await markAccountExhausted(workDir, "cx@x.com", { target: "codex", reset5h: reset });

    expect(fs.existsSync(path.join(workDir, "tier-cache.codex.json"))).toBe(true);
    expect(fs.existsSync(path.join(workDir, "tier-cache.json"))).toBe(false);
    const cache = readTierCache("codex");
    expect(cache.accounts[0].email).toBe("cx@x.com");
    expect(cache.accounts[0].serviceTier).toBe("exhausted");
  });

  it("writes a 'quota exhausted' response when none provided", async () => {
    const reset = 1_900_000_000;
    await markAccountExhausted(workDir, "a@x.com", { reset5h: reset });
    const cache = readTierCache();
    expect(cache.accounts[0].response).toContain("quota exhausted");
    expect(cache.accounts[0].response).toContain(new Date(reset * 1000).toISOString());
  });
});
