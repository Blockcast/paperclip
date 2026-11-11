#!/usr/bin/env node
/**
 * check-script-test-registration.mjs
 *
 * `.github/workflows/pr.yml` invokes script tests BY LITERAL NAME. There is no
 * glob over `scripts/`, so a `*.test.mjs` file is run only if someone wrote a
 * step for it -- and nothing noticed when they did not. Such a file still
 * exists, still passes locally, still reads as covered in review, and is never
 * executed by CI again. It is a test-shaped file, not a test.
 *
 * PEN-5272 measured the gap on master @ 269bdc0d: of 132 candidate files under
 * `scripts/**` and `.github/scripts/**`, 27 were reachable from no workflow and
 * no workflow-invoked root npm script. Three of the 27 had exactly one in-tree
 * reference each and all three were PROSE -- a runbook line, a sibling test's
 * comment, a doc paragraph. Being documented as runnable is the failure mode,
 * not the exception to it: `scripts/security-audit-overrides.test.js` carries a
 * comment reading "This file is referenced by no workflow", and had rotted red
 * against a dependency dropped out of the lockfile without anyone finding out.
 *
 * The population is drifting in one direction. Registration is a separate,
 * forgettable act from writing the test, performed in a different file, and its
 * omission produces no symptom -- every required check stays green. That is the
 * shape of a defect a guard can hold and a reviewer cannot.
 *
 * REACHABILITY, defined so the verdict is falsifiable. A file is reachable iff
 * its repo-relative path appears as a WHOLE COMMAND TOKEN in:
 *
 *   (a) the body of a `run:` STEP in some `.github/workflows/*.y{a,}ml`, with
 *       comments stripped (whole-line and inline) and action `with:` inputs
 *       excluded; or
 *   (b) the body of a root `package.json` script transitively reachable from
 *       one such `run:` body (`pnpm run X` / `pnpm X` / `npm run X` / `yarn X`).
 *
 * Four deliberate narrowings, each of which closes a way this guard could pass
 * a file CI never runs. All four were measured against the tree before being
 * adopted, and all four cost NOTHING: 134 of 134 reachable files satisfy the
 * strict form.
 *
 *   - WHOLE TOKEN, not substring. `text.includes(basename)` fails OPEN for any
 *     unregistered test whose name is a suffix of a registered one: with
 *     `check-pr-template.test.mjs` registered, an unrun `scripts/pr-template.
 *     test.mjs` reads as reachable. That is this guard's own defect class, and
 *     the population is full of suffix-shaped names (`*-security-override.
 *     test.js`, `check-pr-*.test.mjs`). The same hazard exists one level up at
 *     path level (`scripts/tests/x` inside `.github/scripts/tests/x`); there
 *     are no such pairs today, but tokenizing removes the class rather than the
 *     instance. Found by Ally on PR #3275 with a working reproduction.
 *   - `run:` BODIES ONLY, not whole workflow text. Otherwise `- name: Test
 *     foo.test.mjs` with `run: echo skipped` registers nothing and still reads
 *     as reachable. Only a command can run a test, so only commands count.
 *   - COMMENTS STRIPPED, whole-line AND inline. A file named in a `#` comment
 *     is documented, not run, and being documented as runnable is PEN-5272's
 *     failure mode rather than an exception to it. `run: echo hi # scripts/a.
 *     test.mjs` runs nothing, so the trailing path is not a registration; a
 *     path BEFORE the `#` still is, because that half is real shell. Found by
 *     Ally on PR #3275, fixed under PEN-5282.
 *   - STEP COMMANDS ONLY, not action inputs. A `run:` nested under `with:` is
 *     an INPUT to an action, not a shell command -- the action decides whether
 *     it ever runs, and most never run it as one. A line-based scan cannot tell
 *     the two apart by name, so it tells them apart by INDENT: a `run:` deeper
 *     than the nearest enclosing `with:` is an input and is skipped. Also found
 *     by Ally on PR #3275, fixed under PEN-5282.
 *
 *     RECOGNISING the `with:` is the whole of this narrowing, and FOUR shapes
 *     of it were missed at first -- each one re-opening the hole completely:
 *     `with: # inputs` (a trailing comment), `- with:` (`with` as a step
 *     item's opening key), `with: {` (a multi-line flow mapping, inputs on
 *     the lines below), and a `with:` nested INSIDE a `with:` block (an input
 *     literally named `with`). Ally found the first two on PR #3281 and the
 *     fourth on its follow-up head; the third came from probing the mutant
 *     the first of those reviews left surviving.
 *
 *     So the pattern is unanchored on the right, tolerant of a leading `- `,
 *     anchored on the column of the `with` TOKEN rather than of the dash --
 *     a step's own keys sit at the token column, so the dash column would skip
 *     a REAL step `run:` written there -- and it keeps the OUTERMOST anchor,
 *     never moving it inward. The first three fail open by not recognising a
 *     `with:` at all; the fourth is subtler, and worth keeping in mind before
 *     touching this: the anchor IS set throughout, it just points at the inner
 *     block, so the next line at outer input depth trips the dedent clear and
 *     releases everything after it. Each shape has a named test, and so does
 *     the opposite error in each case -- an anchor that latches and eats real
 *     commands is the fail-CLOSED way to "pass" all four.
 *
 * KNOWN CEILING, stated rather than buried. The match is LITERAL, so a runner
 * that builds a path dynamically reads as unregistered here; the one
 * glob-shaped `node --test` in the workflow set
 * (`deploy/helm/paperclip/tests/*.test.mjs`) covers none of this population,
 * and arm 5 refuses to run if a second glob over these directories appears.
 * Non-root `package.json` scripts are not walked -- that can only move a file
 * from unreachable to reachable, so this guard can demand a registration that
 * a nested script already provides. The allowlist is the escape hatch for that,
 * and `reason` is where it gets said.
 *
 * The remaining ceiling is that this is a LINE-BASED SCAN, not a YAML parse, so
 * `run:`, `with:` and `#` are recognised by shape rather than by structure. The
 * one residual this is known to cost, verified by probe rather than reasoned
 * about: a `#` inside a QUOTED shell string (`run: echo " # x" && node --test
 * scripts/a.test.mjs`) is stripped as a comment and the real token after it is
 * lost. That direction is the SAFE one, and is what licenses the blunt rule --
 * it demands a registration that already exists, which is loud and fixable in
 * one line, rather than passing a file CI never runs, which is the failure that
 * is silent. No such line exists in the workflow set today.
 *
 * Closing it needs a real YAML parse plus shell-aware quoting, a larger
 * instrument than the defect warrants; the measurement is what holds that
 * decision honest instead. Re-run the guard after any change here -- it must
 * still report every currently-reachable file as reachable, which means
 * comparing the reachable SET and not just its size. 136 candidates / 134
 * reachable / 2 allowlisted across 44 workflows at the PEN-5282 commit, which
 * is where each of the four narrowings above was measured to cost nothing.
 *
 * What is NOT left open, so nobody re-opens it looking: the `with:` shapes
 * listed under the fourth narrowing are closed and each is pinned by its own
 * named test. Every clause of the inline-comment and `with:`-anchoring logic
 * carries a mutant that a named test kills; the sweep is in the sibling test
 * file and is the thing to re-run, not re-derive, after touching either.
 *
 * Reachability is NOT a claim that the test is any good, only that CI runs it.
 * PEN-5205 is an open defect in one of the files this guard now protects.
 *
 * Five arms:
 *
 *   1. registered   -- every candidate is reachable per (a)/(b), or carries an
 *                      allowlist entry. This is PEN-5272's actual ask.
 *   2. no dangling  -- every allowlist entry names a file that EXISTS. A rename
 *                      or delete otherwise leaves a permanent silent exemption
 *                      behind, and the allowlist keeps its length, so "we only
 *                      ever shrink it" is satisfied in letter.
 *   3. reasoned     -- every entry carries a non-empty `reason`. An exemption
 *                      nobody had to justify is how allowlists become the
 *                      default path.
 *   4. not stale    -- an entry whose file IS reachable is a contradiction and
 *                      is refused, so the allowlist cannot quietly outlive the
 *                      condition it was granted for. EXCEPTION: an entry
 *                      carrying `pendingRegistrationPr` expects to become
 *                      reachable -- that is its resolution, not its violation --
 *                      so it only prints a notice telling you to delete it. That
 *                      exemption exists so landing the PR named there does not
 *                      need a second push to this allowlist.
 *   5. method intact -- no glob covers these directories. One would silently run
 *                      files this guard reports as unregistered, making every
 *                      verdict unsound, so it is refused loudly instead.
 *
 * This guard is itself registered in `pr.yml`, in the PR that added it. An
 * unregistered registration guard is the joke PEN-5272 is about.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Files deliberately NOT reachable from CI.
 *
 * `reason` is mandatory and is read by arm 3. `pendingRegistrationPr` marks an
 * entry whose file is expected to become reachable when that PR lands -- see
 * arm 4 -- and is the only way an entry survives its file becoming registered.
 */
