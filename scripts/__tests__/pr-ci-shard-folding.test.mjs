import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

function jobBlock(name, nextName) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `pr.yml must define ${name}`);
  const end = workflow.indexOf(`\n  ${nextName}:\n`, start + 1);
  assert.notEqual(end, -1, `pr.yml must define ${nextName} after ${name}`);
  return workflow.slice(start, end);
}

test("server shards run general and serialized suites in the same jobs", () => {
  const general = jobBlock("general_tests", "verify");
  const serverEntries = general.match(
    /          - group: general-server\n(?:            [^\n]*\n)*/g,
  ) ?? [];
  assert.ok(serverEntries.length >= 2, "general_tests must retain isolated server shards");
  const shardCount = serverEntries.length;
  for (const [index, entry] of serverEntries.entries()) {
    assert.match(
      entry,
      new RegExp(`group_label: server ${index + 1}/${shardCount}`),
      `server shard ${index} must retain its matching label`,
    );
    assert.match(entry, new RegExp(`shard_index: ${index}\\b`));
    assert.match(
      entry,
      new RegExp(`shard_count: ${shardCount}\\b`),
      `server shard ${index} must declare the real shard count`,
    );
  }
  assert.match(general, /pnpm test:run:general -- "\$\{args\[@\]\}"/);
  assert.match(
    general,
    /- name: Run serialized server test shard\n        if: matrix\.group == 'general-server'\n        run: pnpm test:run:serialized -- --shard-index \$\{\{ matrix\.shard_index \}\} --shard-count \$\{\{ matrix\.shard_count \}\}/,
    "serialized suites must run only in the corresponding server shard",
  );
  assert.ok(
    general.indexOf("pnpm test:run:general") < general.indexOf("pnpm test:run:serialized"),
    "each server shard must run general suites before serialized suites",
  );
});

// BLO-36439: the one way resharding loses. `max-parallel` below the matrix size
// holds shards back behind a full shard duration, so a split meant to shorten
// the critical path lengthens it instead -- silently, with every job green.
test("max-parallel covers the whole general_tests matrix", () => {
  const general = jobBlock("general_tests", "verify");
  const entries = general.match(/\n          - group: general-[a-z-]+\n/g) ?? [];
  const maxParallel = Number(general.match(/\n      max-parallel: (\d+)\n/)?.[1]);
  assert.ok(Number.isInteger(maxParallel), "general_tests must declare max-parallel");
  assert.ok(
    maxParallel >= entries.length,
    `max-parallel (${maxParallel}) must be >= matrix size (${entries.length}); ` +
      "a lower value serializes shards and lengthens the critical path",
  );
});

test("serialized coverage is aggregated through general_tests without a second job matrix", () => {
  assert.doesNotMatch(workflow, /\n  verify_serialized_server:\n/);
  assert.equal(
    workflow.match(/pnpm test:run:serialized -- --shard-index/g)?.length,
    1,
    "the PR workflow should declare one matrix-driven serialized command",
  );

  const verify = jobBlock("verify", "build");
  assert.match(verify, /\n        general_tests,/);
  assert.doesNotMatch(verify, /verify_serialized_server/);
  assert.match(verify, /GENERAL_TESTS_RESULT: \$\{\{ needs\.general_tests\.result \}\}/);
});
