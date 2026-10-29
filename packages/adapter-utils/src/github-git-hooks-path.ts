/**
 * Where the pre-push publish guard lives — declared ONCE, compared everywhere else.
 *
 * This path is spelled by four independent consumers, in three languages, each
 * covered by a different test suite in this repository:
 *
 *   1. the Helm seed that WRITES the hook  (`statefulset.yaml`, `GIT_HOOKS_DIR`)
 *   2. the egress runtime that LOOKS for it (`github-git-egress-runtime.ts`)
 *   3. the Job manifest that MOUNTS it      (`job-manifest.ts`, `ROOT_TOOLCHAIN_SUBPATHS`)
 *   4. the preflight that ASSERTS it        (`runtime-pin.ts`, both adapters)
 *
 * There are now TWO paths here, and which consumer reads which is the whole
 * point of keeping them in one file. 1 and 3 are the SEEDED copy on the data
 * volume (`DEFAULT_HOOKS_DIR` / `hooksDirForDataMount`). 2 and 4 are the BAKED
 * copy in the agent image (`BAKED_HOOKS_DIR`), as of PEN-4932: the runtime
 * reads the image, not the volume. The seeded copy is still written and still
 * mounted — it is what the preflight reports as a diagnostic when the image
 * copy is missing, and it is deleted in the step that drops
 * `ROOT_TOOLCHAIN_SUBPATHS`, not in this one.
 *
 * PEN-4518 is what a disagreement between them costs. BLO-32734 phase 2b gave
 * narrowed Job pods an emptyDir over the PVC root and re-exposed an allowlist
 * of toolchain subpaths; this path was not on it. Consumer 1 kept writing the
 * hook and saying so in its log, consumer 2 kept looking for it, and consumer 3
 * had quietly stopped making it visible — so every agent in the fleet lost the
 * ability to push for 2h17m, and the seed's success message was still true the
 * whole time. Nothing failed. The two halves were just in different test
 * suites, and neither suite could see the join.
 *
 * Consumers 1, 3 and 4 cannot import this module, so each is joined to it by a
 * test instead, and their declarations are kept to a plain `= "literal"` form a
 * regex can read:
 *
 *   - Helm renders shell and can import nothing.
 *     `deploy/helm/paperclip/tests/agent-egress-path.test.mjs` reads these
 *     constants out of this file and compares them against the rendered seed.
 *   - The two vendored adapters are built and tested STANDALONE, against
 *     whatever `@paperclipai/adapter-utils` their own lockfile pins from the
 *     registry — so a subpath that exists only in this working tree does not
 *     resolve there, and importing it would trade this drift class for a
 *     publish-ordering one. Each carries
 *     `src/server/github-git-hooks-path.ts` restating these declarations, with
 *     a sibling `.test.ts` that fails if its copy and this file diverge.
 *
 * Copies are not what PEN-4518 was. Copies that nothing compared were.
 *
 * Side-effect free ON PURPOSE, and that is not merely tidiness. The obvious
 * home for these would be `github-git-egress-runtime.ts`, which already
 * exported `DEFAULT_HOOKS_DIR` — but that module selects its hook leg on
 * `process.argv[2] === "--pre-push-hook"` at import time, with the
 * entrypoint guard deliberately removed (see the long comment there for why
 * removing it was correct). Importing it into the server's Job-manifest path
 * to reach one string would pull that behaviour into the server process. This
 * module imports nothing and runs nothing.
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
