import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  EXIT_UNMEASURED,
  EXIT_VIOLATION,
  SECRET_SCAN_SILENCING_PATHS,
  fetchCodeownersErrors,
  ghErrorText,
  isTransientGhError,
  ownersForExactPattern,
  parseCodeownersRules,
  runGuard,
  summarizeErrors,
  uncoveredSecretScanPaths,
} from "./check-codeowners.mjs";
import { withRetry } from "./mirror-comment-review-gate-to-merge-group.mjs";

describe("summarizeErrors", () => {
  it("returns an empty list for no errors", () => {
    assert.deepEqual(summarizeErrors([]), []);
    assert.deepEqual(summarizeErrors(undefined), []);
    assert.deepEqual(summarizeErrors(null), []);
  });

  it("formats a line, kind, and suggestion into one string", () => {
    const errors = [
      {
        line: 15,
        column: 25,
        kind: "Unknown owner",
        suggestion: "make sure @cryppadotta exists and has write access to the repository",
        message: "Unknown owner on line 15: make sure @cryppadotta exists...",
        path: ".github/CODEOWNERS",
      },
    ];

    assert.deepEqual(summarizeErrors(errors), [
      "line 15: Unknown owner — make sure @cryppadotta exists and has write access to the repository",
    ]);
  });

  it("formats multiple errors preserving order", () => {
    const errors = [
      { line: 3, kind: "Unknown owner" },
      { line: 4, kind: "Unknown owner" },
    ];

    assert.deepEqual(summarizeErrors(errors), [
      "line 3: Unknown owner",
      "line 4: Unknown owner",
    ]);
  });

  it("omits the suggestion clause when absent", () => {
    assert.deepEqual(summarizeErrors([{ line: 1, kind: "Syntax error" }]), [
      "line 1: Syntax error",
    ]);
  });
});

describe("ghErrorText", () => {
  it("prefers stderr, where execFileSync actually puts the gh message", () => {
    const error = Object.assign(new Error("Command failed: gh api ..."), {
      stderr: "gh: HTTP 502: 502 Bad Gateway (https://api.github.com/...)\n",
    });
    assert.match(ghErrorText(error), /HTTP 502/);
  });

  it("falls back to message when there is no stderr, so a non-gh throw is still classifiable", () => {
    assert.equal(ghErrorText(new Error("boom")), "boom");
  });

  it("never throws on a null-ish or non-Error value", () => {
    assert.equal(ghErrorText(null), "");
    assert.equal(ghErrorText(undefined), "");
    assert.equal(ghErrorText("plain string"), "plain string");
  });
});

describe("isTransientGhError", () => {
  for (const message of [
    "HTTP 500: Internal Server Error",
    "HTTP 502: 502 Bad Gateway",
    "HTTP 503: Service Unavailable",
    "HTTP 504: Gateway Timeout",
    "connect ETIMEDOUT 140.82.121.6:443",
    "read ECONNRESET",
    "getaddrinfo EAI_AGAIN api.github.com",
    "socket hang up",
  ]) {
    it(`retries ${JSON.stringify(message)}`, () => {
      assert.equal(isTransientGhError(message), true);
    });
  }

  // ⛔ These are the fail-toward-unmeasured cases. Retrying cannot repair any
  // of them, and crediting one as transient would spend the backoff and then
  // land on the same answer.
  for (const message of [
    "HTTP 404: Not Found",
    "HTTP 401: Bad credentials",
    "HTTP 403: API rate limit exceeded",
    "HTTP 422: Validation Failed",
    "something nobody has classified",
    "",
  ]) {
    it(`does NOT retry ${JSON.stringify(message)}`, () => {
      assert.equal(isTransientGhError(message), false);
    });
  }

  it("does not treat a 4xx as transient merely because it contains a 5", () => {
    assert.equal(isTransientGhError("HTTP 451: Unavailable For Legal Reasons"), false);
  });

  it("is null-safe", () => {
    assert.equal(isTransientGhError(null), false);
    assert.equal(isTransientGhError(undefined), false);
  });
});

