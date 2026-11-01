#!/usr/bin/env node
// PEN-5186: the standing detector for residual 4 of §8 of
// `docs/security/PEN-5016-github-publish-broker-enablement-plan.md`.
//
// Usage: node scripts/check-git-egress-exec-closure-reread.mjs
//   env: PR_BASE_SHA, PR_HEAD_SHA  (the `policy` job already exports both)
//        REREAD_TODAY              (test seam; an ISO date, default now)
// Exit 0 = clear, 1 = a re-read is OWED, 2 = could not judge (NOT "clear").
//
// WHAT IT WATCHES
// ---------------
// §8 residual 4 is ONE residual naming TWO files:
//
//   packages/adapter-utils/src/github-git-egress-shim.ts      (`--no-textconv`)
//   packages/adapter-utils/src/github-git-egress-runtime.ts   (injected `core.hooksPath`)
//
// Two git config keys the agent owns in its own `.git/config` would reach an
// exec inside the container that holds the publish credential. Neither is in
// the broker's own `BROKER_INJECTED_GIT_CONFIG`; both are closed in these two
// files instead. §8's review trigger is therefore "2027-01-31, AND on any
// change to those two files" — and that second clause is live today, which is
// why this row was filed before stage 3 rather than after it.
//
// ⛔ The trigger is deliberately OVER-BROAD. The harm it proxies for is "a
// change silently re-opens an exec route", and the set of exec-reachable config
// keys is not enumerable — that is residual 1, "a list, not a proof", and this
// file must not be read as narrowing it. So the trigger fires on ANY change to
// either file, not on a change to the closures.
//
// WHY A COMMIT TRAILER AND NOT A PINNED DIGEST
// --------------------------------------------
// Measured 2026-11-01 over the files' whole history (they were created
// 2026-10-01): 21 commits touch at least one of them, 20 of those in the last
// 30 days — roughly five a week. A pinned digest at that rate would be a shared
// line two concurrent PRs both rewrite, so it would generate merge conflicts on
// a security guard, which is how a security guard gets deleted. A per-commit
// trailer has no shared line, cannot conflict, and carries the author's name
// and their words about THIS change, which a bumped digest does not.
//
// WHAT THE TRAILER IS AND IS NOT
// ------------------------------
// It is an attestation that a human re-read the exec-route question for this
// change. It is NOT the mechanical part: that the shim still passes
// `--no-textconv` on every content read, and that the runtime still injects
// `core.hooksPath` ahead of the subcommand, are pinned by assertions in
// `github-publish-broker-policy.test.ts` that fail on their own with no
// judgement required. This check carries only the part no assertion can hold —
// "did this change open a route nobody has enumerated".
//
// ⚠ A trailer is an attestation, which means it is exactly as good as the
// person who wrote it. It is not a proof and must not be described as one.
// Its value is that the attestation is RECORDED, per change, with a name on it.

import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The two files §8 residual 4 names. One residual, two files — not two residuals. */
export const WATCHED_PATHS = [
  "packages/adapter-utils/src/github-git-egress-shim.ts",
  "packages/adapter-utils/src/github-git-egress-runtime.ts",
];

/** The trailer a change to either file must carry. */
export const TRAILER = "Residual-4-Reread";

/**
 * §8's calendar review date, bound by the CTO 2026-10-30 (§11.5).
 *
 * `REVIEW_LAST_COMPLETED` is null because the review has never been performed —
 * this row is its first carrier. Discharging it is a two-line edit here by the
 * owner (Security) AFTER the review: set the completion date, and set the next
 * `REVIEW_DUE`. Leaving the completion date alone and moving `REVIEW_DUE` out is
 * the one edit that defeats the purpose, and it is the edit this comment exists
 * to make visible in a diff.
 */
export const REVIEW_DUE = "2027-01-31";
export const REVIEW_LAST_COMPLETED = null;

export const CLEAR = 0;
export const OWED = 1;
export const UNREADABLE = 2;

/** Which watched files a changed-path list touches. */
export function touchedWatchedPaths(changedPaths) {
  const set = new Set(changedPaths ?? []);
  return WATCHED_PATHS.filter((p) => set.has(p));
}

/**
 * Which watched files are NOT present in the tree at head.
 *
 * This is the arm that keeps the watch from dying quietly. Every other clause
 * here asks "did the watched files change"; none of them can tell that a
 * watched file is GONE — and a watch pointing at a path nothing occupies
 * reports clear forever, which is byte-identical to a clean repository. That
 * is the PEN-4988 failure this row exists not to repeat.
 *
 * ⛔ A trailer does NOT clear this. The trailer attests to a change; this says
 * the detector no longer knows where to look. The only fix is to re-point
 * `WATCHED_PATHS` at wherever the closure now lives — or, if the closure is
 * genuinely gone, to re-open residual 4 rather than delete the watch.
 *
 * `headPaths` is REQUIRED and has no default on purpose: any default would be
 * a value that reads as "present", and a guard that passes when it was never
 * given its input is the vacuous pin this same PR removed from
 * `github-publish-broker-policy.test.ts`.
 */
