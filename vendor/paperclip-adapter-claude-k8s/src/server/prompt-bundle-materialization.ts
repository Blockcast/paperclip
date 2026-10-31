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
    //
    // SHALLOWEST FIRST, and that direction is the whole correctness argument. Walking
    // bottom-up tests the deepest ancestor while the farm link ABOVE it is still live, so
    // `-L` and `rm -f` resolve THROUGH that link: given a farm entry
    // `.claude/skills/x -> shared/x` and a symlinked subdirectory `shared/x/refs` inside
    // the source — the within-tree shape the projection now resolves rather than skips —
    // the step deletes `shared/x/refs` in the SHARED source, outside the bundle root and
    // for every agent sharing it. Top-down removes each link before anything beneath it
    // is tested, so nothing is ever reached through one.
    //
    // Segment-split rather than `dirname`: no subprocess per component, and no argument
    // for a leading-dash segment — which `isSafeBundlePath` admits — to be read as an
    // option. `$__pcpb_pre` also carries the parent path out of the loop, which is what
    // the `mkdir` below uses instead of a second `dirname`.
    `__pcpb_pre=""; __pcpb_rest="$__pcpb";`,
    // Loop while a `/` remains: `\${x#*/}` equals `$x` exactly when there is none, so the
    // last segment (the file itself) is never treated as an ancestor.
    `while [ "$__pcpb_rest" != "\${__pcpb_rest#*/}" ]; do`,
    `__pcpb_pre="\${__pcpb_pre:+$__pcpb_pre/}\${__pcpb_rest%%/*}";`,
    `__pcpb_rest="\${__pcpb_rest#*/}";`,
    `if [ -L "$__pcpb_dst/$__pcpb_pre" ]; then`,
    `echo "[paperclip] prompt bundle: dropping stale symlink at $__pcpb_pre; its target is not on this pod's volume" >&2;`,
    `rm -f "$__pcpb_dst/$__pcpb_pre" || exit $?;`,
    `fi;`,
    `done;`,
    // The destination itself gets the same treatment: `cp` would otherwise follow a
    // symlink parked at the leaf and write through it.
    `if [ -L "${dst}" ]; then rm -f "${dst}" || exit $?; fi;`,
    // A declared path absent from the mount means the Secret and the projection disagree,
    // which is a bug in this channel rather than a condition to tolerate. Exit, so the
    // pod reports it instead of the run quietly missing a skill.
    `if [ ! -f "${src}" ]; then echo "[paperclip] prompt bundle: $__pcpb was declared but not delivered to this pod" >&2; exit 1; fi;`,
    `mkdir -p "$__pcpb_dst/$__pcpb_pre" || exit $?;`,
    // `-L` dereferences the Secret's internal links; `--` keeps a leading-dash path from
    // being read as an option even though `isSafeBundlePath` already admits one.
    //
    // Copy to a sibling and rename, rather than `cp` onto the destination: `cp` truncates
    // in place, so a reader during the copy sees a half-written file, and two runs sharing
    // a `bundleKey` root would interleave. `mv` within one directory is atomic.
    `cp -L -- "${src}" "${dst}.pcpb-part" || exit $?;`,
    `mv -f -- "${dst}.pcpb-part" "${dst}" || exit $?;`,
    `done;`,
    `true`,
  ].join(" ");
}

/**
 * A skill-farm link the pod has to rebuild for itself.
 *
 * `runtimeName` is the directory under `.claude/skills/` the agent looks for;
 * `target` is the link's CONTENT, already translated to a POD address by
 * `toPodAddress`.
 */
export type PromptBundleSkillLink = {
  runtimeName: string;
  target: string;
};

/**
 * A `runtimeName` safe to use as the single path segment under `.claude/skills/`.
 *
 * Decided here rather than defended against in shell, for the same reason
 * `isSafeBundlePath` is: every value reaching this step comes from
 * `readPaperclipRuntimeSkillEntries`, so an unsafe one is a bug upstream and the
 * right response is to refuse to emit a step rather than to emit one carrying a
 * guard. It is also what BOUNDS the destination — with this check the target is
 * always exactly `<bundleRoot>/.claude/skills/<one-segment>`, which is what makes
 * the `rm -rf` below safe to write.
 */
