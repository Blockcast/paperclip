import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const guard = new URL("./check-test-undefined-symbols.mjs", import.meta.url).pathname;

function runWithFakeTsc(fakeNpx) {
  const root = mkdtempSync(path.join(tmpdir(), "test-undefined-symbols-"));
  const binDir = path.join(root, "bin");
  const project = path.join(root, "tsconfig.json");
  mkdirSync(binDir);
  writeFileSync(project, "{}\n");
  writeFileSync(path.join(binDir, "npx"), `#!/bin/sh\n${fakeNpx}\n`);
  chmodSync(path.join(binDir, "npx"), 0o755);

  const result = spawnSync(process.execPath, [guard, "--project", project], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  rmSync(root, { recursive: true, force: true });
  return result;
}

const successfulConfigPreflight = `
for arg in "$@"; do
  if [ "$arg" = "--showConfig" ]; then
    printf '{}\\n'
    exit 0
  fi
done`;

test("fails closed when TypeScript cannot resolve the project config", () => {
  const result = runWithFakeTsc(`
printf '%s\\n' "error TS5083: Cannot read file '/missing.json'." >&2
exit 2`);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TS5083/);
  assert.match(result.stderr, /configuration preflight exited 2/);
});

test("fails closed when the diagnostic compiler terminates abnormally", () => {
  const result = runWithFakeTsc(`${successfulConfigPreflight}
kill -TERM $$`);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /diagnostic pass terminated abnormally by SIGTERM/);
});

test("tolerates existing source type errors outside the undefined-name class", () => {
  const result = runWithFakeTsc(`${successfulConfigPreflight}
printf '%s\\n' 'src/example.test.ts(1,1): error TS2322: Type mismatch.'
exit 2`);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 other type errors present/);
});

test("still rejects an undefined identifier source diagnostic", () => {
  const result = runWithFakeTsc(`${successfulConfigPreflight}
printf '%s\\n' "src/example.test.ts(1,1): error TS2304: Cannot find name 'missing'."
exit 2`);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 test reference\(s\)/);
  assert.match(result.stderr, /TS2304/);
});
