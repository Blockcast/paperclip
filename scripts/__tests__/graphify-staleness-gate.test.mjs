// Executes the real `run:` block of .github/workflows/graphify-staleness.yml
// against throwaway git repositories, with the step's `env:` expressions bound
// to the values GitHub would supply for a `pull_request` event.
//
// The case that matters: the graphify-reindex bot builds the graph at the base
// commit it branches off, so `built_at_commit` == `pull_request.base.sha` by
// construction, and that payload value never moves while the PR sits open
// (re-runs replay the same event). A gate that diffs against it can never fire
// for the producer it exists to police — Paperclip PR #1550 was 98 commits
// behind master with `staleness` green. The gate has to diff against the base
// branch tip it would merge into.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workflowText = readFileSync(
  new URL("../../.github/workflows/graphify-staleness.yml", import.meta.url),
  "utf8",
);

// The workflow has exactly one step with an `env:` map and a `run: |` block.
// No YAML dependency (see check-scheduled-guard-liveness.test.mjs): read both
// by indentation.
function extractStep(text) {
  const lines = text.split("\n");
  const runAt = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.notEqual(runAt, -1, "no `run: |` block in graphify-staleness.yml");
  assert.equal(
    lines.findIndex((l, i) => i > runAt && /^\s+run: \|\s*$/.test(l)),
    -1,
    "expected exactly one `run: |` block",
  );
  const keyIndent = lines[runAt].search(/\S/);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const bodyIndent = body.find((l) => l.trim()).search(/\S/);
  const script = body.map((l) => l.slice(bodyIndent)).join("\n");

  const envAt = lines.slice(0, runAt).findLastIndex((l) => /^\s+env:\s*$/.test(l));
  assert.notEqual(envAt, -1, "the gate step has no `env:` map");
  const env = {};
  for (const line of lines.slice(envAt + 1, runAt)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s+([A-Z_][A-Z0-9_]*):\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/);
    assert.ok(m, `unparsed env line: ${line}`);
    env[m[1]] = m[2];
  }
  return { script, env };
}

const STEP = extractStep(workflowText);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function commitFile(cwd, rel, content, msg) {
  mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  writeFileSync(path.join(cwd, rel), content);
  git(cwd, "add", rel);
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
}

