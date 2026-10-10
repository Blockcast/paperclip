import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADAPTER_REPO,
  SECRET_PUT_SYMBOL,
  WRAPPER_BIN_DIR,
  WRAPPER_PATCH_PATH,
  WRAPPER_PATH_GAP_ACCEPTED_PINS,
  classify,
  extractPin,
  nonTestHits,
} from "../check-opencode-k8s-pin-reachable.mjs";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

test("extractPin reads the vendor-stage pin the build checks out", () => {
  assert.equal(
    extractPin("FROM node\nARG OPENCODE_K8S_REF=2075ae1ba249e97c49a77386c81a9d88b22c481d\n"),
    "2075ae1ba249e97c49a77386c81a9d88b22c481d",
  );
  assert.equal(extractPin(dockerfile)?.length, 40, "live Dockerfile must expose a 40-hex pin");
});

test("extractPin rejects a pin the vendor stage could not check out", () => {
  // A branch name or short SHA is not reproducible and is not what the ARG
  // contract promises, so it must read as absent rather than pass through.
  assert.equal(extractPin("ARG OPENCODE_K8S_REF=master\n"), null);
  assert.equal(extractPin("ARG OPENCODE_K8S_REF=2075ae1\n"), null);
  assert.equal(extractPin("# ARG OPENCODE_K8S_REF=" + "a".repeat(40) + "\n"), null);
  assert.equal(extractPin("FROM node\n"), null);
});

test("a reachable pin passes", () => {
  const result = classify({ pin: "a".repeat(40), cloneOk: true, commitPresent: true });
  assert.equal(result.verdict, "ok");
  assert.equal(result.exitCode, 0);
});

test("an orphaned pin fails the PR and explains the cache-timed failure", () => {
  const pin = "87a865ded22d3ac4655b1c3fa1ad47473f23e7d8";
  const result = classify({ pin, cloneOk: true, commitPresent: false });
  assert.equal(result.verdict, "unreachable");
  assert.equal(result.exitCode, 1);
  assert.match(result.message, new RegExp(pin));
  // The message has to carry the two facts that make this diagnosable, because
  // the raw build error (`unable to read tree`) names neither: that a cache HIT
  // still passes, and that a squash-merge is the usual cause.
  assert.match(result.message, /cache/i);
  assert.match(result.message, /squash/i);
});

test("an unclonable repo warns but does NOT fail the PR", () => {
  // Fail-open on inconclusive is the whole safety design: this guard exists to
  // keep a broken pin from blocking deploys, so it must not itself become a way
  // for a network blip to block them.
  const result = classify({
    pin: "a".repeat(40),
    cloneOk: false,
    commitPresent: false,
    detail: "Could not resolve host: github.com",
  });
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /INCONCLUSIVE/);
  // ...but it must say so loudly, or a permanently-dead probe passes forever
  // and this whole class of failure is unguarded again without anyone noticing.
  assert.match(result.message, /guard is inert/i);
  assert.match(result.message, /Could not resolve host/);
});

test("a missing or malformed pin fails the PR", () => {
  const result = classify({ pin: null, cloneOk: false, commitPresent: false });
  assert.equal(result.verdict, "no-pin");
  assert.equal(result.exitCode, 1);
});

test("the verdict depends on reachability alone, never on distance from master", () => {
  // BLO-33204 regression. The issue's first-cut guard was "compare/master...REF
  // must be identical or behind", which rejects a pinned un-merged branch head.
  // 83197d46… read `diverged, ahead_by 1, behind_by 9` while master shipped it
  // for three days (2026-08-05 → 08-08) — the same status an orphan reads. So
  // `diverged` must be able to pass, and only ref-reachability may decide.
  const divergedButReachable = classify({
    pin: "83197d46b0784c941801165464d48aca1b979909",
    cloneOk: true,
    commitPresent: true,
  });
  assert.equal(divergedButReachable.verdict, "ok");

  // classify() takes no master/compare input at all, which is what makes the
  // false positive above structurally impossible rather than merely absent.
  assert.equal(classify.length, 1);
  const source = readFileSync(
    new URL("../check-opencode-k8s-pin-reachable.mjs", import.meta.url),
    "utf8",
  );
  // Comments are stripped first: the module's header deliberately DISCUSSES the
  // rejected compare-based approach, and gating on the raw text would fail for
  // documenting the trap it avoids.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /compare/, "must not gate on a compare status");
  assert.doesNotMatch(code, /ahead_by|behind_by|diverged/);
});

