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
 * Headline PREFIX of the `formatInheritedExecutionWorkspaceReuseFailure`
 * wrapper in `heartbeat.ts`. Deliberately NOT a membership marker -- both of
 * the wrapper's arms open with it. See {@link REUSE_FAILURE_NO_CAUSE_HEADLINE}.
 */
export const REUSE_FAILURE_HEADLINE = "Inherited execution workspace reuse failed";

/**
 * Marker for the wrapper's no-cause arm: the headline AND the sentence that
 * only that arm emits.
 *
 * The prefix alone cannot be the marker, because the cause-PRESENT arm emits
 * `${REUSE_FAILURE_HEADLINE} because <cause>.` from the same constant. Keying
 * on the prefix therefore swept in every inherited-reuse failure in the fleet
 * whose cause was not one of the three checkout markers above -- an archived
 * execution workspace, a failed restore, a provision error -- all of which
 * DID report a cause. That was wrong three times over: it contradicted this
 * bucket's own meaning, it sent the runbook looking for a defect in the
 * reporting path when nothing was missing, and (the expensive one) it added
 * ISSUE-scoped failures to a PER-PROJECT-WORKSPACE count, so three unrelated
 * archived-workspace reuses in one project paged as "ONE broken checkout...
 * do not triage the issues individually" -- the exact mis-routing this row
 * exists to remove. (Ally review on #2750.)
 *
 * A wrapper whose embedded cause carries none of the checkout markers is not a
 * member of this class and classifies as `null`.
 */
export const REUSE_FAILURE_NO_CAUSE_HEADLINE =
  `${REUSE_FAILURE_HEADLINE}: the referenced execution workspace could not be restored, ` +
  "and no cause was reported";

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
 * Marker -> class, in precedence order.
 *
 * The inner markers are tested BEFORE the wrapper's, because the wrapper embeds
 * the inner cause and the inner cause is the informative half: a body carrying
 * both must count as the specific failure, not as `cause_unreported`.
 */
const REFUSAL_CLASS_BY_MARKER = [
  [NOT_A_CHECKOUT_MARKER, "not_a_checkout"],
  [PROBE_INDETERMINATE_MARKER, "probe_indeterminate"],
  [ORIGIN_MISMATCH_MARKER, "origin_mismatch"],
  [REUSE_FAILURE_NO_CAUSE_HEADLINE, "cause_unreported"],
] as const satisfies readonly (readonly [string, WorkspaceReuseRefusalClass])[];

/**
 * Every substring that can make a body a member of this class.
 *
 * Exported so the sweep's SQL prefilter is built from the SAME list
 * {@link classifyWorkspaceReuseRefusal} branches on. A hand-copied predicate
 * that drifted narrower would drop refusals before they were ever classified,
 * and the only symptom would be a count that quietly went down.
 */
export const WORKSPACE_REUSE_REFUSAL_MARKERS: readonly string[] = REFUSAL_CLASS_BY_MARKER.map(
  ([marker]) => marker,
);

/**
 * Classify a `heartbeat_runs.error` body, or null when the body is not a member
 * of this class.
 */
export function classifyWorkspaceReuseRefusal(
  errorBody: string | null | undefined,
): WorkspaceReuseRefusalClass | null {
  if (!errorBody) return null;
  for (const [marker, failureClass] of REFUSAL_CLASS_BY_MARKER) {
    if (errorBody.includes(marker)) return failureClass;
  }
  return null;
}
