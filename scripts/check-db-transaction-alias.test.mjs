import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE,
  scanRepo,
  TX_ALIAS_REDERIVATION,
  violatesTxAliasBan,
} from "./check-db-transaction-alias.mjs";

// The shapes this rule exists to stop. Both spellings are real: BLO-34656
// swept the first out of 20 files and missed the second in two more.
const BANNED = [
  'type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];',
  "  type CompanyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];",
  "    dbOrTx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],",
  'type Tx = Parameters< Parameters<Db["transaction"]>[0]>[0];',
];

// Must stay green. The first two are the deliberate two-alias split in
// packages/db/src/client.ts that DEFINES the replacement — a rule that flags
// its own definition is unshippable. The third is a legitimate unrelated
// nested-Parameters expression (company-skill-test-runs-service.test.ts).
const ALLOWED = [
  'type DbTransactionCallback = Parameters<Db["transaction"]>[0];',
  "export type DbTransaction = Parameters<DbTransactionCallback>[0];",
  "    createHarnessIssue: async (issue: Parameters<Parameters<typeof svc.createTestRun>[4][\"createHarnessIssue\"]>[0]) => {",
  "type HeartbeatDbExecutor = Db | DbTransaction;",
  "  async function applyArchiveCascadeInTx(tx: DbTransaction, id: string) {",
  // `transaction` must appear INSIDE the first type argument, not merely
  // somewhere on the line — otherwise a passing mention in a comment or a
  // later argument turns an unrelated nested Parameters<...> into a failure.
  "const seed: Parameters<Parameters<typeof makeSeed>[0]>[0] = row; // used inside the transaction",
];

test("flags every spelling of the inline transaction-handle re-derivation", () => {
  for (const line of BANNED) {
    assert.equal(violatesTxAliasBan(line), true, `should flag: ${line}`);
  }
});

test("does not flag the client.ts split that defines the replacement", () => {
  for (const line of ALLOWED) {
    assert.equal(violatesTxAliasBan(line), false, `should not flag: ${line}`);
  }
});

test("nesting is required — a single Parameters<...> over a transaction is the definition, not a copy", () => {
  assert.equal(violatesTxAliasBan('Parameters<Db["transaction"]>[0]'), false);
});

test("the message names the replacement import", () => {
  assert.match(MESSAGE, /DbTransaction/);
  assert.match(MESSAGE, /@paperclipai\/db/);
});

test("scanRepo returns the matching lines", () => {
  const lines = scanRepo({
    repoRoot: "/repo",
    exec: () => 'server/src/a.ts:64:  type T = Parameters<Parameters<typeof db.transaction>[0]>[0];\n',
  });
  assert.deepEqual(lines, [
    'server/src/a.ts:64:  type T = Parameters<Parameters<typeof db.transaction>[0]>[0];',
  ]);
});

test("scanRepo treats git grep's empty exit 1 as a clean tree", () => {
  const lines = scanRepo({
    repoRoot: "/repo",
    exec: () => {
      throw Object.assign(new Error("no match"), { status: 1, stdout: "" });
    },
  });
  assert.deepEqual(lines, []);
});

// A bad pathspec or a non-repo cwd exits 128. Swallowing that would report a
// clean tree for a scan that never ran — the fail-open this guard prevents.
test("scanRepo rethrows a non-matching failure instead of reporting clean", () => {
  assert.throws(
    () =>
      scanRepo({
        repoRoot: "/repo",
        exec: () => {
          throw Object.assign(new Error("fatal: not a git repository"), { status: 128, stdout: "" });
        },
      }),
    /not a git repository/,
  );
});

test("scanRepo rethrows exit 1 that still produced output", () => {
  assert.throws(
    () =>
      scanRepo({
        repoRoot: "/repo",
        exec: () => {
          throw Object.assign(new Error("partial"), { status: 1, stdout: "server/src/a.ts:1:hit\n" });
        },
      }),
    /partial/,
  );
});

test("the exported pattern is what the script greps with", () => {
  let grepArgs;
  scanRepo({
    repoRoot: "/repo",
    exec: (_cmd, args) => {
      grepArgs = args;
      return "";
    },
  });
  assert.ok(grepArgs.includes(TX_ALIAS_REDERIVATION.source));
  assert.ok(grepArgs.includes("*.ts"));
});
