import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");
const approveScript = readFileSync(
  new URL("../scripts/approve-paperclip-api-digest.sh", import.meta.url),
  "utf8",
);

// BLO-31598. `approve-paperclip-api-digest.sh` holds an in-flight lock from the
// moment it approves a digest until that digest's rollout actually lands. A
// deploy that dies between the approval step and `helm upgrade` therefore
// leaves a lock no rollout can ever clear, and every subsequent production
// deploy is refused at admission. That is not hypothetical: run 33763503004
// died in `pending-migration pre-flight` with `helm upgrade` skipped, and run
// 33810092507 was then refused against the lock it stranded.
//
// The script documents an escape hatch for exactly this, but before this change
// `docker.yml` declared no input for it and contained no occurrence of ABANDON,
// so the only way out was a human with the approver credential running the
// script by hand, outside CI. These tests pin the wiring that makes the
// documented remedy reachable from the workflow that needs it.

// Read the env var names out of the script rather than restating them, so a
// rename there fails here instead of silently disabling the escape hatch.
test("the approval script still exposes the abandon escape hatch this workflow wires", () => {
  assert.match(
    approveScript,
    /^ABANDON_IN_FLIGHT="\$\{PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT:-\}"/m,
    "approve script must read PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT",
  );
  assert.match(
    approveScript,
    /^ABANDON_IN_FLIGHT_OWNER="\$\{PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER:-\}"/m,
    "approve script must read PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER",
  );
});

test("workflow_dispatch declares both abandon inputs", () => {
  // Anchored at the input's own indentation so a mention inside a comment or a
  // `description:` string cannot satisfy this.
  assert.match(
    workflow,
    /^ {6}abandon_in_flight:$/m,
    "docker.yml must declare an abandon_in_flight dispatch input",
  );
  assert.match(
    workflow,
    /^ {6}abandon_in_flight_owner:$/m,
    "docker.yml must declare an abandon_in_flight_owner dispatch input",
  );
});

test("both abandon inputs are optional, so an ordinary deploy needs neither", () => {
  // A required input would make every routine deploy supply a lock to abandon.
  for (const name of ["abandon_in_flight", "abandon_in_flight_owner"]) {
    const block = workflow.match(new RegExp(`^ {6}${name}:$([\\s\\S]*?)(?=^ {6}\\S|^ {2}\\S)`, "m"));
    assert.ok(block, `${name} must be declared as a dispatch input`);
    assert.doesNotMatch(
      block[1],
      /required:\s*true/,
      `${name} must be optional; a routine deploy has no lock to abandon`,
    );
  }
});

test("the approve step passes both values through to the script", () => {
  // The invocation itself, not merely an `env:` entry: an env var the script
  // never receives is wiring that looks present and does nothing.
  assert.match(
    workflow,
    /PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT="\$\{ABANDON_IN_FLIGHT\}"/,
    "the approve invocation must forward PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT",
  );
  assert.match(
    workflow,
    /PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER="\$\{ABANDON_IN_FLIGHT_OWNER\}"/,
    "the approve invocation must forward PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER",
  );
});

test("the workflow rejects a half-supplied pair before touching the approver credential", () => {
  // The script rejects digest-alone because a configuration-only release can
  // reuse a digest, making the owner the part that identifies WHICH in-flight
  // approval is being retired. Failing early keeps a malformed abandon from
  // reaching the higher-privilege credential at all, and gives a clearer error
  // than the script's own.
  assert.match(
    workflow,
    /abandon_in_flight and abandon_in_flight_owner must be supplied together/,
    "docker.yml must refuse a half-supplied abandon pair with an explicit message",
  );
});

test("both abandon values are shape-checked in the workflow", () => {
  // Same reasoning as `target_sha`'s 40-hex check: reject a malformed value
  // where the error is readable, not deep inside the approver script.
  //
  // Bound to the abandon variables by name. An earlier draft asserted the bare
  // patterns `^sha256:[0-9a-f]{64}$` and `^[0-9a-f]{64}$`, and passed on
  // unmodified master -- docker.yml already shape-checks `digest` (three
  // places) and `marker` (one). A test that passes before the change under test
  // proves nothing about it.
  assert.match(
    workflow,
    /\[\[ !? ?"\$\{ABANDON_IN_FLIGHT\}" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/,
    "the abandon digest must be shape-checked by name",
  );
  assert.match(
    workflow,
    /\[\[ !? ?"\$\{ABANDON_IN_FLIGHT_OWNER\}" =~ \^\[0-9a-f\]\{64\}\$ \]\]/,
    "the abandon owner must be shape-checked by name",
  );
});
