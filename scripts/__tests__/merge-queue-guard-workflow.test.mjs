import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function extractBlock(startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker ${startMarker}`);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing marker ${endMarker}`);
  return workflow.slice(start, end);
}

function extractGuardScript() {
  const stepMarker = "\n      - name: Cancel if superseded by merge-queue re-stage\n";
  const stepStart = workflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, "pr.yml must define the merge-queue guard step");

  const scriptMarker = "\n          script: |\n";
  const scriptStart = workflow.indexOf(scriptMarker, stepStart);
  assert.notEqual(scriptStart, -1, "merge-queue guard must use a github-script block");

  const lines = workflow.slice(scriptStart + scriptMarker.length).split("\n");
  const scriptLines = [];
  for (const line of lines) {
    if (line !== "" && !line.startsWith("            ")) break;
    scriptLines.push(line.slice(12));
  }
  return scriptLines.join("\n");
}

function responseFor(nodes, pageInfo = { hasNextPage: false, endCursor: null }) {
  return {
    repository: {
      mergeQueue: {
        entries: {
          nodes: nodes.map((oid) => ({ headCommit: { oid } })),
          pageInfo,
        },
      },
    },
  };
}

async function runGuard({
  headSha = "head-sha",
  branch = "master",
  responses = [],
  cancelError = null,
} = {}) {
  const script = extractGuardScript();
  const fn = new AsyncFunction("github", "core", "context", "process", script);
  const graphqlCalls = [];
  const cancelCalls = [];
  const warnings = [];
  const infos = [];
  const queuedResponses = [...responses];
  const github = {
    graphql: async (_query, variables) => {
      graphqlCalls.push(variables);
      assert.ok(queuedResponses.length > 0, "test did not provide enough mocked GraphQL responses");
      const next = queuedResponses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    rest: {
      actions: {
        cancelWorkflowRun: async (args) => {
          cancelCalls.push(args);
          if (cancelError) throw cancelError;
        },
      },
    },
  };
  const core = {
    info(message) {
      infos.push(message);
    },
    warning(message) {
      warnings.push(message);
    },
  };
  const context = {
    repo: { owner: "Blockcast", repo: "paperclip" },
    runId: 123456789,
  };

  await fn(github, core, context, { env: { HEAD_SHA: headSha, QUEUE_BRANCH: branch } });
  return { graphqlCalls, cancelCalls, warnings, infos };
}

test("merge-queue guard is isolated from the checkout policy job", () => {
  const guardBlock = extractBlock("\n  merge_queue_guard:\n", "\n  policy:\n");
  assert.match(guardBlock, /\n    if: github\.event_name == 'merge_group'\n/);
  assert.match(guardBlock, /\n      actions: write\n/);
  assert.doesNotMatch(guardBlock, /actions\/checkout/);
  assert.doesNotMatch(guardBlock, /pnpm|node --test|git diff/);

  const policyBlock = extractBlock("\n  policy:\n", "\n  typecheck_release_registry:\n");
  assert.match(policyBlock, /\n    permissions:\n      contents: read\n/);
  assert.doesNotMatch(policyBlock, /\n      actions: write\n/);
});

test("every arc-light root job waits for the merge-queue guard before consuming a runner", () => {
  // BLO-21953 follow-up: `policy` and `helm_chart` are the only two jobs that
  // start with no `needs` of their own -- everything else in the workflow is
  // already gated behind `policy`. If either became an independent root
  // again, it would race `merge_queue_guard` for the same arc-light pool and
  // could consume a runner before a superseded run gets cancelled, making
  // the guard's fail-open cancellation nondeterministic under the exact
  // pool-starvation load it exists to relieve.
  const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
  const jobNames = [...jobsSection.matchAll(/^  ([a-z0-9_]+):\n/gm)].map((match) => match[1]);
  assert.deepEqual(jobNames, [
    "merge_queue_guard",
    "policy",
    "helm_chart",
    "typecheck_release_registry",
    "worktree_install",
    "general_tests",
    "verify",
    "build",
    "verify_serialized_server",
    "canary_dry_run",
    "e2e",
  ]);

  for (const job of ["policy", "helm_chart"]) {
    const block = extractBlock(`\n  ${job}:\n`, `\n  ${job === "policy" ? "helm_chart" : "typecheck_release_registry"}:\n`);
    assert.match(
      block,
      /\n    needs: \[merge_queue_guard\]\n/,
      `${job} must declare needs: [merge_queue_guard] so it cannot start before the guard resolves`,
    );
    assert.match(
      block,
      /\n    if: "!cancelled\(\) && \(needs\.merge_queue_guard\.result == 'success' \|\| needs\.merge_queue_guard\.result == 'skipped'\)"\n/,
      `${job} must fail open when the guard is skipped (pull_request) or succeeded (merge_group, still live)`,
    );
  }
});

test("every job downstream of policy scopes its own success check instead of inheriting the default", () => {
  // BLO-21953 follow-up #2: GitHub's default `if: success()` walks the whole
  // transitive needs graph, not just a job's direct `needs:` edge. Once
  // `policy` gained `merge_queue_guard` as an ancestor, every job with a bare
  // `needs: [policy]` (relying on the implicit default condition) started
  // silently skipping on pull_request events -- merge_queue_guard reports
  // `skipped` there, and that skip cascades past policy's own explicit
  // !cancelled()-tolerant override to every descendant that didn't repeat it.
  // `verify` treats an upstream skip as a failure, so this broke the
  // required check for every PR, not just ones touching this workflow. This
  // was caught by `verify` itself failing on this PR's own pull_request
  // check run, not by this test file -- codifying it here so it can't ship
  // silently again.
  //
  // A first attempt at this fix used a bare `if: needs.policy.result ==
  // 'success'` with no status-check function. That still failed live:
  // GitHub applies its default "skip if anything upstream was skipped" gate
  // underneath a custom `if:` unless a status-check function is also
  // present, so the custom condition never even got evaluated --
  // merge_queue_guard's pull_request skip kept cascading through it exactly
  // as before. `!cancelled()` must prefix every condition below, matching the
  // pattern policy/helm_chart already use without making cancelled workflows
  // keep scheduling runner-heavy jobs.
  const directPolicyJobs = [
    "typecheck_release_registry",
    "worktree_install",
    "general_tests",
    "build",
    "canary_dry_run",
    "e2e",
  ];
  const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
  const jobNames = [...jobsSection.matchAll(/^  ([a-z0-9_]+):\n/gm)].map((match) => match[1]);

  for (const job of directPolicyJobs) {
    const nextJob = jobNames[jobNames.indexOf(job) + 1];
    const startMarker = `\n  ${job}:\n`;
    const block = nextJob
      ? extractBlock(startMarker, `\n  ${nextJob}:\n`)
      : workflow.slice(workflow.indexOf(startMarker));
    assert.match(block, /\n    needs: \[policy\]\n/, `${job} must declare needs: [policy]`);
    assert.match(
      block,
      /\n    if: "!cancelled\(\) && needs\.policy\.result == 'success'"\n/,
      `${job} must gate on !cancelled() && needs.policy.result == 'success', not the implicit transitive success() and not a bare custom condition without a status-check function`,
    );
  }

  const verifyServerBlock = extractBlock("\n  verify_serialized_server:\n", "\n  canary_dry_run:\n");
  assert.match(verifyServerBlock, /\n    needs: \[policy, general_tests\]\n/);
  assert.match(
    verifyServerBlock,
    /\n    if: "!cancelled\(\) && needs\.policy\.result == 'success' && needs\.general_tests\.result == 'success'"\n/,
    "verify_serialized_server must gate on !cancelled() plus both its direct dependencies' results",
  );
});

test("live membership on the first page continues without cancelling", async () => {
  const result = await runGuard({
    responses: [responseFor(["other", "head-sha"])],
  });
  assert.equal(result.cancelCalls.length, 0);
  assert.match(result.infos.join("\n"), /still a live merge-queue entry/);
});

test("complete lookup that excludes the head sha cancels the workflow run", async () => {
  const result = await runGuard({
    responses: [responseFor(["other-a", "other-b"])],
  });
  assert.deepEqual(result.cancelCalls, [{
    owner: "Blockcast",
    repo: "paperclip",
    run_id: 123456789,
  }]);
  assert.match(result.infos.join("\n"), /not a live merge-queue entry/);
});

test("GraphQL errors are inconclusive and fail open", async () => {
  const result = await runGuard({
    responses: [new Error("GraphQL: permission denied")],
  });
  assert.equal(result.cancelCalls.length, 0);
  assert.match(result.warnings.join("\n"), /lookup failed/);
});

test("malformed or partial GraphQL data is inconclusive and fails open", async () => {
  for (const response of [
    null,
    { repository: null },
    { repository: { mergeQueue: null } },
    { repository: { mergeQueue: { entries: { nodes: null, pageInfo: { hasNextPage: false } } } } },
    { repository: { mergeQueue: { entries: { nodes: [], pageInfo: null } } } },
    { repository: { mergeQueue: { entries: { nodes: [], pageInfo: { hasNextPage: "false" } } } } },
  ]) {
    const result = await runGuard({ responses: [response] });
    assert.equal(result.cancelCalls.length, 0, `must not cancel for ${JSON.stringify(response)}`);
    assert.match(result.warnings.join("\n"), /malformed data/);
  }
});

test("pagination continues until a live entry is found", async () => {
  const result = await runGuard({
    responses: [
      responseFor(["other-a"], { hasNextPage: true, endCursor: "cursor-1" }),
      responseFor(["head-sha"], { hasNextPage: false, endCursor: null }),
    ],
  });
  assert.equal(result.cancelCalls.length, 0);
  assert.equal(result.graphqlCalls.length, 2);
  assert.equal(result.graphqlCalls[0].cursor, null);
  assert.equal(result.graphqlCalls[1].cursor, "cursor-1");
});

test("paginated complete lookup cancels only after all pages exclude the head sha", async () => {
  const result = await runGuard({
    responses: [
      responseFor(["other-a"], { hasNextPage: true, endCursor: "cursor-1" }),
      responseFor(["other-b"], { hasNextPage: false, endCursor: null }),
    ],
  });
  assert.equal(result.cancelCalls.length, 1);
  assert.equal(result.graphqlCalls.length, 2);
});

test("truncated page without an end cursor is inconclusive and fails open", async () => {
  const result = await runGuard({
    responses: [
      responseFor(["other-a"], { hasNextPage: true, endCursor: "" }),
    ],
  });
  assert.equal(result.cancelCalls.length, 0);
  assert.match(result.warnings.join("\n"), /without an endCursor/);
});

test("cancellation API failures do not fail the guard job", async () => {
  const result = await runGuard({
    responses: [responseFor(["other-a"])],
    cancelError: new Error("cancel endpoint unavailable"),
  });
  assert.equal(result.cancelCalls.length, 1);
  assert.match(result.warnings.join("\n"), /failed to cancel superseded run/);
});
