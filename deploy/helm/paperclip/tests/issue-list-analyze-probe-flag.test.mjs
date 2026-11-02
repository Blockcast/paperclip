import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PEN-5296 box 2: the deliberate `EXPLAIN (ANALYZE, BUFFERS)` probe is enabled
 * in production for a bounded diagnostic window.
 *
 * Twin of `issue-list-timeout-explain-flag.test.mjs`, with one difference that
 * is the whole reason this file exists separately: **the value of this flag is
 * the search term to probe, not a boolean.** `value: "true"` would be a valid
 * YAML entry, would pass admission, would look enabled in every dashboard --
 * and would probe the literal term `true`, which matches nothing and measures
 * nothing. A boolean here is the silent-no-op failure, so it is asserted
 * against by name rather than left to review.
 *
 * Box 4 flips the value to "" (off). At that point the ENABLED test is the one
 * assertion that has to change, and it changing is the point: the flip should
 * be a deliberate edit with a reviewer looking at it, not silent drift.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const VALUES_FILE = "deploy/helm/paperclip/values.blockcast.yaml";
const FLAG = "PAPERCLIP_EXPLAIN_ANALYZE_ISSUE_LIST_TERM";

const PRESENCE_PATTERN = new RegExp(`- name: ${FLAG}\\n`);
/**
 * Helm emits an unquoted scalar for a term it does not need to quote
 * (`value: the`) and a quoted one when it does (`value: "true"`), so the
 * pattern captures the rest of the line and the quotes come off in
 * {@link probeTerm}. Pinning `value: "..."` here would pass today only by
 * accident of which term is configured.
 */
const VALUE_PATTERN = new RegExp(`- name: ${FLAG}\\n\\s+value: (.*)`);

/** The configured term, as the server will read it out of the environment. */
function probeTerm(rendered) {
  const match = rendered.match(VALUE_PATTERN);
  assert.ok(match, `${FLAG} must be present with a plain value`);
  return match[1].trim().replace(/^"(.*)"$/, "$1");
}
/** A `valueFrom` would be denied by admission for a non-secret-bound name. */
const VALUE_FROM_PATTERN = new RegExp(`- name: ${FLAG}\\n\\s+valueFrom:`);

/** Values that are "on" in the boolean sense but probe nothing. */
const BOOLEAN_SHAPED = new Set(["true", "false", "1", "0", "yes", "no", "on", "off", "enabled"]);

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

test("the ANALYZE probe flag carries a search term on the API tier (PEN-5296 box 2; box 4 clears it)", () => {
  assert.notEqual(probeTerm(api), "", `${FLAG} is empty, so no probe will ever fire`);
});

test("the probe term is not boolean-shaped, which would be a silent no-op", () => {
  // The failure this exists to catch: someone "enables" the probe by copying
  // the neighbouring flag's `value: "true"`. That probes the term `true`,
  // matches nothing, and logs nothing -- indistinguishable at the log from a
  // flag that was never set.
  const term = probeTerm(api);
  assert.ok(
    !BOOLEAN_SHAPED.has(term.toLowerCase()),
    `${FLAG} is set to "${term}", which is a search term that matches nothing. `
      + "The value must be the term to probe.",
  );
});

test("the probe flag reaches the worker tier too, so a probe can land on either", () => {
  // `env.extra` is rendered by BOTH deployment-api.yaml and statefulset.yaml.
  // Asserted rather than assumed because box 2 has to know where to look: the
  // log line lands on whichever pod served the matching request.
  assert.match(worker, PRESENCE_PATTERN);
});

test("the flag is a plain-value entry, which is what makes it admissible", () => {
  // `PAPERCLIP_`-prefixed plain values are explicitly allowed by the admission
  // policy's env contract; a `valueFrom` on a name outside the secret-bound
  // names is not. Pinned separately from the value so the box-4 flip cannot
  // drop it.
  assert.match(api, PRESENCE_PATTERN);
  assert.doesNotMatch(api, VALUE_FROM_PATTERN);
  assert.ok(FLAG.startsWith("PAPERCLIP_"), `${FLAG} must be PAPERCLIP_-prefixed to be admissible`);
});
