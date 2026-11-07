// The ratchet for PEN-5927.
//
// Five of the repo's seven image workflows shipped images whose base was decided
// by the wall clock, and the cost was measured rather than theoretical: two
// paperclip-mcp-gateway images built from an identical tree five weeks apart
// landed on opposite sides of CVE-2026-59873, and establishing which was which
// took two published corrections on PEN-5690 plus archaeology through published
// npm tarballs — because the repo could not answer the question about itself.
//
// Pinning those five was a one-time fix. This keeps them pinned: every
// externally-sourced FROM in a CI-published Dockerfile must take its base
// through an ARG that the building workflow supplies, so the base is named by
// the build rather than by the day it ran.
//
// WHY A TEST AND NOT A BUILD-TIME GUARD
//
// A guard in the image workflows would have to be correct before it could be
// trusted, and would simply have turned every image build red while any base
// was still unpinned. A test fails the pull request that introduces the next
// unpinned base — which is the whole point — and costs the image workflows no
// runner time at all.
//
// WHY NO YAML PARSER
//
// `js-yaml` is in package.json only as a version override, not a dependency, so
// it does not resolve in CI (see the header of scripts/check-workflows-parse.mjs
// for the full reasoning, and why declaring it is not available either). The
// workflow side of this check is therefore a search for the build-arg name in
// the workflow text, which is enough to answer "does the workflow supply it?".
// Structural validity of the workflow files is already guaranteed by
// check-workflows-parse.mjs.
//
// That search is ANCHORED, and must stay anchored. A bare `includes("BASE=")`
// is satisfied by an unrelated `NODE_BASE=` in the same file, so a workflow that
// supplies the wrong arg entirely would still pass — the gate failing open,
// which is the one direction a gate must never fail. Found in review of the
// commit that introduced this file; the regression test below is
// `a build-arg whose name merely ends with the one we need does not satisfy it`.
//
// WHY THIS ASSERTS THE SEAM AND NOT THE VALUE
//
// Whether a base resolves to a digest is decided at run time by
// scripts/resolve-base-digest.sh (covered in resolve-base-digest.test.mjs) and
// is not knowable from a static read. docker.yml legitimately passes a
// content-addressed TAG derived from a resolved base digest rather than a
// digest literal.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Every Dockerfile whose image CI publishes, mapped to the workflow that builds
// it. ADD AN ENTRY WHEN YOU ADD AN IMAGE WORKFLOW — an image missing from here
// is simply unchecked, which is the failure mode this list is arranged to make
// obvious rather than silent: each pairing is verified below to still be real.
const PUBLISHED_IMAGES = [
  { dockerfile: "Dockerfile", workflow: "docker.yml" },
  { dockerfile: "Dockerfile.runtime", workflow: "docker.yml" },
  { dockerfile: "Dockerfile.agent", workflow: "docker-agent.yml" },
  { dockerfile: "Dockerfile.agent-toolchain", workflow: "docker-agent.yml" },
  { dockerfile: "packages/mcp-gateway/Dockerfile", workflow: "docker-mcp-gateway.yml" },
  { dockerfile: "packages/mcp-external/Dockerfile", workflow: "docker-mcp-external.yml" },
  { dockerfile: "packages/services/designer/Dockerfile", workflow: "docker-designer.yml" },
  { dockerfile: "packages/services/webflow-bot/Dockerfile", workflow: "docker-webflow-bot.yml" },
  { dockerfile: "packages/services/figma-bot/Dockerfile", workflow: "docker-figma-bot.yml" },
];

// Known-unpinned bases. Each entry records a gap rather than hiding one;
// removing an entry is the fix, and adding one needs a reason written here.
const ALLOWED_LITERAL_BASES = new Map([
  [
    "ghcr.io/github/github-mcp-server:v1.0.3",
    "An intermediate stage of the main server image. docker.yml resolves a " +
      "digest for the RUNTIME base only. Out of PEN-5927's scope, which covered " +
      "the five side-image workflows; recorded so the next reader sees it.",
  ],
]);

const VARIABLE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

// Does `workflowText` supply a build-arg literally named `argName`? Anchored on
// a line start or whitespace so `BASE` is not matched by `NODE_BASE=`. argName
// comes from VARIABLE above, so it holds no regex metacharacters.
export function suppliesBuildArg(workflowText, argName) {
  return new RegExp(`(^|[\\s|])${argName}=`, "m").test(workflowText);
}

