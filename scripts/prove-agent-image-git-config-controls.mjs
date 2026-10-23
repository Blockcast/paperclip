#!/usr/bin/env node
// The positive controls for PEN-4541 assertion (b).
//
// Usage: node scripts/prove-agent-image-git-config-controls.mjs <agent-image-ref>
//
// WHY THIS EXISTS AS A REQUIRED STEP, NOT A COURTESY
// ---------------------------------------------------
// `check-agent-image-git-config.mjs` is a detective control, and the thing that
// fails silently about a detective control is the DETECTOR. A check that reads
// the wrong file -- or whose predicate can no longer match -- passes trivially
// and forever, and nothing about its green run distinguishes "the image is
// clean" from "this has been measuring nothing since the day it shipped".
// PEN-4538 kept exactly this check out of the PVC scrubber for exactly that
// reason: a process that reads its OWN /etc/gitconfig measures its own
// container and reports a confident wrong answer about the agent image.
//
// So each assertion the checker makes gets an input here that must RED it. The
// inversion is the whole point: a control that comes back GREEN is a FAILURE.
//
// THE ONE THAT PROVES THE CHECKER READS THE AGENT IMAGE
// ------------------------------------------------------
// Every mutation below is applied to a one-layer image derived FROM the agent
// image and to nothing else. This runner's own filesystem is never touched. So
// a checker that had drifted onto reading the runner would stay green on all
// three, the inversion would fail, and this step would go red -- which is the
// only way that drift is observable from outside.
//
// The complementary half, which this cannot provide, is in
// `scripts/check-agent-image-git-config.test.mjs`: that drives the checker's
// content logic through a `docker` shim on every PR, with no daemon. Read the
// two together -- that file proves the checker reacts correctly to content,
// this one proves it is pointed at the right image.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { credentialedUrl } from "./git-config-surface.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = path.join(repoRoot, "scripts/check-agent-image-git-config.mjs");

const baseImage = process.argv[2];
if (!baseImage) {
  console.error("usage: prove-agent-image-git-config-controls.mjs <agent-image-ref>");
  process.exit(64);
}

// One control per assertion the checker makes. Each is a complete Dockerfile;
// `BASE` is passed as a build arg rather than interpolated, so nothing in this
// file has to be escaped for a shell and the mutation reads as what it is.
//
// `USER root` is required: PEN-3715 ships the wrapper tree root-owned and not
// other-writable precisely so the agent uid cannot rewrite it, and
// /etc/gitconfig is 0644 root:root.
const CONTROLS = [
  {
    name: "insteadof",
    // Correction C3's mutation in the system scope. Also the wrong-machine
    // control: it exists only inside the derived image.
    asserts: "the system scope defines no insteadOf rule",
    dockerfile: [
      "ARG BASE",
      "FROM ${BASE}",
      "USER root",
      "RUN git config --system url.https://control.invalid/.insteadOf https://github.com/",
    ],
  },
  {
    name: "credential",
    // A credential-bearing URL in a URL SECTION NAME -- the shape the
    // 2026-10-19 token at rest actually took (PEN-4330), and the one an
    // implementation anchored to `url = ` / `remote = ` keys would miss.
    //
    // The value is deliberately NOT token-shaped. `residual_secrets()` keys on
    // `user:secret@`, not on a token prefix, so this control fires without any
    // realistic-looking credential ever existing in this repository or in a
    // build log.
    asserts: "the system scope carries no credential-bearing URL",
    dockerfile: [
      "ARG BASE",
      "FROM ${BASE}",
      "USER root",
      `RUN git config --system "url.${credentialedUrl({ secret: "control-not-a-real-token" })}.insteadOf" https://github.com/`,
    ],
  },
  {
    name: "extra-key",
    // No insteadOf and no credential: only the EQUALITY can see this one. It
    // stands in for the class assertion (b) exists for -- a base-image bump or
    // toolchain layer writing the system scope outside this repo's declared
    // lines.
    asserts: "the system scope is exactly the declared one / defines exactly one key",
    dockerfile: [
      "ARG BASE",
      "FROM ${BASE}",
      "USER root",
      "RUN git config --system http.sslVerify false",
    ],
  },
  {
    name: "wrapper",
    // Correction C3 applied to the shipped wrapper: ONE added `-c` flag, which
    // adds zero occurrences of the wrapper path the pre-existing PEN-3748
    // guard counts, so that guard stays green while this must not.
    //
    // The `grep` is this control's own control: if the `sed` ever stops
    // matching (the wrapper's last line is reshaped), the build fails loudly
    // instead of producing an unmutated image that the checker then correctly
    // passes -- which would read as "the checker is broken" and send the next
    // reader in the wrong direction entirely.
    asserts: "the shipped wrapper is byte-identical / passes exactly the declared flags",
    dockerfile: [
      "ARG BASE",
      "FROM ${BASE}",
      "USER root",
      'RUN sed -i \'s#^  "$@"$#  -c url.https://control.invalid/.insteadOf=https://github.com/ "$@"#\' /usr/local/libexec/paperclip/bin/git \\',
      "  && grep -q 'control.invalid' /usr/local/libexec/paperclip/bin/git",
    ],
  },
  {
    name: "wrapper-config-env",
    // The shape that walked past BOTH assertions at b70c7aae (Ally review).
    // `--config-env=<key>=<ENVVAR>` injects config with exactly the force of
    // `-c`, and the payload here is a CREDENTIAL HELPER rather than a URL
    // rewrite -- so it names no insteadOf and the insteadOf scan is no
    // backstop. Its own `grep` control, same reasoning as the `wrapper` case.
    asserts: "the shipped wrapper passes exactly the declared flags, in either argv spelling",
    dockerfile: [
      "ARG BASE",
      "FROM ${BASE}",
      "USER root",
      'RUN sed -i \'s#^  "$@"$#  --config-env=credential.https://github.com.helper=CONTROL_INVALID_VAR "$@"#\' /usr/local/libexec/paperclip/bin/git \\',
      "  && grep -q 'CONTROL_INVALID_VAR' /usr/local/libexec/paperclip/bin/git",
    ],
  },
  {
    name: "wrapper-config-env-parameters",
    // The argv-FREE carrier, and the one the enumerated GIT_CONFIG regex at
    // b70c7aae returned null on. Nothing appears on the exec line at all, so
    // only the GIT_CONFIG* scan can see this one.
    asserts: "the shipped wrapper sets no GIT_CONFIG* variable",
    dockerfile: [
      "ARG BASE",
      "FROM ${BASE}",
      "USER root",
      'RUN sed -i \'s#^exec #export GIT_CONFIG_PARAMETERS="\\x27credential.https://github.com.helper\\x27=\\x27!control-invalid\\x27"\\nexec #\' /usr/local/libexec/paperclip/bin/git \\',
      "  && grep -q 'GIT_CONFIG_PARAMETERS' /usr/local/libexec/paperclip/bin/git",
    ],
  },
];

