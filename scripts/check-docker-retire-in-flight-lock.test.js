import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");
const approveScriptPath = path.join(repoRoot, "scripts/approve-paperclip-api-digest.sh");

// BLO-31666. `approve-paperclip-api-digest.sh` holds an in-flight lock from the
// moment it rotates the approval ring until that digest's rollout lands, and
// only a landing rollout releases it. A deploy that dies between the approval
// step and `helm upgrade` therefore strands a lock for a digest that was never
// applied, and every subsequent production deploy is refused at admission.
// Run 33763503004 died in the pending-migration pre-flight; run 33810092507 was
// then refused against the lock it left behind (BLO-31598).
//
// The fix is a cleanup step that retires the lock THIS job took, and only when
// `helm upgrade` never executed. That condition is the entire design: a failure
// during or after helm may leave a rollout genuinely in flight, and retiring
// that lock would let a competing release rotate the ring underneath a landing
// one -- exactly what the lock exists to prevent.
//
// So this file executes rather than reads. #1636's review showed two
// presence-only assertions passing against mutated code (an inverted-polarity
// guard, and a condition gutted to `if false; then`), which is why the guard
// matrix below runs the step's real shell and the retirement tests below run the
// real script against a fake cluster.

const VALID_DIGEST = `sha256:${"a".repeat(64)}`;
const VALID_OWNER = "b".repeat(64);
const OTHER_DIGEST = `sha256:${"d".repeat(64)}`;
const OTHER_OWNER = "e".repeat(64);

const LOCK_ANNOTATIONS = [
  "paperclip.blockcast.net/approval-in-flight-digest",
  "paperclip.blockcast.net/approval-in-flight-plan-sha256",
  "paperclip.blockcast.net/approval-in-flight-deployment-uid",
  "paperclip.blockcast.net/approval-in-flight-deployment-generation",
  "paperclip.blockcast.net/approval-in-flight-rollout-marker",
  "paperclip.blockcast.net/approval-in-flight-server-plan-sha256",
  "paperclip.blockcast.net/approval-in-flight-owner",
];

// ---------------------------------------------------------------------------
// The guard, executed
// ---------------------------------------------------------------------------

// Extracted between explicit markers rather than by matching the condition
// text, so rewording a message cannot silently reduce this to testing nothing:
// a missing marker throws here instead.
function extractGuard() {
  const beginMarker = "# BEGIN RETIRE_IN_FLIGHT_LOCK_GUARD";
  const endMarker = "# END RETIRE_IN_FLIGHT_LOCK_GUARD";
  const start = workflow.indexOf(beginMarker);
  assert.notEqual(start, -1, `could not locate ${beginMarker} in docker.yml`);
  const end = workflow.indexOf(endMarker, start);
  assert.notEqual(end, -1, `could not locate ${endMarker} in docker.yml`);

  const body = workflow
    .slice(start + beginMarker.length, end)
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");

  // Both `exit 0` paths in the guard are no-ops, so reaching this line is the
  // observable "the lock is about to be retired" decision. Its ABSENCE is the
  // assertion for every row that must preserve the lock.
  return `set -euo pipefail\n${body}\necho REACHED_RETIRE\n`;
}

