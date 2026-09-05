// Guards the pnpm-setup retry wrapper introduced for BLO-28813.
//
// pnpm/action-setup@v6 cannot install a pinned pnpm in one step: it bootstraps a
// version pinned inside the action, then runs `pnpm self-update <target>`, which
// verifies `@pnpm/exe@<target>` and its per-platform optional deps against
// registry.npmjs.org fail-closed. A slow registry therefore kills a job before
// it runs a single test, and on a merge_group ref that ejects the PR. These
// tests exist so that the mitigation cannot be quietly undone or bypassed.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const workflowDir = ".github/workflows";
const actionPath = ".github/actions/setup-pnpm/action.yml";
const wrapperRef = "./.github/actions/setup-pnpm";

// A job that sets up pnpm needs room for the wrapper's second attempt AND for
// its own work. This floor used to be 10, derived from "two attempts at
// (bootstrap + a 120s registry stall) plus up to 25s of jittered backoff, ~5
// minutes". Measuring pr.yml's `policy` job over 75 runs (2026-09-04,
// BLO-31690) showed that model mis-attributes where the time goes, and so
// understates every case built on it:
//
//   - the retry fired in 0 of 75 runs -- the wrapper's `Setup pnpm (retry)`
//     and back-off nodes both log `conclusion=skipped` -- and a SUCCESSFUL
//     first attempt still took 254.5s (259s for the step as a whole), so the
//     ~4.3m is one slow success rather than two attempts;
//   - that 254.5s is almost entirely the bootstrap `npm ci` -- 243s of it,
//     logged as "added 1 package in 4m" -- and only ~7s the `pnpm
//     self-update` the old model treated as the expensive part. The bootstrap
//     is not a cheap prelude to a 120s fetch; it IS the cost.
//
// Re-deriving the retry path on measured parts rather than assumed ones: a
// first attempt that bootstraps (243s) and then loses its self-update to the
// 120s fetch timeout is 363s, + up to 25s of backoff + a 259s slow-success
// retry = ~10.8m for `Setup pnpm` alone. That floor is also why the 0-of-75
// count above does not need 75 logs read to be sound: no observed step came
// within half of it.
//
// So 15 does NOT buy full retry-path coverage, and this constant should not be
// read as claiming it does: for `policy` that would be 10.8m pnpm + 4.6m p100
// checkout + 4.8m gate work = ~20m. What 15 does buy is the observed
// worst case -- a slow-but-successful setup plus the job's own work, which is
// what both historical blowouts actually were -- with margin, and it is a
// floor every other budgeted wrapper job in this repo already clears. Counted
// 2026-09-04: 24 jobs reach for the wrapper, 23 declare a budget (the 24th is
// listed in WRAPPER_JOBS_WITHOUT_A_BUDGET below), the next-lowest two declare
// exactly 15, and `policy` was the lone outlier at 10 -- as well as the only
// one observed dying at its cap. Closing the retry gap by raising budgets
// further is the wrong lever;
// the structural fix is baking the pinned pnpm into the ARC runner image so
// the bootstrap stops being a registry round-trip at all (see the wrapper's
// own header), and the residual is recorded at pr.yml's `policy` cap.
//
// The NAME is historical: it dates from the 10 derived above and still says
// "for retry", but what the number now encodes is the measured slow-success
// setup floor. Read it as that, not as a retry budget -- the two differ by
// ~4m and the paragraph above is the reason.
const MIN_TIMEOUT_MINUTES_FOR_RETRY = 15;

// Direct calls are allowed at exactly these grandfathered sites. Keyed by
// (workflow, ref) rather than matched as `@v\d+`, because a SHA pin -- the
// direction repos drift for supply-chain reasons -- would sail straight past a
// version-shaped pattern and reintroduce the bug the wrapper exists to fix.
// Fails closed: an unlisted file, or a listed file on a different ref, is a
// failure and has to be added here deliberately.
const ALLOWED_DIRECT_CALLS = new Map([
  ["e2e.yml", "v4"],
  ["refresh-lockfile.yml", "v4"],
  ["release-smoke.yml", "v4"],
]);

