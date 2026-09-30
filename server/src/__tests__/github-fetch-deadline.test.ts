import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GITHUB_FETCH_DEADLINE_MS,
  GITHUB_REQUEST_TIMEOUT_MS,
  ghFetch,
  _setGhFetchDeadlineMsForTest,
} from "../services/github-fetch.js";

const URL_UNDER_TEST = "https://api.github.com/repos/o/r";

/**
 * A fetch that only ever settles because something aborted it — plus a LATE
 * resolve that is never reached while a deadline is in force.
 *
 * The late resolve is the whole point: with the deadline removed, the call
 * resolves at `lateMs` and the `.rejects` assertion fails on its own terms.
 * Without it the unbounded case would hang and fail by SUITE TIMEOUT, which is
 * exactly the regression-masquerading-as-timeout the CEO's 2026-09-17 rule
 * forbids.
 */
function neverResolvingFetch(lateMs = 1_500) {
  return (_url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const late = setTimeout(
        () => resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
        lateMs,
      );
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(late);
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    });
}

afterEach(() => {
  _setGhFetchDeadlineMsForTest();
  vi.unstubAllGlobals();
});

describe("ghFetch deadline (BLO-38257)", () => {
  it("has a default well under undici's ~300s, and webhook paths bind tighter still", () => {
    expect(GITHUB_FETCH_DEADLINE_MS).toBeLessThan(300_000);
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBeLessThan(GITHUB_FETCH_DEADLINE_MS);
  });

  it(
    "bounds a caller that supplies no signal at all",
    async () => {
      _setGhFetchDeadlineMsForTest(60);
      vi.stubGlobal("fetch", neverResolvingFetch());

      const startedAt = Date.now();
      await expect(ghFetch(URL_UNDER_TEST)).rejects.toThrow(/Could not connect to api\.github\.com/);
      // Fired at the 60ms deadline, nowhere near the 1.5s late resolve.
      expect(Date.now() - startedAt).toBeLessThan(750);
    },
    10_000,
  );

  it(
    "lets a caller-supplied signal abort EARLIER than the default (composition, not replacement)",
    async () => {
      // Default deliberately far away: if ghFetch replaced the caller's signal
      // with its own deadline, the caller abort below would never reach fetch
      // and this call would resolve at 1.5s instead of rejecting.
      _setGhFetchDeadlineMsForTest(5_000);
      vi.stubGlobal("fetch", neverResolvingFetch());

      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("caller-deadline")), 60);

      const startedAt = Date.now();
      await expect(ghFetch(URL_UNDER_TEST, { signal: controller.signal })).rejects.toThrow(
        /Could not connect to api\.github\.com/,
      );
      expect(Date.now() - startedAt).toBeLessThan(750);
    },
    10_000,
  );

  it("passes an already-aborted caller signal straight through to fetch", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    });

    await ghFetch(URL_UNDER_TEST, { signal: AbortSignal.abort(new Error("already-aborted")) });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });
});

/**
 * AC3 as a standing guard rather than a one-time count: a helper that declares
 * `signal?: AbortSignal` and then mints an installation token with no arguments
 * has an UNBOUNDED first hop while looking bounded at its second. That is the
 * exact trap BLO-38257 was filed about, and it is re-introduced by writing one
 * ordinary-looking line — so it is checked in source, not counted once by hand.
 */
describe("no helper declares a signal and drops it at the token mint", () => {
  it("every signal-declaring function threads it into getInstallationToken[Result]", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../services/github-app-auth.ts", import.meta.url)),
      "utf8",
    );
    const blocks = source.split(/\n(?=(?:export )?(?:async )?function )/);

    const offenders = blocks
      .filter(
        (block) =>
          /signal\?: AbortSignal/.test(block) &&
          /getInstallationTokenResult\(\s*\)|getInstallationToken\(\s*\)/.test(block),
      )
      .map((block) => block.split("\n")[0]?.trim() ?? "<unknown>");

    expect(offenders).toEqual([]);
  });
});
