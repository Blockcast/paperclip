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

// Worst case for the wrapper is two attempts at (bootstrap + a 120s registry
// stall) plus up to 25s of jittered backoff, ~5 minutes. A job budgeted below
// this turns a degraded registry into a job timeout, which ejects a merge-queue
// candidate exactly the same way but burns the runner for the full budget first.
const MIN_TIMEOUT_MINUTES_FOR_RETRY = 10;

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

test("no workflow reaches for pnpm/action-setup@v6-or-newer directly", async () => {
  // v4 sites are grandfathered on purpose, not overlooked: v4 installs the exact
  // requested version in one call with no self-update and no engine-identity
  // verifier, so it never had this failure mode. Routing them through the
  // wrapper would move them onto the v6 code path and hand them an exposure they
  // do not currently have.
  for (const { name, body } of await readWorkflows()) {
    const direct = [...stripComments(body).matchAll(/uses: pnpm\/action-setup@v(\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((major) => major >= 6);

    assert.equal(
      direct.length,
      0,
      `${name} calls pnpm/action-setup@v${direct[0]} directly; use \`uses: ${wrapperRef}\` ` +
        `so the registry fetch gets a retry (BLO-28813)`,
    );
  }
});

test("every job that sets up pnpm has headroom for a second attempt", async () => {
  for (const { name, body } of await readWorkflows()) {
    for (const job of splitJobs(stripComments(body))) {
      const text = job.lines.join("\n");
      if (!text.includes(wrapperRef)) continue;

      const declared = text.match(/^ {4}timeout-minutes: (\d+)$/m);
      if (!declared) continue; // no explicit budget: GitHub's 360m default is ample

      assert.ok(
        Number(declared[1]) >= MIN_TIMEOUT_MINUTES_FOR_RETRY,
        `${name} job "${job.name}" sets up pnpm with timeout-minutes: ${declared[1]}, ` +
          `below the ${MIN_TIMEOUT_MINUTES_FOR_RETRY}m needed for the retry budget — a stalled ` +
          `registry would time the job out instead of retrying (BLO-28813)`,
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
