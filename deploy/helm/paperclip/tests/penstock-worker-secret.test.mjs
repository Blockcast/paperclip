import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = new URL("../../../..", import.meta.url).pathname;
const chartDir = "deploy/helm/paperclip";
const blockcastValues = `${chartDir}/values.blockcast.yaml`;

function render(template, extraArgs = []) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      chartDir,
      "--namespace",
      "paperclip",
      "-f",
      blockcastValues,
      ...extraArgs,
      "--show-only",
      template,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function renderExpectingFailure(extraArgs) {
  const result = spawnSync(
    "helm",
    [
      "template",
      "paperclip",
      chartDir,
      "--namespace",
      "paperclip",
      ...extraArgs.flatMap((entry) => ["--set", entry]),
      "--show-only",
      "templates/statefulset.yaml",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "expected Helm rendering to fail closed");
  return result.stderr;
}

test("worker StatefulSet receives the required Penstock Secret reference", () => {
  const rendered = render("templates/statefulset.yaml");
  const match = rendered.match(
    /- name: PENSTOCK_API_KEY\s+valueFrom:\s+secretKeyRef:\s+key: token\s+name: paperclip-penstock-org-key/s,
  );
  assert.ok(match, "worker must bind PENSTOCK_API_KEY from paperclip-penstock-org-key/token");
  assert.doesNotMatch(rendered, /- name: PENSTOCK_API_KEY\s+value:/);
});

test("API Deployment does not receive the worker-only Penstock key", () => {
  const rendered = render("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
    "--set",
    "persistence.existingClaim=paperclip-shared",
  ]);
  assert.doesNotMatch(rendered, /PENSTOCK_API_KEY/);
});

test("shared env.extra rejects the Penstock key instead of exposing it to API pods", () => {
  const stderr = renderExpectingFailure([
    "env.extra[0].name=PENSTOCK_API_KEY",
    "env.extra[0].value=unexpected",
  ]);
  assert.match(stderr, /env\.extra must not define PENSTOCK_API_KEY/);
});

test("worker Penstock key rejects a literal value", () => {
  const stderr = renderExpectingFailure([
    "worker.extraEnv[0].name=PENSTOCK_API_KEY",
    "worker.extraEnv[0].value=unexpected",
  ]);
  assert.match(stderr, /worker\.extraEnv PENSTOCK_API_KEY must use valueFrom\.secretKeyRef/);
});

test("worker Penstock key requires a Secret name and key", () => {
  const missingName = renderExpectingFailure([
    "worker.extraEnv[0].name=PENSTOCK_API_KEY",
    "worker.extraEnv[0].valueFrom.secretKeyRef.key=token",
  ]);
  assert.match(missingName, /requires valueFrom\.secretKeyRef\.name/);

  const missingKey = renderExpectingFailure([
    "worker.extraEnv[0].name=PENSTOCK_API_KEY",
    "worker.extraEnv[0].valueFrom.secretKeyRef.name=paperclip-penstock-org-key",
  ]);
  assert.match(missingKey, /requires valueFrom\.secretKeyRef\.key/);
});

// BLO-33279. The launcher's readiness budget defaults to 15000 ms, but measured
// Caveman cold starts reach 11548 ms under concurrency — a 1.3x margin, and the
// retry loop covers only EADDRINUSE, so a readiness timeout kills the run on
// attempt 1. The override lives in worker.extraEnv because the claude_k8s
// adapter copies the worker container's literal env into every agent Job via
// selfPod.inheritedEnv; that is what makes one committed line a fleet-wide
// default instead of N hand-edited adapterConfig records.
const LAUNCHER_DEFAULT_READY_TIMEOUT_MS = 15_000;
const LAUNCHER_MAX_READY_TIMEOUT_MS = 300_000;

test("worker exports an inheritable Caveman readiness budget above the launcher default", () => {
  const rendered = render("templates/statefulset.yaml");
  const match = rendered.match(/- name: PENSTOCK_READY_TIMEOUT_MS\s+value: "(\d+)"/);

  // A literal value, not valueFrom: the adapter only reaches inheritedEnv for
  // literals, and this is a tunable rather than a credential.
  assert.ok(match, "worker must export PENSTOCK_READY_TIMEOUT_MS as a quoted literal");

  // The launcher's positiveInteger() silently falls back to the 15000 ms default
  // on anything unparseable or out of range. That failure is invisible — the
  // manifest still renders the typo — so assert the bounds the launcher applies
  // rather than merely that the name is present.
  const budgetMs = Number(match[1]);
  assert.ok(
    budgetMs > LAUNCHER_DEFAULT_READY_TIMEOUT_MS,
    `budget ${budgetMs}ms must exceed the ${LAUNCHER_DEFAULT_READY_TIMEOUT_MS}ms default it exists to raise`,
  );
  assert.ok(
    budgetMs <= LAUNCHER_MAX_READY_TIMEOUT_MS,
    `budget ${budgetMs}ms exceeds the launcher cap of ${LAUNCHER_MAX_READY_TIMEOUT_MS}ms and would be ignored`,
  );
});