// Every FROM in order, flagged for whether it names an earlier stage in the same
// file — such a FROM inherits that stage's pinning and needs none of its own.
function parseFroms(dockerfile) {
  const stages = new Set();
  const froms = [];
  for (const raw of readFileSync(path.join(repoRoot, dockerfile), "utf8").split("\n")) {
    const match = /^\s*FROM\s+(.*)$/i.exec(raw);
    if (!match) continue;
    // Drop flags such as --platform=linux/amd64 that precede the reference.
    const tokens = match[1].trim().split(/\s+/).filter((token) => !token.startsWith("--"));
    const asIndex = tokens.findIndex((token) => /^as$/i.test(token));
    froms.push({ ref: tokens[0], isStageRef: stages.has(tokens[0]), line: raw.trim() });
    if (asIndex !== -1 && tokens[asIndex + 1]) stages.add(tokens[asIndex + 1]);
  }
  return froms;
}

test("the published-image map still describes real files", () => {
  // A stale pairing silently stops checking an image, so prove both halves
  // exist before trusting any verdict derived from them.
  assert.ok(PUBLISHED_IMAGES.length > 0, "PUBLISHED_IMAGES is empty — this gate protects nothing");
  for (const { dockerfile, workflow } of PUBLISHED_IMAGES) {
    assert.ok(existsSync(path.join(repoRoot, dockerfile)), `${dockerfile} does not exist — update PUBLISHED_IMAGES`);
    assert.ok(
      existsSync(path.join(repoRoot, ".github/workflows", workflow)),
      `.github/workflows/${workflow} does not exist — update PUBLISHED_IMAGES`,
    );
  }
});

test("every CI-published image takes its external base through a build-arg the workflow supplies", () => {
  const problems = [];
  let checked = 0;

  for (const { dockerfile, workflow } of PUBLISHED_IMAGES) {
    const workflowText = readFileSync(path.join(repoRoot, ".github/workflows", workflow), "utf8");

    for (const { ref, isStageRef, line } of parseFroms(dockerfile)) {
      if (isStageRef || ref === "scratch") continue;
      checked += 1;

      if (ref.includes("@sha256:")) continue; // already immutable in the tree

      const variable = VARIABLE.exec(ref);
      if (!variable) {
        if (ALLOWED_LITERAL_BASES.has(ref)) continue;
        problems.push(
          `${dockerfile} pins nothing: \`${line}\`. Take the base through an ARG and pass a ` +
            `resolved digest from ${workflow} using scripts/resolve-base-digest.sh, or record ` +
            "it in ALLOWED_LITERAL_BASES with a reason.",
        );
        continue;
      }

      const argName = variable[1];
      if (!suppliesBuildArg(workflowText, argName)) {
        problems.push(
          `${dockerfile} reads \`${line}\` but ${workflow} never passes ${argName}=, so the ` +
            "build falls back to the floating default in the Dockerfile and the published " +
            "image's base is decided by its build date.",
        );
      }
    }
  }

  assert.ok(checked > 0, "no FROM lines were examined — the Dockerfile scan found nothing");
  assert.deepEqual(problems, [], `\n${problems.join("\n\n")}\n`);
});

test("a build-arg whose name merely ends with the one we need does not satisfy it", () => {
  // The fail-open shape: `BASE` must NOT be satisfied by `NODE_BASE=`, or a
  // workflow supplying entirely the wrong arg passes this gate.
  const workflow = ["        build-args: |", "          NODE_BASE=${{ steps.base.outputs.image }}"].join("\n");
  assert.equal(suppliesBuildArg(workflow, "NODE_BASE"), true);
  assert.equal(suppliesBuildArg(workflow, "BASE"), false);
  assert.equal(suppliesBuildArg(workflow, "WEBFLOW_BOT_IMAGE"), false);
  // A first-on-the-line arg, and one after a YAML block scalar pipe, both count.
  assert.equal(suppliesBuildArg("BASE=x", "BASE"), true);
  assert.equal(suppliesBuildArg("build-args: |BASE=x", "BASE"), true);
});

test("the known-unpinned allowlist still describes something real", () => {
  // An entry matching no FROM is stale permission to stay unpinned, and would
  // silently re-admit the very base it was written for.
  const refs = new Set();
  for (const { dockerfile } of PUBLISHED_IMAGES) {
    for (const { ref } of parseFroms(dockerfile)) refs.add(ref);
  }
  for (const [ref, reason] of ALLOWED_LITERAL_BASES) {
    assert.ok(refs.has(ref), `ALLOWED_LITERAL_BASES entry \`${ref}\` matches no FROM — remove it. (${reason})`);
  }
});