// origin (bare) <- author pushes master; the runner clone checks out the PR
// commit detached, as actions/checkout does with the merge ref.
// `advance` commits to master AFTER the PR's event, i.e. what a re-run or a
// late run sees but `pull_request.base.sha` never does.
function scenario(t, advance, baseRef = "master", mode = "pristine") {
  const root = mkdtempSync(path.join(os.tmpdir(), "graphify-staleness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const author = path.join(root, "author");
  const runner = path.join(root, "runner");
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  git(root, "clone", "-q", origin, author);
  git(author, "symbolic-ref", "HEAD", "refs/heads/master");

  const base = commitFile(author, "server/src/a.ts", "export const a = 1;\n", "base");
  git(author, "push", "-q", "origin", "master");

  git(author, "checkout", "-q", "-b", "bot/graphify-reindex");
  const graph = JSON.stringify({ built_at_commit: base, nodes: [], links: [] });
  const pr = commitFile(author, "server/src/graphify-out/graph.json", graph, "graph");
  git(author, "checkout", "-q", "master");

  if (advance) {
    commitFile(author, advance.path, advance.content, "master moves on");
    git(author, "push", "-q", "origin", "master");
  }
  const tip = git(author, "rev-parse", "master");

  // `graphify` stamps built_at_commit with HEAD at build time, so the two
  // recovery shapes below differ only in WHERE the rebuild happened.
  let head = pr;
  if (mode === "merged") {
    // What `gh pr update-branch` does, then a rebuild in place: HEAD is the
    // merge commit, which is not on master, so built_at_commit leaves the base
    // line entirely.
    git(author, "checkout", "-q", "bot/graphify-reindex");
    git(author, "merge", "-q", "--no-edit", "master");
    const merge = git(author, "rev-parse", "HEAD");
    head = commitFile(
      author,
      "server/src/graphify-out/graph.json",
      JSON.stringify({ built_at_commit: merge, nodes: [], links: [] }),
      "rebuild in place on the updated branch",
    );
    git(author, "checkout", "-q", "master");
  } else if (mode === "regenerated") {
    // The documented recovery: one graph commit straight onto the base tip.
    git(author, "checkout", "-q", "-B", "bot/graphify-reindex", tip);
    head = commitFile(
      author,
      "server/src/graphify-out/graph.json",
      JSON.stringify({ built_at_commit: tip, nodes: [], links: [] }),
      "regenerate at the base tip",
    );
    git(author, "checkout", "-q", "master");
  }

  git(author, "push", "-q", "origin", `${head}:refs/pull/1/head`);
  git(root, "clone", "-q", origin, runner);
  git(runner, "fetch", "-q", "origin", "refs/pull/1/head");
  git(runner, "checkout", "-q", "--detach", head);
  // Leave the runner's remote-tracking ref at the event-time base, as a
  // single-branch or shallow checkout would: the gate must fetch the tip itself.
  git(runner, "update-ref", "refs/remotes/origin/master", base);

  const bindings = {
    "github.event.pull_request.base.sha": base,
    "github.base_ref": baseRef,
  };
  const env = { ...GIT_ENV };
  for (const [key, expr] of Object.entries(STEP.env)) {
    assert.ok(expr in bindings, `no test binding for \${{ ${expr} }} (${key})`);
    env[key] = bindings[expr];
  }
  const r = spawnSync("bash", ["-c", STEP.script], { cwd: runner, env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("fresh: base branch has not moved since the graph was built", (t) => {
  const r = scenario(t, null);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /OK: server\/src\/graphify-out\/graph\.json is fresh/);
});

test("stale: base tip changed graphed source after built_at_commit == base.sha", (t) => {
  const r = scenario(t, { path: "server/src/a.ts", content: "export const a = 2;\n" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /STALE graph — base changed 'server\/src'/);
});

test("fresh: base tip moved only outside the graphed scope", (t) => {
  const r = scenario(t, { path: "ui/src/b.ts", content: "export const b = 1;\n" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /is fresh/);
});

test("fails closed when the base branch tip cannot be resolved", (t) => {
  const r = scenario(t, null, "no-such-branch");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /cannot resolve the current tip of base branch 'no-such-branch'/);
});

// PEN-5042. Measured on Paperclip #3005: the gate was green when the bot opened
// the PR and went red the moment `gh pr update-branch` merged master into the
// branch. Bringing a graphify PR up to date is not a git operation — neither a
// merge nor a rebase moves `built_at_commit`, because it is a field inside
// graph.json. Rebuilding in place on the updated branch then trades the STALE
// verdict for an ancestry failure, which is what the gate's old remedy text
// ("Rebuild: graphify update <scope> --force") walked you into.
test("merging the base into the branch and rebuilding leaves the base line", (t) => {
  const r = scenario(t, { path: "server/src/a.ts", content: "export const a = 2;\n" }, "master", "merged");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not an ancestor of base/);
  assert.match(r.out, /the graph was built on this branch, not on master/);
});

test("a failing verdict prints the regenerate-from-the-tip recovery", (t) => {
  const r = scenario(t, { path: "server/src/a.ts", content: "export const a = 2;\n" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /How to clear this gate/);
  assert.match(r.out, /git checkout --no-track -B graphify-regen origin\/master/);
  // The literal `$(...)` has to survive the heredoc so it is runnable as printed.
  assert.match(r.out, /git rev-parse --short origin\/master/);
  assert.doesNotMatch(r.out, /Rebuild: graphify update/);
  // The push must name its remote and refspec. A bare `git push` here resolves
  // against the upstream `-B <branch> origin/master` would have set, which git
  // answers by suggesting `git push origin HEAD:master` — i.e. the graph commit
  // onto the base branch. A bare `--force-with-lease` leases against the
  // tracking ref and protects nothing, so the printed lease must name a sha.
  assert.match(r.out, /git push --force-with-lease=refs\/heads\/<pr-branch>:<expected> origin graphify-regen:<pr-branch>/);
  assert.doesNotMatch(r.out, /git push --force-with-lease\s*$/m);
  assert.doesNotMatch(r.out, /git checkout -B <branch>/);
  // Only the base ref is fetched above, so the lease sha has to come from the
  // remote, not from a tracking ref that is stale or absent.
  assert.match(r.out, /git ls-remote origin refs\/heads\/<pr-branch>/);
  assert.doesNotMatch(r.out, /git rev-parse origin\/<pr-branch>/);
});

test("regenerating the branch at the base tip clears the gate", (t) => {
  const r = scenario(t, { path: "server/src/a.ts", content: "export const a = 2;\n" }, "master", "regenerated");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /is fresh/);
  assert.doesNotMatch(r.out, /How to clear this gate/);
});