test("API Deployment does not receive the worker-only readiness budget", () => {
  const rendered = render("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
    "--set",
    "persistence.existingClaim=paperclip-shared",
  ]);
  assert.doesNotMatch(rendered, /PENSTOCK_READY_TIMEOUT_MS/);
});

// BLO-33279, second half. Rendering the value onto the worker is necessary and
// NOT sufficient: the claude_k8s adapter filters every inherited literal
// through AGENT_ENV_ALLOWLIST (BLO-22514, k8s-client.ts), so a worker.extraEnv
// literal whose name is not listed there reaches no agent pod at all. That is
// how PENSTOCK_READY_TIMEOUT_MS shipped green on 2026-09-12 and changed
// nothing — the test above passed, the sts carried the value, and every agent
// Job still ran the 15000 ms default. The runbook asserted "there is no name
// allowlist", which had been false since BLO-22514.
//
// ponytail: text-scrape of the allowlist rather than importing it — the module
// is TypeScript in a vendored package and this is a dependency-free node:test
// file. Upgrade to a real import if these tests ever gain a TS pipeline.

// Entries only. Matched at line start so a name quoted inside a COMMENT in the
// set body is not counted as a member (BLO-34412) — `// "X" stays denied` would
// otherwise read as an entry under a substring test and make the guard report a
// denied name inheritable. Requires the trailing comma prettier already writes;
// a comma-less final entry is dropped, which fails toward a false RED.
const setEntries = (block) => [...block.matchAll(/^\s*"([A-Za-z0-9_]+)",/gm)].map((m) => m[1]);

// Mirrors isAgentInheritableEnvName (inherit-allowlist.ts). The order is the
// point: the runtime checks SERVER_ONLY_ENV_DENY FIRST and deny beats both the
// exact allowlist and the prefix families, so a predicate written as
// "allowlist OR prefix" reports inheritable for a name the adapter drops.
function buildInheritPredicate(allowlistSrc) {
  const block = (re, label) => {
    const found = allowlistSrc.match(re)?.[0];
    assert.ok(found, `could not locate the adapter ${label} declaration`);
    return setEntries(found);
  };
  const deny = block(/SERVER_ONLY_ENV_DENY[\s\S]*?\n\]\);/, "SERVER_ONLY_ENV_DENY");
  const exact = block(/AGENT_ENV_ALLOWLIST[\s\S]*?\n\]\);/, "AGENT_ENV_ALLOWLIST");
  const prefixes = block(/AGENT_ENV_ALLOWED_PREFIXES[\s\S]*?\n\];/, "AGENT_ENV_ALLOWED_PREFIXES");

  return (name) =>
    !deny.includes(name) &&
    (exact.includes(name) || prefixes.some((prefix) => name.startsWith(prefix)));
}

// Literals that are deliberately NOT inherited, because the worker process is
// their only reader. The guard below asserts inheritability, which is the right
// invariant for a name placed here to reach agent Jobs (PENSTOCK_READY_TIMEOUT_MS)
// and the wrong one for a name that configures the worker itself: the allowlist
// is a credential-disclosure boundary (inherit-allowlist.ts), so widening it to
// satisfy a test would spend real security budget on a value no agent reads.
//
// Membership here is the deliberate edit, exactly as adding to the allowlist is.
// A new literal in neither list still fails the guard, which is the point.
const WORKER_ONLY_ENV_LITERALS = new Map([
  [
    // BLO-19123. Read once at worker startup by config.ts and consulted only
    // inside the heartbeat scheduler's drain block. Agent Jobs run no scheduler.
    "PAPERCLIP_STRANDED_RECOVERY_HAND_BACK_DRAIN_ENABLED",
    "server-side scheduler flag; no agent-side reader",
  ],
]);