// Runs the REAL `withRetry` from the shared module, only with the backoff
// collapsed, so these exercise the actual helper and the actual `shouldRetry`
// predicate rather than a hand-built stand-in. PEN-5314's own review caught a
// regression that every by-hand test missed for exactly this reason.
const noSleepRetry = (label, fn, options) => withRetry(label, fn, { ...options, delayMs: 0 });

describe("fetchCodeownersErrors", () => {
  it("survives a transient 5xx and returns the errors from the retried call", () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("Command failed"), {
          stderr: "gh: HTTP 502: 502 Bad Gateway",
        });
      }
      return JSON.stringify({ errors: [{ line: 3, kind: "Unknown owner" }] });
    };

    const errors = fetchCodeownersErrors("o/r", "master", { run, retry: noSleepRetry });

    assert.equal(calls, 2);
    assert.deepEqual(errors, [{ line: 3, kind: "Unknown owner" }]);
  });

  it("⛔ does NOT retry a 404 — it throws on the first attempt", () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      throw Object.assign(new Error("Command failed"), { stderr: "gh: HTTP 404: Not Found" });
    };

    assert.throws(() => fetchCodeownersErrors("o/r", "nope", { run, retry: noSleepRetry }));
    assert.equal(calls, 1);
  });

  it("gives up after the shared helper's attempt budget rather than looping", () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      throw Object.assign(new Error("Command failed"), { stderr: "gh: HTTP 503" });
    };

    assert.throws(() => fetchCodeownersErrors("o/r", "master", { run, retry: noSleepRetry }));
    assert.equal(calls, 3);
  });

  it("passes the ref through to the endpoint it claims to assert", () => {
    const seen = [];
    const run = (args) => {
      seen.push(args);
      return JSON.stringify({ errors: [] });
    };

    fetchCodeownersErrors("Blockcast/paperclip", "abc123", { run, retry: noSleepRetry });

    assert.deepEqual(seen, [
      ["api", "repos/Blockcast/paperclip/codeowners/errors?ref=abc123"],
    ]);
  });

  it("treats a response with no errors key as zero errors", () => {
    const run = () => JSON.stringify({});
    assert.deepEqual(fetchCodeownersErrors("o/r", "master", { run, retry: noSleepRetry }), []);
  });
});

describe("runGuard exit-code contract", () => {
  const capture = () => {
    const lines = [];
    return { lines, sink: (...args) => lines.push(args.join(" ")) };
  };

  it("exits 0 and says so when the ref is sound", () => {
    const out = capture();
    const code = runGuard({
      repo: "o/r",
      ref: "master",
      fetch: () => [],
      log: out.sink,
      logError: () => {},
    });

    assert.equal(code, 0);
    assert.match(out.lines.join("\n"), /passed: 0 errors/);
  });

  it("exits 1 for a measured violation and names each inert rule", () => {
    const err = capture();
    const code = runGuard({
      repo: "o/r",
      ref: "master",
      fetch: () => [{ line: 7, kind: "Unknown owner" }],
      log: () => {},
      logError: err.sink,
    });

    assert.equal(code, EXIT_VIOLATION);
    assert.match(err.lines.join("\n"), /line 7: Unknown owner/);
  });

  it("⛔ exits EXIT_UNMEASURED, not 1, when the read itself failed", () => {
    const code = runGuard({
      repo: "o/r",
      ref: "master",
      fetch: () => {
        throw Object.assign(new Error("Command failed"), { stderr: "gh: HTTP 502" });
      },
      log: () => {},
      logError: () => {},
    });

    assert.equal(code, EXIT_UNMEASURED);
    assert.notEqual(EXIT_UNMEASURED, EXIT_VIOLATION);
  });

  it("⛔ an unmeasured run never prints a pass — the fail-closed property", () => {
    const out = capture();
    const err = capture();
    runGuard({
      repo: "o/r",
      ref: "master",
      fetch: () => {
        throw new Error("boom");
      },
      log: out.sink,
      logError: err.sink,
    });

    assert.deepEqual(out.lines, []);
    assert.match(err.lines.join("\n"), /DID NOT MEASURE/);
    assert.match(err.lines.join("\n"), /asserts nothing about the ref/);
  });

  it("⛔ EXIT_UNMEASURED stays non-zero, so the scheduled step still fails", () => {
    assert.notEqual(EXIT_UNMEASURED, 0);
  });

  it("reports a non-gh throw without a stderr as its message, not as empty", () => {
    const err = capture();
    runGuard({
      repo: "o/r",
      ref: "master",
      fetch: () => {
        throw new TypeError("x is not a function");
      },
      log: () => {},
      logError: err.sink,
    });

    assert.match(err.lines.join("\n"), /x is not a function/);
  });

  it("composes end to end: a 502 then a clean read exits 0 through the real retry", () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("Command failed"), { stderr: "gh: HTTP 502" });
      }
      return JSON.stringify({ errors: [] });
    };

    const code = runGuard({
      repo: "o/r",
      ref: "master",
      fetch: (repo, ref) => fetchCodeownersErrors(repo, ref, { run, retry: noSleepRetry }),
      log: () => {},
      logError: () => {},
    });

    assert.equal(code, 0);
    assert.equal(calls, 2);
  });
});

