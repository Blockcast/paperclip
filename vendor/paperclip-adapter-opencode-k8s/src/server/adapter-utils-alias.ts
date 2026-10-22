/**
 * Builds the `@paperclipai/adapter-utils` resolve alias used by this adapter's
 * vitest config.
 *
 * The alias exists because this package neither declares `@paperclipai/adapter-utils`
 * as a dependency nor has a node_modules link to it inside the monorepo, so suites
 * that import it collect 0 tests without one.
 *
 * It is **monorepo-only**, and that conditionality is the whole point of this
 * module. The image build copies the adapter directory *alone* to
 * `/vendor/<adapter>-src` and installs adapter-utils from a packed tarball into
 * local `node_modules`; `../../packages` does not exist there. An unconditional
 * alias then rewrites a bare specifier node could already resolve into an
 * absolute path to a missing file, and the import fails with
 * `Cannot find package '@paperclipai/adapter-utils'` — a helper that turns a
 * working import into a failing one. That reddened the opencode-k8s image build
 * at `a7cd822d` and left `master` with no publishable image (PEN-4518).
 *
 * `exists` and `resolveSrc` are injected rather than closed over so the absent
 * branch is reachable from a test. It is not otherwise: it only occurs outside a
 * monorepo checkout, which is precisely where no suite of ours runs.
 */
export type AdapterUtilsAlias = { find: RegExp; replacement: string };

export function buildAdapterUtilsAlias(options: {
  resolveSrc: (sub: string) => string;
  exists: (path: string) => boolean;
}): AdapterUtilsAlias[] {
  const { resolveSrc, exists } = options;
  // Probe the very module the alias would point at, so the decision cannot be
  // made against a path other than the one that has to resolve.
  if (!exists(resolveSrc("index.ts"))) return [];
  return [
    {
      find: /^@paperclipai\/adapter-utils$/,
      replacement: resolveSrc("index.ts"),
    },
    {
      find: /^@paperclipai\/adapter-utils\/(.*)$/,
      replacement: resolveSrc("$1.ts"),
    },
  ];
}