test("every literal worker.extraEnv name is inheritable by agent Jobs", () => {
  const values = readFileSync(`${repoRoot}/${blockcastValues}`, "utf8");
  // ponytail: two known ceilings in this scan, both of which degrade QUIETLY
  // rather than erroring (BLO-34412) — `literals.length > 0` catches only TOTAL
  // truncation, so a partially-skipped block still reports green.
  //   1. the worker: capture ends at the first column-0 line, so a top-level
  //      comment between extraEnv entries truncates it;
  //   2. the literal regex requires `name:` before `value:` inside a mapping,
  //      which YAML does not guarantee.
  // Both are cheap to spot once written down. Upgrade path: parse the values
  // file with a real YAML loader once this test file has a dependency.
  const workerBlock = values.match(/^worker:\n((?:[ \t].*\n|\n)*)/m)?.[1];
  assert.ok(workerBlock, "worker: block not found in values.blockcast.yaml");

  // Literals only. valueFrom entries travel a separate path.
  const literals = [...workerBlock.matchAll(/- name: (\S+)\n\s+value:/g)].map((m) => m[1]);
  assert.ok(literals.length > 0, "expected at least one literal in worker.extraEnv");

  const inheritable = buildInheritPredicate(
    readFileSync(
      `${repoRoot}/vendor/paperclip-adapter-claude-k8s/src/server/inherit-allowlist.ts`,
      "utf8",
    ),
  );

  for (const name of literals) {
    if (WORKER_ONLY_ENV_LITERALS.has(name)) continue;
    assert.ok(
      inheritable(name),
      `worker.extraEnv sets ${name}, but the adapter will not inherit it — ` +
        `no agent pod will ever see the value. If the worker is its only reader, ` +
        `add it to WORKER_ONLY_ENV_LITERALS with the reason instead of widening ` +
        `the adapter allowlist`,
    );
  }

  // The exemption list must not outlive its entries: a name left here after the
  // values file stops setting it reads as a reviewed decision about a literal
  // that no longer exists, and would silently exempt it if it ever came back.
  for (const name of WORKER_ONLY_ENV_LITERALS.keys()) {
    assert.ok(
      literals.includes(name),
      `WORKER_ONLY_ENV_LITERALS exempts ${name}, which worker.extraEnv no longer sets`,
    );
  }
});

// Negative controls for the predicate above. The guard scrapes the real
// allowlist, so these are the only place the deny-shadowing and commented-name
// cases can be exercised: today's source happens to contain neither, which is
// exactly why the un-fixed guard read green on both.
test("SERVER_ONLY_ENV_DENY beats the allowlist and the prefix families", () => {
  const inheritable = buildInheritPredicate(`
export const SERVER_ONLY_ENV_DENY: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "ANTHROPIC_ADMIN_KEY",
]);
export const AGENT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "PAPERCLIP_API_URL",
]);
export const AGENT_ENV_ALLOWED_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
];
`);

  // Both of these pass a predicate that omits the deny check.
  assert.equal(inheritable("DATABASE_URL"), false, "deny must beat the exact allowlist");
  assert.equal(inheritable("ANTHROPIC_ADMIN_KEY"), false, "deny must beat a prefix family");

  assert.equal(inheritable("PAPERCLIP_API_URL"), true);
  assert.equal(inheritable("ANTHROPIC_AUTH_TOKEN"), true);
});

test("a name quoted only in a comment is not a set entry", () => {
  const inheritable = buildInheritPredicate(`
export const SERVER_ONLY_ENV_DENY: ReadonlySet<string> = new Set([
  // "PENSTOCK_READY_TIMEOUT_MS" was considered here and rejected.
  "DATABASE_URL",
]);
export const AGENT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // "PENSTOCK_RUNTIME_TOKEN" stays denied.
  "PENSTOCK_READY_TIMEOUT_MS",
]);
export const AGENT_ENV_ALLOWED_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
];
`);

  // Substring membership reads both comments as entries, and gets both wrong.
  assert.equal(inheritable("PENSTOCK_RUNTIME_TOKEN"), false, "a comment must not admit a name");
  assert.equal(inheritable("PENSTOCK_READY_TIMEOUT_MS"), true, "a comment must not deny a name");
});

// BLO-19123. The drain returns mis-owned recovery rows to their real owner. Its
// block in index.ts sits inside `if (config.heartbeatSchedulerEnabled)`, and
// config.ts forces that false whenever PAPERCLIP_NODE_ROLE=api — so setting this
// flag on the API Deployment is read, stored, and never consulted. That failure
// deploys green: clean rollout, correct deployed-commit, zero rows drained, and
// nothing to distinguish it from a drain that ran and found no work. Assert the
// placement rather than merely the presence.
test("the hand-back drain flag is enabled on the scheduler tier only", () => {
  const worker = render("templates/statefulset.yaml");
  assert.match(
    worker,
    /- name: PAPERCLIP_STRANDED_RECOVERY_HAND_BACK_DRAIN_ENABLED\s+value: "true"/,
    'worker must enable the drain with the literal string "true" — config.ts compares === "true"',
  );
  // The gate this tier must satisfy for the flag to mean anything.
  assert.match(worker, /- name: PAPERCLIP_NODE_ROLE\s+value: worker/);

  const api = render("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
    "--set",
    "persistence.existingClaim=paperclip-shared",
  ]);
  assert.doesNotMatch(
    api,
    /PAPERCLIP_STRANDED_RECOVERY_HAND_BACK_DRAIN_ENABLED/,
    "the API tier runs no scheduler; the flag there is a silent no-op",
  );
});