export function isSafeSkillRuntimeName(value: string): boolean {
  if (value.length === 0) return false;
  if (value === "." || value === "..") return false;
  if (value.includes("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/**
 * Builds the in-pod step that rebuilds the skill-farm links the Secret does NOT carry.
 *
 * PEN-4932 stage 4b, the gap review found on #3170. `skillSourceNeedsProjection` leaves
 * IMAGE-PATH skills out of the projection on the correct grounds that the pod already
 * has their bytes — but the bytes are only half of it. The agent reaches a skill through
 * the farm link `.claude/skills/<runtimeName> -> <source>`, and `prepareClaudePromptBundle`
 * writes that link into `serverRootDir`, i.e. into the SERVER'S volume. On a foreign
 * claim the pod never sees it, and the materialization step above copies only the paths
 * the projection declared — so every adapter-bundled skill would vanish from `--add-dir`
 * with nothing reporting it. That is precisely the silent dangling-skill outcome this
 * whole channel exists to prevent, reached from the other side.
 *
 * Two properties carried over from the copy step, for the same reasons:
 *
 *   * **Fails the pod rather than under-delivering.** A link that cannot be created is a
 *     skill the agent will not have, and nothing else in the run would say so.
 *   * **Replaces rather than preserving.** Anything already at the destination is either
 *     this run's own earlier attempt or a pre-swap farm entry pointing at a volume this
 *     pod does not mount. `ln -sfn` alone is not enough: with a real DIRECTORY parked at
 *     the destination it creates the link INSIDE it rather than replacing it, which is
 *     silent and leaves the skill unreachable. `rm -rf` first, bounded by
 *     `isSafeSkillRuntimeName` to a single segment under the bundle root.
 *
 * Returns `""` when there is nothing to link, so a caller can splice it unconditionally.
 * Throws when a `runtimeName` is unsafe or a target is not absolute.
 */
export function buildPromptBundleSkillLinkShell(input: {
  /** POD path of the bundle root — the directory handed to the CLI as `--add-dir`. */
  bundleRoot: string;
  links: readonly PromptBundleSkillLink[];
  quote: (value: string) => string;
}): string {
  const { bundleRoot, quote } = input;
  if (!bundleRoot.startsWith("/")) return "";
  // Sorted and de-duplicated by `runtimeName` so the emitted command is a function of
  // the link SET, not of discovery order — the command string feeds the prompt cache
  // key, and an unstable order would miss the cache on every run.
  const byName = new Map<string, string>();
  for (const link of input.links) byName.set(link.runtimeName, link.target);
  const names = [...byName.keys()].sort((left, right) => left.localeCompare(right));
  if (names.length === 0) return "";
  const unsafe = names.filter((name) => !isSafeSkillRuntimeName(name));
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to build the prompt-bundle skill-link step: ${unsafe.length} runtimeName(s) are not a safe path segment (${unsafe
        .slice(0, 3)
        .map((value) => JSON.stringify(value))
        .join(", ")})`,
    );
  }
  const badTargets = names.filter((name) => !(byName.get(name) ?? "").startsWith("/"));
  if (badTargets.length > 0) {
    throw new Error(
      `refusing to build the prompt-bundle skill-link step: ${badTargets.length} link target(s) are not absolute pod paths (${badTargets
        .slice(0, 3)
        .map((value) => JSON.stringify(value))
        .join(", ")})`,
    );
  }
  const skillsDir = `${bundleRoot.replace(/\/+$/, "")}/.claude/skills`;
  const parts = [`__pcpl_dst=${quote(skillsDir)};`, `mkdir -p "$__pcpl_dst" || exit $?;`];
  for (const name of names) {
    const dst = `"$__pcpl_dst"/${quote(name)}`;
    parts.push(`rm -rf ${dst} || exit $?;`);
    parts.push(`ln -s ${quote(byName.get(name) as string)} ${dst} || exit $?;`);
  }
  return parts.join(" ");
}
