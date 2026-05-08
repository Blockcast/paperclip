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
  it("creates the lockfile during fn() and removes it after", () => {
    const lockPath = path.join(workDir, ".active-files.lock");
    let observedExisted = false;

    withCcrotateLock(workDir, () => {
      observedExisted = fs.existsSync(lockPath);
    });

    expect(observedExisted).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("removes the lock even when fn throws", () => {
    const lockPath = path.join(workDir, ".active-files.lock");
    expect(() =>
      withCcrotateLock(workDir, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims a stale lock older than staleMs", () => {
    const lockPath = path.join(workDir, ".active-files.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: 0 }));
    // Backdate mtime so the lock looks stale.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    let ran = false;
    withCcrotateLock(workDir, () => {
      ran = true;
    }, { staleMs: 1_000, timeout: 2_000 });
    expect(ran).toBe(true);
  });
});

describe("markAccountExhausted", () => {
  function readTierCache(target: "claude" | "codex" = "claude") {
    const file = target === "claude" ? "tier-cache.json" : "tier-cache.codex.json";
    return JSON.parse(fs.readFileSync(path.join(workDir, file), "utf8"));
  }

  it("creates a fresh tier-cache.json with serviceTier='exhausted' when none exists", () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    markAccountExhausted(workDir, "burned@example.com", { reset5h: reset });

    const cache = readTierCache();
    expect(cache.accounts).toHaveLength(1);
    expect(cache.accounts[0].email).toBe("burned@example.com");
    expect(cache.accounts[0].serviceTier).toBe("exhausted");
    expect(cache.accounts[0].rateLimits.reset5h).toBe(reset);
    expect(cache.accounts[0].rateLimits.snapshotCapturedAt).toBeTypeOf("string");
    expect(cache.updatedAt).toBeTypeOf("string");
  });

  it("preserves other accounts and overwrites the matching entry", () => {
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
    markAccountExhausted(workDir, "burn@x.com", { reset5h: reset });

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

  it("uses tier-cache.codex.json for the codex target", () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    markAccountExhausted(workDir, "cx@x.com", { target: "codex", reset5h: reset });

    expect(fs.existsSync(path.join(workDir, "tier-cache.codex.json"))).toBe(true);
    expect(fs.existsSync(path.join(workDir, "tier-cache.json"))).toBe(false);
    const cache = readTierCache("codex");
    expect(cache.accounts[0].email).toBe("cx@x.com");
    expect(cache.accounts[0].serviceTier).toBe("exhausted");
  });

  it("writes a 'quota exhausted' response when none provided", () => {
    const reset = 1_900_000_000;
    markAccountExhausted(workDir, "a@x.com", { reset5h: reset });
    const cache = readTierCache();
    expect(cache.accounts[0].response).toContain("quota exhausted");
    expect(cache.accounts[0].response).toContain(new Date(reset * 1000).toISOString());
  });
});