// Wrapper jobs that intentionally declare no budget and inherit GitHub's 360m
// default. Everything else must declare one: otherwise "delete timeout-minutes"
// becomes the cheapest way to satisfy the floor below, and trading a tight
// budget for 360m is strictly worse merge-queue protection than the tight
// budget was.
const WRAPPER_JOBS_WITHOUT_A_BUDGET = new Set(["release-penstock-scope.yml:publish"]);

const readWorkflows = async () => {
  const names = (await readdir(workflowDir)).filter((n) => n.endsWith(".yml"));
  return Promise.all(
    names.map(async (name) => ({
      name: `${workflowDir}/${name}`,
      body: await readFile(`${workflowDir}/${name}`, "utf8"),
    })),
  );
};

// Drop whole-line YAML comments. Prose in this repo's workflows explains the
// traps being guarded against, and naming a trap must not read as committing it.
const stripComments = (body) =>
  body
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

// Split a workflow into its top-level jobs. Scoped to the `jobs:` block so that
// value-less two-space keys elsewhere -- `on:` has `pull_request:` and
// `merge_group:` -- are not mistaken for job names.
const splitJobs = (body) => {
  const jobs = [];
  let inJobs = false;
  let current = null;
  for (const line of body.split("\n")) {
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inJobs) continue;

    const header = line.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
    if (header) {
      current = { name: header[1], lines: [] };
      jobs.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return jobs;
};

test("no workflow reaches for pnpm/action-setup outside the grandfathered v4 sites", async () => {
  // The v4 sites are grandfathered on purpose, not overlooked: v4 installs the
  // exact requested version in one call with no self-update and no
  // engine-identity verifier, so it never had this failure mode. Routing them
  // through the wrapper would move them onto the v6 code path and hand them an
  // exposure they do not currently have.
  for (const { name, body } of await readWorkflows()) {
    const file = name.slice(name.lastIndexOf("/") + 1);
    // Deliberately NOT `@v(\d+)`: a SHA pin would not match, and would then be
    // reported as "no direct calls" while reintroducing the bug.
    for (const [, ref] of stripComments(body).matchAll(/uses: pnpm\/action-setup@(\S+)/g)) {
      const allowed = ALLOWED_DIRECT_CALLS.get(file);
      assert.equal(
        ref,
        allowed,
        `${name} calls pnpm/action-setup@${ref} directly` +
          (allowed
            ? ` but is only grandfathered at @${allowed}`
            : `; use \`uses: ${wrapperRef}\` so the registry fetch gets a retry`) +
          ` (BLO-28813)`,
      );
    }
  }
});

test("every job that sets up pnpm clears the measured setup floor", async () => {
  for (const { name, body } of await readWorkflows()) {
    const file = name.slice(name.lastIndexOf("/") + 1);
    for (const job of splitJobs(stripComments(body))) {
      const text = job.lines.join("\n");
      if (!text.includes(wrapperRef)) continue;

      const declared = text.match(/^ {4}timeout-minutes: (\d+)$/m);
      if (!declared) {
        // Not a free pass: absence has to be listed. Otherwise deleting the
        // line is the cheapest way to satisfy the floor, and inheriting
        // GitHub's 360m default is strictly worse merge-queue protection than
        // whatever tight budget was deleted.
        assert.ok(
          WRAPPER_JOBS_WITHOUT_A_BUDGET.has(`${file}:${job.name}`),
          `${name} job "${job.name}" sets up pnpm with no timeout-minutes, so it inherits ` +
            `GitHub's 360m default. Declare a budget of at least ` +
            `${MIN_TIMEOUT_MINUTES_FOR_RETRY}m, or add it to WRAPPER_JOBS_WITHOUT_A_BUDGET ` +
            `deliberately (BLO-28813)`,
        );
        continue;
      }

      assert.ok(
        Number(declared[1]) >= MIN_TIMEOUT_MINUTES_FOR_RETRY,
        `${name} job "${job.name}" sets up pnpm with timeout-minutes: ${declared[1]}, ` +
          `below the ${MIN_TIMEOUT_MINUTES_FOR_RETRY}m floor. A slow-but-successful setup ` +
          `alone measured 8.1m (worst observed checkout + pnpm combined, NOT the sum of ` +
          `the two p100s), and the job's own work adds up to ` +
          `4.8m on top, so a budget under the floor is spent before the work starts — the ` +
          `job dies at its cap as an unattributable \`cancelled\` (BLO-31690)`,
      );
    }
  }
});

test("the wrapper is always preceded by a checkout in the same job", async () => {
  // The wrapper passes no `version:`; the action reads package.json
  // "packageManager" instead, so the repo has to be on disk first.
  for (const { name, body } of await readWorkflows()) {
    for (const job of splitJobs(stripComments(body))) {
      const text = job.lines.join("\n");
      const useAt = text.indexOf(wrapperRef);
      if (useAt === -1) continue;

      const checkoutAt = text.indexOf("uses: actions/checkout@");
      assert.ok(
        checkoutAt !== -1 && checkoutAt < useAt,
        `${name} job "${job.name}" sets up pnpm without a preceding actions/checkout; ` +
          `the wrapper reads the pnpm pin from package.json (BLO-28813)`,
      );
    }
  }
});

test("the pnpm pin lives only in package.json", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(
    manifest.packageManager ?? "",
    /^pnpm@\d+\.\d+\.\d+/,
    "package.json must pin packageManager to an exact pnpm version — the wrapper resolves the version from it",
  );

  assert.doesNotMatch(
    stripComments(await readFile(actionPath, "utf8")),
    /^\s*version:/m,
    "the wrapper must not pass a `version:` input; that would duplicate the packageManager pin " +
      "and pnpm/action-setup hard-errors when the two disagree",
  );
});

