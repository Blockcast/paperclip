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
 *
 * SECOND PROPERTY, BLO-34510 — the pinned source must make no Secret PUT.
 *
 * `deploy/helm/paperclip/templates/role.yaml` retired `secrets: update` from
 * the release-namespace Role once BLO-32424 converted the claude-k8s adopt
 * path to a merge PATCH. The opencode-k8s half of that evidence is a property
 * of THE PIN, not of the adapter: it holds because the pinned tree contains no
 * `replaceNamespacedSecret`. A pin bump that reintroduces one would 403 at
 * runtime, on a collision path, for every opencode-k8s agent — and would do it
 * with nothing in this repo's diff to review but a 40-hex number.
 *
 * So the same bump that could break it is the moment to check, and the clone is
 * already paid for here. Scope, stated rather than implied: this greps the
 * client-node symbol in non-test `src/`. It is not a proof that no PUT exists —
 * a hand-rolled request or a renamed wrapper slips past it — so it is a guard
 * against the realistic regression (someone re-adds the call), not a soundness
 * argument. The soundness argument is the enumeration in role.yaml.
 *
 * The grep carries its own negative control. A filter that matches nothing
 * because the tree moved out of `src/` is indistinguishable from a clean pin,
 * and that failure reads as a pass — so the probe also counts the TypeScript
 * files it searched, and zero means inconclusive rather than clean.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ADAPTER_REPO = "kkroo/paperclip-adapter-opencode-k8s";

// The @kubernetes/client-node call whose HTTP verb is PUT, which the RBAC
// authorizer maps to `secrets: update` — the verb BLO-34510 retired.
export const SECRET_PUT_SYMBOL = "replaceNamespacedSecret";

/**
 * Keep only real call sites: a `vi.fn()` stub in a `.test.ts` is a mock, not a
 * consumer, and the adapter's test files legitimately name the symbol while
 * asserting it is never called.
 *
 * @param {string[]} grepLines raw `git grep -n` output lines, `path:line:text`
 * @returns {string[]} lines from non-test sources
 */
export function nonTestHits(grepLines) {
  return grepLines.filter((line) => line.trim() !== "" && !/\.test\.[cm]?tsx?:/.test(line));
}

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
 * permanently broken probe is visible in the run rather than silently inert.
 *
 * `secret-put` follows the same rule and lands on the same side as
 * `unreachable`: it is a definite finding about the pinned tree, so it fails.
 * A searched-nothing grep is not — hence `srcFileCount`, which routes an
 * inert search to `inconclusive` rather than letting it read as clean.
 *
 * @param {{pin: string | null, cloneOk: boolean, commitPresent: boolean, detail?: string,
 *          srcFileCount?: number, secretPutHits?: string[]}} probe
 * @returns {{verdict: "ok" | "unreachable" | "secret-put" | "inconclusive" | "no-pin", exitCode: 0 | 1, message: string}}
 */
export function classify(probe) {
  const { pin, cloneOk, commitPresent, detail, srcFileCount, secretPutHits } = probe;

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

  if (srcFileCount === 0) {
    return {
      verdict: "inconclusive",
      exitCode: 0,
      message:
        `GUARD INCONCLUSIVE: pin ${pin} is reachable, but the Secret-PUT search found no ` +
        "TypeScript sources under `src/` to search. The adapter's layout has moved, so " +
        "the grep is inert and matching nothing no longer means clean. Not failing the " +
        "PR — but re-point the search before trusting it, or the BLO-34510 retirement of " +
        "`secrets: update` is unguarded against the next pin bump.",
    };
  }

  if (secretPutHits && secretPutHits.length > 0) {
    return {
      verdict: "secret-put",
      exitCode: 1,
      message:
        `PIN REINTRODUCES A SECRET PUT: ${pin} calls ${SECRET_PUT_SYMBOL} in non-test ` +
        `source.\n\n${secretPutHits.map((h) => `  ${h}`).join("\n")}\n\n` +
        "A PUT maps to the `secrets: update` RBAC verb, which BLO-34510 RETIRED from " +
        "`deploy/helm/paperclip/templates/role.yaml` — precisely because the previous " +
        "pin made no such call. With this pin, that call 403s at runtime for every " +
        "opencode-k8s agent, on a Secret-collision path, which is intermittent and will " +
        "not show up in any build or test here.\n\n" +
        "Two ways out, and they are a real choice, not a formality: change the adapter " +
        "to a merge PATCH (what the claude-k8s adapter did in BLO-32424 — `patch` is " +
        "still granted), or re-add `update` to that Role naming this call site, and " +
        "update deploy/helm/paperclip/tests/role-rbac.test.mjs in the same change. " +
        "Re-granting a retired standing privilege is a stated decision, not a fix-up.",
    };
  }

  return {
    verdict: "ok",
    exitCode: 0,
    message:
      `Pin ${pin} is reachable from a ref in ${ADAPTER_REPO}` +
      (srcFileCount === undefined
        ? "."
        : ` and makes no ${SECRET_PUT_SYMBOL} call in ${srcFileCount} non-test source file(s).`),
  };
}

/**
 * Clone the adapter repo the way the build does and ask git whether the pinned
 * commit arrived. Deliberately a full (bare) clone, not a partial or
 * explicit-SHA fetch: `git fetch origin <sha>` succeeds for an ORPHANED commit
 * on GitHub, so it is not a reachability test and would pass the very pin that
 * broke the build.
 *
 * The same clone then answers the BLO-34510 question — does the pinned tree
 * make a Secret PUT — because a second clone would double the slowest step for
 * one grep.
 *
 * @param {string} pin
 * @returns {{pin: string, cloneOk: boolean, commitPresent: boolean, detail?: string,
 *            srcFileCount?: number, secretPutHits?: string[]}}
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
    } catch {
      return { pin, cloneOk: true, commitPresent: false };
    }

    const git = (args) => {
      try {
        return execFileSync("git", ["-C", repoDir, ...args], {
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
          timeout: 60_000,
        });
      } catch (error) {
        // `git grep` exits 1 on no match, which is a result, not a failure.
        // Any other status leaves stdout empty and the control below catches
        // it: a failed ls-tree reads as srcFileCount 0, i.e. inconclusive.
        return error?.status === 1 ? (error.stdout ?? "") : "";
      }
    };
    const lines = (out) => out.split("\n").filter((l) => l.trim() !== "");

    return {
      pin,
      cloneOk: true,
      commitPresent: true,
      srcFileCount: nonTestHits(
        lines(git(["ls-tree", "-r", "--name-only", pin, "--", "src"])).map((f) => `${f}:`),
      ).length,
      secretPutHits: nonTestHits(
        lines(git(["grep", "-n", "--fixed-strings", SECRET_PUT_SYMBOL, pin, "--", "src"])).map(
          // `git grep <tree-ish>` prefixes every line with `<sha>:`; strip it so
          // the message reads as a path, and so nonTestHits sees the real path.
          (l) => (l.startsWith(`${pin}:`) ? l.slice(pin.length + 1) : l),
        ),
      ),
    };
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
