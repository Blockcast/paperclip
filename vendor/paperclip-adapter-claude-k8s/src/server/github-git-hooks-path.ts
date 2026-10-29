/**
 * Where the pre-push publish guard lives — the vendor-side copy.
 *
 * The canonical declaration is `packages/adapter-utils/src/github-git-hooks-path.ts`.
 * This file restates it, and `github-git-hooks-path.test.ts` beside it fails if
 * the two ever disagree.
 *
 * WHY A COPY, in a change whose whole point is one source of truth: these
 * adapters are built and tested STANDALONE. The `Vendored * adapter` lane runs
 * `npm ci` in this directory, which resolves `@paperclipai/adapter-utils` from
 * the npm registry at the version this package's lockfile pins — not from the
 * monorepo working tree. A subpath that exists only in the working tree is
 * therefore unresolvable here, no matter how the export map is written:
 * `2026.428.0` ships `dist/server-utils.*` and nothing named
 * `github-git-hooks-path`, so importing it typechecked in the monorepo and
 * failed in the lane that proves these packages still build on their own.
 * Importing it would trade a drift class for a publish-ordering class — the
 * adapter would stop building until adapter-utils cut a release and this
 * lockfile bumped, and that ordering is not visible from either side.
 *
 * So the join is enforced by a test rather than by the module system, which is
 * the same trade `pod-log-redactor.test.ts` already makes against
 * `command-redaction.ts`, for the same standalone-build reason. A test is also
 * what the fourth consumer needs regardless: the Helm chart renders shell and
 * cannot import anything, so `agent-egress-path.test.mjs` already reads these
 * constants out of the canonical file as text. PEN-4518 was not caused by
 * copies existing — it was caused by copies that nothing compared.
 *
 * Keep the declarations in a plain `= "literal"` form: the chart-side test
 * reads them with a regex.
 */

/** The hook directory, relative to the data volume's mount point. */
export const GIT_HOOKS_SUBPATH = ".local/share/paperclip-git-hooks";

/**
 * The data volume's mount point in the image's default layout.
 *
 * `persistence.mountPath` is operator-configurable, so this is the default and
 * not the truth. Anything that can see the configured value should use
 * `hooksDirForDataMount` instead; `DEFAULT_HOOKS_DIR` is for the one consumer
 * that cannot — the runtime, which has no access to chart values.
 */
export const DEFAULT_DATA_MOUNT_PATH = "/paperclip";

/** Where the Helm seed writes the pre-push hook, in the default layout. */
export const DEFAULT_HOOKS_DIR = `${DEFAULT_DATA_MOUNT_PATH}/${GIT_HOOKS_SUBPATH}`;

/**
 * Where the AGENT IMAGE carries the hook, independent of any volume.
 *
 * `COPY --chmod=0755 --exclude=*.md docker/github-hooks/` in the server image,
 * re-copied `--from=server` into the agent image, so the hook and the runtime
 * that looks for it are ONE artifact from one Docker build. A pod has both or
 * neither; it cannot have a runtime pointed here and no file here, which is
 * what makes repointing the runtime at this path atomic in a way the PVC path
 * never was (the volume and the image roll on independent cadences).
 *
 * It is also the stronger of the two paths for the property the guard exists
 * to have. The seeded copy is written by a `runAsUser: 1000` init container
 * and is therefore owned by the uid the agent runs as; it is read-only in an
 * agent pod only for as long as the volumeMount says `readOnly`. This copy is
 * `root:root 0755` inside the image, so no uid-1000 process can rewrite it in
 * any pod, under any mount topology. PEN-3715.
 *
 * NOT derived from `DEFAULT_DATA_MOUNT_PATH` on purpose: the point of this
 * path is that it does not live on the data volume, so an operator who
 * relocates `persistence.mountPath` must not move it.
 */
export const BAKED_HOOKS_DIR = "/usr/local/libexec/paperclip/hooks";

/**
 * The hooks directory for a given data mount point.
 *
 * Trailing slashes are stripped so `/paperclip/` and `/paperclip` agree; an
 * empty or all-slash value falls back to the default rather than producing a
 * root-relative path, because `//.local/...` would silently miss the mount.
 */
export function hooksDirForDataMount(dataMountPath: string): string {
  const base = dataMountPath.replace(/\/+$/, "");
  return `${base || DEFAULT_DATA_MOUNT_PATH}/${GIT_HOOKS_SUBPATH}`;
}