export function missingWatchedPaths(headPaths) {
  if (!Array.isArray(headPaths)) {
    throw new Error(`headPaths must be an array of paths at head; got ${headPaths}`);
  }
  const set = new Set(headPaths);
  return WATCHED_PATHS.filter((p) => !set.has(p));
}

/**
 * Trailer values present in a commit-message blob.
 *
 * Deliberately tolerant about WHERE the trailer sits (any line, any leading
 * whitespace, case-insensitive key) and strict about it having a value: a bare
 * `Residual-4-Reread:` with nothing after it attests to nothing, and accepting
 * it would make the check satisfiable by pasting a word with no thought behind
 * it — which is the failure this whole file is trying not to become.
 *
 * The emptiness test is `trim()` then `if (value)`, and that is the ONLY place
 * it lives. Spelling the capture `(.+?)` as well reads like a second guard and
 * is not one: measured against this regex, `Residual-4-Reread:` followed by
 * spaces still MATCHES under `(.+?)` — the greedy `[ \t]*` gives a space back
 * so the capture is non-empty. So `(.+?)` rejects nothing `trim()` does not
 * already reject, while making the real check look optional. One guard, named.
 */
export function rereadAttestations(commitMessages) {
  const found = [];
  for (const message of commitMessages ?? []) {
    const re = new RegExp(`^[ \\t]*${TRAILER}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, "gim");
    for (const match of String(message ?? "").matchAll(re)) {
      const value = match[1].trim();
      if (value) found.push(value);
    }
  }
  return found;
}

/**
 * Is the calendar review owed?
 *
 * `today < due` is clear. Once due, only a completion dated ON OR AFTER the due
 * date clears it — an older completion is a PREVIOUS review and says nothing
 * about this one. Dates compare as ISO strings, which is sound for the
 * zero-padded `YYYY-MM-DD` form and nothing else, so an unparseable date is
 * refused rather than silently compared.
 */
export function reviewOwed(today, due = REVIEW_DUE, lastCompleted = REVIEW_LAST_COMPLETED) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(String(today ?? "")) || !iso.test(String(due ?? ""))) {
    throw new Error(`dates must be YYYY-MM-DD; got today=${today} due=${due}`);
  }
  if (today < due) return false;
  if (lastCompleted == null) return true;
  if (!iso.test(String(lastCompleted))) {
    throw new Error(`REVIEW_LAST_COMPLETED must be YYYY-MM-DD or null; got ${lastCompleted}`);
  }
  return lastCompleted < due;
}

/** The whole verdict, as data, so the renderer and the tests read the same thing. */
export function evaluate({ changedPaths, commitMessages, today, headPaths }) {
  const touched = touchedWatchedPaths(changedPaths);
  const attestations = rereadAttestations(commitMessages);
  const trailerOwed = touched.length > 0 && attestations.length === 0;
  const calendarOwed = reviewOwed(today);
  // Deliberately NOT part of `trailerOwed`: an attestation cannot clear a stale
  // watch, so this arm stands on its own in the verdict.
  const missing = missingWatchedPaths(headPaths);
  const watchStale = missing.length > 0;
  return {
    touched,
    attestations,
    trailerOwed,
    calendarOwed,
    missing,
    watchStale,
    verdict: trailerOwed || calendarOwed || watchStale ? "owed" : "clear",
  };
}

export function renderReport(result, { base, head, today } = {}) {
  const lines = [
    "PEN-5186 — §8 residual 4 (exec routes closed outside the broker's own policy list)",
    `range          = ${base ?? "(unset)"}...${head ?? "(unset)"}`,
    `today          = ${today ?? "(unset)"}`,
    `watched        = ${WATCHED_PATHS.join(", ")}`,
    `touched        = ${result.touched.length ? result.touched.join(", ") : "(none)"}`,
    `attestations   = ${result.attestations.length}`,
    `missing_at_head= ${result.missing?.length ? result.missing.join(", ") : "(none)"}`,
    `review_due     = ${REVIEW_DUE}  last_completed = ${REVIEW_LAST_COMPLETED ?? "(never)"}`,
    `verdict        = ${result.verdict}`,
  ];

  if (result.trailerOwed) {
    lines.push(
      "",
      "A RE-READ IS OWED — this change touches a file that closes an exec route the",
      "publish broker depends on but does not state in its own policy list.",
      "",
      "Re-read the change and answer, in the trailer, the one question no assertion",
      "can hold for you: does anything here open a path from repository-owned git",
      "config to an exec inside the container that holds the publish credential?",
      "",
      "The two closures themselves are already pinned mechanically in",
      "packages/adapter-utils/src/github-publish-broker-policy.test.ts — if you broke",
      "one of those, that suite is red and this trailer is not the thing to fix.",
      "",
      `Add a trailer to any commit in this range (\`git commit --amend\` on the last one):`,
      "",
      `    ${TRAILER}: <what you checked, and what you concluded>`,
      "",
      "Context: docs/security/PEN-5016-github-publish-broker-enablement-plan.md §8,",
      "carrier row PEN-5186.",
    );
  }

  if (result.watchStale) {
    lines.push(
      "",
      "THIS CHECK HAS STOPPED WATCHING SOMETHING — a watched file is not present at",
      `head: ${result.missing.join(", ")}`,
      "",
      "Either it moved, or it was deleted. Both are changes to a file that closes an",
      "exec route, and neither is cleared by a trailer: a trailer attests to a change,",
      "while this says the detector no longer knows where to look.",
      "",
      "If the closure MOVED, re-point WATCHED_PATHS in",
      "scripts/check-git-egress-exec-closure-reread.mjs at its new home, and check that",
      "the mechanical pins in",
      "packages/adapter-utils/src/github-publish-broker-policy.test.ts moved with it.",
      "",
      "If the closure is GONE, residual 4 is re-opened and PEN-5186 is the row to say",
      "so on. Deleting the watch is not the remedy for the thing it watches going away.",
    );
  }

  if (result.calendarOwed) {
    lines.push(
      "",
      `THE ${REVIEW_DUE} REVIEW IS DUE and has not been recorded.`,
      "",
      "All four §8 residuals are due for re-read, by Security, on PEN-5186. Residual 1",
      "is re-read as A LIST OF VECTORS CLOSED — §8 forbids promoting it to a proof that",
      "no other git config key can reach an exec during a publish, and the re-read must",
      "not be written up as one.",
      "",
      "After the review, record it in scripts/check-git-egress-exec-closure-reread.mjs:",
      "set REVIEW_LAST_COMPLETED to the date it was done and REVIEW_DUE to the next one.",
    );
  }

  return lines.join("\n");
}

function readRange(base, head) {
  // `--no-renames` is load-bearing, not tidiness. Rename detection is ON by
  // default (`diff.renames`, since git 2.9), and under it a renamed watched
  // file is reported ONLY at its new path — so the old path never appears,
  // `touchedWatchedPaths` returns empty, and the move sails through with no
  // attestation. With `--no-renames` the same move is a delete plus an add, the
  // watched path appears, and the per-change arm fires as it should.
  const changedPaths = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", `${base}...${head}`],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Which of the watched paths actually exist at head, so one that has been
  // moved or deleted cannot leave this check watching an address with nothing
  // at it. Pathspec-limited rather than a whole-tree listing: the repo is ~5.7k
  // entries and only two of them are the question being asked.
  const headPaths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", head, "--", ...WATCHED_PATHS],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // %B is the raw body, and the NUL delimiter keeps a message containing the
  // separator from splitting into two.
  const log = execFileSync("git", ["log", "--format=%B%x00", `${base}..${head}`], {
    encoding: "utf8",
  });
  const commitMessages = log.split("\0").map((m) => m.trim()).filter(Boolean);
  return { changedPaths, commitMessages, headPaths };
}

async function main() {
  const base = process.env.PR_BASE_SHA;
  const head = process.env.PR_HEAD_SHA;
  const today = (process.env.REREAD_TODAY || new Date().toISOString().slice(0, 10)).trim();

  // The calendar arm needs no range, so it is evaluated even when the range is
  // unreadable. A missing range must never read as "nothing changed" — that is
  // the one failure that would make this check silently stop watching.
  let range = null;
  let rangeError = null;
  if (base && head) {
    try {
      range = readRange(base, head);
    } catch (error) {
      rangeError = error.message;
    }
  } else {
    rangeError = `PR_BASE_SHA/PR_HEAD_SHA unset (base=${base ?? "(unset)"} head=${head ?? "(unset)"})`;
  }

  if (!range) {
    let calendarOwed;
    try {
      calendarOwed = reviewOwed(today);
    } catch (error) {
      console.error(`::error::${error.message}`);
      process.exit(UNREADABLE);
    }
    console.error(`::error::cannot read the commit range, so the per-change arm could not run: ${rangeError}`);
    if (calendarOwed) {
      console.log(renderReport({ touched: [], attestations: [], trailerOwed: false, calendarOwed, verdict: "owed" }, { base, head, today }));
    }
    process.exit(UNREADABLE);
  }

  let result;
  try {
    result = evaluate({ ...range, today });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(UNREADABLE);
  }

  console.log(renderReport(result, { base, head, today }));
  process.exit(result.verdict === "clear" ? CLEAR : OWED);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