function runGuard({
  owner = VALID_OWNER,
  digest = VALID_DIGEST,
  helmConclusion,
  helmStarted = "",
}) {
  const guard = extractGuard();
  try {
    const stdout = execFileSync("bash", ["-c", guard], {
      env: {
        PATH: process.env.PATH,
        LOCK_OWNER: owner,
        LOCK_DIGEST: digest,
        HELM_CONCLUSION: helmConclusion,
        HELM_STARTED: helmStarted,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, retires: stdout.includes("REACHED_RETIRE"), stdout };
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    return { code: error.status ?? 1, retires: stdout.includes("REACHED_RETIRE"), stdout };
  }
}

test("only a minted lock whose helm step never ran is retired", () => {
  // Both directions matter. A guard that always refuses would "preserve" every
  // dangerous row and still be completely broken -- it would leave the wedge
  // this fix exists to prevent -- so the accepting rows are as load-bearing as
  // the rejecting ones. An inverted polarity fails on the accepting rows; a
  // gutted condition fails on the rejecting ones.
  //
  // The guard reads TWO signals because neither is sufficient alone: the helm
  // step's own start marker (positive evidence, but can be lost if the runner
  // is killed) and the step conclusion (survives that, but a never-started step
  // may be reported as `skipped` OR as absent). Retirement requires both to say
  // the step never ran.
  const rows = [
    // The two shapes of "helm never started". Both must retire, because both are
    // the real incident: the pre-flight failed and the cluster was never
    // touched. `skipped` is what the UI shows; empty is what the steps context
    // may hold for a step that never ran, and treating that as "unknown, so
    // preserve" would silently disable this whole fix.
    { label: "minted lock, helm skipped", helmConclusion: "skipped", retires: true },
    { label: "minted lock, helm absent from context", helmConclusion: "", retires: true },

    // helm ran. A rollout may be in flight or already landed; the lock is not
    // ours to retire even though the job failed.
    { label: "helm succeeded", helmConclusion: "success", helmStarted: "true", retires: false },
    { label: "helm failed", helmConclusion: "failure", helmStarted: "true", retires: false },
    // The most dangerous row: --atomic may still be rolling the release back,
    // and the marker may not have survived the kill -- so the conclusion is the
    // only thing standing between this and a retired lock under a live rollout.
    { label: "helm cancelled, marker lost", helmConclusion: "cancelled", retires: false },
    // The mirror of that row: the marker survived but the conclusion did not.
    { label: "helm started, conclusion lost", helmConclusion: "", helmStarted: "true", retires: false },
    // Contradictory signals. The marker is positive evidence, so it wins, and
    // "preserve" is the direction that fails safely.
    { label: "helm marked started yet skipped", helmConclusion: "skipped", helmStarted: "true", retires: false },
    // An unrecognised conclusion must not be read as "did not run".
    { label: "unknown helm conclusion", helmConclusion: "neutral", retires: false },

    // Nothing was minted. An ADOPTED lock leaves the owner empty precisely
    // because its rollout may still be running, so this row is a real safety
    // case and not just an early return.
    { label: "no lock minted", helmConclusion: "skipped", owner: "", retires: false },
    { label: "owner without digest", helmConclusion: "skipped", digest: "", retires: false },
  ];

  for (const row of rows) {
    const result = runGuard(row);
    assert.equal(result.code, 0, `${row.label}: guard must not fail the job, got ${result.code}`);
    assert.equal(
      result.retires,
      row.retires,
      `${row.label}: expected retire=${row.retires}, got ${result.retires}\n${result.stdout}`,
    );
  }
});

test("the guard says which signal made it decline", () => {
  // A cleanup step that silently declines is indistinguishable from one that
  // never ran, and the failure it is declining on surfaces later as a confusing
  // admission refusal on someone else's deploy. Whoever reads the log needs the
  // reason, and the two signals fail for different reasons.
  const byConclusion = runGuard({ helmConclusion: "failure" });
  assert.match(byConclusion.stdout, /concluded 'failure'/);
  assert.match(byConclusion.stdout, /intact/);

  const byMarker = runGuard({ helmConclusion: "", helmStarted: "true" });
  assert.match(byMarker.stdout, /started/);
  assert.match(byMarker.stdout, /intact/);
});

// ---------------------------------------------------------------------------
// The retirement itself, executed against a fake cluster
// ---------------------------------------------------------------------------

function lockedConfigMap({ digest, owner }) {
  const annotations = {
    "paperclip.blockcast.net/approval-in-flight-digest": digest,
    "paperclip.blockcast.net/approval-in-flight-plan-sha256": "f".repeat(64),
    "paperclip.blockcast.net/approval-in-flight-deployment-uid": "a-uid",
    "paperclip.blockcast.net/approval-in-flight-deployment-generation": "7",
    "paperclip.blockcast.net/approval-in-flight-rollout-marker": "9".repeat(64),
    "paperclip.blockcast.net/approval-in-flight-server-plan-sha256": "",
    "paperclip.blockcast.net/approval-in-flight-owner": owner,
    // Must survive: retirement clears the lock, not the object.
    "kubectl.kubernetes.io/last-applied-configuration": "{}",
  };
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "paperclip-api-approved-images",
      namespace: "paperclip-release-approvals",
      // Rides along into `kubectl replace`, which is what makes the write
      // optimistic-concurrency guarded rather than a blind clobber.
      resourceVersion: "4242",
      annotations,
    },
    data: { approvedDigests: `${digest}\n${OTHER_DIGEST}` },
  };
}