function docker(args, options = {}) {
  return execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"], ...options });
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pen4541-controls-"));
const stayedGreen = [];
try {
  for (const control of CONTROLS) {
    const tag = `pen4541-control-${control.name}:${process.pid}`;
    const dockerfile = path.join(workDir, `Dockerfile.${control.name}`);
    fs.writeFileSync(dockerfile, `${control.dockerfile.join("\n")}\n`);

    console.log(`\n--- control '${control.name}' -> ${control.asserts}`);

    // `--builder default` is pinned deliberately. docker-agent.yml installs a
    // REMOTE buildx driver as the current builder, and a remote build's result
    // does not land in this runner's local daemon -- the build would succeed
    // and the checker's `docker create` would then fail on an image that is
    // not here, which reads as a broken control rather than a configuration
    // mismatch. `default` is the daemon's own docker driver: always present,
    // loads locally.
    docker([
      "buildx",
      "build",
      "--builder",
      "default",
      "--load",
      "--build-arg",
      `BASE=${baseImage}`,
      "--tag",
      tag,
      "--file",
      dockerfile,
      workDir,
    ]);

    let checkerExit = 0;
    try {
      execFileSync(process.execPath, [CHECKER, tag], { stdio: "inherit" });
    } catch (error) {
      checkerExit = error.status ?? 1;
    }

    // THE INVERSION. A green checker here is the failure.
    if (checkerExit === 0) {
      console.error(
        `\n::error::PEN-4541 positive control '${control.name}' did NOT red the checker. The checker is not measuring what it claims to measure — the most likely cause is that it is reading this runner's filesystem rather than the agent image, which is the exact failure mode this control exists to exclude. Do not promote this image.`,
      );
      stayedGreen.push(control.name);
    } else {
      console.log(`control '${control.name}': correctly red (exit ${checkerExit})`);
    }

    try {
      docker(["rmi", "-f", tag], { stdio: "ignore" });
    } catch {
      // A leaked throwaway tag on an ephemeral runner is not worth failing a
      // gate over, and swallowing it keeps a real finding as the reported cause.
    }
  }
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

if (stayedGreen.length > 0) {
  console.error(
    `\nPEN-4541: ${stayedGreen.length} positive control(s) stayed green: ${stayedGreen.join(", ")}`,
  );
  process.exit(1);
}
console.log(
  `\nPEN-4541: all ${CONTROLS.length} positive controls red the checker, so its green verdict on the real agent image is meaningful.`,
);
