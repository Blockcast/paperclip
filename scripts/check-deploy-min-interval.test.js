import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// BLO-49140: refuse a production roll while paperclip-0 is younger than 6h.
const script = new URL("../.github/scripts/check-deploy-min-interval.sh", import.meta.url).pathname;
const NOW = Date.parse("2026-10-20T07:44:36Z") / 1000;

function run(env) {
  const r = spawnSync("bash", [script], {
    env: { PATH: process.env.PATH, NOW_EPOCH: String(NOW), ...env },
    encoding: "utf8",
  });
  return r.status;
}

test("refuses a roll inside the window, allows it outside", () => {
  // The 2026-10-20 pair: 01:50:12Z then 07:44:36Z, 5h54m apart.
  assert.equal(run({ POD_CREATED: "2026-10-20T01:50:12Z" }), 1);
  assert.equal(run({ POD_CREATED: "2026-10-20T01:44:36Z" }), 0); // exactly 6h
  assert.equal(run({ POD_CREATED: "2026-10-19T07:23:00Z" }), 0);
});

test("emergency and rollback override; anything else does not", () => {
  const young = { POD_CREATED: "2026-10-20T07:00:00Z" };
  assert.equal(run({ ...young, OVERRIDE: "emergency" }), 0);
  assert.equal(run({ ...young, OVERRIDE: "rollback" }), 0);
  assert.equal(run({ ...young, OVERRIDE: "none" }), 1);
  assert.equal(run({ ...young, OVERRIDE: "yes" }), 1);
});

test("absent pod allows; unparseable timestamp fails closed", () => {
  assert.equal(run({ POD_CREATED: "" }), 0);
  assert.notEqual(run({ POD_CREATED: "not-a-date" }), 0);
});

test("docker.yml wires the guard into deploy before any mutation", () => {
  const wf = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");
  const guard = wf.indexOf("check-deploy-min-interval.sh");
  assert.notEqual(guard, -1);
  assert.ok(guard > wf.indexOf("\n  deploy:\n"), "guard must be in the deploy job");
  assert.ok(guard < wf.indexOf("- name: Approve exact deploy plan"), "guard must precede approval");
  assert.ok(guard < wf.indexOf("- name: helm upgrade"));
  assert.match(wf, /min_interval_override:[\s\S]*?options:[\s\S]*?- none[\s\S]*?- emergency[\s\S]*?- rollback/);
  assert.match(wf, /OVERRIDE: \$\{\{ inputs\.min_interval_override \}\}/);
});