// A fake `kubectl` that serves one ConfigMap and records any replace. Real jq
// and real bash; only the cluster is stubbed, so the script under test is the
// shipping one, byte for byte.
function runRetire({ liveConfigMap, digest, owner }) {
  const dir = mkdtempSync(path.join(tmpdir(), "retire-lock-"));
  const binDir = path.join(dir, "bin");
  execFileSync("mkdir", ["-p", binDir]);
  const statePath = path.join(dir, "configmap.json");
  const replacedPath = path.join(dir, "replaced.json");
  if (liveConfigMap !== null) {
    writeFileSync(statePath, JSON.stringify(liveConfigMap));
  }

  const fakeKubectl = path.join(binDir, "kubectl");
  writeFileSync(
    fakeKubectl,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "replace" ]; then',
      '  cat > "${FAKE_REPLACED}"',
      "  exit 0",
      "fi",
      '# Anything else is the scoped `get`. An absent state file stands in for a',
      '# ConfigMap the approver credential cannot read.',
      'if [ ! -f "${FAKE_STATE}" ]; then exit 1; fi',
      'cat "${FAKE_STATE}"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeKubectl, 0o755);

  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync("bash", [approveScriptPath], {
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: dir,
        FAKE_STATE: statePath,
        FAKE_REPLACED: replacedPath,
        PAPERCLIP_APPROVAL_RETIRE_IN_FLIGHT_ONLY: "1",
        PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT: digest,
        PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER: owner,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    code = error.status ?? 1;
    stdout = String(error.stdout ?? "");
    stderr = String(error.stderr ?? "");
  }

  return {
    code,
    stdout,
    stderr,
    wrote: existsSync(replacedPath),
    written: existsSync(replacedPath)
      ? JSON.parse(readFileSync(replacedPath, "utf8"))
      : null,
  };
}

test("a matching digest+owner pair retires exactly the lock and nothing else", () => {
  const live = lockedConfigMap({ digest: VALID_DIGEST, owner: VALID_OWNER });
  const result = runRetire({ liveConfigMap: live, digest: VALID_DIGEST, owner: VALID_OWNER });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.wrote, "the matching lock must actually be written away");

  // Every constituent annotation, not just the owner. A retirement that clears
  // the owner but leaves the digest behind still wedges the channel -- the
  // digest field is what the next approval refuses on -- while reporting
  // success, which is strictly worse than not running at all.
  for (const key of LOCK_ANNOTATIONS) {
    assert.equal(
      result.written.metadata.annotations[key],
      undefined,
      `${key} survived the retirement`,
    );
  }

  // The ring is legitimately approved and bounded; dropping entries here could
  // evict a rollback target.
  assert.deepEqual(result.written.data, live.data, "the approval ring must be untouched");
  assert.equal(
    result.written.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"],
    "{}",
    "unrelated annotations must be untouched",
  );
  // Without this the write is a blind clobber that can erase a concurrent
  // release's lock.
  assert.equal(result.written.metadata.resourceVersion, "4242");
});

test("a lock this run did not take is never retired, and that is not an error", () => {
  // The pairing rule. Digest alone is insufficient because a configuration-only
  // release legitimately reuses a digest, so the owner is the identifying half;
  // and the owner alone would be matched against the wrong transaction. Each row
  // below agrees with the live lock on exactly one half of the pair.
  const rows = [
    {
      label: "same digest, another run's owner",
      liveConfigMap: lockedConfigMap({ digest: VALID_DIGEST, owner: OTHER_OWNER }),
      digest: VALID_DIGEST,
      owner: VALID_OWNER,
    },
    {
      label: "our owner, but the lock moved to another digest",
      liveConfigMap: lockedConfigMap({ digest: OTHER_DIGEST, owner: VALID_OWNER }),
      digest: VALID_DIGEST,
      owner: VALID_OWNER,
    },
    {
      label: "no lock held at all",
      liveConfigMap: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "paperclip-api-approved-images",
          namespace: "paperclip-release-approvals",
          resourceVersion: "1",
          annotations: {},
        },
        data: { approvedDigests: VALID_DIGEST },
      },
      digest: VALID_DIGEST,
      owner: VALID_OWNER,
    },
  ];

  for (const row of rows) {
    const result = runRetire(row);
    // Exit 0: the caller is a cleanup step on an already-failing job. "Nothing
    // to retire" turned into a second red step would bury the real failure.
    assert.equal(result.code, 0, `${row.label}: expected a clean no-op\n${result.stderr}`);
    assert.equal(result.wrote, false, `${row.label}: wrote to the approval ConfigMap`);
    assert.match(result.stdout, /nothing to retire/, `${row.label}: must say why it declined`);
  }
});

test("an unreadable approval ConfigMap fails loudly instead of claiming success", () => {
  // A caller that cannot read the lock cannot conclude anything about it.
  // Reporting success here would leave the wedge in place while telling the
  // operator it was cleared, which is the one outcome worse than the wedge.
  const result = runRetire({ liveConfigMap: null, digest: VALID_DIGEST, owner: VALID_OWNER });
  assert.notEqual(result.code, 0, "an unreadable ConfigMap must not report success");
  assert.equal(result.wrote, false);
  assert.match(result.stderr, /cannot read/);
});