// PEN-6393. The gap this pins shut: `.github/**` code-owns the `secret_scan` lane
// that RUNS gitleaks, while the root-level files that can SWITCH IT OFF matched no
// rule at all — so an edit to the mechanism drew a reviewer and an edit to the
// allowlist drew nothing.
//
// ⚠ What a CODEOWNERS entry buys on this repository, so nobody reads this suite as
// proving more than it does: GitHub does not enforce CODEOWNERS here (there is no
// `require_code_owner_review`), so these rules are NOT a merge gate. They
// auto-request @kkroo, and the landing routine then holds the PR on that
// outstanding request rather than enqueuing it — a hold plus a named reviewer.
describe("secret-scan silencing paths stay code-owned (PEN-6393)", () => {
  // The one assertion about the real file. Deliberately the ONLY one: every
  // control below runs against the synthetic fixture instead, so that deleting a
  // rule from `.github/CODEOWNERS` reds exactly this test, naming the path that
  // lost its owner, rather than cascading through the controls as well.
  it("every file that can silence the secret-scan lane has an owner", () => {
    const codeowners = readFileSync(
      new URL("../.github/CODEOWNERS", import.meta.url),
      "utf8",
    );
    assert.deepEqual(uncoveredSecretScanPaths(codeowners), []);
  });

  // Pins the LIST, not just the lookup. Without this, the cheapest way to green a
  // failing run above is to delete the path from SECRET_SCAN_SILENCING_PATHS —
  // which silently shrinks the control instead of restoring it.
  it("pins the full set of silencing channels, so coverage cannot be narrowed quietly", () => {
    assert.deepEqual([...SECRET_SCAN_SILENCING_PATHS].sort(), [
      ".gitleaks-staging.toml",
      ".gitleaks.toml",
      ".gitleaksignore",
    ]);
  });
});