test("the wrapper retries once, and the retry is allowed to fail the job", async () => {
  const action = stripComments(await readFile(actionPath, "utf8"));

  const attempts = action.match(/uses: pnpm\/action-setup@v6/g) ?? [];
  assert.equal(attempts.length, 2, "expected exactly two attempts in the wrapper");

  const tolerated = action.match(/^\s*continue-on-error: true$/gm) ?? [];
  assert.equal(
    tolerated.length,
    1,
    "exactly one attempt may be tolerated — if the retry also carries continue-on-error, " +
      "a total registry outage silently yields a job with no pnpm installed",
  );

  // The retry, and its backoff, must be gated on the first attempt failing.
  assert.match(action, /id: first\n/);
  assert.match(action, /if: steps\.first\.outcome == 'failure'\n\s*shell: bash/);
  assert.match(action, /id: retry\n\s*if: steps\.first\.outcome == 'failure'/);

  // Jitter, not a constant sleep: eight pr.yml jobs run this simultaneously and
  // a fixed backoff would re-synchronise them into a second thundering herd.
  assert.match(action, /RANDOM/, "the backoff must be jittered");
});

test("the wrapper widens the fetch timeout on every attempt and keeps one retry layer", async () => {
  const action = stripComments(await readFile(actionPath, "utf8"));

  // 120s, because a request measured at 70,506ms was aborted under pnpm's 60s
  // default and would otherwise have succeeded.
  const timeouts = action.match(/^\s*npm_config_fetch_timeout: "120000"$/gm) ?? [];
  assert.equal(timeouts.length, 2, "both attempts must widen npm_config_fetch_timeout");

  // pnpm's in-process retries stay off so the two retry layers cannot multiply
  // into a worst case that outruns the job budget asserted above.
  const retries = action.match(/^\s*npm_config_fetch_retries: "0"$/gm) ?? [];
  assert.equal(retries.length, 2, "both attempts must disable pnpm's in-process retries");
});

test("nothing downgrades the pnpm engine-identity check to a warning", async () => {
  // ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE suggests setting pmOnFail=ignore.
  // That does not skip the registry fetch, it skips the version SWITCH — leaving
  // the job running the action's bootstrap pnpm (a different major) against this
  // repo's lockfile. Silently resolving with the wrong major is worse than a red
  // build, so failing closed is deliberate.
  const files = [
    { name: actionPath, body: await readFile(actionPath, "utf8") },
    ...(await readWorkflows()),
  ];

  for (const { name, body } of files) {
    assert.doesNotMatch(
      stripComments(body),
      /pm[-_]?on[-_]?fail/i,
      `${name} sets pmOnFail; that would run pnpm against a lockfile written by a different ` +
        `major rather than failing closed (BLO-28813)`,
    );
  }
});