const ALLOWLIST = [
  {
    file: "scripts/security-audit-overrides.test.js",
    reason:
      "Terminal assertion is `pnpm audit --prod` against the live advisory " +
      "feed, so this file can turn red with no change to this repository -- " +
      "registering it makes every PR hostage to upstream advisory " +
      "publication. That is not hypothetical: `pnpm audit --prod` on master " +
      "reports 38 moderate advisories as of 2026-11-02, so registering this " +
      "file anywhere -- pr.yml or a scheduled lane -- lands an " +
      "immediately-red gate. Its live half (fast-uri over both lockfiles) is " +
      "already covered by scripts/fast-uri-advisory.test.js and " +
      "scripts/designer-fast-uri-security.test.js, both of which pr.yml runs, " +
      "and its override/ledger half by the CI-run " +
      "server/src/__tests__/security-audit-overrides.test.ts. " +
      "Run on demand with `pnpm run test:security-audit-overrides`. " +
      "PEN-5277 repairs this file's stale @connectrpc/connect-node " +
      "assertions in #3278. That repair does NOT make it registerable -- the " +
      "live-feed reason above is permanent -- so do not read PEN-5277 " +
      "closing as a cue to delete this entry. It is permanent, not pending, " +
      "which is why it carries no pendingRegistrationPr.",
  },
  {
    file: "scripts/github-publish-broker-soak-queries.test.mjs",
    reason:
      "Registration for this file is the sole unique residue of PR #3205. " +
      "That PR's operative hold is the `do-not-merge` label, NOT the " +
      "code-owner review request this entry named until 2026-11-11: " +
      "`land-clean-prs.mjs` opts out on `SKIP_LABELS` before it reaches any " +
      "code-owner handling, so no CODEOWNERS ruling releases it and clearing " +
      "the review request would achieve nothing. Measured live 2026-11-11: " +
      "#3205 OPEN, CONFLICTING/DIRTY, labels ['do-not-merge'], " +
      "reviewDecision null, head eb2dc737 unmoved since 2026-11-03. " +
      "Removing that label is the CEO's to authorise and is ALREADY asked on " +
      "board card c4bfaa88 (annotation c5350051) -- a second ask is a " +
      "duplicate, not an escalation. PEN-5272 forbids routing around the " +
      "hold, so the step is NOT duplicated here and this entry stands in for " +
      "it. DELETE THIS ENTRY when #3205 lands (arm 4 will print a notice " +
      "telling you to); if #3205 is closed unmerged, re-land its 23-line " +
      "pr.yml step and delete this entry then.",
    pendingRegistrationPr: 3205,
  },
];

