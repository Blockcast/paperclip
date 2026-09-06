import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflowUrl = new URL("../.github/workflows/docker.yml", import.meta.url);
const workflow = readFileSync(workflowUrl, "utf8");
const approveScript = readFileSync(
  new URL("../scripts/approve-paperclip-api-digest.sh", import.meta.url),
  "utf8",
);

// BLO-31598. `approve-paperclip-api-digest.sh` holds an in-flight lock from the
// moment it approves a digest until that digest's rollout lands. A deploy that
// dies between the approval step and `helm upgrade` therefore leaves a lock no
// rollout can ever clear, and every subsequent production deploy is refused at
// admission. That is not hypothetical: run 33763503004 died in
// `pending-migration pre-flight` with `helm upgrade` skipped, and run
// 33810092507 was then refused against the lock it stranded.
//
// The script documents an escape hatch for exactly this, but before this change
// `docker.yml` declared no input for it and contained no occurrence of ABANDON,
// so the only way out was a human with the approver credential running the
// script by hand, outside CI.
//
// The guard's stated security property is that a malformed or half-supplied
// pair is rejected BEFORE the approver credential is written to disk. The
// executable matrix below is what actually holds that property: it runs the
// step's real shell, so a guard whose polarity is inverted or whose condition
// has been gutted fails here even if every regex below still matches.

// Extract the guard exactly as the step runs it. Anchored on the condition
// itself and on the comment that begins the next block; if either moves, this
// throws rather than silently testing nothing.
function extractGuard() {
  const start = workflow.indexOf('if [ -n "${ABANDON_IN_FLIGHT}${ABANDON_IN_FLIGHT_OWNER}" ]; then');
  assert.notEqual(start, -1, "could not locate the abandon guard in docker.yml");
  const end = workflow.indexOf("# mktemp -d, not a fixed path", start);
  assert.notEqual(end, -1, "could not locate the end anchor after the abandon guard");

  const body = workflow
    .slice(start, end)
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");

  // REACHED is the credential-write path the guard protects. Its absence is the
  // assertion: a rejected input must not get this far.
  return `set -euo pipefail\n${body}\necho REACHED_CREDENTIAL_WRITE\n`;
}

function runGuard({ digest, owner }) {
  try {
    const stdout = execFileSync("bash", ["-c", extractGuard()], {
      env: {
        ...process.env,
        ABANDON_IN_FLIGHT: digest,
        ABANDON_IN_FLIGHT_OWNER: owner,
        DIGEST: "sha256:" + "c".repeat(64),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, reached: stdout.includes("REACHED_CREDENTIAL_WRITE") };
  } catch (error) {
    return {
      code: error.status ?? 1,
      reached: String(error.stdout ?? "").includes("REACHED_CREDENTIAL_WRITE"),
    };
  }
}

const VALID_DIGEST = "sha256:" + "a".repeat(64);
const VALID_OWNER = "b".repeat(64);

test("the guard admits the two legitimate shapes and rejects every malformed one", () => {
  // Both directions. An always-failing guard would "gate" every bad case and
  // still be broken -- it would make the escape hatch unusable during the
  // incident it exists for -- so the two accepting rows are as load-bearing as
  // the four rejecting ones. This is also what catches an inverted polarity: a
  // flipped `=~` rejects the well-formed pair and fails the last row.
  const cases = [
    { name: "neither set (ordinary deploy)", digest: "", owner: "", code: 0, reached: true },
    { name: "digest only", digest: VALID_DIGEST, owner: "", code: 1, reached: false },
    { name: "owner only", digest: "", owner: VALID_OWNER, code: 1, reached: false },
    { name: "malformed digest", digest: "nope", owner: VALID_OWNER, code: 1, reached: false },
    { name: "malformed owner", digest: VALID_DIGEST, owner: "nothex", code: 1, reached: false },
    { name: "both valid", digest: VALID_DIGEST, owner: VALID_OWNER, code: 0, reached: true },
  ];

  for (const expected of cases) {
    const actual = runGuard(expected);
    assert.equal(actual.code, expected.code, `${expected.name}: wrong exit code`);
    assert.equal(
      actual.reached,
      expected.reached,
      expected.reached
        ? `${expected.name}: must reach the credential write`
        : `${expected.name}: must be rejected BEFORE the credential write`,
    );
  }
});

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

test("the pairing guard asserts on its condition, not on the prose it prints", () => {
  // An earlier draft matched only the message text. Gutting the condition to
  // `if false; then` while leaving the `echo` in place kept that draft green,
  // so the "reject before the credential reaches disk" property could lapse
  // silently and leave the approve script -- which runs after the credential is
  // written -- as the only enforcement.
  assert.match(
    workflow,
    /\[ -z "\$\{ABANDON_IN_FLIGHT\}" \] \|\| \[ -z "\$\{ABANDON_IN_FLIGHT_OWNER\}" \]/,
    "the half-supplied check must test both variables for emptiness",
  );
});

test("both abandon values are shape-checked, with the negation required", () => {
  // The `!` is mandatory, not optional. A draft that wrote `!? ?` accepted an
  // INVERTED guard, which rejects every well-formed digest -- the hatch would
  // fail closed at exactly the moment an incident needs it -- while malformed
  // values fell through to the credential-write path.
  //
  // Bound to the abandon variables by name. An even earlier draft asserted the
  // bare patterns and passed on unmodified master, which already shape-checks
  // `digest` (three places) and `marker` (one). A test that passes before the
  // change under test proves nothing about it.
  assert.match(
    workflow,
    /\[\[ ! "\$\{ABANDON_IN_FLIGHT\}" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/,
    "the abandon digest must be shape-checked by name, with the negation present",
  );
  assert.match(
    workflow,
    /\[\[ ! "\$\{ABANDON_IN_FLIGHT_OWNER\}" =~ \^\[0-9a-f\]\{64\}\$ \]\]/,
    "the abandon owner must be shape-checked by name, with the negation present",
  );
});

test("the workflow's accepted shapes match the approval script's", () => {
  // The patterns are duplicated across two files. Bind them the same way the
  // env var names are bound above: if the script ever widens what it accepts,
  // the workflow would silently become the stricter gate and reject values the
  // script would have taken.
  const scriptDigest = approveScript.match(/"\$ABANDON_IN_FLIGHT" =~ (\^sha256:\S+\$)/);
  const scriptOwner = approveScript.match(/"\$ABANDON_IN_FLIGHT_OWNER" =~ (\^\[0-9a-f\]\S*\$)/);
  assert.ok(scriptDigest, "approve script must shape-check the abandon digest");
  assert.ok(scriptOwner, "approve script must shape-check the abandon owner");

  assert.ok(
    workflow.includes(scriptDigest[1]),
    `docker.yml must accept the same digest shape as the script (${scriptDigest[1]})`,
  );
  assert.ok(
    workflow.includes(scriptOwner[1]),
    `docker.yml must accept the same owner shape as the script (${scriptOwner[1]})`,
  );
});
