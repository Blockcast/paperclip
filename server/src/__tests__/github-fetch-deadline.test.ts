import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GITHUB_FETCH_DEADLINE_MS,
  GITHUB_REQUEST_TIMEOUT_MS,
  ghFetch,
  ghReadBody,
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
      // Reported as a timeout, never as the connect failure that would send
      // on-call to check URL configuration during a GitHub slowdown.
      await expect(ghFetch(URL_UNDER_TEST)).rejects.toMatchObject({
        status: 422,
        message: "GitHub request to api.github.com timed out after 60ms",
      });
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
      const callerReason = new Error("caller-deadline");
      setTimeout(() => controller.abort(callerReason), 60);

      const startedAt = Date.now();
      // The caller's own abort comes back as exactly what it aborted with, so
      // "I cancelled this" stays distinguishable from "GitHub is down".
      await expect(ghFetch(URL_UNDER_TEST, { signal: controller.signal })).rejects.toBe(callerReason);
      expect(Date.now() - startedAt).toBeLessThan(750);
    },
    10_000,
  );

  it("still reports a genuine connect failure as one", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));

    await expect(ghFetch(URL_UNDER_TEST)).rejects.toThrow(/Could not connect to api\.github\.com/);
  });

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

describe("ghReadBody: the deadline stays armed through the body read (BLO-38257)", () => {
  it(
    "reports a deadline that fires mid-body as a timeout, not a raw TimeoutError",
    async () => {
      _setGhFetchDeadlineMsForTest(60);
      // Headers arrive at once; the body only settles when something aborts it,
      // or at the late resolve that no deadline in force ever lets it reach.
      vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((resolve, reject) => {
              const late = setTimeout(() => resolve("late body"), 1_500);
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(late);
                reject(init.signal?.reason);
              });
            }),
        } as unknown as Response),
      );

      const response = await ghFetch(URL_UNDER_TEST);
      await expect(ghReadBody(URL_UNDER_TEST, () => response.text())).rejects.toMatchObject({
        status: 422,
        message: "GitHub request to api.github.com timed out after 60ms",
      });
    },
    10_000,
  );

  it("leaves a body failure that is not an abort exactly as it was", async () => {
    const parseError = new SyntaxError("Unexpected token < in JSON");

    await expect(ghReadBody(URL_UNDER_TEST, () => Promise.reject(parseError))).rejects.toBe(parseError);
  });

  it("every ghFetch body read in the unprocessable-convention helpers goes through ghReadBody", () => {
    const offenders = ["company-portability.ts", "company-skills.ts", "skills-catalog.ts"].flatMap((file) =>
      readFileSync(fileURLToPath(new URL(`../services/${file}`, import.meta.url)), "utf8")
        .split("\n")
        .filter((line) => /\.(?:text|json|arrayBuffer|blob|bytes)\(\)/.test(line) && !line.includes("ghReadBody("))
        .map((line) => `${file}: ${line.trim()}`),
    );

    expect(offenders).toEqual([]);
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
