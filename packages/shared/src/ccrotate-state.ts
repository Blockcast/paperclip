import fs from "node:fs";
import path from "node:path";

/**
 * Cross-process advisory lock around shared-state file writes on the
 * shared `/paperclip/.ccrotate` PVC. The lock filename matches ccrotate's
 * own `withCcrotateLock` (lib/state-helpers.js) so this writer and
 * ccrotate's own writers serialize on the same lock.
 *
 * Contract is the file format + lock filename, not the code. If you change
 * the lock path, change it in ccrotate too. If you change the tier-cache
 * schema, update both writers.
 */
export function withCcrotateLock<T>(
  profilesDir: string,
  fn: () => T,
  opts: { timeout?: number; staleMs?: number } = {},
): T {
  const lockPath = path.join(profilesDir, ".active-files.lock");
  const timeout = opts.timeout ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const sleepMs = 50;
  const start = Date.now();
  let fd: number | undefined;

  try {
    fs.mkdirSync(profilesDir, { recursive: true });
  } catch {
    // best-effort
  }

  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch {
        // metadata best-effort
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // race with concurrent reclaim
        }
        continue;
      }
    } catch {
      // file disappeared; retry
    }
    if (Date.now() - start > timeout) {
      throw new Error(`ccrotate: timed out waiting for ${lockPath} after ${timeout}ms`);
    }
    const sleepUntil = Date.now() + sleepMs;
    while (Date.now() < sleepUntil) {
      // synchronous spin
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

interface RateLimits {
  utilization5h?: number | null;
  utilization7d?: number | null;
  reset5h?: number | null;
  reset7d?: number | null;
  resetAt?: string | null;
  snapshotCapturedAt?: string | null;
  [key: string]: unknown;
}

export interface TierCacheEntry {
  email: string;
  status?: string;
  serviceTier?: string | null;
  response?: string | null;
  result?: string | null;
  rateLimits?: RateLimits | null;
}

export interface TierCache {
  updatedAt: string | null;
  accounts: TierCacheEntry[];
}

export type TierCacheTarget = "claude" | "codex";

function tierCacheFilename(target: TierCacheTarget): string {
  return target === "claude" ? "tier-cache.json" : "tier-cache.codex.json";
}

/**
 * Atomically mark an account as `serviceTier: 'exhausted'` in the shared
 * tier-cache for `target`. Captures runtime quota-failure events observed
 * by the orchestrator (paperclip-server) — the reset epoch comes from the
 * adapter's `retryNotBefore`, so subsequent `ccrotate next` invocations
 * skip this account in candidate scoring (next.js stale-and-tier filter).
 *
 * Without this writeback, runtime quota burns are invisible to the pool's
 * state machine: ccrotate's own probe (testAccountViaMessages) is throttled
 * by Anthropic's per-org Usage API rate limit, so tier-cache stays "unknown"
 * while the runtime is observing the same burns and dropping the data on
 * the floor. Pool spirals into a retry storm. Real incident 2026-05-08.
 */
export function markAccountExhausted(
  profilesDir: string,
  email: string,
  fields: {
    target?: TierCacheTarget;
    reset5h?: number | null;
    reset7d?: number | null;
    response?: string | null;
  } = {},
): void {
  const target = fields.target ?? "claude";
  const reset5h = fields.reset5h ?? null;
  const reset7d = fields.reset7d ?? null;
  const response = fields.response ?? null;

  withCcrotateLock(profilesDir, () => {
    const tierCachePath = path.join(profilesDir, tierCacheFilename(target));

    let cache: TierCache = { updatedAt: null, accounts: [] };
    try {
      const raw = fs.readFileSync(tierCachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TierCache>;
      cache = {
        updatedAt: parsed.updatedAt ?? null,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      };
    } catch {
      // fresh cache
    }

    const existing = cache.accounts.find((a) => a.email === email);
    const others = cache.accounts.filter((a) => a.email !== email);
    const resetEpoch = reset5h ?? reset7d;
    const fallbackResp = resetEpoch
      ? `quota exhausted; resets at ${new Date(resetEpoch * 1000).toISOString()}`
      : "quota exhausted";

    const entry: TierCacheEntry = {
      email,
      status: "success",
      serviceTier: "exhausted",
      response: response ?? existing?.response ?? fallbackResp,
      rateLimits: {
        ...(existing?.rateLimits ?? {}),
        ...(reset5h != null ? { reset5h } : {}),
        ...(reset7d != null ? { reset7d } : {}),
        snapshotCapturedAt: new Date().toISOString(),
      },
    };

    const next: TierCache = {
      updatedAt: new Date().toISOString(),
      accounts: others.concat(entry),
    };

    const tmp = `${tierCachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, tierCachePath);
  });
}
