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
 * this row is its first carrier. Discharging it is a THREE-line edit here by the
 * owner (Security) AFTER the review: set the completion date, set the next
 * `REVIEW_DUE`, and move `REVIEW_NOTICE` along with it. Leaving the completion
 * date alone and moving `REVIEW_DUE` out is the one edit that defeats the
 * purpose, and it is the edit this comment exists to make visible in a diff.
 *
 * ⚠ Three constants is three things to get wrong, so note which way each fails.
 * Forgetting `REVIEW_NOTICE` strands it in the past, and the advisory warning
 * then fires on every run from that edit to the new `REVIEW_DUE` — the stranded
 * window swallows the next one rather than ending before it, so there is no
 * quiet interval in between. Loud, harmless, and obviously wrong to anyone who
 * reads it. Forgetting `REVIEW_LAST_COMPLETED` is the silent one, which is why
 * it is named first above. The remaining ordering mistake is enforced rather
 * than trusted: see `reviewNoticeDue`.
 */
export const REVIEW_DUE = "2027-01-31";
export const REVIEW_LAST_COMPLETED = null;

/**
 * When the advisory notice starts, ahead of `REVIEW_DUE`. Added at the CTO's ask
 * on PEN-5186 2026-11-02, with the gate itself left exactly as merged.
 *
 * The gate guarantees the review happens eventually. It does nothing to make it
 * happen before it costs anyone anything, and a repo-wide freeze that arrives
 * with no warning is the version of this that gets the step deleted rather than
 * discharged. So this prints `::warning::` for the window before the due date
 * and leaves every exit code alone. 2026-12-15 gives 47 days of yellow on every
 * `policy` run before the hard stop. (Setting it on or after `REVIEW_DUE` is
 * refused outright — see `reviewNoticeDue`.)
 *
 * Explicit ISO, not derived from `REVIEW_DUE`. This file compares dates as ISO
 * strings on purpose and holds no date arithmetic anywhere; adding some here to
 * save one constant would put the single unreviewable thing in the file into the
 * arm whose entire job is to be read by someone who has not seen it before.
 */
export const REVIEW_NOTICE = "2026-12-15";

export const CLEAR = 0;
export const OWED = 1;
export const UNREADABLE = 2;

/**
 * Output ceiling for the two per-commit reads, well above Node's 1 MiB default.
 * `git log --name-only` over a long range is much larger than the `%B` read it
 * sits beside; this is a reporting ceiling, not a safety one, since the `try`
 * in `readRange` contains an overrun either way.
 */
const PER_COMMIT_MAX_BUFFER = 64 * 1024 * 1024;

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
 * Which commits in the range touch a watched file, and which of those carry a
 * trailer of their own.
 *
 * INFORMATIONAL. It reaches no verdict and changes no exit code — `trailerOwed`
 * is unchanged and still clears on ONE attestation anywhere in the range. That
 * is deliberate and is not an oversight to be tightened later:
 *
 *  - A per-commit REQUIREMENT would red on the better behaviour. Measured on
 *    PR #3336 (2026-11-03): two commits both touched
 *    `github-git-egress-runtime.ts`, one carried the trailer, and that trailer
 *    said "re-read BOTH runtime changes in this range" and named each. One
 *    attestation reasoning about the combined change is worth more than two
 *    narrow ones, and a security guard that reds on the right answer is a
 *    security guard somebody deletes.
 *  - It would also be satisfiable by pasting the same trailer onto every
 *    commit, which adds mechanical compliance and no thought — the exact
 *    failure `rereadAttestations` is written to refuse.
 *
 * What was actually missing is that NOTHING anywhere said the range had two
 * touching commits and one attestation. The attester could not see what their
 * trailer had to cover, and a reviewer could not check that it did. So this arm
 * states that, and leaves the judgement where it already was.
 *
 * ⚠ It is NOT a decomposition of the range-wide `touched` arm and must not be
 * read as one. `touched` comes from `git diff base...head` (three-dot, the
 * merge-base diff); this reads `git log base..head` (two-dot), the same commit
 * set `commitMessages` already uses, so the attestation count and the per-commit
 * list can never disagree about which commits were considered. Merge commits
 * carry no file list under `git log --name-only`, so a path arriving only
 * through a merge appears in `touched` and in no row here. `touched` is the
 * authoritative per-change arm; this one is the coverage note beside it.
 */
