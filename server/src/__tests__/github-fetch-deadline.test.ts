import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it(
    "returns a FALSY caller abort reason as-is instead of misreporting it as a connect failure",
    async () => {
      // Deliberately NOT neverResolvingFetch(): its `?? new Error("aborted")`
      // substitutes a truthy reason, which would hide the bug under test.
      _setGhFetchDeadlineMsForTest(5_000);
      vi.stubGlobal(
        "fetch",
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );

      const controller = new AbortController();
      setTimeout(() => controller.abort(null), 60);

      // With a truthiness test in ghFetch this rejects with the "Could not
      // connect" message instead — on-call sent to check URL configuration for
      // a request the caller itself cancelled (BLO-38471).
      await expect(ghFetch(URL_UNDER_TEST, { signal: controller.signal })).rejects.toBeNull();
    },
    10_000,
  );
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

  /**
   * Derived, not enumerated (BLO-38471). The previous form named three files,
   * so it certified exactly those three and a NEW service adopting the
   * convention escaped it silently — the failure mode worth closing, more than
   * any individual unwrapped read.
   *
   * Membership is `ghFetch(` AND `unprocessable(`: `ghFetch` is what arms the
   * deadline through the body read, and `unprocessable(` is what makes the file
   * one of the helpers whose callers are promised a structured rejection.
   * Known ceiling: a file that mentions `ghFetch` and does NOT use
   * `unprocessable` is out of scope here. Recompute that set instead of keeping a
   * list of it, which is how the previous form rotted: from `server/src/services`,
   * `grep -L unprocessable $(grep -l ghFetch *.ts)`. At BLO-38471 it held four
   * files, and every body read in them was inside a try/catch or carried
   * `.catch(() => …)`. Widening to `ghFetch(` alone needs a try/catch-aware
   * scanner, which is a parser; do that only if a file in that set grows an
   * unhandled read.
   */
  function scanGhFetchBodyReads(dir: string) {
    const scanned: string[] = [];
    const offenders: string[] = [];
    let bodyReads = 0;

    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      if (!source.includes("ghFetch(") || !source.includes("unprocessable(")) continue;
      scanned.push(file);
      for (const line of source.split("\n")) {
        if (!/\.(?:text|json|arrayBuffer|blob|bytes)\(\)/.test(line)) continue;
        bodyReads += 1;
        if (!line.includes("ghReadBody(")) offenders.push(`${file}: ${line.trim()}`);
      }
    }

    return { scanned, bodyReads, offenders };
  }

  const SERVICES_DIR = fileURLToPath(new URL("../services/", import.meta.url));

  it("every ghFetch body read in the unprocessable-convention helpers goes through ghReadBody", () => {
    const { scanned, bodyReads, offenders } = scanGhFetchBodyReads(SERVICES_DIR);

    // Non-vacuity: a scan that matched nothing would report zero offenders and
    // pass while certifying nothing at all.
    expect(bodyReads).toBeGreaterThan(0);
    // The file this guard was widened for. Not the membership rule — an anchor
    // proving the derived scan actually reaches it.
    expect(scanned).toContain("issue-pull-requests.ts");
    expect(offenders).toEqual([]);
  });

  it("the guard counts real matches: an empty directory yields no body reads", () => {
    const empty = mkdtempSync(join(tmpdir(), "ghfetch-scan-"));
    try {
      expect(scanGhFetchBodyReads(empty)).toEqual({ scanned: [], bodyReads: 0, offenders: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
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

/**
 * A webhook handler must answer GitHub inside its ~10s delivery timeout, so a
 * GitHub read it `await`s ahead of its first `respond(200, …)` has to be bound
 * to GITHUB_REQUEST_TIMEOUT_MS rather than left on ghFetch's 30s default — two
 * sequential unbounded hops is 60s, and the redelivery that follows is the
 * storm shape BLO-38257 names in github-fetch.ts's own docstring.
 *
 * Both halves are DERIVED, not listed, and that is the deliverable (BLO-40593).
 * The two guards above name their files by hand; this family has now been
 * caught twice by a human reviewer and zero times by CI, because a hardcoded
 * list cannot see the call site nobody has written yet. A new webhook route, or
 * a new signal-accepting helper, is covered here without editing this test.
 *
 * Scope ceiling, stated so it is not mistaken for coverage: only helpers that
 * DECLARE `signal?: AbortSignal` are checked. githubListIssueCommentBodies,
 * githubListPullRequestCommits and githubPostIssueComment reach the network and
 * accept no signal at all, so no call site can bound them — giving them one is
 * BLO-38257 residual, not something this guard can report. Reachability is
 * approximated by FILE, not by control flow: every call in a `*webhook*.ts`
 * route is held to the request bound, including the handful reached only from
 * the heartbeat tick. That is deliberate — over-binding a background read costs
 * nothing, and proving reachability would need a call graph this does not have.
 */
function scanWebhookGithubCallSites(routesDir: string, servicesDir: string) {
  const boundable = new Set<string>();
  for (const file of readdirSync(servicesDir).filter((f) => f.startsWith("github") && f.endsWith(".ts"))) {
    const source = readFileSync(join(servicesDir, file), "utf8");
    for (const block of source.split(/\n(?=export (?:async )?function )/)) {
      const name = /^export (?:async )?function (github\w+)/.exec(block)?.[1];
      // Signature only. A `signal` the body threads onward is not a parameter
      // the call site can supply, and counting it would make the guard demand
      // an argument the helper does not accept.
      const signature = block.slice(0, block.indexOf("): ") + 1);
      if (name && /signal\?: AbortSignal/.test(signature)) boundable.add(name);
    }
  }

  const sites: Array<{ file: string; line: number; helper: string; bound: boolean }> = [];
  if (boundable.size === 0) return { boundable, sites };

  for (const file of readdirSync(routesDir).filter((f) => f.includes("webhook") && f.endsWith(".ts"))) {
    const source = readFileSync(join(routesDir, file), "utf8");
    // A helper reached through a test/config override is still a call on this
    // path, and a direct-call-only scan reports its absence as coverage. Both
    // spellings in the tree bind the real helper as the fallback — an inline
    // `(config.x ?? githubY)({…})`, and a named `const alias = config.x ?? githubY;`
    // called later — so accept the inline form and resolve the alias by name.
    const aliases = [...source.matchAll(/\bconst (\w+) = (?:[\w.]+ \?\? )?(github\w+);/g)]
      .filter((match) => boundable.has(match[2] ?? ""))
      .map((match) => match[1] ?? "");
    const callPattern = new RegExp(`\\b(${[...boundable, ...aliases].join("|")})\\)?\\s*\\(`, "g");
    for (const match of source.matchAll(callPattern)) {
      const start = match.index ?? 0;
      const open = start + match[0].length - 1;
      let depth = 0;
      let close = open;
      while (close < source.length) {
        if (source[close] === "(") depth += 1;
        else if (source[close] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        close += 1;
      }
      sites.push({
        file,
        line: source.slice(0, start).split("\n").length,
        helper: match[1] ?? "<unknown>",
        bound: /\bsignal:/.test(source.slice(open, close + 1)),
      });
    }
  }
  return { boundable, sites };
}

function assertWebhookGithubCallsAreBounded(routesDir: string, servicesDir: string) {
  const { sites } = scanWebhookGithubCallSites(routesDir, servicesDir);
  // Non-vacuity: a scan that matched nothing fails here instead of reporting an
  // empty offender list as a pass. Without this the guard reads green forever
  // the day a rename puts the routes somewhere the scan does not look.
  if (sites.length === 0) {
    throw new Error(`scan matched no signal-accepting GitHub call sites under ${routesDir}`);
  }
  const offenders = sites.filter((site) => !site.bound).map((site) => `${site.file}:${site.line} ${site.helper}`);
  if (offenders.length > 0) {
    throw new Error(
      `GitHub call on a request-blocking webhook path with no signal: ${offenders.join(", ")} ` +
        "— pass signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)",
    );
  }
}

const ROUTES_DIR = fileURLToPath(new URL("../routes/", import.meta.url));
const SERVICES_DIR = fileURLToPath(new URL("../services/", import.meta.url));
// A real directory that holds no webhook route, so the control stays honest
// without a fixture to drift.
const NO_WEBHOOK_DIR = fileURLToPath(new URL("../middleware/", import.meta.url));

describe("every GitHub read on a request-blocking webhook path is bounded (BLO-40593)", () => {
  it("every signal-accepting GitHub helper call in a webhook route supplies one", () => {
    expect(() => assertWebhookGithubCallsAreBounded(ROUTES_DIR, SERVICES_DIR)).not.toThrow();
  });

  it("is non-vacuous: the same scan over a directory with no webhook routes fails rather than passing", () => {
    expect(() => assertWebhookGithubCallsAreBounded(NO_WEBHOOK_DIR, SERVICES_DIR)).toThrow(
      /scan matched no signal-accepting GitHub call sites/,
    );
  });

  // The classification is checked, not asserted. Widening it to "mentions a
  // signal anywhere in the function" silently admits githubGetWorkflowRun,
  // whose `signal?: AbortSignal` sits in its BODY while its own parameter
  // object is {repoFullName, runId} — and the guard would then demand an
  // argument the helper does not accept, i.e. fail on correct code. Verified by
  // a second, independent extraction (paren depth from the opening paren) so
  // this is a real cross-check rather than a restatement of the scan.
  it("never classifies a helper as boundable unless its own parameter list takes the signal", () => {
    const { boundable } = scanWebhookGithubCallSites(ROUTES_DIR, SERVICES_DIR);
    const sources = readdirSync(SERVICES_DIR)
      .filter((f) => f.startsWith("github") && f.endsWith(".ts"))
      .map((f) => readFileSync(join(SERVICES_DIR, f), "utf8"))
      .join("\n");

    const misclassified = [...boundable].filter((name) => {
      const declared = sources.indexOf(`function ${name}(`);
      if (declared < 0) return true;
      const open = sources.indexOf("(", declared);
      let depth = 0;
      let close = open;
      while (close < sources.length) {
        if (sources[close] === "(") depth += 1;
        else if (sources[close] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        close += 1;
      }
      return !/signal\?: AbortSignal/.test(sources.slice(open, close + 1));
    });

    expect(boundable.size).toBeGreaterThan(0);
    expect(misclassified).toEqual([]);
  });
});
