import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PEN-6104 done-when 1: the deliberate `EXPLAIN (ANALYZE, BUFFERS)` probe for
 * the wake-membership statement is enabled in production for a bounded
 * diagnostic window.
 *
 * Twin of `issue-list-analyze-probe-flag.test.mjs`, with two differences that
 * are the whole reason this file exists separately.
 *
 * **1. The value is a set of issue UUIDs, not a boolean and not an
 * identifier.** `shouldProbeWakeDiagnostics` compares each comma-separated
 * entry against `issue.id` lower-cased, so `value: "PEN-6104"` is valid YAML,
 * passes admission, reads as enabled on every dashboard -- and matches
 * nothing. The sibling flag's silent no-op is a boolean; this one's is the
 * human-facing identifier, which is strictly the easier mistake to make
 * because it is the string a person uses for this row everywhere else. Both
 * shapes are refused by name below.
 *
 * **2. The pin is the SHAPE and the COUNT, deliberately not the two literal
 * ids.** PEN-6104's own experiment-design constraint requires the probed rows
 * to be re-picked at measurement time -- a row that was sparse-but-populated
 * when the values file was written can have been pruned empty by the 14-day
 * retention before the capture is taken. Pinning the literal UUIDs would make
 * the correct action (re-pick, re-measure) fight the test, so what is pinned
 * is the part that is wrong no matter which rows are chosen: enabled at all,
 * exactly two of them, and each one a thing the server can actually match.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const VALUES_FILE = "deploy/helm/paperclip/values.blockcast.yaml";
const FLAG = "PAPERCLIP_EXPLAIN_ANALYZE_WAKE_DIAGNOSTICS_ISSUE_IDS";

const PRESENCE_PATTERN = new RegExp(`- name: ${FLAG}\\n`);
/**
 * Helm emits a quoted scalar here because the configured value contains
 * commas, but an empty value renders as `value: ""` and a single bare UUID
 * would render unquoted. The pattern captures the rest of the line and the
 * quotes come off in {@link probeIds}, so the assertions survive all three.
 */
const VALUE_PATTERN = new RegExp(`- name: ${FLAG}\\n\\s+value: (.*)`);
/** A `valueFrom` would be denied by admission for a non-secret-bound name. */
const VALUE_FROM_PATTERN = new RegExp(`- name: ${FLAG}\\n\\s+valueFrom:`);

/** Values that are "on" in the boolean sense but probe nothing. */
const BOOLEAN_SHAPED = new Set(["true", "false", "1", "0", "yes", "no", "on", "off", "enabled"]);
/** `PEN-6104` is what a person calls the row; the server matches `issue.id`. */
const IDENTIFIER_SHAPED = /^[a-z]+-\d+$/;
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The configured ids, parsed exactly as `wakeDiagnosticsProbeIssueIds` parses
 * them out of the environment: split on commas, trimmed, lower-cased, blanks
 * dropped. Re-implemented rather than imported because this test renders the
 * chart and never loads the server.
 */
function probeIds(rendered) {
  const match = rendered.match(VALUE_PATTERN);
  assert.ok(match, `${FLAG} must be present with a plain value`);
  const raw = match[1].trim().replace(/^"(.*)"$/, "$1");
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

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

test("the wake-diagnostics ANALYZE probe is ON, with a dense row and a sparse one", () => {
  // The measurement is the CONTRAST, so one id is not a smaller version of
  // this experiment -- it is a different one that cannot answer done-when 1's
  // question. Turning the probe off once both plans are recorded means
  // emptying the value and inverting this assertion, in front of a reviewer,
  // exactly as box 4 did for the issues-list probe.
  const ids = probeIds(api);
  assert.equal(
    ids.length,
    2,
    `${FLAG} names ${ids.length} issue id(s). done-when 1 needs a DENSE row and a `
      + "SPARSE one captured under one deploy: the LIMIT bounds the scan only while "
      + "matches are dense, so a single row cannot show the effect it is measuring.",
  );
});

test("every probe id is a UUID, not the PEN- identifier or a boolean", () => {
  // The failure this exists to catch: someone "enables" the probe with the
  // string they use for the row everywhere else. `shouldProbeWakeDiagnostics`
  // compares against `issue.id`, so a PEN- identifier matches nothing, logs
  // nothing, and is indistinguishable at the log from a flag never set.
  for (const id of probeIds(api)) {
    assert.ok(
      !BOOLEAN_SHAPED.has(id),
      `${FLAG} contains "${id}", a boolean-shaped value. The value is a set of issue UUIDs.`,
    );
    assert.ok(
      !IDENTIFIER_SHAPED.test(id),
      `${FLAG} contains "${id}", which is the human identifier. The server matches `
        + "`issue.id`, so this probes nothing. Use the row's UUID.",
    );
    assert.match(
      id,
      UUID_SHAPED,
      `${FLAG} contains "${id}", which is not a UUID and cannot match any issue.id.`,
    );
  }
});

test("the probe flag reaches the worker tier too, so a probe can land on either", () => {
  // `env.extra` is rendered by BOTH deployment-api.yaml and statefulset.yaml.
  // Asserted rather than assumed because the capture has to be looked for:
  // the log line lands on whichever pod served the matching request, and the
  // per-process budget is per-POD, so a two-replica API tier admits 2x it.
  assert.match(worker, PRESENCE_PATTERN);
});

test("the flag is a plain-value entry, which is what makes it admissible", () => {
  // `PAPERCLIP_`-prefixed plain values are explicitly allowed by the admission
  // policy's env contract; a `valueFrom` on a name outside the secret-bound
  // names is not. Pinned separately from the value so that emptying it later
  // cannot drop the admissibility cover.
  assert.match(api, PRESENCE_PATTERN);
  assert.doesNotMatch(api, VALUE_FROM_PATTERN);
  assert.ok(FLAG.startsWith("PAPERCLIP_"), `${FLAG} must be PAPERCLIP_-prefixed to be admissible`);
});