const TEST_FILE = /\.test\.(mjs|js)$/;
const SCOPES = ["scripts/", ".github/scripts/"];

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function trackedFiles(root) {
  return execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\n")
    .filter(Boolean);
}

/** Whole-line YAML comments. Inline `#` is handled by `stripInlineComment`. */
function stripCommentLines(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Drop an inline comment: everything from a `#` that starts the line or follows
 * whitespace. `run: echo hi # scripts/a.test.mjs` is a shell comment, and a
 * file named only there is documented, not run -- the same failure mode as a
 * whole-line comment, which is why both are stripped.
 *
 * Over-stripping is SAFE HERE and that is what licenses the blunt rule. The
 * result is only ever membership-tested for file paths, so a token lost can
 * make this guard STRICTER -- demand a registration that already exists, which
 * is loud and immediately fixable -- but never LOOSER. It cannot pass a file CI
 * never runs, which is the only direction that fails silently.
 *
 * Anchoring to `#` at a word boundary keeps a `#` INSIDE a token out of scope:
 * a pinned `uses: ...@sha`, a URL fragment, a `--grep '#tag'`. Measured at the
 * adopting commit: no `run:` body in the workflow set loses a token to this.
 */
function stripInlineComment(line) {
  return line.replace(/(^|\s)#.*$/, "$1");
}

function invocationPattern(scriptName) {
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:pnpm|npm|yarn)\\s+(?:run\\s+)?${escaped}(?![A-Za-z0-9:_-])`,
  );
}

/** Root scripts a workflow invokes, closed over scripts that call each other. */
function workflowInvokedScripts(scripts, workflowText) {
  const reachable = new Set(
    Object.keys(scripts).filter((name) =>
      invocationPattern(name).test(workflowText),
    ),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of [...reachable]) {
      for (const other of Object.keys(scripts)) {
        if (reachable.has(other)) continue;
        if (invocationPattern(other).test(scripts[name] ?? "")) {
          reachable.add(other);
          grew = true;
        }
      }
    }
  }
  return reachable;
}

/**
 * The text of every `run:` STEP body. Only a command can run a test, so a
 * mention anywhere else in the YAML (a step `name:`, a `with:` input) is not a
 * registration. Handles both `run: <inline>` and `run: |` block scalars.
 *
 * Two shapes read as a step command and are not one. Both fail OPEN -- a file
 * CI never runs reads as reachable -- so both are refused here:
 *
 *   - An inline `#` comment. `run: echo hi # scripts/a.test.mjs` runs nothing.
 *     Stripped from every command line, inline and block-scalar body alike; a
 *     path BEFORE the `#` still registers, because that half is real shell.
 *   - A `run:` nested under `with:`. That is an ACTION INPUT, not a step
 *     command -- the action decides whether it ever runs, and most do not run
 *     it as a shell command at all. A line-based scan cannot tell the two
 *     apart by name, so it is told apart by INDENT: a `run:` indented deeper
 *     than the nearest enclosing `with:` is an input and is skipped.
 */
export function runCommands(workflowSource) {
  const lines = stripCommentLines(workflowSource).split("\n");
  const out = [];
  // Indent of the nearest enclosing `with:` block, or null outside one. A
  // `run:` deeper than this is an action input rather than a step command.
  let withIndent = null;
  for (let i = 0; i < lines.length; i += 1) {
    const indent = lines[i].length - lines[i].trimStart().length;
    if (lines[i].trim() !== "") {
      if (withIndent !== null && indent <= withIndent) withIndent = null;
      // Deliberately NOT anchored with `\s*$`, and matched on the RAW line.
      // Three shapes are `with:` keys that an anchored form misses, and each
      // one then lets every nested input register (fail-OPEN):
      //   - `with: # inputs`  -- an ordinary trailing comment.
      //   - `- with:`         -- `with` as the opening key of a step list
      //     item; hence the `-?`.
      //   - `with: {`         -- a multi-line flow mapping, whose inputs sit
      //     on the lines BELOW it.
      // Dropping the anchor cannot over-match: the line is only ever treated
      // as OPENING a block, and the dedent clear above ends that block at the
      // next same-or-shallower key -- so a flow mapping closed on its own line
      // (`with: {a: 1}`) still releases the step's real `run:`.
      //
      // No `stripInlineComment` here, and that is not an oversight: whole-line
      // comments are already gone, and this pattern reads only the prefix UP
      // TO `with:`, which stripping from a later `#` cannot change. Measured
      // redundant on every probed shape, so it is not kept as decoration --
      // the anchored version that did need it is what this replaces.
      const withKey = /^(\s*-?\s*)with:/.exec(lines[i]);
      if (withKey) {
        // OUTERMOST `with:` only. An action input literally named `with` would
        // otherwise overwrite the anchor with its own deeper column; the next
        // line back at the outer input depth then trips the dedent clear, the
        // anchor resets to null, and every later sibling input registers --
        // fail-OPEN, and a more devious one than the shapes above, because the
        // anchor is set the whole time and merely points at the wrong block.
        // Found by Ally on #3281. Keeping the outer column makes the nested
        // key just another input, which is what it is.
        //
        // Column of the `with` TOKEN, not of a leading `- `. For `- with:` the
        // step's own sibling keys sit at the `with` column, so anchoring on the
        // dash column would skip a REAL step `run:` written at that depth.
        if (withIndent === null) withIndent = withKey[1].length;
        continue;
      }
    }
    const match = /^(\s*)-?\s*run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    if (withIndent !== null && indent > withIndent) continue;
    const inline = stripInlineComment(match[2]).trim();
    if (inline !== "" && !/^[|>][-+]?\d*$/.test(inline)) {
      out.push(inline);
      continue;
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "") continue;
      if (lines[j].length - lines[j].trimStart().length <= indent) break;
      out.push(stripInlineComment(lines[j]));
    }
  }
  return out.join("\n");
}

/**
 * Command text split into whole argument tokens, each normalised by dropping a
 * leading `./`. Substring matching fails OPEN on suffix-shaped names -- see the
 * header -- so reachability is decided by exact membership in this set.
 */
export function commandTokens(text) {
  return new Set(
    text
      .split(/[\s'"`;|&()<>]+/)
      .map((token) => token.replace(/^\.\//, ""))
      .filter(Boolean),
  );
}

export function analyze({ tracked, workflowSources, packageScripts }) {
  const candidates = tracked
    .filter((f) => SCOPES.some((s) => f.startsWith(s)) && TEST_FILE.test(f))
    .sort();

  const runText = workflowSources.map(runCommands).join("\n");
  const invoked = workflowInvokedScripts(packageScripts, runText);
  const invokedText = [...invoked].map((n) => packageScripts[n]).join("\n");

  const tokens = commandTokens(`${runText}\n${invokedText}`);
  const reachable = new Set(candidates.filter((f) => tokens.has(f)));

  // Arm 5: a glob over these directories would silently cover files this guard
  // reports as unregistered, making every verdict here unsound.
  const globs = [];
  for (const src of workflowSources) {
    for (const m of stripCommentLines(src).matchAll(
      /[A-Za-z0-9_./*-]*\*[A-Za-z0-9_./*-]*\.test\.(?:mjs|js)/g,
    )) {
      if (SCOPES.some((s) => m[0].includes(s) || m[0].includes(`./${s}`))) {
        globs.push(m[0]);
      }
    }
  }

  return { candidates, reachable, invoked, globs };
}

export function evaluate(analysis, allowlist) {
  const { candidates, reachable, globs } = analysis;
  const errors = [];
  const notices = [];

  for (const glob of [...new Set(globs)]) {
    errors.push(
      `arm 5: workflow glob "${glob}" covers a guarded directory. This guard ` +
        `matches literally and would report files that glob already runs as ` +
        `unregistered. Teach this guard the glob, or drop it.`,
    );
  }

  const seen = new Set();
  const allowed = new Set();
  for (const entry of allowlist) {
    if (seen.has(entry.file)) {
      errors.push(`arm 3: duplicate allowlist entry for ${entry.file}.`);
      continue;
    }
    seen.add(entry.file);
    allowed.add(entry.file);

    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      errors.push(
        `arm 3: allowlist entry ${entry.file} carries no reason. Say why CI ` +
          `must not run it.`,
      );
    }
    if (!candidates.includes(entry.file)) {
      errors.push(
        `arm 2: allowlist entry ${entry.file} names no candidate test file. ` +
          `It was renamed or deleted; drop the entry.`,
      );
      continue;
    }
    if (reachable.has(entry.file)) {
      if (entry.pendingRegistrationPr) {
        notices.push(
          `${entry.file} is now reachable from CI, which is what ` +
            `PR #${entry.pendingRegistrationPr} was going to do. Delete its ` +
            `allowlist entry in scripts/check-script-test-registration.mjs.`,
        );
      } else {
        errors.push(
          `arm 4: allowlist entry ${entry.file} is reachable from CI. The ` +
            `exemption has outlived its reason; drop the entry.`,
        );
      }
    }
  }

  const unregistered = candidates.filter(
    (f) => !reachable.has(f) && !allowed.has(f),
  );
  for (const f of unregistered) {
    errors.push(
      `arm 1: ${f} is reachable from no workflow and no workflow-invoked root ` +
        `npm script. Register it in .github/workflows/pr.yml, or add it to ` +
        `ALLOWLIST in scripts/check-script-test-registration.mjs with a reason.`,
    );
  }

  return { errors, notices, unregistered };
}

/** The IO half, split out so the test can analyze the real tree. */
export function collect(root = repoRoot()) {
  const tracked = trackedFiles(root);
  const workflowPaths = tracked.filter((f) =>
    /^\.github\/workflows\/.+\.ya?ml$/.test(f),
  );
  return {
    tracked,
    workflowPaths,
    workflowSources: workflowPaths.map((f) =>
      readFileSync(path.join(root, f), "utf8"),
    ),
    packageScripts:
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
        .scripts ?? {},
  };
}

function main() {
  const { tracked, workflowPaths, workflowSources, packageScripts } = collect();
  const analysis = analyze({ tracked, workflowSources, packageScripts });
  const { errors, notices } = evaluate(analysis, ALLOWLIST);

  const unreachableCount = analysis.candidates.length - analysis.reachable.size;
  console.log(
    `script-test registration: ${analysis.candidates.length} candidate files, ` +
      `${analysis.reachable.size} reachable from CI, ${unreachableCount} not ` +
      `(${ALLOWLIST.length} allowlisted), across ${workflowPaths.length} workflows.`,
  );

  for (const notice of notices) console.log(`notice: ${notice}`);

  if (errors.length > 0) {
    console.error("");
    for (const error of errors) console.error(`error: ${error}`);
    console.error("");
    console.error(
      `${errors.length} problem(s). A test file CI never runs is a ` +
        `test-shaped file, not a test (PEN-5272).`,
    );
    process.exit(1);
  }

  console.log("every candidate script test is reachable from CI or allowlisted.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}

export { ALLOWLIST, stripCommentLines };
