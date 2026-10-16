/**
 * @fileoverview PEN-4188 (carried out of PEN-3633 item 5). The single
 * definition of "is this checkout the repository it is supposed to be?".
 *
 * Two callers ask that question and they must never be able to disagree:
 *
 * - `validateProjectPrimaryRepoOrigin` in `workspace-runtime.ts`, which asks it
 *   at dispatch and refuses the run.
 * - `reconcileProjectCheckoutOrigins` in
 *   `project-checkout-origin-reconciler.ts`, which asks it on a timer and
 *   raises a project-scoped signal BEFORE a run is dispatched into the fault.
 *
 * The periodic caller is the reason this module exists as a module. PEN-3628
 * was found by a manual board sweep ~3 h in, after 33 run failures across one
 * checkout; the detector that follows it must not be a second, drifting copy of
 * the gate's comparison, because a detector that disagrees with the gate is
 * worse than none -- it either pages on checkouts the gate is happy with, or
 * stays silent on ones it refuses.
 *
 * ## The `insteadOf` trap this module exists to keep closed
 *
 * `/paperclip/.gitconfig` (shared, home-level) carries
 *
 * ```
 * url.git@github.com:Blockcast/.insteadOf = https://github.com/Blockcast/
 * ```
 *
 * so on every HEALTHY Blockcast checkout in the fleet:
 *
 * ```
 * $ git remote -v                              # SSH, rewritten
 * origin  git@github.com:Blockcast/penstock-llm-proxy-core.git (fetch)
 * $ git config --get remote.origin.url         # HTTPS, as stored
 * https://github.com/Blockcast/penstock-llm-proxy-core.git
 * ```
 *
 * Two properties keep that from producing a fleet-wide false alarm, and BOTH
 * are load-bearing:
 *
 * 1. The origin is read with `git config --get remote.origin.url`, never with
 *    `git remote -v`. `insteadOf` is a TRANSPORT-time rewrite; it does not
 *    touch the stored config value. (This is why `readGitOriginUrl` in
 *    `workspace-runtime.ts` is the shared reader and not an incidental detail.)
 * 2. Both sides go through {@link normalizeRepoIdentity}, which reduces either
 *    form to lowercased `owner/repo` with any `.git` suffix stripped -- so even
 *    a checkout whose config genuinely holds the SSH form compares equal to an
 *    HTTPS `repo_url`.
 *
 * Do not add a second normaliser, and do not compare raw URL strings anywhere.
 * Measured on the production PVC 2026-10-16: of 665 on-disk checkouts (646
 * Blockcast-owned), `git remote -v` disagrees with the stored config on **485**.
 * A verbatim comparison against `remote -v` therefore fires on 485 healthy
 * checkouts; this comparison fires on 0 of them. On the project that motivated
 * the row that is 565 issues' worth of page for a checkout that is fine.
 */

import { formatOriginMismatchRefusal } from "./workspace-reuse-refusal-class.js";

/**
 * Reduce a repository URL to a comparable `owner/repo` identity.
 *
 * Moved here verbatim from `workspace-runtime.ts` (PEN-4188) so the dispatch
 * gate and the periodic reconciler share one definition rather than two that
 * can drift. Handles `git@host:owner/repo.git`, `https://host/owner/repo.git`,
 * `ssh://git@host/owner/repo`, and falls back to a lowercased, `.git`-stripped
 * copy of the input when it parses as none of those -- so an unparseable value
 * still compares equal to an identical unparseable value rather than being
 * silently treated as "no identity".
 */
export function normalizeRepoIdentity(repoUrl: string | null | undefined): string | null {
  const trimmed = (repoUrl ?? "").trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  const pathish = sshMatch
    ? `/${sshMatch[2]}`
    : (() => {
        try {
          return new URL(trimmed).pathname;
        } catch {
          return trimmed;
        }
      })();
  const parts = pathish.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length >= 2) {
    const owner = parts[parts.length - 2].toLowerCase();
    const repo = parts[parts.length - 1].replace(/\.git$/i, "").toLowerCase();
    if (owner && repo) return `${owner}/${repo}`;
  }
  return trimmed.replace(/\.git$/i, "").toLowerCase();
}

/**
 * The verdict of one origin comparison.
 *
 * `unknown` is deliberately a FIRST-CLASS state rather than being folded into
 * `match`. The dispatch gate collapses the two (it returns without throwing
 * when it could not read an origin, which is the right fail-open for a gate
 * that would otherwise strand every run on a transient `git` failure), but a
 * DETECTOR cannot afford that collapse: a reconciler whose probes all failed
 * would report zero mismatches, which is indistinguishable from a healthy
 * estate and is exactly the shape of "a zero you did not verify". The
 * reconciler counts `unknown` separately and publishes the comparable count
 * beside the mismatches so an operator can tell "measured none" from
 * "measured nothing".
 */
export type ProjectCheckoutOriginVerdict =
  | { state: "match"; identity: string }
  | {
      state: "mismatch";
      cwd: string;
      actualUrl: string;
      expectedRepoUrl: string;
      actualIdentity: string;
      expectedIdentity: string;
      /** The refusal sentence, built from the shared PEN-3633 item 3 marker module. */
      message: string;
    }
  | { state: "unknown"; reason: "no_expected_repo_url" | "origin_unreadable" };

/**
 * Compare a checkout's actual git origin against the repository it is expected
 * to be, through {@link normalizeRepoIdentity} on both sides.
 *
 * Pure: the caller performs the `git config --get remote.origin.url` read and
 * hands the result in. That split is what lets the reconciler impose a timeout
 * and a concurrency bound on the read without the gate's behaviour changing,
 * while the comparison itself stays a single shared function.
 *
 * The mismatch message is built by `formatOriginMismatchRefusal`, the sole
 * producer of `ORIGIN_MISMATCH_MARKER`. That is not cosmetic reuse: the
 * body-bucketed refusal metric (PEN-3633 item 3) classifies on that marker, so
 * building the sentence anywhere else would create a refusal the aggregator
 * cannot see.
 */
export function compareProjectCheckoutOrigin(input: {
  cwd: string;
  expectedRepoUrl: string | null | undefined;
  actualUrl: string | null | undefined;
}): ProjectCheckoutOriginVerdict {
  const expectedIdentity = normalizeRepoIdentity(input.expectedRepoUrl);
  if (!expectedIdentity) return { state: "unknown", reason: "no_expected_repo_url" };

  const actualIdentity = normalizeRepoIdentity(input.actualUrl);
  if (!actualIdentity) return { state: "unknown", reason: "origin_unreadable" };

  if (actualIdentity === expectedIdentity) return { state: "match", identity: actualIdentity };

  return {
    state: "mismatch",
    cwd: input.cwd,
    // Non-null by construction: `normalizeRepoIdentity` returns null for every
    // nullish or blank input, so reaching here means both were present.
    actualUrl: String(input.actualUrl),
    expectedRepoUrl: String(input.expectedRepoUrl),
    actualIdentity,
    expectedIdentity,
    message: formatOriginMismatchRefusal({
      cwd: input.cwd,
      actualUrl: input.actualUrl,
      expectedRepoUrl: input.expectedRepoUrl,
    }),
  };
}
