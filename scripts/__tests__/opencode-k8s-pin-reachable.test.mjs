import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ADAPTER_REPO,
  classify,
  extractPin,
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
