import assert from "node:assert/strict";
import test from "node:test";

import { findRawNulOffenses, isSourcePath, runCheck } from "./check-no-raw-nul.mjs";

const NUL = String.fromCharCode(0);
const bytes = (text) => Buffer.from(text, "utf8");

test("flags a raw NUL byte and reports its line number", () => {
  const offenses = findRawNulOffenses({
    files: ["server/src/services/metrics.ts"],
    read: () => bytes(`line one\nline two\nconst key = \`a${NUL}b\`;\n`),
  });

  assert.deepEqual(offenses, [{ relative: "server/src/services/metrics.ts", lineNumber: 3 }]);
});

test("reports every occurrence in a file, not just the first", () => {
  const offenses = findRawNulOffenses({
    files: ["a.ts"],
    read: () => bytes(`x${NUL}\ny\nz${NUL}\n`),
  });

  assert.deepEqual(
    offenses.map((offense) => offense.lineNumber),
    [1, 3],
  );
});

test("passes the escaped form, which is what the fix writes", () => {
  const offenses = findRawNulOffenses({
    files: ["a.ts"],
    // Six literal characters, not the byte — this is the correct source form.
    read: () => bytes("const key = `${a}\\u0000${b}`;\n"),
  });

  assert.deepEqual(offenses, []);
});

test("ignores non-source paths so real binary assets never fail the check", () => {
  assert.equal(isSourcePath("ui/public/logo.png"), false);
  assert.equal(isSourcePath("server/src/services/metrics.ts"), true);

  const offenses = findRawNulOffenses({
    files: ["ui/public/logo.png"],
    read: () => bytes(`PNG${NUL}${NUL}`),
  });

  assert.deepEqual(offenses, []);
});

test("skips files that cannot be read instead of throwing", () => {
  const offenses = findRawNulOffenses({
    files: ["deleted.ts"],
    read: () => {
      throw new Error("ENOENT");
    },
  });

  assert.deepEqual(offenses, []);
});

test("runCheck exits non-zero and names the offender", () => {
  const errors = [];
  const code = runCheck({
    repoRoot: "/repo",
    exec: () => Buffer.from("a.ts\0ui/logo.png\0", "utf8"),
    read: (relative) => (relative === "a.ts" ? bytes(`q${NUL}\n`) : bytes("")),
    log: () => {},
    error: (message) => errors.push(message),
  });

  assert.equal(code, 1);
  assert.match(errors.join("\n"), /a\.ts:1/);
});

test("runCheck exits zero on a clean tree", () => {
  const code = runCheck({
    repoRoot: "/repo",
    exec: () => Buffer.from("a.ts\0", "utf8"),
    read: () => bytes("const key = `${a}\\u0000${b}`;\n"),
    log: () => {},
    error: () => {},
  });

  assert.equal(code, 0);
});
