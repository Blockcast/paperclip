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
 * REACHABILITY, defined so the verdict is falsifiable:
 *
 *   (a) the file path (bare or `./`-prefixed) or its basename appears in the
 *       text of some `.github/workflows/*.y{a,}ml`, with WHOLE-LINE COMMENTS
 *       STRIPPED -- a file named only in a `#` comment is documented, not run;
 *   (b) or it appears in the body of a root `package.json` script that is
 *       transitively reachable from one a workflow actually invokes
 *       (`pnpm run X` / `pnpm X` / `npm run X` / `yarn X`).
 *
 * Comment-stripping is a strengthening that costs nothing here: measured at
 * 269bdc0d, ZERO of the 105 reachable files were reachable only via a comment,
 * so (a) and its loose variant agreed exactly. It is in force to keep a future
 * comment from being mistaken for a registration.
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
 *   5. method intact -- basenames across the population are unique (arm 1 may
 *                      match on basename) and no second glob covers these
 *                      directories. Either would make a verdict here unsound, so
 *                      it is refused loudly instead of reported quietly.
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
      "publication. It is also red on master today: it asserts " +
      "`@connectrpc/connect-node@1.7.0` resolves undici 6.29.1, and that " +
      "package is in no package.json and no lockfile entry, so the assertion " +
      "is unsatisfiable. Its live half (fast-uri over both lockfiles) is " +
      "already covered by scripts/fast-uri-advisory.test.js and " +
      "scripts/designer-fast-uri-security.test.js, both of which pr.yml runs. " +
      "Run on demand with `pnpm run test:security-audit-overrides`. " +
      "Assertion repair is tracked by PEN-5277.",
  },
  {
    file: "scripts/github-publish-broker-soak-queries.test.mjs",
    reason:
      "Registration for this file is the sole unique residue of PR #3205, " +
      "which is open and held on its code-owner review request. PEN-5272 " +
      "forbids routing around that hold, so the step is NOT duplicated here " +
      "and this entry stands in for it. DELETE THIS ENTRY when #3205 lands " +
      "(arm 4 will print a notice telling you to); if #3205 is closed " +
      "unmerged, re-land its 23-line pr.yml step and delete this entry then.",
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

/** Whole-line YAML comments only. An inline `#` inside a `run:` block is shell. */
function stripCommentLines(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
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

function mentions(text, file) {
  return (
    text.includes(file) ||
    text.includes(`./${file}`) ||
    text.includes(path.basename(file))
  );
}

export function analyze({ tracked, workflowSources, packageScripts }) {
  const candidates = tracked
    .filter((f) => SCOPES.some((s) => f.startsWith(s)) && TEST_FILE.test(f))
    .sort();

  const workflowText = stripCommentLines(workflowSources.join("\n"));
  const invoked = workflowInvokedScripts(packageScripts, workflowText);
  const invokedText = [...invoked].map((n) => packageScripts[n]).join("\n");

  const reachable = new Set(
    candidates.filter(
      (f) => mentions(workflowText, f) || mentions(invokedText, f),
    ),
  );

  // Arm 5a: basename uniqueness, which arm 1's basename match relies on.
  const byBase = new Map();
  for (const f of candidates) {
    const b = path.basename(f);
    byBase.set(b, [...(byBase.get(b) ?? []), f]);
  }
  const collisions = [...byBase.entries()].filter(([, v]) => v.length > 1);

  // Arm 5b: a second glob over these directories would silently cover files
  // this guard reports as unregistered.
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

  return { candidates, reachable, invoked, collisions, globs };
}

export function evaluate(analysis, allowlist) {
  const { candidates, reachable, collisions, globs } = analysis;
  const errors = [];
  const notices = [];

  for (const [base, files] of collisions) {
    errors.push(
      `arm 5: basename "${base}" is shared by ${files.length} candidate files ` +
        `(${files.join(", ")}). Registration is matched by basename, so a ` +
        `verdict here would be unsound. Rename one.`,
    );
  }
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

  const registered = analysis.candidates.length - analysis.reachable.size;
  console.log(
    `script-test registration: ${analysis.candidates.length} candidate files, ` +
      `${analysis.reachable.size} reachable from CI, ${registered} not ` +
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
