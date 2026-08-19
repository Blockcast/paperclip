// Tests for the BLO-23511 workflow-parse gate.
//
// The behavioural tests inject a fake `spawn`, so the gate's own logic —
// especially its fail-closed paths — is verified without needing the binary.
// One integration test drives the real actionlint to prove the reference
// break from f94d5212 is genuinely rejected with its line number; in CI that
// test always runs, because `./.github/actions/setup-actionlint` installs the
// binary before this file executes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DETERMINISM_FLAGS,
  WORKFLOWS_DIR,
  collectWorkflowFiles,
  runCheck,
} from "./check-workflows-parse.mjs";

// The f94d5212 shape: a heredoc body and its `EOF` terminator at column 0
// inside a `run: |` block scalar. YAML strips the block's common indent, so
// a column-0 line ends the scalar and the prose is read as a new top-level
// key — "could not find expected ':'".
const BROKEN_WORKFLOW = `name: t
on: push
jobs:
  alert:
    runs-on: ubuntu-latest
    steps:
      - name: alert
        run: |
          body="$(cat <<EOF
Docker (agent base) failed on master.
EOF
          )"
          echo "$body"
`;

const FIXED_WORKFLOW = BROKEN_WORKFLOW.replace(
  /^Docker \(agent base\) failed on master\.\nEOF$/m,
  "          Docker (agent base) failed on master.\n          EOF",
);

function withTempRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-parse-"));
  mkdirSync(path.join(root, WORKFLOWS_DIR), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, WORKFLOWS_DIR, name), body);
  }
  return root;
}

function silent() {
  const lines = [];
  return { sink: (...args) => lines.push(args.join(" ")), lines };
}

test("collectWorkflowFiles returns .yml and .yaml sorted, ignoring others", () => {
  const root = withTempRepo({ "b.yml": "", "a.yaml": "", "notes.md": "", "c.yml": "" });
  try {
    assert.deepEqual(collectWorkflowFiles(root), [
      path.join(WORKFLOWS_DIR, "a.yaml"),
      path.join(WORKFLOWS_DIR, "b.yml"),
      path.join(WORKFLOWS_DIR, "c.yml"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty workflow set fails instead of passing vacuously", () => {
  const root = withTempRepo({});
  const { sink, lines } = silent();
  try {
    assert.equal(runCheck({ repoRoot: root, spawn: () => ({ status: 0 }), log: sink, error: sink }), 1);
    assert.match(lines.join("\n"), /empty set is a failure, not a pass/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable workflows directory fails rather than reporting green", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-parse-missing-"));
  const { sink } = silent();
  try {
    assert.equal(runCheck({ repoRoot: root, spawn: () => ({ status: 0 }), log: sink, error: sink }), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing actionlint binary fails closed and says how to get it", () => {
  const root = withTempRepo({ "a.yml": FIXED_WORKFLOW });
  const { sink, lines } = silent();
  try {
    const code = runCheck({
      repoRoot: root,
      spawn: () => ({ error: new Error("spawn actionlint ENOENT") }),
      log: sink,
      error: sink,
    });
    assert.equal(code, 1);
    const out = lines.join("\n");
    assert.match(out, /fails closed/);
    assert.match(out, /setup-actionlint/);
    assert.match(out, /ACTIONLINT_BIN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shellcheck and pyflakes are pinned off so the verdict is runner-independent", () => {
  const root = withTempRepo({ "a.yml": FIXED_WORKFLOW });
  const { sink } = silent();
  let argv;
  try {
    runCheck({
      repoRoot: root,
      spawn: (_bin, args) => {
        argv = args;
        return { status: 0 };
      },
      log: sink,
      error: sink,
    });
    for (const flag of DETERMINISM_FLAGS) assert.ok(argv.includes(flag), `missing ${flag}`);
    assert.deepEqual(DETERMINISM_FLAGS, ["-shellcheck=", "-pyflakes="]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-zero actionlint exit surfaces its output and fails the gate", () => {
  const root = withTempRepo({ "a.yml": BROKEN_WORKFLOW });
  const { sink, lines } = silent();
  try {
    const code = runCheck({
      repoRoot: root,
      spawn: () => ({ status: 1, stdout: "a.yml:10:0: could not parse as YAML", stderr: "" }),
      log: sink,
      error: sink,
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /could not parse as YAML/);
    assert.match(lines.join("\n"), /zero jobs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const actionlintBin = process.env.ACTIONLINT_BIN || "actionlint";
const actionlintAvailable = spawnSync(actionlintBin, ["--version"], { encoding: "utf8" }).status === 0;

test(
  "integration: real actionlint rejects the f94d5212 heredoc break with its line number",
  {
    skip: actionlintAvailable
      ? false
      : "actionlint not installed; CI installs it via ./.github/actions/setup-actionlint before this runs",
  },
  () => {
    const root = withTempRepo({ "broken.yml": BROKEN_WORKFLOW });
    const { sink, lines } = silent();
    try {
      assert.equal(runCheck({ repoRoot: root, actionlintBin, log: sink, error: sink }), 1);
      const out = lines.join("\n");
      assert.match(out, /could not parse as YAML/);
      // The column-0 prose line — the same failure Psych reported at line 409
      // of the real file, reproduced here at the fixture's line 10.
      assert.match(out, /broken\.yml:10:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "integration: the indentation-repaired twin passes, so the gate is not rejecting the shape wholesale",
  {
    skip: actionlintAvailable
      ? false
      : "actionlint not installed; CI installs it via ./.github/actions/setup-actionlint before this runs",
  },
  () => {
    const root = withTempRepo({ "fixed.yml": FIXED_WORKFLOW });
    const { sink, lines } = silent();
    try {
      assert.equal(runCheck({ repoRoot: root, actionlintBin, log: sink, error: sink }), 0, lines.join("\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "integration: a workflow with no jobs is rejected — zero jobs is the defect, not a pass",
  {
    skip: actionlintAvailable
      ? false
      : "actionlint not installed; CI installs it via ./.github/actions/setup-actionlint before this runs",
  },
  () => {
    const root = withTempRepo({ "nojobs.yml": "name: t\non: push\n" });
    const { sink, lines } = silent();
    try {
      assert.equal(runCheck({ repoRoot: root, actionlintBin, log: sink, error: sink }), 1);
      assert.match(lines.join("\n"), /"jobs" section is missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
