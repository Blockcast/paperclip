import { PROMPT_BUNDLE_SECRET_MOUNT_PATH } from "./prompt-bundle-projection.js";

/**
 * A bundle-relative path the materialization step will write.
 *
 * Decided in TypeScript rather than defended against in shell. Every path reaching this
 * step comes from `buildPromptBundleSecretProjection`'s `items[].path`, which the server
 * derives from `entry.runtimeName` plus a tree-relative path — so an unsafe one is a bug
 * in the projection, not hostile input, and the right response is to refuse to emit a
 * step at all rather than to emit one carrying a guard. A shell guard would also have to
 * be correct under every `sh` the image might ship; a rejection here is correct once.
 *
 * Rejected: an absolute path, any `.`/`..`/empty segment (each of which can leave the
 * bundle root once the shell resolves it), and any control character — a newline would
 * split the emitted `for` list and turn one path into two.
 */
export function isSafeBundlePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Builds the in-pod step that materializes the prompt bundle from its staged Secret.
 *
 * This is property 2 of the 4b delivery channel (PEN-4932 §4.2): symlinks do not survive
 * a Secret projection, so the `.claude/skills/<runtimeName>` farm the server writes today
 * has to be rebuilt inside the pod from the projected tree. The write target moves into
 * the pod because, once `dataClaimName` is a per-agent claim, the server no longer holds
 * a volume it can write the farm onto — that is the whole of stage 4.
 *
 * Every property below is load-bearing, and three of them are the OPPOSITE of the choice
 * `buildSharedDocOverlayShell` makes for the same shape of problem. That is deliberate,
 * and the difference is what each failure costs:
 *
 *   * **Fails the pod rather than under-delivering.** A shared doc that does not arrive
 *     costs the run some documentation and is reported on stderr. A skill file that does
 *     not arrive is the dangling-skill failure this entire channel exists to prevent, and
 *     it degrades *silently*: the agent simply does not have the skill and nothing in the
 *     run says so. §4.2's decision states the preference directly — "a failure that is a
 *     `Pending` pod with an event, not a partially-populated tree" — so any copy failure
 *     exits non-zero. A run that cannot get its skills must not look like one that chose
 *     not to use them.
 *   * **Overwrites rather than filling absences.** The bundle root is content-addressed
 *     by `bundleKey`, so anything already at a destination is either byte-identical or
 *     the residue of a half-finished earlier attempt. Keeping it would make the tree a
 *     function of history; overwriting makes it a function of the Secret alone, which is
 *     the invariant the swap needs. The whole payload is capped at
 *     `PROMPT_BUNDLE_SECRET_MAX_BYTES`, so re-copying it is cheap.
 *   * **Removes a symlinked ancestor instead of stepping over it.** The shared-doc step
 *     steps over one because it does not own the destination tree and a write could land
 *     in a shared directory. Here the pod does own the bundle root, and a symlink at
 *     `.claude/skills/<runtimeName>` is precisely the farm entry the pre-swap server
 *     wrote, whose target lives on a volume this pod no longer mounts. Stepping over it
 *     would preserve the dangling link the swap exists to retire; writing through it
 *     would land outside the run. So it is removed and reported.
 *
 * Two further details:
 *
 *   * **`cp -L`.** A Secret volume is an atomic-writer layout: each projected path is a
 *     symlink into `..data/<key>`, itself a symlink to a timestamped directory. A copy
 *     that preserved links would leave the bundle root correct only while that mount
 *     exists, which is the same class of fault as the server-written farm. `-L`
 *     dereferences, so the bundle root holds real bytes.
 *   * **The `..data` layout is never walked.** The step copies exactly the paths the
 *     projection declared, so the Secret's own bookkeeping entries cannot reach the
 *     bundle root — which a `cp -R` of the mount root would deliver.
 *
 * Returns `""` when there is nothing to materialize, so a caller can splice it
 * unconditionally. Throws when a declared path is unsafe, because emitting a step that
 * silently dropped it would reintroduce the silent loss this change removes.
 */
export function buildPromptBundleMaterializationShell(input: {
  /** POD path of the bundle root — the directory handed to the CLI as `--add-dir`. */
  bundleRoot: string;
  /** Bundle-relative paths to materialize, i.e. the projection's `items[].path`. */
  paths: readonly string[];
  /** Where the staged Secret is mounted in the pod. */
  sourceDir?: string;
  quote: (value: string) => string;
}): string {
  const { bundleRoot, quote } = input;
  if (!bundleRoot.startsWith("/")) return "";
  const sourceDir = input.sourceDir?.trim() || PROMPT_BUNDLE_SECRET_MOUNT_PATH;
  if (!sourceDir.startsWith("/")) return "";
  // Sorted and de-duplicated so the emitted command is a function of the path SET, not
  // of projection order. The command string feeds the prompt cache key, so an unstable
  // order would miss the cache on every run — the same reason the projection sorts.
  const paths = [...new Set(input.paths)].sort((left, right) => left.localeCompare(right));
  if (paths.length === 0) return "";
  const unsafe = paths.filter((value) => !isSafeBundlePath(value));
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to build the prompt-bundle materialization step: ${unsafe.length} declared path(s) are not bundle-relative (${unsafe
        .slice(0, 3)
        .map((value) => JSON.stringify(value))
        .join(", ")})`,
    );
  }
  const src = "$__pcpb_src/$__pcpb";
  const dst = "$__pcpb_dst/$__pcpb";
  return [
    `__pcpb_src=${quote(sourceDir)};`,
    `__pcpb_dst=${quote(bundleRoot)};`,
    `mkdir -p "$__pcpb_dst" || exit $?;`,
    `for __pcpb in ${paths.map(quote).join(" ")}; do`,
    // Walk the destination's ancestors under the bundle root and drop any that is a
    // symlink. `-L` tests the link itself, so a dangling one — the shape a pre-swap farm
    // entry takes on a volume this pod does not mount — is caught as well as a live one.
    `__pcpb_dir="$(dirname "$__pcpb")";`,
    `while [ "$__pcpb_dir" != "." ] && [ "$__pcpb_dir" != "/" ]; do`,
    `if [ -L "$__pcpb_dst/$__pcpb_dir" ]; then`,
    `echo "[paperclip] prompt bundle: dropping stale symlink at $__pcpb_dir; its target is not on this pod's volume" >&2;`,
    `rm -f "$__pcpb_dst/$__pcpb_dir" || exit $?;`,
    `fi;`,
    `__pcpb_dir="$(dirname "$__pcpb_dir")";`,
    `done;`,
    // The destination itself gets the same treatment: `cp` would otherwise follow a
    // symlink parked at the leaf and write through it.
    `if [ -L "${dst}" ]; then rm -f "${dst}" || exit $?; fi;`,
    // A declared path absent from the mount means the Secret and the projection disagree,
    // which is a bug in this channel rather than a condition to tolerate. Exit, so the
    // pod reports it instead of the run quietly missing a skill.
    `if [ ! -f "${src}" ]; then echo "[paperclip] prompt bundle: $__pcpb was declared but not delivered to this pod" >&2; exit 1; fi;`,
    `mkdir -p "$(dirname "${dst}")" || exit $?;`,
    // `-L` dereferences the Secret's internal links; `--` keeps a leading-dash path from
    // being read as an option even though `isSafeBundlePath` already admits one.
    `cp -L -- "${src}" "${dst}" || exit $?;`,
    `done;`,
    `true`,
  ].join(" ");
}