test("the guard probes the same repo the vendor stage clones", () => {
  assert.equal(ADAPTER_REPO, "kkroo/paperclip-adapter-opencode-k8s");
  assert.match(dockerfile, new RegExp(`clone https://github\\.com/${ADAPTER_REPO}\\.git`));
});

test("the guard is wired into BOTH a PR gate and a schedule", () => {
  // A guard wired nowhere is inert, and these two surfaces catch DIFFERENT
  // things — dropping either silently reopens half the hole.
  const invocation = /node \.\/scripts\/check-opencode-k8s-pin-reachable\.mjs/;

  // Pre-merge: stops someone pinning an already-unreachable commit.
  const pr = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");
  assert.match(pr, invocation, "pr.yml must run the reachability guard");

  // Scheduled: the pin rots retroactively from another repo with no commit
  // here, so no push/PR/merge_group trigger can observe it. This is the only
  // surface that catches the case that actually broke the deploy path.
  const monitor = readFileSync(
    new URL("../../.github/workflows/adapter-pin-drift-monitor.yml", import.meta.url),
    "utf8",
  );
  assert.match(monitor, invocation, "the drift monitor must run the reachability guard");
  assert.match(monitor, /^\s*- cron: /m, "the drift monitor must be scheduled, not only manual");
  assert.match(monitor, /ref: master/, "it must check master, not the default checkout");
});

// ---------------------------------------------------------------------------
// BLO-34510: the pinned tree must make no Secret PUT.
//
// `deploy/helm/paperclip/templates/role.yaml` retired `secrets: update`
// because the pinned adapter makes no `replaceNamespacedSecret` call. That is
// a property of THE PIN, so a bump can revoke it with nothing to review but a
// 40-hex number, and the resulting 403 is runtime-only and collision-timed.
// ---------------------------------------------------------------------------

// Real `git grep -n <tree-ish> -- src` output shape, captured from the live
// adapter at the current pin against `patchNamespacedSecret` — a symbol that
// genuinely occurs in BOTH test and non-test sources, so this fixture
// exercises the filter in both directions rather than only the easy one.
// Measured 2026-10-07: 7 raw hits, exactly 1 of them non-test.
const GREP_FIXTURE = [
  "src/server/execute.test.ts:414:    patchNamespacedSecret: vi.fn().mockResolvedValue({}),",
  "src/server/execute.test.ts:948:      patchNamespacedSecret: vi.fn().mockResolvedValue({}),",
  "src/server/execute.test.ts:1339:    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledTimes(2);",
  "src/server/execute.ts:1052:    await coreApi.patchNamespacedSecret({",
];

test("nonTestHits keeps real call sites and drops mocks", () => {
  // Over-match control: without the filter a `vi.fn()` stub reads as a
  // consumer, and the adapter's tests legitimately name the symbol while
  // asserting it is never called. Six of seven live hits are mocks, so an
  // unfiltered guard is a false-positive factory that blocks every pin bump.
  assert.deepEqual(nonTestHits(GREP_FIXTURE), ["src/server/execute.ts:1052:    await coreApi.patchNamespacedSecret({"]);

  // Under-match control: the filter must key on the TEST-FILE suffix, not on
  // the word "test" appearing anywhere in the path, or a real call site under
  // e.g. src/server/test-harness.ts is silently exempted.
  assert.deepEqual(
    nonTestHits(["src/server/test.ts:90:  replaceNamespacedSecret(", "src/testing/secrets.ts:4:  replaceNamespacedSecret("]),
    ["src/server/test.ts:90:  replaceNamespacedSecret(", "src/testing/secrets.ts:4:  replaceNamespacedSecret("],
  );

  assert.deepEqual(nonTestHits([]), []);
  assert.deepEqual(nonTestHits(["", "   "]), []);
  assert.deepEqual(nonTestHits([
    "src/execute.spec.ts:1: replaceNamespacedSecret(",
    "src/__tests__/execute.ts:1: replaceNamespacedSecret(",
    "src/__mocks__/k8s.ts:1: replaceNamespacedSecret(",
    "src/execute.ts:1: // src/__tests__/execute.ts",
  ]), ["src/execute.ts:1: // src/__tests__/execute.ts"]);
});

