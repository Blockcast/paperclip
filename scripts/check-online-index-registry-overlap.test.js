import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Two registries name the migrations that need an online index, they are
// maintained independently, and until PEN-4179 NOTHING asserted how they
// relate — not in concurrent-index-guard.test.ts, not in
// pending-migration-preflight.test.ts. That is how they drifted: the
// pre-flight's header still quotes the guard saying 0205/0208/0209 are
// "deliberately NOT listed here" while all three are listed, and a reader
// trusting that quote concludes an operator must hand-run a statement the
// pipeline is supposed to run (PEN-4176: ~25 h of silent deploy freeze).
//
// Pinned textually rather than by import because these assertions must run
// without installing the workspace — the same reason check-docker-deploy-
// timeout.test.js reads docker.yml as text.
const guardSource = readFileSync(
  new URL("../packages/db/src/concurrent-index-guard.ts", import.meta.url),
  "utf8",
);
const preflightSource = readFileSync(
  new URL("../packages/db/src/pending-migration-preflight.ts", import.meta.url),
  "utf8",
);
const workflow = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");

// `migration:` keys only. A bare /\d{4}_\w+\.sql/ scan would also pick up
// filenames named in prose, and both files discuss migrations they do not
// register — which would silently inflate both sets and make the overlap
// assertion below pass for the wrong reason.
function registeredMigrations(source) {
  return new Set(
    [...source.matchAll(/^\s*migration:\s*"([0-9]{4}_[a-z0-9_]+\.sql)",$/gm)].map(
      (match) => match[1],
    ),
  );
}

const RUNNER_REGISTRY = registeredMigrations(guardSource);
const PREFLIGHT_REGISTRY = registeredMigrations(preflightSource);

// Measured from master at 816ad95a, 2026-10-16. This is the set the deploy-time
// precreation step covers; the pre-flight-only remainder has no automated path
// and its operators are told so.
const EXPECTED_OVERLAP = [
  "0205_heartbeat_runs_company_finished_at_index.sql",
  "0208_heartbeat_runs_agent_dispatch_index.sql",
  "0209_heartbeat_runs_recovery_dispatch_index.sql",
  "0217_heartbeat_runs_queued_age_idx.sql",
  "0224_heartbeat_runs_overdue_scheduled_retry_index.sql",
  "0230_heartbeat_runs_retry_successor_index.sql",
  "0259_heartbeat_runs_failed_finished_at_index.sql",
];

test("both registries are non-empty and parsed from `migration:` keys, not from prose", () => {
  // Fixture check. Without it every set assertion below is vacuously true the
  // moment the parser stops matching — a renamed key would read as "no drift".
  assert.ok(RUNNER_REGISTRY.size >= 8, `runner registry parsed ${RUNNER_REGISTRY.size} entries`);
  assert.ok(
    PREFLIGHT_REGISTRY.size >= 13,
    `pre-flight registry parsed ${PREFLIGHT_REGISTRY.size} entries`,
  );
});

test("the automated subset is exactly the migrations in both registries", () => {
  const overlap = [...PREFLIGHT_REGISTRY].filter((migration) => RUNNER_REGISTRY.has(migration));
  assert.deepEqual(
    overlap.sort(),
    [...EXPECTED_OVERLAP].sort(),
    "the set of migrations the deploy-time precreation step covers changed. That is allowed — but " +
      "it changes what operators are told to hand-run, so update EXPECTED_OVERLAP deliberately " +
      "rather than letting the two registries drift apart again (PEN-4179)",
  );
});

test("the pre-flight derives its automated set from the guard instead of restating it", () => {
  // The whole defect was two hand-maintained lists with no link. A literal
  // re-listing here would reintroduce it, so require the derivation.
  assert.match(
    preflightSource,
    /import \{ PENDING_CONCURRENT_INDEXES \} from "\.\/concurrent-index-guard\.js";/,
    "pending-migration-preflight.ts must import the guard's registry",
  );
  assert.match(
    preflightSource,
    /MIGRATIONS_WITH_RUNNER_PRECREATION[^=]*=\s*new Set\(\s*PENDING_CONCURRENT_INDEXES\.map\(/,
    "MIGRATIONS_WITH_RUNNER_PRECREATION must be derived from PENDING_CONCURRENT_INDEXES",
  );
});

test("the failure text no longer claims the automated half cannot build its own index", () => {
  // The exact sentence that licensed PEN-4176's framing. It is true of the SQL
  // file and false of the runner, which builds these one statement earlier,
  // outside the transaction.
  assert.doesNotMatch(
    preflightSource,
    /so these cannot build the index themselves/,
    "the undifferentiated 'cannot build the index themselves' claim is false for every migration " +
      "in PENDING_CONCURRENT_INDEXES — partition the remediation instead",
  );
  assert.match(
    preflightSource,
    /has a deploy-time precreation path/,
    "blockers with a runner path must be reported as such, not as operator work",
  );
  assert.match(
    preflightSource,
    /has NO automated path/,
    "blockers without a runner path must still print the operator remediation",
  );
});

test("the deploy runs precreation BEFORE the gate that reports on it", () => {
  // Ordering is the whole point: precreating after the gate would report on an
  // index that did not exist when the gate read it, and precreating after
  // `helm upgrade` would build it during the rollout — the crashloop venue the
  // gate exists to avoid.
  const marker = "\n  deploy:\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "docker.yml must define a deploy job");
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  const deployJob = nextJob === -1 ? remainder : remainder.slice(0, nextJob);

  const precreate = deployJob.search(
    /^\s*run:\s*\.github\/scripts\/precreate-online-indexes\.sh\s*$/m,
  );
  const preflight = deployJob.search(
    /^\s*run:\s*\.github\/scripts\/check-pending-migrations\.sh\s*$/m,
  );
  const helm = deployJob.indexOf("id: helm");

  assert.notEqual(precreate, -1, "deploy job must run the online-index precreation step");
  assert.notEqual(preflight, -1, "deploy job must run the pending-migration pre-flight");
  assert.notEqual(helm, -1, "deploy job must run helm upgrade");
  assert.ok(
    precreate < preflight,
    "precreation must run before the pre-flight, or the gate reports on a pre-precreation state",
  );
  assert.ok(
    preflight < helm,
    "the pre-flight must still gate helm upgrade — precreation is advisory and decides nothing",
  );
});

test("the precreation step cannot fail the deploy", () => {
  // Advisory is load-bearing: the step sits on the production deploy path and
  // must only ever be able to improve the outcome. `set -e` would make any
  // kubectl hiccup a deploy failure, which is strictly worse than the status
  // quo it replaces.
  const script = readFileSync(
    new URL("../.github/scripts/precreate-online-indexes.sh", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    script,
    /^set -e/m,
    "the precreation script must not use `set -e`: it is advisory and must always exit 0",
  );
  assert.match(
    script,
    /^set -uo pipefail$/m,
    "the precreation script should still catch unset variables and pipeline failures",
  );
  const exits = [...script.matchAll(/^\s*exit (\d+)/gm)].map((match) => match[1]);
  assert.ok(exits.length > 0, "fixture check: the script has explicit exits");
  assert.deepEqual(
    [...new Set(exits)],
    ["0"],
    `every exit must be 0; found ${exits.join(", ")}`,
  );
});
