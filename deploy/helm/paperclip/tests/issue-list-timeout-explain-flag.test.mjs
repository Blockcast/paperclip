import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PEN-5223 box 4: the timed-out issues-list `EXPLAIN` capture is enabled in
 * production for a bounded diagnostic window.
 *
 * The flag is default-OFF in the server (`issueListExplainEnabled`), so this
 * values entry is the only thing that turns it on. Box 5 flips it back to
 * "false" -- at which point the ENABLED test below is the one assertion that
 * has to change, and it changing is the point: the flip should be a deliberate
 * edit with a reviewer looking at it, not a silent drift.
 *
 * Why the shape asserts are separate from the value assert: the admission
 * policy admits this var because it is `PAPERCLIP_`-prefixed with a PLAIN
 * value. A `valueFrom` on a name outside `apiSecretBoundEnvNames`, or a name
 * without the prefix, is denied by
 * ValidatingAdmissionPolicy/paperclip-core-service-routing validation 3. Those
 * are properties of how the entry is written rather than of which state it is
 * in, so they must survive the box-5 flip.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const VALUES_FILE = "deploy/helm/paperclip/values.blockcast.yaml";
const FLAG = "PAPERCLIP_EXPLAIN_TIMED_OUT_ISSUE_LIST";

const PRESENCE_PATTERN = new RegExp(`- name: ${FLAG}\\n`);
const ENABLED_PATTERN = new RegExp(`- name: ${FLAG}\\n\\s+value: "true"`);
/** A `valueFrom` would be denied by admission for a non-secret-bound name. */
const VALUE_FROM_PATTERN = new RegExp(`- name: ${FLAG}\\n\\s+valueFrom:`);

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

test("the EXPLAIN capture flag is enabled on the API tier (PEN-5223 box 4; box 5 flips this)", () => {
  assert.match(api, ENABLED_PATTERN);
});

test("the EXPLAIN capture flag reaches the worker tier too, so captures can land on either", () => {
  // `env.extra` is rendered by BOTH deployment-api.yaml and statefulset.yaml.
  // This is asserted rather than assumed because box 4 has to know where to
  // look for the capture: the log line lands on whichever pod served the 57014.
  assert.match(worker, PRESENCE_PATTERN);
});

test("the flag is a plain-value entry, which is what makes it admissible", () => {
  // `PAPERCLIP_`-prefixed plain values are explicitly allowed by the policy's
  // env contract; a `valueFrom` on a name outside the 11 secret-bound names is
  // not. Pinned separately from the value so the box-5 flip cannot drop it.
  assert.match(api, PRESENCE_PATTERN);
  assert.doesNotMatch(api, VALUE_FROM_PATTERN);
  assert.ok(FLAG.startsWith("PAPERCLIP_"), `${FLAG} must be PAPERCLIP_-prefixed to be admissible`);
});
