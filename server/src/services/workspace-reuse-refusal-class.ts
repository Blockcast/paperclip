/**
 * PEN-3633 item 3. A closed vocabulary for the managed-checkout refusal class,
 * plus the message builders that produce it.
 *
 * Two measured episodes (2026-09-29 and 2026-10-05) were reported as one fault
 * because both bucket as `setup_failed` on `heartbeat_runs.error_code`. They
 * are different branches with different causes, and `error_code` cannot tell
 * them apart -- which is why the aggregation in
 * `workspace-reuse-refusal-metrics.ts` buckets on the error BODY instead.
 *
 * Bucketing on a body means matching substrings, and a substring matcher that
 * lives apart from the sentence it matches goes silently blind the first time
 * someone rewords that sentence. So the markers below are not a copy of the
 * producers' text -- they ARE the producers' text. `workspace-runtime.ts` and
 * `heartbeat.ts` build their refusals from these builders, and
 * `workspace-reuse-refusal-class.test.ts` round-trips every builder back
 * through {@link classifyWorkspaceReuseRefusal}. A reword that drops a marker
 * fails that test rather than emptying the detector in production.
 */

/**
 * Closed set. `project_workspace_id` is unbounded, so this label must not be --
 * the metric's cardinality is (workspaces currently refusing) x (this set), and
 * only the second factor is ours to bound. An unrecognised body is NOT given an
 * `other` bucket: it is not a member of this class at all and is not counted,
 * because a catch-all would quietly absorb unrelated `setup_failed` bodies and
 * turn a project-scoped signal back into the undifferentiated one this row
 * exists to split.
 */
export const WORKSPACE_REUSE_REFUSAL_CLASSES = [
  "origin_mismatch",
  "not_a_checkout",
  "probe_indeterminate",
  "cause_unreported",
] as const;

export type WorkspaceReuseRefusalClass = (typeof WORKSPACE_REUSE_REFUSAL_CLASSES)[number];

/**
 * Marker for the `validateProjectPrimaryRepoOrigin` refusal: the checkout is a
 * real git repository whose origin is not the one the issue expects. This is
 * episode 1 (2026-09-29).
 */
export const ORIGIN_MISMATCH_MARKER = " is checked out from ";

/**
 * Markers for the two arms of the `!cwdIsGitCheckout` refusal. Both are
 * `WorkspaceRepoMismatchError` but neither reads `repoUrl` -- see the PEN-3633
 * note at that throw site. `not_a_checkout` is a positive verdict (git looked
 * and found no repository); `probe_indeterminate` is the absence of a verdict
 * (the probe itself failed), and the two must stay distinguishable because only
 * the second can be a fault process-local to the API pod rather than on disk.
 */
export const NOT_A_CHECKOUT_MARKER = "git rev-parse --git-dir found no git repository in ";
export const PROBE_INDETERMINATE_MARKER = "git rev-parse --git-dir could not verify a checkout in ";

/**
 * Marker for the `formatInheritedExecutionWorkspaceReuseFailure` wrapper in
 * `heartbeat.ts`. The wrapper embeds the inner cause, so an episode normally
 * classifies on one of the three markers above; this one is reached only when
 * the wrapper reported no cause at all, which is itself worth separating
 * because it is the one shape item 1 was meant to eliminate.
 */
export const REUSE_FAILURE_HEADLINE = "Inherited execution workspace reuse failed";

/** Builds the episode-1 refusal. Sole producer of {@link ORIGIN_MISMATCH_MARKER}. */
export function formatOriginMismatchRefusal(input: {
  cwd: string;
  actualUrl: string | null | undefined;
  expectedRepoUrl: string | null | undefined;
}): string {
  return (
    `Execution workspace cwd "${input.cwd}"${ORIGIN_MISMATCH_MARKER}"${input.actualUrl}" ` +
    `but the issue expects "${input.expectedRepoUrl}". Refusing to start the agent in the wrong repository.`
  );
}

/**
 * Builds the episode-2 refusal. `probeReason` carries git's own stderr, which
 * PEN-3633 item 1 stopped discarding; it is interpolated verbatim so the next
 * occurrence is attributable from the message alone.
 */
export function formatGitProbeRefusal(input: {
  state: "not_a_checkout" | "indeterminate";
  cwd: string;
  probeReason: string;
}): string {
  return input.state === "not_a_checkout"
    ? `${NOT_A_CHECKOUT_MARKER}"${input.cwd}" (${input.probeReason}); refusing to start a managed run from a directory that is not a checkout.`
    : `${PROBE_INDETERMINATE_MARKER}"${input.cwd}" (${input.probeReason}); refusing to start because the probe did not reach a verdict, so the directory's state is unknown.`;
}

/**
 * Classify a `heartbeat_runs.error` body, or null when the body is not a member
 * of this class.
 *
 * Inner markers are tested BEFORE the wrapper headline, because the wrapper
 * embeds the inner cause and the inner cause is the informative half: a body
 * carrying both must count as the specific failure, not as `cause_unreported`.
 */
export function classifyWorkspaceReuseRefusal(
  errorBody: string | null | undefined,
): WorkspaceReuseRefusalClass | null {
  if (!errorBody) return null;
  if (errorBody.includes(NOT_A_CHECKOUT_MARKER)) return "not_a_checkout";
  if (errorBody.includes(PROBE_INDETERMINATE_MARKER)) return "probe_indeterminate";
  if (errorBody.includes(ORIGIN_MISMATCH_MARKER)) return "origin_mismatch";
  if (errorBody.includes(REUSE_FAILURE_HEADLINE)) return "cause_unreported";
  return null;
}
