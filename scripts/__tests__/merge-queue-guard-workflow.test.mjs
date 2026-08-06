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