test("the CLI distinguishes empty results from failed Git subprocesses", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "pin-guard-cli-test-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const pin = "a".repeat(40);
  const fixtureDockerfile = join(scratch, "Dockerfile");
  writeFileSync(fixtureDockerfile, `ARG OPENCODE_K8S_REF=${pin}\n`);
  // A second fixture pinned to an ACCEPTED SHA. The accepted-gap verdict is
  // keyed to the pin itself, so it is unreachable from the fixture above at
  // any setting — and it is the verdict the live pin produces today.
  const acceptedDockerfile = join(scratch, "Dockerfile.accepted");
  if (ACCEPTED_PIN) writeFileSync(acceptedDockerfile, `ARG OPENCODE_K8S_REF=${ACCEPTED_PIN}\n`);
  // Exercise the real execFileSync catch path without network access.
  writeFileSync(join(scratch, "git"), `#!/bin/sh
case "$1" in clone) exit 0;; esac
case "$3" in
  cat-file) exit 0;;
  ls-tree) printf '%s\\n' "$PIN_GUARD_TEST_FILES"; exit "$PIN_GUARD_TEST_TREE_STATUS";;
  grep)
    # Two greps run over the same tree now (PEN-3732), and they are judged in
    # OPPOSITE directions — a Secret-PUT hit is the finding, a wrapper-PATH
    # MISS is. Dispatch on the search pattern ($6) so a stub answering both
    # with one fixture cannot make an empty Secret-PUT search read as a
    # missing prepend.
    if [ "$6" = "${WRAPPER_BIN_DIR}" ]; then
      if [ "$PIN_GUARD_TEST_WRAPPER_STATUS" = signal ]; then kill -TERM "$$"; fi
      printf '%s\\n' "$PIN_GUARD_TEST_WRAPPER_HITS"
      exit "$PIN_GUARD_TEST_WRAPPER_STATUS"
    fi
    if [ "$PIN_GUARD_TEST_GREP_STATUS" = signal ]; then kill -TERM "$$"; fi
    printf '%s\\n' "$PIN_GUARD_TEST_HITS"
    exit "$PIN_GUARD_TEST_GREP_STATUS";;
esac
exit 128
`, { mode: 0o755 });
  const script = fileURLToPath(new URL("../check-opencode-k8s-pin-reachable.mjs", import.meta.url));
  const cases = [
    { name: "grep exit 1 means no match", verdict: "OK", env: {} },
    { name: "a real call fails", verdict: "FAILED", env: { PIN_GUARD_TEST_GREP_STATUS: "0", PIN_GUARD_TEST_HITS: `${pin}:src/execute.ts:1: replaceNamespacedSecret(` } },
    { name: "a real call fails even when no counted source was found", verdict: "FAILED", env: { PIN_GUARD_TEST_FILES: "src/README.md", PIN_GUARD_TEST_GREP_STATUS: "0", PIN_GUARD_TEST_HITS: `${pin}:src/server/execute.go:12: replaceNamespacedSecret(` } },
    { name: "JS sources count as searched", verdict: "OK", env: { PIN_GUARD_TEST_FILES: "src/execute.js" } },
    { name: "grep exit 128 is not clean", env: { PIN_GUARD_TEST_GREP_STATUS: "128" } },
    { name: "a signalled grep is not clean", env: { PIN_GUARD_TEST_GREP_STATUS: "signal" } },
    { name: "ls-tree exit 128 is not clean", env: { PIN_GUARD_TEST_TREE_STATUS: "128" } },
    { name: "ls-tree exit 1 is not a no-match result", env: { PIN_GUARD_TEST_TREE_STATUS: "1" } },
    { name: "assets do not establish searched sources", env: { PIN_GUARD_TEST_FILES: "src/README.md\nsrc/icon.svg" } },
    { name: "test-only sources do not establish searched sources", env: { PIN_GUARD_TEST_FILES: "src/execute.test.ts\nsrc/execute.spec.ts\nsrc/__tests__/execute.ts\nsrc/__mocks__/k8s.ts" } },
    // PEN-3732. An unaccepted pin with no prepend is a definite finding; a
    // wrapper grep that could not run is not, and must not fail the bump.
    { name: "an unaccepted pin missing the prepend fails", verdict: "FAILED", env: { PIN_GUARD_TEST_WRAPPER_STATUS: "1", PIN_GUARD_TEST_WRAPPER_HITS: "" } },
    { name: "a failed wrapper grep is not a missing prepend", env: { PIN_GUARD_TEST_WRAPPER_STATUS: "128", PIN_GUARD_TEST_WRAPPER_HITS: "" } },
    { name: "a signalled wrapper grep is not a missing prepend", env: { PIN_GUARD_TEST_WRAPPER_STATUS: "signal", PIN_GUARD_TEST_WRAPPER_HITS: "" } },
    { name: "a test-only mention of the wrapper dir is not the prepend", verdict: "FAILED", env: { PIN_GUARD_TEST_WRAPPER_STATUS: "0", PIN_GUARD_TEST_WRAPPER_HITS: `${pin}:src/server/job-manifest.test.ts:9:${WRAPPER_BIN_DIR}` } },
    // The one verdict the LIVE pin produces. classify() covers it, but without
    // this the CLI path did not — and the accepted-gap branch is exactly the
    // one whose output a reader has to keep seeing for the gap to stay
    // re-decided. Conditional because README step 3 empties the accepted set
    // once upstream carries the fix, after which this verdict is unreachable.
    ...(ACCEPTED_PIN
      ? [{
          name: "the accepted gap warns through the CLI and does not fail the bump",
          verdict: "ACCEPTED GAP",
          dockerfile: acceptedDockerfile,
          env: { PIN_GUARD_TEST_WRAPPER_STATUS: "1", PIN_GUARD_TEST_WRAPPER_HITS: "" },
        }]
      : []),
  ];
  for (const { name, verdict = "inconclusive", dockerfile: caseDockerfile, env } of cases) {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH}`,
        OPENCODE_PIN_GUARD_DOCKERFILE: caseDockerfile || fixtureDockerfile,
        PIN_GUARD_TEST_FILES: "src/execute.ts\nsrc/execute.test.ts\nsrc/README.md",
        PIN_GUARD_TEST_TREE_STATUS: "0",
        PIN_GUARD_TEST_GREP_STATUS: "1",
        PIN_GUARD_TEST_HITS: "",
        // Default: the pinned tree DOES carry the prepend, so these cases keep
        // exercising the Secret-PUT semantics they were written for.
        PIN_GUARD_TEST_WRAPPER_STATUS: "0",
        PIN_GUARD_TEST_WRAPPER_HITS: `${pin}:src/server/job-manifest.ts:130:${WRAPPER_BIN_DIR}`,
        ...env,
      },
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, verdict === "FAILED" ? 1 : 0, `${name}: ${output}`);
    assert.match(output, new RegExp(`opencode_k8s pin guard ${verdict}`), name);
    if (verdict !== "OK") assert.doesNotMatch(output, /pin guard OK/, name);
    else assert.match(output, /1 non-test source file/, name);
  }
});

test("a pin that reintroduces a Secret PUT fails the bump", () => {
  const result = classify({
    pin: "b".repeat(40),
    cloneOk: true,
    commitPresent: true,
    srcFileCount: 17,
    secretPutHits: ["src/server/execute.ts:1052:  await coreApi.replaceNamespacedSecret({"],
  });
  assert.equal(result.verdict, "secret-put");
  assert.equal(result.exitCode, 1);
  // The offending line must be IN the message: the reviewer is looking at a
  // diff that changed one hex string and has no other way to see the cause.
  assert.match(result.message, /execute\.ts:1052/);
  assert.match(result.message, new RegExp(SECRET_PUT_SYMBOL));
  // ...and it must name the retired verb and both exits, or the only obvious
  // move is to re-grant the privilege quietly to make CI green.
  assert.match(result.message, /secrets: update/);
  assert.match(result.message, /BLO-34510/);
  assert.match(result.message, /merge PATCH/);
  assert.match(result.message, /role-rbac\.test\.mjs/);
});

test("a clean pin reports how many files it actually searched", () => {
  const result = classify({
    pin: "a".repeat(40),
    cloneOk: true,
    commitPresent: true,
    srcFileCount: 17,
    secretPutHits: [],
  });
  assert.equal(result.verdict, "ok");
  assert.equal(result.exitCode, 0);
  // A bare "no hits" is indistinguishable from a search that ran over nothing.
  // Printing the denominator is what makes the pass readable as evidence.
  assert.match(result.message, /17 non-test source file/);
});

test("a search that found nothing to search is inconclusive, NOT clean", () => {
  // THE control this guard needs most. If the adapter moves its sources out of
  // `src/`, the grep matches nothing — which is byte-identical to a clean pin
  // and fails in the permissive direction, silently reopening the class while
  // printing a pass. Same shape as every other empty-filter trap in this repo.
  const result = classify({
    pin: "a".repeat(40),
    cloneOk: true,
    commitPresent: true,
    srcFileCount: 0,
    secretPutHits: [],
  });
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /INCONCLUSIVE/);
  assert.match(result.message, /inert/);
});

test("a real Secret PUT fails even when the file count is zero or failed", () => {
  // A non-empty hit set is self-evidencing: it proves the grep ran over
  // something, so the inert-search control (which reasons only about an empty
  // result) must not downgrade it to a warning. The grep has no extension
  // filter, so a hit can exist in a file the denominator does not count.
  for (const srcFileCount of [0, null]) {
    const result = classify({
      pin: "b".repeat(40),
      cloneOk: true,
      commitPresent: true,
      srcFileCount,
      secretPutHits: ["src/server/execute.js:12: await coreApi.replaceNamespacedSecret({"],
    });
    assert.equal(result.verdict, "secret-put", `srcFileCount=${srcFileCount}`);
    assert.equal(result.exitCode, 1, `srcFileCount=${srcFileCount}`);
    assert.match(result.message, /execute\.js:12/);
  }
});

test("reachability is judged before the Secret-PUT search, and clone failure before both", () => {
  // Ordering matters for the message, not the exit code: an orphaned pin
  // cannot be grepped, so reporting "no Secret PUT" about a tree that was
  // never fetched would be a claim with nothing behind it.
  const orphan = classify({
    pin: "c".repeat(40),
    cloneOk: true,
    commitPresent: false,
    srcFileCount: 0,
    secretPutHits: [],
  });
  assert.equal(orphan.verdict, "unreachable");

  const unclonable = classify({
    pin: "c".repeat(40),
    cloneOk: false,
    commitPresent: false,
    srcFileCount: 0,
    secretPutHits: [],
  });
  assert.equal(unclonable.verdict, "inconclusive");
  assert.match(unclonable.message, /could not clone/);
});

test("the retirement this guard protects is actually in the chart", () => {
  // The guard and the Role are two halves of one decision. If someone re-adds
  // `update` without removing this guard, the guard starts failing bumps for a
  // verb that is granted again — noise that trains people to ignore it.
  const role = readFileSync(
    new URL("../../deploy/helm/paperclip/templates/role.yaml", import.meta.url),
    "utf8",
  );
  const verbs = role.match(/resources: \["secrets"\]\n\s*verbs: \[([^\]]*)\]/)?.[1];
  assert.ok(verbs, "role.yaml must render a secrets rule");
  assert.doesNotMatch(verbs, /"update"/, "secrets:update is retired (BLO-34510)");
  assert.match(verbs, /"patch"/, "patch is what replaced it and must stay");
});

test("the wrapper directory this guard greps is the one the chart pins", () => {
  // The patch names one directory in three places; a value that drifts becomes
  // a PATH entry no image carries. If the chart's directory moves, the guard
  // would grep a stale literal and find 0 hits forever.
  const helpers = readFileSync(
    new URL("../../deploy/helm/paperclip/templates/_helpers.tpl", import.meta.url),
    "utf8",
  );
  const body = helpers.match(
    /\{\{-? define "paperclip\.imageWrapperBinDir" -?\}\}\n([^\n]*)\n\{\{-? end -?\}\}/,
  )?.[1];
  assert.ok(body, "_helpers.tpl must define paperclip.imageWrapperBinDir");
  assert.equal(body.trim(), WRAPPER_BIN_DIR);
});

// PEN-3732 — the wrapper-PATH property. Its control runs the OPPOSITE way round
// from the Secret-PUT one above: there a HIT is the finding, here an EMPTY
// result is, so an unrun or inert search must never be read as a finding.
const WRAPPED = { cloneOk: true, commitPresent: true, srcFileCount: 5, secretPutHits: [] };
const ACCEPTED_PIN = [...WRAPPER_PATH_GAP_ACCEPTED_PINS][0];

test("a pin that names the wrapper directory passes, and says only that", () => {
  const result = classify({
    ...WRAPPED,
    pin: "b".repeat(40),
    wrapperPathHits: ["src/server/job-manifest.ts:120:const X = ..."],
  });
  assert.equal(result.verdict, "ok");
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /references .*libexec\/paperclip\/bin/);
  // A presence hit must not read as an ordering attestation (Ally, #2392).
  assert.match(result.message, /does not attest that the directory is PREPENDED/);
});

test("the measured, accepted gap warns at its own SHA without failing the PR", () => {
  const result = classify({ ...WRAPPED, pin: ACCEPTED_PIN, wrapperPathHits: [] });
  assert.equal(result.verdict, "wrapper-path-accepted-gap");
  assert.equal(result.exitCode, 0);
  // The remedy must be reachable from the message; a gap nobody can act on is
  // one that stays open.
  assert.ok(result.message.includes(WRAPPER_PATCH_PATH));
});

test("carrying that gap to a NEW pin fails the bump", () => {
  // This is the whole point of keying the acceptance to a SHA: the gap was
  // accepted on evidence about one tree, and a bump re-opens that decision.
  const result = classify({ ...WRAPPED, pin: "c".repeat(40), wrapperPathHits: [] });
  assert.equal(result.verdict, "wrapper-path-missing");
  assert.equal(result.exitCode, 1);
  assert.ok(result.message.includes(WRAPPER_BIN_DIR));
  assert.ok(result.message.includes(WRAPPER_PATCH_PATH));
});

test("a FAILED wrapper search is inconclusive, never a missing prepend", () => {
  // Without this, a probe that cannot run manufactures the finding it is
  // supposed to detect — and would fail every bump on a network blip.
  const result = classify({ ...WRAPPED, pin: "c".repeat(40), wrapperPathHits: null });
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.exitCode, 0);
});

test("an inert search over an empty tree is inconclusive, never a missing prepend", () => {
  // Same failure, different cause: the adapter's layout moving out of src/
  // makes the grep match nothing, which is indistinguishable from a real gap.
  const result = classify({
    ...WRAPPED,
    srcFileCount: 0,
    pin: "c".repeat(40),
    wrapperPathHits: [],
  });
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.exitCode, 0);
});

test("a Secret PUT still outranks the wrapper-PATH verdict", () => {
  // Ordering matters: secret-put is self-evidencing (a hit), so it must not be
  // masked by an empty wrapper search on the same tree.
  const result = classify({
    ...WRAPPED,
    pin: "c".repeat(40),
    secretPutHits: ["src/server/x.ts:9:replaceNamespacedSecret"],
    wrapperPathHits: [],
  });
  assert.equal(result.verdict, "secret-put");
  assert.equal(result.exitCode, 1);
});

test("the accepted-gap SHA is the pin the Dockerfile actually carries", () => {
  // An acceptance keyed to a SHA nobody builds is inert, and would let the
  // live pin fail the guard for a reason that reads as a stale allowlist.
  assert.ok(
    WRAPPER_PATH_GAP_ACCEPTED_PINS.has(extractPin(dockerfile)) ||
      WRAPPER_PATH_GAP_ACCEPTED_PINS.size === 0,
    // Offline: this test cannot tell a pin that carries the fix from one that
    // does not, so its message must not claim to. Both remedies, in the order
    // the README gives them.
    "the live pin is not in the accepted set — if it carries the fix, drop the stale SHA " +
      "(emptying the set); if it does not, add it with the measurement that accepts the gap",
  );
});
