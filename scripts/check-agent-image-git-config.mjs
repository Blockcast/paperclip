#!/usr/bin/env node
// Assertion (b) of PEN-4541: the git-config surface of the AGENT IMAGE AS
// BUILT, checked before that image is promoted or rolled out to any agent.
//
// Usage: node scripts/check-agent-image-git-config.mjs <image-ref>
//
// WHY THIS EXISTS ALONGSIDE THE SOURCE-LEVEL CHECK
// ------------------------------------------------
// Its pair, assertion (a), lives in
// `deploy/helm/paperclip/tests/agent-egress-path.test.mjs` and asserts the
// surface AS DECLARED IN THIS REPO -- the `-c` flags in
// docker/github-wrappers/ and the single `git config --system` line in
// Dockerfile.runtime. That is the cheaper check and it catches the mutation in
// the diff, before an image is ever built.
//
// It is also structurally blind to anything that writes /etc/gitconfig from
// OUTSIDE those declared lines: a SERVER_IMAGE or TOOLCHAIN_IMAGE base change,
// a toolchain layer, a vendored step, a package postinst. Those produce an
// agent image whose system scope nobody in this repo declared, and every
// source-level assertion stays green. Hence this one, which reads the artifact
// instead of the intent. Neither is sufficient alone; do not delete one as
// redundant with the other.
//
// ⛔ EXPLICITLY OUT OF SCOPE -- do not read a green run as covering it
// --------------------------------------------------------------------
// This measures the image AT PRODUCTION. It does NOT cover:
//   * mutation of an already-published image -- a Harbor retag or an overwrite
//     of a tag that already passed this gate;
//   * drift of an already-running pod.
// Registry-side immutability is a separate control and was deliberately NOT
// assigned with PEN-4541. If you judge it needed, file it; do not assume this
// script grew to cover it.
//
// WHY `docker create` + `docker cp` AND NOT `docker run`
// -------------------------------------------------------
// This is a security control reading an artifact it exists to distrust, so it
// never executes that artifact's code. `docker create` makes a container
// without starting it and `docker cp` reads its filesystem from the daemon
// side, so a `cat` or `git` shipped inside the image cannot influence what this
// script sees. Parsing then happens with the RUNNER's git and this repo's
// predicates: trusted parser, untrusted data. A `docker run --entrypoint cat`
// would be shorter and would hand the measurement to the thing being measured.

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  configFlags,
  configInjectionEnv,
  insteadOfOccurrences,
  redactCredentials,
  residualSecrets,
  EXPECTED_SYSTEM_CONFIG_ENTRIES,
  EXPECTED_SYSTEM_GITCONFIG,
  EXPECTED_WRAPPER_CONFIG_FLAGS,
} from "./git-config-surface.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_WRAPPER_BIN = "/usr/local/libexec/paperclip/bin";
const SYSTEM_GITCONFIG = "/etc/gitconfig";

const imageRef = process.argv[2];
if (!imageRef) {
  console.error("usage: check-agent-image-git-config.mjs <image-ref>");
  process.exit(64);
}

function docker(args, options = {}) {
  return execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"], ...options });
}

// Copy a path out of the image. Returns null when the path does not exist,
// which is a distinct outcome from "exists and is empty" -- a missing
// /etc/gitconfig means the credential helper every agent depends on is simply
// not there, and that must read as a finding rather than as a clean scan.
function copyOut(container, source, destination) {
  try {
    docker(["cp", `${container}:${source}`, destination]);
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (/no such file or directory|Could not find the file/i.test(stderr)) return null;
    throw error;
  }
  return destination;
}