export function touchingCommits(commits) {
  if (!Array.isArray(commits)) {
    throw new Error(`commits must be an array of {sha, message, paths}; got ${commits}`);
  }
  return commits
    .map((commit) => ({
      sha: String(commit?.sha ?? ""),
      touched: touchedWatchedPaths(commit?.paths),
      attested: rereadAttestations([commit?.message]).length > 0,
    }))
    .filter((commit) => commit.touched.length > 0);
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

/**
 * Is the advisory notice window open? `REVIEW_NOTICE <= today < REVIEW_DUE`.
 *
 * It closes ON the due date, deliberately: from there the calendar arm reds, and
 * a warning riding alongside a failure is noise that teaches people to skim the
 * annotation that matters.
 *
 * ⛔ This arm never reaches the verdict, and never changes the exit code of a
 * correctly configured file. It is a notice. If it ever gains one, it has
 * become a second gate nobody agreed to.
 *
 * `notice >= due` is REFUSED rather than compared, because it is the only way to
 * misconfigure these three constants that fails silent: the window is empty, no
 * warning ever fires, and the result is byte-identical to a correct file in a
 * year with nothing due. Every other mistake here is loud.
 *
 * ⚠ That refusal THROWS, and both `main` paths route the throw to UNREADABLE —
 * exit 2, which is not the clear bucket. So the sentence above is scoped to a
 * correctly configured file on purpose, and the two statements do not conflict:
 * a misconfigured constant is refused, it is not the notice gating. Do NOT
 * delete the throw to make a comment read more simply — a guard removed to
 * satisfy its own docstring is this file's whole subject matter.
 */
export function reviewNoticeDue(today, notice = REVIEW_NOTICE, due = REVIEW_DUE) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(String(today ?? "")) || !iso.test(String(notice ?? "")) || !iso.test(String(due ?? ""))) {
    throw new Error(`dates must be YYYY-MM-DD; got today=${today} notice=${notice} due=${due}`);
  }
  if (notice >= due) {
    throw new Error(`REVIEW_NOTICE must be strictly before REVIEW_DUE; got notice=${notice} due=${due}`);
  }
  return today >= notice && today < due;
}

/** The whole verdict, as data, so the renderer and the tests read the same thing. */
export function evaluate({ changedPaths, commitMessages, today, headPaths, commits }) {
  const touched = touchedWatchedPaths(changedPaths);
  const attestations = rereadAttestations(commitMessages);
  const trailerOwed = touched.length > 0 && attestations.length === 0;
  // `null` when the caller supplied no per-commit input, so the report can say
  // "(not measured)" rather than "(none)". Collapsing those two is how a report
  // asserts a clean read that nothing performed, and this file refuses that
  // everywhere else — see `fieldOrUnmeasured`.
  const perCommit = commits == null ? null : touchingCommits(commits);
  const calendarOwed = reviewOwed(today);
  // Advisory only, and deliberately absent from `verdict` below — the ask was a
  // notice arm with no exit-code change, and this is the line that keeps it one.
  const noticeDue = reviewNoticeDue(today);
  // Deliberately NOT part of `trailerOwed`: an attestation cannot clear a stale
  // watch, so this arm stands on its own in the verdict.
  const missing = missingWatchedPaths(headPaths);
  const watchStale = missing.length > 0;
  return {
    touched,
    attestations,
    trailerOwed,
    calendarOwed,
    noticeDue,
    missing,
    watchStale,
    perCommit,
    // Informational, and deliberately absent from `verdict` below — the same
    // line that keeps `noticeDue` a notice keeps this one a note.
    //
    // The predicate is exactly "a commit touched a watched file and did not
    // attest to it", with no clause about how many commits are in the range. An
    // earlier draft also required MORE THAN ONE touching commit, on the theory
    // that a single commit could have nothing to say. That was wrong, and a
    // mutation test is what showed it: with one touching commit whose trailer
    // sits on a DIFFERENT commit, the extra clause suppressed the note on the
    // one shape where the coverage question is sharpest. The fully-covered
    // cases are already quiet without it, because `some` is false there.
    coverageUnstated: perCommit != null && perCommit.some((c) => !c.attested),
    verdict: trailerOwed || calendarOwed || watchStale ? "owed" : "clear",
  };
}

