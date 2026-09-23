#!/usr/bin/env node

/**
 * Guards against an UNREACHABLE `ARG OPENCODE_K8S_REF` landing on master.
 *
 * The Dockerfile's `vendor` stage does a plain `git clone` of the adapter fork
 * and then `git checkout "${OPENCODE_K8S_REF}"`. `git clone` fetches only
 * ref-reachable objects, so a pinned SHA that is reachable from no ref is
 * simply absent from the checkout and the stage dies with
 * `fatal: unable to read tree (<sha>)`, exit 128.
 *
 * BLO-33204: that is exactly what a squash-merge does to a pin. #62's branch
 * head 87a865de was pinned on 2026-09-09; the squash landed as 2075ae1b on
 * 2026-09-10 and orphaned it. The two commits are CONTENT-IDENTICAL (same tree,
 * cd60d847...), so nothing about the pin or the code looked wrong.
 *
 * The failure is CACHE-TIMED, not commit-timed, which is what makes it worth a
 * guard: builds reusing a `vendor` layer created before the force-push kept
 * passing, so master looked healthy for hours while every cache-missing build —
 * including any `workflow_dispatch` at an older, "known-good" SHA — failed.
 * By the time CI tells you, the deploy path is already broken estate-wide.
 *
 * WHY REACHABILITY AND NOT `compare/master...REF`:
 * BLO-33204's first-cut guard was "`compare/master...$REF` must be `identical`
 * or `behind`". That is WRONG — it rejects legitimate pins. Pinning an
 * un-merged branch head is normal practice here, and such a pin reads
 * `diverged`, the same status an orphan reads. Measured on the real history:
 *
 *   83197d46… (pinned on master 2026-08-05 → 08-08, shipped fine)
 *     compare/master...83197d4 → diverged, ahead_by 1, behind_by 9
 *     reachable? YES — it is the head of codex/pen1305-env-guard-review-fix
 *
 * So `diverged` does not imply orphaned, and a master-compare guard would have
 * blocked that pin. The property the build actually depends on is "reachable
 * from some ref a clone fetches", so this asserts precisely that, by doing the
 * same clone the build does and asking git whether the object arrived.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ADAPTER_REPO = "kkroo/paperclip-adapter-opencode-k8s";

/**
 * @param {string} dockerfile raw Dockerfile text
 * @returns {string | null} the 40-hex pin, or null when the ARG is absent/malformed
 */
export function extractPin(dockerfile) {
  return dockerfile.match(/^ARG OPENCODE_K8S_REF=([0-9a-f]{40})$/m)?.[1] ?? null;
}

/**
 * Classify a probe result into an exit disposition.
 *
 * The asymmetry is deliberate. `unreachable` is a definite finding — the build
 * WILL fail on its next cache miss — so it fails the PR. `inconclusive` means
 * we could not clone at all (network, rate limit, repo turned private, no
 * credential in this job); that says nothing about the pin, and turning every
 * transient network fault into a blocked merge would inflict the same class of
 * harm this guard exists to prevent. It warns loudly instead of failing, so a
 * permanently-broken probe is visible in the run rather than silently inert.
 *
 * @param {{pin: string | null, cloneOk: boolean, commitPresent: boolean, detail?: string}} probe
 * @returns {{verdict: "ok" | "unreachable" | "inconclusive" | "no-pin", exitCode: 0 | 1, message: string}}
 */
export function classify(probe) {
  const { pin, cloneOk, commitPresent, detail } = probe;

  if (!pin) {
    return {
      verdict: "no-pin",
      exitCode: 1,
      message:
        "Could not read `ARG OPENCODE_K8S_REF=<40-hex>` from the Dockerfile. The vendor " +
        "stage checks out that ARG, so an absent or malformed pin is a build break.",
    };
  }

  if (!cloneOk) {
    return {
      verdict: "inconclusive",
      exitCode: 0,
      message:
        `GUARD INCONCLUSIVE: could not clone ${ADAPTER_REPO} to verify pin ${pin}.` +
        `${detail ? ` (${detail})` : ""} Not failing the PR — an unclonable repo says ` +
        "nothing about whether the pin is reachable. If this warning is persistent the " +
        "guard is inert and the orphaned-pin class is unprotected: fix the probe.",
    };
  }

  if (!commitPresent) {
    return {
      verdict: "unreachable",
      exitCode: 1,
      message:
        `ORPHANED PIN: ${pin} is reachable from no ref in ${ADAPTER_REPO}.\n\n` +
        "A plain `git clone` fetches only ref-reachable objects, so the Dockerfile's " +
        "`vendor` stage cannot check this SHA out. Every image build that misses the " +
        "vendor-stage cache will fail with `fatal: unable to read tree`, blocking all " +
        "production deploys. Builds that HIT the cache still pass, so this will look " +
        "intermittent.\n\n" +
        "Most likely cause: the pinned commit was a PR branch head and that PR was " +
        "squash-merged, replacing it. Re-pin to the squash commit on the adapter's " +
        "default branch — check `git diff <old> <new>` first, since the squash of the " +
        "same PR is usually content-identical and therefore a safe, behaviour-neutral " +
        "move.",
    };
  }

  return {
    verdict: "ok",
    exitCode: 0,
    message: `Pin ${pin} is reachable from a ref in ${ADAPTER_REPO}.`,
  };
}

/**
 * Clone the adapter repo the way the build does and ask git whether the pinned
 * commit arrived. Deliberately a full (bare) clone, not a partial or
 * explicit-SHA fetch: `git fetch origin <sha>` succeeds for an ORPHANED commit
 * on GitHub, so it is not a reachability test and would pass the very pin that
 * broke the build.
 *
 * @param {string} pin
 * @returns {{pin: string, cloneOk: boolean, commitPresent: boolean, detail?: string}}
 */
function probe(pin) {
  const scratch = mkdtempSync(join(tmpdir(), "opencode-k8s-pin-"));
  const repoDir = join(scratch, "probe.git");
  try {
    try {
      execFileSync(
        "git",
        ["clone", "--bare", "--quiet", `https://github.com/${ADAPTER_REPO}.git`, repoDir],
        { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 120_000 },
      );
    } catch (error) {
      const stderr = (error?.stderr || error?.message || "").trim().split("\n").at(-1);
      return { pin, cloneOk: false, commitPresent: false, detail: stderr };
    }

    try {
      execFileSync("git", ["-C", repoDir, "cat-file", "-e", `${pin}^{commit}`], {
        stdio: "ignore",
        timeout: 30_000,
      });
      return { pin, cloneOk: true, commitPresent: true };
    } catch {
      return { pin, cloneOk: true, commitPresent: false };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const dockerfilePath =
    process.env.OPENCODE_PIN_GUARD_DOCKERFILE ||
    fileURLToPath(new URL("../Dockerfile", import.meta.url));

  const pin = extractPin(readFileSync(dockerfilePath, "utf8"));
  const result = classify(pin ? probe(pin) : { pin, cloneOk: false, commitPresent: false });

  if (result.verdict === "ok") {
    console.log(`opencode_k8s pin guard OK — ${result.message}`);
    return;
  }

  if (result.verdict === "inconclusive") {
    // GitHub Actions annotation so an inert guard is visible in the run summary
    // rather than passing quietly forever.
    console.log(`::warning title=opencode_k8s pin guard inconclusive::${result.message}`);
    console.warn(result.message);
    return;
  }

  console.error(`opencode_k8s pin guard FAILED\n\n${result.message}`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
