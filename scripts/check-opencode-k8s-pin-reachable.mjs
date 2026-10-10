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
 * and that failure reads as a pass — so the probe also counts the JS/TS source
 * files it searched, and zero means inconclusive rather than clean. The control
 * only reasons about an EMPTY result: a hit proves the search ran over
 * something, so it fails the bump whatever the count says.
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
 * THIRD PROPERTY, PEN-3732 — the pinned source must keep the root-owned GitHub
 * egress wrappers at the FRONT of the agent Job's PATH.
 *
 * PEN-3713 moved those wrappers into the image root-owned and made the agent
 * Job's PATH lead with them. That second half lives in `buildEnvVars()`, which
 * each adapter owns separately, and it was implemented in the claude_k8s
 * adapter only. `opencode_k8s` is cloned from the fork at the pin below, so an
 * opencode Job still resolves `git` and `gh` through the agent-writable PVC
 * copies — every agent can rewrite them, and the chart's render guard reports
 * healthy either way because it only renders onto the StatefulSet and the api
 * Deployment, never onto a Job.
 *
 * Like the Secret-PUT property above, this is a property of THE PIN: there is
 * nothing in this repo's diff to review but a 40-hex number.
 */
export const WRAPPER_BIN_DIR = "/usr/local/libexec/paperclip/bin";

/**
 * Pins whose missing prepend is a MEASURED, ACCEPTED gap rather than a fresh
 * regression, each with the evidence that made it acceptable.
 *
 * 133f4c1a — PEN-3732, measured 2026-10-02/10-09. The gap is latent, not live:
 * 0 pods and 0 Jobs carry `paperclip.io/adapter-type=opencode_k8s`, against
 * positive controls of 27 pods / 30 Jobs for claude_k8s. No agent seat can
 * push to `kkroo/paperclip-adapter-opencode-k8s` or to the
 * `allyblockcast` fork of it (both measured with `git push --dry-run`: 403),
 * so closing it THIS way needs an external maintainer's merge. The route that
 * needs none is the one claude_k8s already took: BLO-17980 vendored that
 * adapter in-tree and retired its `ARG CLAUDE_K8S_REF`, and
 * `doc/ADAPTER-REPO-OWNERSHIP.md` names opencode as the one case left. Prefer
 * that over mirroring one line into a dependency we still cannot review.
 *
 * The accepted gap is keyed to the exact SHA it was measured on, deliberately.
 * Carrying it to a NEW pin is a fresh decision about a security control, not a
 * fix-up — so the bump that would carry it fails here and has to say so. The
 * one-line escape is to add the new SHA to this set, which is exactly the
 * visible, reviewed decision the guard exists to force.
 */
export const WRAPPER_PATH_GAP_ACCEPTED_PINS = new Set([
  "133f4c1a65085a6c141aab5aa8818afe51e2689c",
]);

/** Where the ready-to-apply mirror of the claude_k8s prepend is carried. */
export const WRAPPER_PATCH_PATH =
  "vendor/opencode-k8s-patches/pen-3732-github-wrapper-path.patch";

/**
 * Exclude conventional test/spec files and __tests__/__mocks__ directories:
 * their stubs can legitimately name the symbol while asserting it is never
 * called. Names such as src/testing remain production sources.
 *
 * @param {string[]} grepLines raw `git grep -n` output lines, `path:line:text`
 * @returns {string[]} lines from non-test sources
 */