/**
 * Render a list-valued arm: `null` = the arm did not run, `[]` = it ran and
 * found nothing. Collapsing those two is how a report lies about a check that
 * never happened, so they get different words.
 */
function fieldOrUnmeasured(value) {
  if (value == null) return "(not measured)";
  return value.length ? value.join(", ") : "(none)";
}

export function renderReport(result, { base, head, today } = {}) {
  const lines = [
    "PEN-5186 — §8 residual 4 (exec routes closed outside the broker's own policy list)",
    `range          = ${base ?? "(unset)"}...${head ?? "(unset)"}`,
    `today          = ${today ?? "(unset)"}`,
    `watched        = ${WATCHED_PATHS.join(", ")}`,
    // EVERY measured field distinguishes "(not measured)" from "(none)"/0. The
    // unreadable-range path renders a result whose per-change and staleness arms
    // never ran, and a report that prints "(none)" there asserts a clean read
    // that nothing performed — the false-clear shape this whole file exists to
    // avoid. `null` means the arm did not run; `[]` means it ran and found
    // nothing. The two must never render the same.
    `touched        = ${fieldOrUnmeasured(result.touched)}`,
    `attestations   = ${result.attestations == null ? "(not measured)" : result.attestations.length}`,
    // Which commits the one attestation count above had to cover. Nothing in
    // this report said that before PEN-5186's 2026-11-08 re-read, so an
    // attester could not see the range their trailer was clearing and a
    // reviewer could not check that it covered it.
    `touched_commits= ${
      result.perCommit == null
        ? "(not measured)"
        : result.perCommit.length === 0
          ? "(none)"
          : result.perCommit
              .map((c) => `${c.sha.slice(0, 9)} [${c.attested ? "trailer" : "no trailer"}]`)
              .join(", ")
    }`,
    `missing_at_head= ${fieldOrUnmeasured(result.missing)}`,
    `review_due     = ${REVIEW_DUE}  last_completed = ${REVIEW_LAST_COMPLETED ?? "(never)"}`,
    `review_notice  = ${REVIEW_NOTICE}`,
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

  if (result.coverageUnstated) {
    const bare = result.perCommit.filter((c) => !c.attested).map((c) => c.sha.slice(0, 9));
    lines.push(
      "",
      `NOTE — ${result.perCommit.length} commit(s) in this range touch a watched file.`,
      `These carry no trailer of their own: ${bare.join(", ")}.`,
      "",
      "Nothing is owed and nothing is blocked: one trailer anywhere in the range",
      "clears this check, on purpose. A single attestation that reasons about the",
      "combined change is worth more than one pasted onto each commit, so this is a",
      "note and not a second gate.",
      "",
      "It is here because the attestation is only sound if it COVERS the range, and",
      "that is the one thing no assertion can check. If you wrote the trailer, say",
      "which commits you read. If you are reviewing, this is the line that tells you",
      "what the attestation had to cover.",
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
      "After the review, record it in scripts/check-git-egress-exec-closure-reread.mjs.",
      "It is a THREE-line edit: REVIEW_LAST_COMPLETED to the date the review was done,",
      "REVIEW_DUE to the next one, and REVIEW_NOTICE ahead of that. Moving REVIEW_DUE",
      "alone is the edit that defeats the purpose; leaving REVIEW_NOTICE in the past",
      "clears this freeze but warns on every run from the edit to the new REVIEW_DUE.",
    );
  }

  if (result.noticeDue) {
    lines.push(
      "",
      `THE ${REVIEW_DUE} REVIEW IS APPROACHING. This is a NOTICE — nothing is blocked by`,
      "it, and it changes no exit code.",
      "",
      "It is here so the review can be done while it still costs nothing. From",
      `${REVIEW_DUE} this same check reds on every PR and every merge group in the`,
      "repository until Security records the review, and a freeze that arrives with no",
      "warning is the version of this that gets the step deleted instead of discharged.",
      "",
      "All four §8 residuals are due for re-read, by Security, on PEN-5186. Residual 1",
      "is re-read as A LIST OF VECTORS CLOSED — §8 forbids promoting it to a proof that",
      "no other git config key can reach an exec during a publish.",
      "",
      "Recording it is a three-line edit in",
      "scripts/check-git-egress-exec-closure-reread.mjs: REVIEW_LAST_COMPLETED to the",
      "date the review was done, REVIEW_DUE to the next one, REVIEW_NOTICE ahead of",
      "that. Moving REVIEW_DUE alone is the edit that defeats the purpose.",
    );
  }

  return lines.join("\n");
}

/**
 * The advisory annotation.
 *
 * ONE line, and that is a constraint rather than a style choice: a `::warning::`
 * is terminated by the newline, so a multi-line message delivers only its first
 * line to the Actions UI and silently drops the rest. The detail lives in the
 * report, which is printed in full; this is the part that has to survive being
 * rendered as a single annotation.
 */
function emitReviewNotice(noticeDue) {
  if (!noticeDue) return;
  console.error(
    `::warning::PEN-5186: the ${REVIEW_DUE} re-read of the four §8 residuals is not yet ` +
      "recorded. This is advisory and blocks nothing today. From " +
      `${REVIEW_DUE} this check reds on every PR and merge group until Security records ` +
      "it in scripts/check-git-egress-exec-closure-reread.mjs (REVIEW_LAST_COMPLETED, " +
      "REVIEW_DUE, REVIEW_NOTICE).",
  );
}

/**
 * Flatten derived text so it cannot forge a GitHub Actions workflow command.
 *
 * ⛔ A WORKFLOW COMMAND IS RECOGNISED PER LINE, so any newline inside a string
 * interpolated into a `::warning::` or `::error::` ends that annotation and
 * lets whatever follows be read as a new command. Three of the four call sites
 * below interpolate a message derived from git — and after this PR added a
 * per-commit read, one of them could carry a COMMIT MESSAGE, which is
 * author-controlled and may contain anything but NUL.
 *
 * Measured at `42cca946`, before this: a commit whose message was
 * `\n::error::INJ-SENTINEL\n\x01x` made the parser throw with the body in the
 * error, and the policy job's log received `::error::INJ-SENTINEL` as a command
 * of its own — from a commit touching no watched file. The NUL framing and the
 * containment beside it already keep a commit message out of every annotation;
 * this is the second layer, so that a message reaching one is merely ugly.
 *
 * Applied to the pre-existing `::error::` sites too. They carry git's stderr
 * rather than a commit message and were not reachable this way on `master`, but
 * one sanitised site beside three bare ones reads as though the other three had
 * been examined and cleared. It changes no verdict and no exit code.
 *
 * ONE `\\s+` collapse does the whole job, and the redundant
 * `[\\r\\n\\u2028\\u2029]+` pass that stood here first is deliberately gone: JS
 * `\\s` is WhiteSpace PLUS LineTerminator, so it already matches `\\r`, `\\n` and
 * U+2028/U+2029 — the two this repo's own review-gate readers disagree about.
 * Deleting it was not tidying. With both passes present, removing either one
 * left the test GREEN, so neither was pinned and the suite would have accepted
 * a build with no sanitiser reachable by that case at all. A guard that two
 * mechanisms both satisfy is a guard no mutation can red.
 */
export function forAnnotation(text, limit = 300) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Split a NUL-delimited `git log --format=%B%x00` blob into one message per
 * commit, IN TRAVERSAL ORDER AND WITHOUT DROPPING ANY.
 *
 * Separate from the `commitMessages` read in `readRange`, which filters empty
 * messages out, because this list is ZIPPED BY INDEX against the per-commit
 * log below and a filtered list desynchronises it. `git commit
 * --allow-empty-message` is accepted by git, so an empty message is an input an
 * author can actually produce — and silently shifting every later message onto
 * the wrong commit is exactly the misattribution this arm must not invent.
 *
 * `%B%x00` emits `<body>NUL` per commit and git writes its own newline between
 * records, so the field after the final NUL is always that trailing newline and
 * is always dropped. An empty range yields one empty field and therefore no
 * messages, which is the right answer rather than an error.
 */
export function parseCommitMessageLog(text) {
  const fields = String(text ?? "").split("\0");
  fields.pop();
  return fields.map((m) => m.trim());
}

/**
 * Split one `git log -z --name-only --format=%x00%H` blob into commits and zip
 * each with its message.
 *
 * Separate and exported because it is the one piece of `readRange` that can
 * fail SILENTLY. The git invocations around it fail loudly — a bad revision is
 * a non-zero exit — whereas a parser that does not recognise a chunk can simply
 * return fewer commits than the range holds, and a short list renders as a
 * shorter coverage note that looks exactly like a well-covered range. So an
 * unrecognised field THROWS rather than being skipped, and `readRange` contains
 * that throw rather than letting it reach the verdict.
 *
 * ⚠ NUL IS THE DELIMITER BECAUSE IT IS THE ONLY BYTE GIT REFUSES. An earlier
 * version framed this read with `\x01`/`\x02`/`\x03` on the premise that those
 * are "bytes a commit message cannot carry". That premise is FALSE: git rejects
 * NUL in a message and nothing else, so an author could write `\x01` into a body
 * and split their own chunk (which threw, and the throw reached the exit code),
 * or write `\x03<40-hex>\x02` and have their file list reported under a sha they
 * invented (which did not throw at all). Both are closed here by construction
 * rather than by validation: THIS READ CARRIES NO MESSAGE. `--format=%x00%H`
 * emits only an empty field and a hash, `-z` makes `--name-only` NUL-terminate
 * its paths, and the messages arrive from a separate `%B%x00` read. The only
 * author-controlled bytes left in this blob are pathnames, and a pathname can
 * neither contain a NUL nor be empty — so an empty field unambiguously starts a
 * record, and one commit's paths can never run into the next commit's hash.
 */
export function parsePerCommitLog(text, messages) {
  if (!Array.isArray(messages)) {
    throw new Error(`per-commit messages must be an array; got ${messages}`);
  }
  const fields = String(text ?? "").split("\0");
  // The blob ends with the last record's terminating NUL, so the field after it
  // is always empty and is never a record of its own. An empty range is the
  // empty string, which splits to one empty field and yields no commits.
  fields.pop();
  const commits = [];
  let i = 0;
  while (i < fields.length) {
    if (fields[i] !== "") {
      throw new Error(`could not parse the per-commit log near: ${fields[i].slice(0, 80)}`);
    }
    i += 1;
    const sha = String(fields[i] ?? "").trim();
    // A pathname that happens to be 40 hex characters must never be mistaken
    // for the next record's hash, which is why the record boundary is the empty
    // field above and this is only a shape check on what follows it.
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(
        `could not parse the per-commit log near: ${String(fields[i] ?? "").slice(0, 80)}`,
      );
    }
    i += 1;
    const paths = [];
    while (i < fields.length && fields[i] !== "") {
      // git writes one newline between the format output and the first path.
      // Only that separator is stripped: a path is kept whole, embedded
      // newlines included, because splitting on them would turn one oddly named
      // file into several that match nothing.
      paths.push(fields[i].replace(/^\n+/, ""));
      i += 1;
    }
    commits.push({ sha, message: "", paths: paths.filter(Boolean) });
  }
  if (commits.length !== messages.length) {
    throw new Error(
      `the per-commit log and the message read disagree: ${commits.length} commit(s) vs ${messages.length} message(s)`,
    );
  }
  return commits.map((commit, idx) => ({ ...commit, message: messages[idx] }));
}

