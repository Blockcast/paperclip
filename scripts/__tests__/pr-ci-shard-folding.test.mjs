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

test("server shards run general and serialized suites in the same four jobs", () => {
  const general = jobBlock("general_tests", "verify");
  const serverEntries = general.match(
    /          - group: general-server\n(?:            [^\n]*\n)*/g,
  ) ?? [];
  assert.equal(serverEntries.length, 4, "general_tests must retain four isolated server shards");
  for (const [index, entry] of serverEntries.entries()) {
    assert.match(
      entry,
      new RegExp(`group_label: server ${index + 1}/4`),
      `server shard ${index} must retain its matching label`,
    );
    assert.match(entry, new RegExp(`shard_index: ${index}`));
    assert.match(entry, /shard_count: 4/);
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