export function nonTestHits(grepLines) {
  return grepLines.filter((line) =>
    line.trim() !== "" &&
    !/(?:^|\/)__(?:tests|mocks)__\/|\.(?:test|spec)\.[cm]?tsx?$/.test(line.split(":", 1)[0]),
  );
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
 * we could not complete the probe (network, rate limit, repo turned private,
 * no credential, or a failed source search); that says nothing about the pin.
 * Turning every transient fault into a blocked merge would inflict the same class of
 * harm this guard exists to prevent. It warns loudly instead of failing, so a
 * permanently broken probe is visible in the run rather than silently inert.
 *
 * `secret-put` follows the same rule and lands on the same side as
 * `unreachable`: it is a definite finding about the pinned tree, so it fails.
 * A searched-nothing grep is not — hence `srcFileCount`, which routes an
 * inert search to `inconclusive` rather than letting it read as clean. A hit
 * is judged BEFORE that control: a non-empty hit set is self-evidencing, so a
 * zero or failed file count cannot turn a real call site into a warning.
 *
 * @param {{pin: string | null, cloneOk: boolean, commitPresent: boolean, detail?: string,
 *          srcFileCount?: number | null, secretPutHits?: string[] | null,
 *          wrapperPathHits?: string[] | null}} probe
 * @returns {{verdict: "ok" | "unreachable" | "secret-put" | "wrapper-path-missing"
 *            | "wrapper-path-accepted-gap" | "inconclusive" | "no-pin",
 *            exitCode: 0 | 1, message: string}}
 */
export function classify(probe) {
  const { pin, cloneOk, commitPresent, detail, srcFileCount, secretPutHits, wrapperPathHits } =
    probe;

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

  // Judged BEFORE the inert-search control below, and only on a NEGATIVE
  // result, so the control has to be read the other way round from the
  // Secret-PUT one: there, a hit is the finding and an empty search is the
  // ambiguous case; here, an EMPTY search is the finding, so an inert search
  // would manufacture it. `wrapperPathHits === null` (search failed) and
  // `srcFileCount === 0` (nothing to search) must therefore both reach the
  // inconclusive branch below rather than be read as "prepend missing" — which
  // is why this branch requires a completed search over a non-empty tree.
  if (
    wrapperPathHits !== null &&
    wrapperPathHits !== undefined &&
    wrapperPathHits.length === 0 &&
    srcFileCount
  ) {
    if (WRAPPER_PATH_GAP_ACCEPTED_PINS.has(pin)) {
      return {
        verdict: "wrapper-path-accepted-gap",
        exitCode: 0,
        message:
          `ACCEPTED GAP: pin ${pin} does not prepend ${WRAPPER_BIN_DIR} to the agent ` +
          "Job's PATH, so an opencode_k8s Job would resolve `git`/`gh` through the " +
          "agent-writable PVC wrappers (PEN-3732). Accepted at this SHA because the gap " +
          "is latent — no opencode_k8s workloads exist — and closing it needs a merge in " +
          `a fork no agent seat can push to. The mirror is ready at ${WRAPPER_PATCH_PATH}.`,
      };
    }
    return {
      verdict: "wrapper-path-missing",
      exitCode: 1,
      message:
        `PIN CARRIES THE PEN-3732 PATH GAP TO A NEW SHA: ${pin} never prepends ` +
        `${WRAPPER_BIN_DIR} to the agent Job's PATH.\n\n` +
        "PEN-3713 made agent Jobs resolve `git` and `gh` through root-owned wrappers in " +
        "the image instead of the mode-755 copies on the shared PVC that every agent can " +
        "rewrite. That half is per-adapter, and this adapter does not do it — so an " +
        "opencode_k8s Job runs GitHub egress through an agent-writable binary, and the " +
        "chart's render guard still reports healthy, because it only renders onto the " +
        "StatefulSet and the api Deployment and never onto a Job.\n\n" +
        "This is not a new finding about your bump — it is the KNOWN gap, pinned to the " +
        "SHA it was measured on so it cannot travel to a new pin unnoticed.\n\n" +
        "Two ways out, and they are a real choice, not a formality: carry the mirror — " +
        `apply ${WRAPPER_PATCH_PATH} upstream (it is the claude_k8s prepend verbatim, ` +
        "verified green on the previous pin) and pin the merge commit — or add this SHA " +
        "to WRAPPER_PATH_GAP_ACCEPTED_PINS in this script, re-stating the measurement " +
        "that makes the gap acceptable. Re-accepting a known security gap on a new pin " +
        "is a stated decision, not a fix-up.",
    };
  }

  if (srcFileCount === null || secretPutHits === null || wrapperPathHits === null) {
    return {
      verdict: "inconclusive",
      exitCode: 0,
      message:
        `GUARD INCONCLUSIVE: pin ${pin} is reachable, but a source search over the pinned ` +
        "tree failed. Not failing the PR — a failed search can neither establish that the " +
        "pin makes no Secret PUT nor that it omits the wrapper-PATH prepend. A missing " +
        "prepend is proven by an EMPTY result, so an unrun search must never reach that " +
        "branch. Fix the probe before trusting the guard.",
    };
  }

  if (srcFileCount === 0) {
    return {
      verdict: "inconclusive",
      exitCode: 0,
      message:
        `GUARD INCONCLUSIVE: pin ${pin} is reachable, but NEITHER source search found ` +
        "any JS/TS sources under `src/` to search. The adapter's layout has moved, so " +
        "both greps are inert — and they go wrong in opposite directions: a Secret-PUT " +
        "search matching nothing no longer means clean, and a wrapper-PATH search " +
        "matching nothing no longer means the prepend is absent. Not failing the PR — " +
        "but re-point them before trusting either verdict, or the BLO-34510 retirement " +
        "of `secrets: update` is unguarded against the next pin bump and the PEN-3732 " +
        "wrapper-PATH gap can neither be found nor cleared.",
    };
  }

  return {
    verdict: "ok",
    exitCode: 0,
    message:
      `Pin ${pin} is reachable from a ref in ${ADAPTER_REPO}` +
      (srcFileCount === undefined
        ? "."
        : ` and makes no ${SECRET_PUT_SYMBOL} call in ${srcFileCount} non-test source file(s)` +
          (wrapperPathHits && wrapperPathHits.length > 0
            ? `, and references ${WRAPPER_BIN_DIR} in non-test source. That is a ` +
              "presence check only: it does not attest that the directory is PREPENDED " +
              "to the agent Job PATH, which is what PEN-3732 needs; the ordering is " +
              "pinned by the adapter's own tests (vendor/opencode-k8s-patches)."
            : ".")),
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
 *            srcFileCount?: number | null, secretPutHits?: string[] | null,
 *            wrapperPathHits?: string[] | null}}
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
        // Preserve all other failures, including signals/timeouts, as unknown
        // rather than turning a failed search into a clean attestation.
        return args[0] === "grep" && error?.status === 1 && !error.signal ? "" : null;
      }
    };
    const lines = (out) => out.split("\n").filter((l) => l.trim() !== "");
    const sources = git(["ls-tree", "-r", "--name-only", pin, "--", "src"]);
    const hits = git(["grep", "-n", "--fixed-strings", SECRET_PUT_SYMBOL, pin, "--", "src"]);
    // Matched on the literal directory rather than a constant NAME: the name is
    // this repo's choice and an upstream mirror may well pick another, while
    // the directory is the thing the image actually creates and the chart
    // actually pins. A test file naming it proves nothing, so the same
    // non-test filter applies — a pin whose only mention is in a spec has the
    // assertion without the behaviour.
    //
    // This is PRESENCE, not ordering, and the `ok` message says so. Requiring
    // `PATH` on the hit line would not narrow it to the prepend: the mirrored
    // implementation names the directory only on its constant's definition
    // line (`const GITHUB_WRAPPER_BIN_DIR = "..."`), which has no `PATH`.
    const wrapperHits = git(["grep", "-n", "--fixed-strings", WRAPPER_BIN_DIR, pin, "--", "src"]);

    return {
      pin,
      cloneOk: true,
      commitPresent: true,
      srcFileCount: sources === null ? null : nonTestHits(
        lines(sources).filter((f) => /\.[cm]?[jt]sx?$/.test(f)).map((f) => `${f}:`),
      ).length,
      secretPutHits: hits === null ? null : nonTestHits(
        lines(hits).map(
          // `git grep <tree-ish>` prefixes every line with `<sha>:`; strip it so
          // the message reads as a path, and so nonTestHits sees the real path.
          (l) => (l.startsWith(`${pin}:`) ? l.slice(pin.length + 1) : l),
        ),
      ),
      wrapperPathHits: wrapperHits === null ? null : nonTestHits(
        lines(wrapperHits).map((l) => (l.startsWith(`${pin}:`) ? l.slice(pin.length + 1) : l)),
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

  if (result.verdict === "wrapper-path-accepted-gap") {
    // Exit 0, but never silently: an accepted security gap that stops being
    // mentioned is one nobody re-decides. Annotated so it is visible in every
    // run summary for as long as it is accepted.
    //
    // The title carries the same `opencode_k8s pin guard <verdict>` marker as
    // every other branch, deliberately: this is the verdict the LIVE pin
    // produces today, so a branch with no marker would be the one verdict the
    // end-to-end cases cannot assert on (Ally, #2392).
    console.log(
      `::warning title=opencode_k8s pin guard ACCEPTED GAP (PEN-3732)::${result.message}`,
    );
    console.warn(result.message);
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
