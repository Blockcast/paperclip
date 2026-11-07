// scripts/resolve-base-digest.sh is the only thing standing between an image
// build and a base image nobody can name afterwards (PEN-5927), so the two
// properties that make it worth having are asserted here:
//
//   1. it FAILS CLOSED — an unreachable registry, or a registry that answers
//      with something that is not a digest, must be exit 1 and empty stdout.
//      A silent fall back to the floating tag would reintroduce exactly the
//      ambiguity the script exists to remove, and would do it invisibly.
//   2. it does not corrupt the reference — in particular `host:5000/img` is a
//      registry PORT, not a tag, and the naive `${ref%:*}` that the inline
//      copies in docker.yml / docker-agent.yml use would truncate it to `host`.
//
// strip_tag is extracted out of the shipping script and sourced, following
// scripts/approve-paperclip-api-digest.test.js: a rename or a rewrite fails
// this test rather than silently leaving it asserting against a stale copy.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// fileURLToPath, not URL.pathname: pathname does not percent-decode, so a
// checkout path containing a space or non-ASCII character would resolve wrong.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = path.join(repoRoot, "scripts/resolve-base-digest.sh");
const script = readFileSync(scriptPath, "utf8");

const FUNCTION_NAME = "strip_tag";
const SHA = `sha256:${"a1b2c3d4".repeat(8)}`;

function extractShellFunction(name) {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `${name}() not found in ${scriptPath} — was it renamed or removed?`);
  const end = lines.indexOf("}", start);
  assert.notEqual(end, -1, `${name}() has no closing brace`);
  return lines.slice(start, end + 1).join("\n");
}

function stripTag(ref) {
  const fn = extractShellFunction(FUNCTION_NAME);
  const result = spawnSync("bash", ["-c", `${fn}\n${FUNCTION_NAME} "$1"`, "bash", ref], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${FUNCTION_NAME} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

// Runs the real script with a stub `docker` first on PATH. `body` is the stub's
// shell body; it sees the attempt number in $PAPERCLIP_STUB_ATTEMPT, counted by
// the stub itself through a file, so retry behaviour is observable.
function runScript(ref, stubBody, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-base-digest-"));
  const counter = path.join(dir, "attempts");
  writeFileSync(counter, "0");
  const stub = path.join(dir, "docker");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `n=$(( $(cat ${JSON.stringify(counter)}) + 1 ))`,
      `printf '%s' "$n" > ${JSON.stringify(counter)}`,
      "PAPERCLIP_STUB_ATTEMPT=$n",
      stubBody,
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  const result = spawnSync("bash", [scriptPath, ref], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      // Keep the retry tests instant; the script's own default is 2s per step.
      PAPERCLIP_BASE_DIGEST_BACKOFF_SECONDS: "0",
      ...env,
    },
  });
  return { ...result, attempts: Number(readFileSync(counter, "utf8")) };
}

const RESOLVES = `printf '"%s"\\n' '${SHA}'`;
const FAILS = "echo 'dial tcp: connection refused' >&2; exit 1";

test("strip_tag drops a tag but never a registry port", () => {
  assert.equal(stripTag("node:22-alpine"), "node");
  assert.equal(stripTag("harbor.blockcast.net/paperclip/node:lts-trixie-slim"), "harbor.blockcast.net/paperclip/node");
  assert.equal(stripTag("mcr.microsoft.com/playwright:v1.49.1-jammy"), "mcr.microsoft.com/playwright");
  // The case the inline `${ref%:*}` copies get wrong.
  assert.equal(stripTag("host:5000/img:tag"), "host:5000/img");
  assert.equal(stripTag("host:5000/img"), "host:5000/img");
  assert.equal(stripTag("node"), "node");
});

test("resolves a floating tag to an immutable reference", () => {
  const { status, stdout, attempts } = runScript("node:22-alpine", RESOLVES);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), `node@${SHA}`);
  assert.equal(attempts, 1, "a resolvable base should not be retried");
});

test("an already-pinned reference is echoed back without a registry lookup", () => {
  const ref = `node@${SHA}`;
  // The stub would exit 1 if it ran at all, so a 0 exit proves it did not.
  const { status, stdout, attempts } = runScript(ref, FAILS);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), ref);
  assert.equal(attempts, 0);
});

test("retries a flaky registry and succeeds", () => {
  const { status, stdout, attempts } = runScript(
    "node:22-alpine",
    `if [ "$PAPERCLIP_STUB_ATTEMPT" -lt 3 ]; then ${FAILS}; fi; ${RESOLVES}`,
  );
  assert.equal(status, 0);
  assert.equal(stdout.trim(), `node@${SHA}`);
  assert.equal(attempts, 3);
});

test("fails closed when the base never resolves", () => {
  const { status, stdout, stderr, attempts } = runScript("node:22-alpine", FAILS, {
    PAPERCLIP_BASE_DIGEST_ATTEMPTS: "3",
  });
  assert.equal(status, 1, "an unresolvable base must be a red build, not a floating tag");
  assert.equal(stdout.trim(), "", "nothing may reach stdout — a caller captures it as the base ref");
  assert.match(stderr, /Unable to resolve node:22-alpine/);
  assert.equal(attempts, 3, "PAPERCLIP_BASE_DIGEST_ATTEMPTS must bound the loop");
});

test("fails closed when the registry answers with something that is not a digest", () => {
  // imagetools printing a warning, an error object, or a truncated digest is
  // the dangerous case: non-empty stdout would otherwise be concatenated into a
  // reference that fails much later, at pull time, with an opaque message.
  for (const junk of ['"not-a-digest"', '"sha256:abc"', '"{\\"error\\":\\"unauthorized\\"}"']) {
    const { status, stdout, stderr } = runScript("node:22-alpine", `printf '%s\\n' ${JSON.stringify(junk)}`);
    assert.equal(status, 1, `expected a malformed digest ${junk} to fail closed`);
    assert.equal(stdout.trim(), "");
    assert.match(stderr, /malformed digest/);
  }
});

test("rejects an empty argument instead of resolving something unintended", () => {
  const { status, stderr } = runScript("", RESOLVES);
  assert.equal(status, 64);
  assert.match(stderr, /usage:/);
});
