import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const SCRIPT_PATH = new URL("./safe-env-inspect.mjs", import.meta.url).pathname;

test("prints variable names only, one per line, no values", () => {
  const output = execFileSync(process.execPath, [SCRIPT_PATH], {
    env: { ...process.env, SAFE_ENV_INSPECT_TEST_SECRET: "should-not-appear" },
    encoding: "utf8",
  });
  const lines = output.trim().split("\n").filter(Boolean);
  assert.ok(lines.includes("SAFE_ENV_INSPECT_TEST_SECRET"));
  for (const line of lines) {
    assert.ok(!line.includes("="), `line "${line}" should not contain a value`);
    assert.ok(!line.includes("should-not-appear"), "value must never be printed");
  }
});

test("--json prints a sorted JSON array of names only", () => {
  const output = execFileSync(process.execPath, [SCRIPT_PATH, "--json"], {
    env: { ...process.env, SAFE_ENV_INSPECT_TEST_SECRET: "should-not-appear" },
    encoding: "utf8",
  });
  const names = JSON.parse(output);
  assert.ok(Array.isArray(names));
  assert.ok(names.includes("SAFE_ENV_INSPECT_TEST_SECRET"));
  assert.deepEqual(names, [...names].sort());
  assert.ok(!output.includes("should-not-appear"));
});