const findings = [];
function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    console.log(`  FAIL  ${label}`);
    console.log(`        ${error.message.split("\n").join("\n        ")}`);
    findings.push(label);
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pen4541-"));
let container = "";
try {
  // `--entrypoint` is overridden to a value that is never executed: `create`
  // does not start the container, and pinning it makes that explicit to a
  // reader and immune to an image whose entrypoint has side effects on create.
  container = String(
    docker(["create", "--entrypoint", "/nonexistent-never-executed", imageRef]),
  ).trim();
  console.log(`agent image : ${imageRef}`);
  console.log(`container   : ${container.slice(0, 12)} (created, never started)`);

  const gitconfigPath = copyOut(
    container,
    SYSTEM_GITCONFIG,
    path.join(workDir, "gitconfig"),
  );
  const wrapperPath = copyOut(
    container,
    `${IMAGE_WRAPPER_BIN}/git`,
    path.join(workDir, "git-wrapper"),
  );

  console.log(`\n${SYSTEM_GITCONFIG} (as shipped in the image)`);

  check(`${SYSTEM_GITCONFIG} exists in the image`, () => {
    assert.ok(
      gitconfigPath,
      `${SYSTEM_GITCONFIG} is absent from ${imageRef}. Dockerfile.runtime writes it with \`git config --system\`; without it no agent has the gh credential helper and every private-repo git operation fails with what looks like a permissions error.`,
    );
  });

  if (gitconfigPath) {
    const raw = fs.readFileSync(gitconfigPath, "utf8");

    // THE WRONG-MACHINE DETECTOR, and the reason it is byte-exact.
    //
    // PEN-4538 kept this check out of the PVC scrubber for exactly one reason:
    // a process reading its OWN /etc/gitconfig measures its own container, not
    // the agent image, and reports a confident wrong answer forever. That
    // failure mode is cheap to exclude here: the agent image's system scope is
    // 77 bytes, one section, one key, and no CI runner's own /etc/gitconfig
    // looks like that. So a read that drifted onto the runner fails here
    // instead of passing silently.
    //
    // It doubles as the equality that makes the rest of this file meaningful:
    // asserting only "no insteadOf" would pass on a scope that had grown a
    // dozen other keys from a base-image change, which is the whole class (b)
    // exists to catch.
    check(`${SYSTEM_GITCONFIG} is exactly the declared system scope`, () => {
      // `assert.ok`, not `assert.equal`, and this is NOT style. A failing
      // `assert.equal` appends its OWN diff of the raw values after the
      // message, so the redaction below would be undone one line later by the
      // assertion library. Every comparison in this file that can touch a
      // credential is written this way for that reason; the control in
      // check-agent-image-git-config.test.mjs is what proves it.
      assert.ok(
        raw === EXPECTED_SYSTEM_GITCONFIG,
        `${SYSTEM_GITCONFIG} in the built image is not the one Dockerfile.runtime declares.\n--- expected ---\n${JSON.stringify(EXPECTED_SYSTEM_GITCONFIG)}\n--- got (credentials redacted) ---\n${JSON.stringify(redactCredentials(raw))}\nIf this changed deliberately, update EXPECTED_SYSTEM_GITCONFIG in scripts/git-config-surface.mjs in the same commit. If it did NOT, something outside this repo's declared lines is writing the agent image's system git scope (a base-image bump, a toolchain layer, a package postinst) — which is precisely what this assertion exists to catch.`,
      );
    });

    // The CTO's own measurement on PEN-4541, re-run here against the image
    // rather than against a live seat: rc 1 and zero lines. Parsed with the
    // RUNNER's git over the extracted bytes, so git's own config grammar does
    // the reading and a spelling this script's regexes do not anticipate is
    // still resolved as git would resolve it.
    check(`${SYSTEM_GITCONFIG} defines no insteadOf rule (git --get-regexp)`, () => {
      let output = "";
      let status = 0;
      try {
        output = String(
          execFileSync("git", ["config", "--file", gitconfigPath, "--get-regexp", "insteadof"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      } catch (error) {
        status = error.status ?? 1;
        output = String(error.stdout ?? "");
      }
      const lines = output.split("\n").filter((line) => line.trim() !== "");
      assert.ok(
        lines.length === 0,
        `the agent image's system git scope defines an insteadOf rule, which silently reroutes every GitHub URL in every repo on every agent away from the credential helper: ${redactCredentials(lines.join(" | "))}`,
      );
      assert.equal(status, 1, `expected git --get-regexp to exit 1 on no match, got ${status}`);
    });

    // Belt to the regex's braces: git resolves the key set, so a rule written
    // in a spelling `insteadOfOccurrences` does not anticipate still shows up
    // as an extra entry here.
    check(`${SYSTEM_GITCONFIG} defines exactly one key`, () => {
      const entries = String(
        execFileSync("git", ["config", "--file", gitconfigPath, "--list"], {
          encoding: "utf8",
        }),
      )
        .split("\n")
        .filter((line) => line.trim() !== "");
      // Compared raw, printed redacted: a config key can itself be a URL
      // carrying a credential (that is the `[url "..."]` section-name shape
      // PEN-4330 found), so the diff `deepEqual` would print is exactly the
      // thing that must not reach a CI log.
      assert.ok(
        entries.length === EXPECTED_SYSTEM_CONFIG_ENTRIES.length &&
          entries.every((entry, i) => entry === EXPECTED_SYSTEM_CONFIG_ENTRIES[i]),
        `the agent image's system git scope is no longer one section with one key: ${redactCredentials(entries.join(" | "))}`,
      );
    });

    check(`${SYSTEM_GITCONFIG} carries no credential-bearing URL`, () => {
      assert.equal(
        residualSecrets(raw),
        0,
        `${SYSTEM_GITCONFIG} carries a credential in a URL. This file ships inside the image at 0644 and is readable by every agent process — the same class as the ghs_ token found at rest on the PVC (PEN-4330). The value is not printed here on purpose.`,
      );
    });

    check(`${SYSTEM_GITCONFIG} names no insteadOf in any casing`, () => {
      assert.deepEqual(insteadOfOccurrences(raw), []);
    });
  }

  console.log(`\n${IMAGE_WRAPPER_BIN}/git (as shipped in the image)`);

  check(`${IMAGE_WRAPPER_BIN}/git exists in the image`, () => {
    assert.ok(
      wrapperPath,
      `${IMAGE_WRAPPER_BIN}/git is absent from ${imageRef}. Without it /usr/bin/git is reached directly and the paperclip credential helper is never installed.`,
    );
  });

  if (wrapperPath) {
    const shipped = fs.readFileSync(wrapperPath);
    const declared = fs.readFileSync(path.join(repoRoot, "docker/github-wrappers/git"));

    // BYTE identity, not "contains the expected flags". The source-level check
    // already asserts the repo file's flag set; what this adds is that the
    // image carries THAT file and not a build-time-modified descendant of it.
    // A content comparison that re-derived the flags from the shipped copy
    // would pass on any file whose flags happen to parse the same, which
    // re-opens the gap for everything else in the script.
    check(`${IMAGE_WRAPPER_BIN}/git is byte-identical to docker/github-wrappers/git`, () => {
      assert.equal(
        crypto.createHash("sha256").update(shipped).digest("hex"),
        crypto.createHash("sha256").update(declared).digest("hex"),
        `the git wrapper in the image differs from the one in this repo. Something modified it between COPY and publish, so every source-level assertion about its flags describes a file that is not the one agents execute.\n--- image (credentials redacted) ---\n${redactCredentials(shipped.toString("utf8"))}\n--- repo ---\n${redactCredentials(declared.toString("utf8"))}`,
      );
    });

    // Asserted against the SHIPPED bytes, so this holds even if the byte
    // identity above is ever relaxed. Same equality discipline as (a): an
    // added `-c` flag is the attack, so a superset check cannot see it.
    const body = shipped.toString("utf8");
    check(`${IMAGE_WRAPPER_BIN}/git passes exactly the declared git config flags`, () => {
      const flags = configFlags(body);
      const expected = EXPECTED_WRAPPER_CONFIG_FLAGS.get("git");
      assert.ok(
        flags.length === expected.length && flags.every((flag, i) => flag === expected[i]),
        `the git wrapper in the image passes git config flags that are not the declared set: ${redactCredentials(flags.join(" | "))}`,
      );
      assert.ok(
        insteadOfOccurrences(body).length === 0,
        "the git wrapper in the image names an insteadOf rule",
      );
      assert.equal(
        configInjectionEnv(body),
        null,
        "the git wrapper in the image sets a GIT_CONFIG* variable",
      );
    });
  }
} finally {
  if (container) {
    try {
      docker(["rm", "-f", container], { stdio: "ignore" });
    } catch {
      // A leaked container on an ephemeral runner is not worth failing a
      // security gate over, and swallowing it here keeps a real finding above
      // as the reported cause rather than this.
    }
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}

if (findings.length > 0) {
  console.error(
    `\nPEN-4541: ${findings.length} finding(s) in the agent image's git-config surface:\n  - ${findings.join("\n  - ")}`,
  );
  process.exit(1);
}
console.log("\nPEN-4541: the agent image's git-config surface matches the declared one.");