/**
 * Exported for the scratch-repo test below it in
 * `check-git-egress-exec-closure-reread.test.mjs`. Everything this function
 * does is a git invocation, so its flags cannot be covered by the pure-function
 * cases: `--no-renames`, `--full-tree` and the per-commit delimiter parser were
 * each justified in a comment and verified by hand, which is an argument rather
 * than a test. A mutation that drops `--no-renames` from the per-commit log
 * survived the whole suite until this was exported.
 *
 * `cwd` defaults to the process working directory, which is exactly how CI
 * invokes this (from the repo root). It is a parameter only so the test can
 * point it at a scratch repository without `process.chdir`, which is global
 * state shared with every other case in the file.
 *
 * `maxBuffer` is a parameter for the same reason and no other: it is the one
 * way a test can force the per-commit read to fail on a repository that is
 * otherwise perfectly readable, which is what pins the containment below — the
 * authoritative arms still read, and only the coverage note goes unmeasured. A
 * `try` whose catch no test can reach is an argument, not a guard.
 */
export function readRange(
  base,
  head,
  { cwd = process.cwd(), maxBuffer = PER_COMMIT_MAX_BUFFER } = {},
) {
  // `--no-renames` is load-bearing, not tidiness. Rename detection is ON by
  // default (`diff.renames`, since git 2.9), and under it a renamed watched
  // file is reported ONLY at its new path — so the old path never appears,
  // `touchedWatchedPaths` returns empty, and the move sails through with no
  // attestation. With `--no-renames` the same move is a delete plus an add, the
  // watched path appears, and the per-change arm fires as it should.
  const changedPaths = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", `${base}...${head}`],
    { cwd, encoding: "utf8" },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Which of the watched paths actually exist at head, so one that has been
  // moved or deleted cannot leave this check watching an address with nothing
  // at it. Pathspec-limited rather than a whole-tree listing: the repo is ~5.7k
  // entries and only two of them are the question being asked.
  //
  // `--full-tree` is required for correctness, not tidiness. `ls-tree` resolves
  // pathspecs RELATIVE TO THE CURRENT DIRECTORY, while `git diff --name-only`
  // always prints repo-root paths -- so without it the two reads disagree on
  // path base and running this from a subdirectory matches nothing, which the
  // staleness arm would report as both watched files missing. Measured from
  // `scripts/`: no flag yields [], `--full-tree` yields the path. The failure
  // is closed (a false red, not a false green), but a security guard that
  // reds spuriously is a security guard someone deletes.
  const headPaths = execFileSync(
    "git",
    ["ls-tree", "-r", "--full-tree", "--name-only", head, "--", ...WATCHED_PATHS],
    { cwd, encoding: "utf8" },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // %B is the raw body, and the NUL delimiter keeps a message containing the
  // separator from splitting into two.
  const log = execFileSync("git", ["log", "--format=%B%x00", `${base}..${head}`], {
    cwd,
    encoding: "utf8",
  });
  const commitMessages = log.split("\0").map((m) => m.trim()).filter(Boolean);
  // The same two-dot commit set, split per commit with its own file list, for
  // the coverage note.
  //
  // ⛔ EVERY FAILURE IN HERE IS CONTAINED, AND THAT IS THE POINT OF THE `try`.
  // The coverage note is informational — it never feeds `verdict` — so it must
  // never be able to change an exit code either, and before this `try` it
  // could: a throw from the parser propagated out of `readRange`, `main` read
  // that as an unreadable range, and a run that `master` exits 1 (owed) or 0
  // (clear) exited 2 (UNREADABLE) instead. Any author could reach it, from a
  // commit that touches no watched file at all. `null` lands in the
  // `(not measured)` state this arm already renders, which is the honest answer
  // and leaves `touched`, `attestations`, `trailerOwed` and `verdict` reading
  // exactly as they did before this arm existed.
  //
  // `maxBuffer` is raised off Node's 1 MiB default because `--name-only` over a
  // long range (a branch that merged a newer `master` while `PR_BASE_SHA` is
  // older) is far larger than the `%B` read beside it, and ENOBUFS here would
  // otherwise be one more way an informational line takes the check down. The
  // `try` covers it regardless; the ceiling is so the common case still reports.
  //
  // `--no-renames` for the same reason it is on the diff above — under rename
  // detection a moved watched file is reported only at its new path, and the
  // move would show no touching commit at all.
  let commits = null;
  let commitsError = null;
  try {
    const perCommitLog = execFileSync(
      "git",
      ["log", "--no-renames", "--name-only", "-z", "--format=%x00%H", `${base}..${head}`],
      { cwd, encoding: "utf8", maxBuffer },
    );
    // Deliberately a SECOND read rather than a reuse of `commitMessages` above:
    // that list drops empty messages, and zipping a filtered list by index
    // attributes every later message to the wrong commit.
    const perCommitMessages = execFileSync(
      "git",
      ["log", "--format=%B%x00", `${base}..${head}`],
      { cwd, encoding: "utf8", maxBuffer },
    );
    commits = parsePerCommitLog(perCommitLog, parseCommitMessageLog(perCommitMessages));
  } catch (error) {
    commitsError = error.message;
  }
  return { changedPaths, commitMessages, headPaths, commits, commitsError };
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
    let noticeDue;
    try {
      calendarOwed = reviewOwed(today);
      noticeDue = reviewNoticeDue(today);
    } catch (error) {
      console.error(`::error::${forAnnotation(error.message)}`);
      process.exit(UNREADABLE);
    }
    console.error(
      "::error::cannot read the commit range, so the per-change arm could not run: " +
        forAnnotation(rangeError),
    );
    if (calendarOwed) {
      console.log(renderReport({ touched: null, attestations: null, trailerOwed: false, calendarOwed, noticeDue, missing: null, watchStale: false, perCommit: null, coverageUnstated: false, verdict: "owed" }, { base, head, today }));
    }
    emitReviewNotice(noticeDue);
    process.exit(UNREADABLE);
  }

  let result;
  try {
    result = evaluate({ ...range, today });
  } catch (error) {
    console.error(`::error::${forAnnotation(error.message)}`);
    process.exit(UNREADABLE);
  }

  console.log(renderReport(result, { base, head, today }));
  // A contained per-commit failure is said out loud and nowhere else. It is a
  // warning rather than an error precisely because it changes no verdict: the
  // report already reads `touched_commits= (not measured)`, and the exit code
  // below is the one `master` would have produced.
  if (range.commitsError) {
    console.error(
      "::warning::PEN-5186: the per-commit coverage note could not be measured and reads " +
        `"(not measured)". This is informational and changes no verdict or exit code: ${forAnnotation(range.commitsError)}`,
    );
  }
  emitReviewNotice(result.noticeDue);
  process.exit(result.verdict === "clear" ? CLEAR : OWED);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
