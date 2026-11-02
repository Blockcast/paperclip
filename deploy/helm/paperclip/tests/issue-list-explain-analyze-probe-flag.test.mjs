import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PEN-5296 box 2: the deliberate issues-list `EXPLAIN (ANALYZE, BUFFERS)` probe
 * is enabled in production for a bounded diagnostic window.
 *
 * The flag is default-OFF in the server (`issueListExplainAnalyzeEnabled`), so
 * these values entries are the only thing that turn it on. Box 4 flips the
 * ENABLED assertion below -- and it changing is the point: the flip should be a
 * deliberate edit with a reviewer looking at it, not a silent drift.
 *
 * The scope assertions are separate from the value assertion on purpose. An
 * UNSET company allowlist admits EVERY company, and an unset floor is a wider
 * window than intended -- both are states the box-4 flip must not leave behind
 * by deleting the wrong line, so they are pinned independently of whether the
 * probe is currently on.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const VALUES_FILE = "deploy/helm/paperclip/values.blockcast.yaml";
const FLAG = "PAPERCLIP_EXPLAIN_ANALYZE_ISSUE_LIST";
const COMPANIES_FLAG = `${FLAG}_COMPANY_IDS`;
const MIN_MS_FLAG = `${FLAG}_MIN_MS`;
/** The company whose statements actually crossed the 30s timeout (PEN-5223). */
const AFFECTED_COMPANY_ID = "aaced805-3491-4ee5-9b14-cdf70cb81d47";

/** Trailing `\n` is what keeps `FLAG` from also matching `FLAG_COMPANY_IDS`. */
const presence = (name) => new RegExp(`- name: ${name}\\n`);
const enabled = (name) => new RegExp(`- name: ${name}\\n\\s+value: "true"`);
const valueFrom = (name) => new RegExp(`- name: ${name}\\n\\s+valueFrom:`);

function render(showOnly) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      VALUES_FILE,
      "--show-only",
      showOnly,
      "--set",
      "api.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

const api = render("templates/deployment-api.yaml");
const worker = render("templates/statefulset.yaml");

test("the EXPLAIN (ANALYZE) probe is enabled on the API tier (PEN-5296 box 2; box 4 flips this)", () => {
  assert.match(api, enabled(FLAG));
});

test("the probe reaches the worker tier too, so a capture can land on either pod", () => {
  // `env.extra` renders in BOTH deployment-api.yaml and statefulset.yaml, so
  // box 2 has to know where to look: the log line lands on whichever pod served
  // the slow list.
  assert.match(worker, presence(FLAG));
});

test("the probe is SCOPED to named companies, never left admitting every tenant", () => {
  // An unset allowlist admits every company. This probe RE-EXECUTES a slow
  // query, so an unscoped enable is a materially different change from the
  // plan-only capture's -- pinned separately so it survives the box-4 flip.
  assert.match(api, presence(COMPANIES_FLAG));
  assert.ok(
    api.includes(AFFECTED_COMPANY_ID),
    `${COMPANIES_FLAG} must name the company whose statements actually time out`,
  );
});

test("the probe carries a duration floor, so the budget is not spent on fast lists", () => {
  assert.match(api, presence(MIN_MS_FLAG));
  assert.match(api, new RegExp(`- name: ${MIN_MS_FLAG}\\n\\s+value: "\\d+"`));
});

test("every probe var is a plain-value entry, which is what makes it admissible", () => {
  // `PAPERCLIP_`-prefixed plain values are explicitly allowed by the admission
  // policy's env contract; a `valueFrom` on a name outside the secret-bound
  // names is not. Pinned separately from the values so the box-4 flip cannot
  // drop it.
  for (const name of [FLAG, COMPANIES_FLAG, MIN_MS_FLAG]) {
    assert.match(api, presence(name));
    assert.doesNotMatch(api, valueFrom(name));
    assert.ok(name.startsWith("PAPERCLIP_"), `${name} must be PAPERCLIP_-prefixed to be admissible`);
  }
});