test("retire-only mode refuses ambiguous or half-supplied input", () => {
  // Positional arguments are refused because the digest would then be supplied
  // in two places and could disagree with itself, which is the ambiguity the
  // digest+owner pairing rule exists to eliminate.
  const withArgs = (() => {
    try {
      execFileSync("bash", [approveScriptPath, VALID_DIGEST, "plan.json"], {
        env: {
          PATH: process.env.PATH,
          PAPERCLIP_APPROVAL_RETIRE_IN_FLIGHT_ONLY: "1",
          PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT: VALID_DIGEST,
          PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER: VALID_OWNER,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stderr: "" };
    } catch (error) {
      return { code: error.status ?? 1, stderr: String(error.stderr ?? "") };
    }
  })();
  assert.equal(withArgs.code, 2);
  assert.match(withArgs.stderr, /no positional arguments/);

  // Half a pair cannot name a lock. Rejected rather than treated as a no-op, so
  // a workflow that wires only one half is a hard failure and not a cleanup
  // step that silently never retires anything.
  for (const half of [
    { PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT: VALID_DIGEST },
    { PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER: VALID_OWNER },
    {},
  ]) {
    let code = 0;
    try {
      execFileSync("bash", [approveScriptPath], {
        env: {
          PATH: process.env.PATH,
          PAPERCLIP_APPROVAL_RETIRE_IN_FLIGHT_ONLY: "1",
          ...half,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      code = error.status ?? 1;
    }
    assert.equal(code, 2, `half-supplied pair ${JSON.stringify(half)} must be refused`);
  }
});

// ---------------------------------------------------------------------------
// Wiring that cannot silently disappear
// ---------------------------------------------------------------------------

test("the workflow wires the owner handoff and the helm conclusion the guard reads", () => {
  // The guard above is exercised for real, but it reads two values the workflow
  // must supply. Either one silently becoming "" disables the cleanup entirely
  // while every executable assertion above still passes, because the guard
  // would then be correctly declining on empty input.
  assert.match(
    workflow,
    /PAPERCLIP_APPROVAL_LOCK_OWNER_OUT="\$\{lock_owner_file\}"/,
    "the approval step must ask the script for the owner of the lock it minted",
  );
  assert.match(
    workflow,
    /^ {8}id: helm$/m,
    "the helm upgrade step needs id: helm or steps.helm.conclusion is always empty",
  );
  assert.match(
    workflow,
    /HELM_CONCLUSION: \$\{\{ steps\.helm\.conclusion \}\}/,
    "the cleanup step must read the helm step's conclusion",
  );
  assert.match(
    workflow,
    /HELM_STARTED: \$\{\{ steps\.helm\.outputs\.started \}\}/,
    "the cleanup step must read the helm step's start marker",
  );
  assert.match(
    workflow,
    /LOCK_OWNER: \$\{\{ steps\.approval\.outputs\.lock_owner \}\}/,
    "the cleanup step must read the owner the approval step published",
  );
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) \}\}/,
    "the cleanup must run on cancellation too -- a job timeout in the pre-flight strands a lock identically",
  );
});

test("the helm step records that it started before it can fail", () => {
  // The marker is the guard's positive-evidence signal, and it is only worth
  // anything if it lands before the first statement that can abort the step. A
  // marker written after the digest assertion would be missing for a step that
  // began and failed immediately, which the guard would then read as "never
  // ran".
  const helmRun = workflow.slice(workflow.indexOf("        id: helm"));
  const marker = helmRun.indexOf('echo "started=true" >> "$GITHUB_OUTPUT"');
  assert.notEqual(marker, -1, "the helm step must record that it started");
  const firstAssertion = helmRun.indexOf('[[ "${DIGEST}" =~');
  assert.notEqual(firstAssertion, -1, "could not find the helm step's digest assertion");
  assert.ok(
    marker < firstAssertion,
    "the start marker must be written before the first statement that can fail",
  );
});

test("the approval publishes the lock before it can fail on anything else", () => {
  // Ordering is a correctness property, not style. The stranding window opens
  // the instant the approval script exits 0, and that includes the remainder of
  // the approval step. Publishing the outputs after the plan verification would
  // leave a verification failure stranding a lock the cleanup step cannot name
  // -- the same wedge, one step earlier than the one this fix is about.
  const publishAnchor = 'echo "lock_owner=${lock_owner}"';
  const verifyAnchor = 'jq -e --arg namespace "${NS}" --arg digest "${DIGEST}"';
  const publish = workflow.indexOf(publishAnchor);
  const verify = workflow.indexOf(verifyAnchor);
  assert.notEqual(publish, -1, "could not find where the lock owner is published");
  assert.notEqual(verify, -1, "could not find the approved-plan verification");
  // Both anchors must be unique, or the comparison below could be reading a
  // different pair of occurrences than the ones that matter.
  assert.equal(workflow.indexOf(publishAnchor, publish + 1), -1, "publish anchor is not unique");
  assert.equal(workflow.indexOf(verifyAnchor, verify + 1), -1, "verify anchor is not unique");
  assert.ok(
    publish < verify,
    "the lock owner must be published BEFORE the approved-plan verification that can fail",
  );
});