// ⛔ The controls for the check above. They run on a CONSTRUCTED fixture, never on
// `.github/CODEOWNERS`: a control whose baseline is the real file stops being a
// counter-example the moment that file changes, and then agrees with the subject
// for a reason that has nothing to do with the code under test.
describe("uncoveredSecretScanPaths", () => {
  const FIXTURE = [
    "# Code owners.",
    ".github/** @kkroo",
    "package.json @kkroo",
    ".gitleaks.toml @kkroo",
    ".gitleaks-staging.toml @kkroo",
    ".gitleaksignore @kkroo",
    "",
  ].join("\n");

  // The must-PASS arm. Without it, a function that reported every path as
  // uncovered would satisfy every must-FAIL arm below.
  it("reports nothing when all three paths are owned", () => {
    assert.deepEqual(uncoveredSecretScanPaths(FIXTURE), []);
  });

  it("⛔ reports a path whose rule was DELETED", () => {
    const mutated = FIXTURE.replace(/^\.gitleaks\.toml .*\n/m, "");
    // The tamper must actually tamper. A `replace` that matches nothing returns
    // its input unchanged, and the control then silently re-tests the must-pass
    // arm while still reporting as a control.
    assert.notEqual(mutated, FIXTURE, "control did not mutate the fixture");
    assert.deepEqual(uncoveredSecretScanPaths(mutated), [".gitleaks.toml"]);
  });

  it("⛔ reports a path whose rule was COMMENTED OUT", () => {
    const mutated = FIXTURE.replace(/^\.gitleaks-staging\.toml /m, "# .gitleaks-staging.toml ");
    assert.notEqual(mutated, FIXTURE, "control did not mutate the fixture");
    assert.deepEqual(uncoveredSecretScanPaths(mutated), [".gitleaks-staging.toml"]);
  });

  // Last-match-wins: an owner-less line for the same pattern REMOVES ownership.
  // Reading only the first match would score this as still covered.
  it("⛔ reports a path overridden by a later owner-less rule", () => {
    assert.deepEqual(uncoveredSecretScanPaths(`${FIXTURE}.gitleaksignore\n`), [
      ".gitleaksignore",
    ]);
  });

  it("⛔ reports all three when the rules are absent entirely", () => {
    assert.deepEqual(uncoveredSecretScanPaths(".github/** @kkroo\n"), [
      ".gitleaks.toml",
      ".gitleaks-staging.toml",
      ".gitleaksignore",
    ]);
  });

  it("is null-safe", () => {
    assert.deepEqual(uncoveredSecretScanPaths(null).length, 3);
  });
});

describe("parseCodeownersRules", () => {
  it("reads a pattern and its owners, numbering lines from 1", () => {
    assert.deepEqual(parseCodeownersRules("\n.gitleaks.toml @kkroo\n"), [
      { line: 2, pattern: ".gitleaks.toml", owners: ["@kkroo"] },
    ]);
  });

  it("keeps multiple owners in order", () => {
    assert.deepEqual(parseCodeownersRules("docs/** @a @b @org/team")[0].owners, [
      "@a",
      "@b",
      "@org/team",
    ]);
  });

  it("drops comments, trailing comments, and blank lines", () => {
    assert.deepEqual(parseCodeownersRules("# a comment\n\n   \nx @o # trailing"), [
      { line: 4, pattern: "x", owners: ["@o"] },
    ]);
  });

  // An owner-less rule is the mechanism CODEOWNERS uses to REMOVE ownership, so
  // discarding it here would make the coverage check blind to the override case.
  it("keeps an owner-less rule rather than discarding it", () => {
    assert.deepEqual(parseCodeownersRules("x"), [{ line: 1, pattern: "x", owners: [] }]);
  });

  it("is null-safe and tolerates CRLF", () => {
    assert.deepEqual(parseCodeownersRules(null), []);
    assert.deepEqual(parseCodeownersRules(undefined), []);
    assert.deepEqual(
      parseCodeownersRules("a @o\r\nb @o\r\n").map((rule) => rule.pattern),
      ["a", "b"],
    );
  });
});

describe("ownersForExactPattern", () => {
  const rules = parseCodeownersRules("a @first\nb @other\na @last\n");

  it("takes the LAST match, because CODEOWNERS is last-match-wins", () => {
    assert.deepEqual(ownersForExactPattern(rules, "a"), ["@last"]);
  });

  it("returns [] for a pattern with no rule", () => {
    assert.deepEqual(ownersForExactPattern(rules, "absent"), []);
  });

  // ⛔ Exact string equality, never a prefix or substring test: `.gitleaks.toml`
  // must not be credited to a rule written for `.gitleaks.toml.bak`.
  it("⛔ does not credit a different pattern that merely shares a prefix", () => {
    const near = parseCodeownersRules(".gitleaks.toml.bak @o\n");
    assert.deepEqual(ownersForExactPattern(near, ".gitleaks.toml"), []);
  });

  it("is null-safe", () => {
    assert.deepEqual(ownersForExactPattern(null, "a"), []);
  });
});
