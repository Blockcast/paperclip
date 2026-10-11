import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../sweep-orphaned-merge-group-runs.sh", import.meta.url));

function classifyRefProbe(rc, stderr) {
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; classify_ref_probe "$2" "$3"', "classifier-test", script, String(rc), stderr],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("only an explicit 404 classifies a ref as gone", () => {
  const cases = [
    ["alive", 0, ""],
    ["gone", 1, "gh: Not Found (HTTP 404)"],
    ["unknown", 1, "gh: Forbidden (HTTP 403)"],
    ["unknown", 1, "gh: API rate limit exceeded (HTTP 429)"],
    ["unknown", 1, "dial tcp: i/o timeout"],
    ["unknown", 1, ""],
    ["unknown", 1, "gh: Server Error (HTTP 500)"],
  ];

  for (const [expected, rc, stderr] of cases) {
    assert.equal(classifyRefProbe(rc, stderr), expected, `${rc}: ${stderr}`);
  }
});
