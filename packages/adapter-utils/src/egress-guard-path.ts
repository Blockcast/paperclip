/**
 * PATH construction that cannot drop the git egress guard (PEN-5030).
 *
 * The agent image installs a `git` wrapper into a directory that leads `PATH`
 * ({@link EGRESS_GUARD_BIN_DIR}); the wrapper execs the real binary through the
 * egress scanner. Enforcement is therefore by PATH *ordering*, and PATH
 * ordering is defeated by PATH *construction*: a child process handed an
 * effective `PATH` without that directory reaches `/usr/bin/git` directly,
 * with the system credential helper still wired up in `/etc/gitconfig`.
 * PEN-4989 measured 28 such reaches in one agent pod.
 *
 * Two shapes produce it and only the first is obvious:
 *
 *   env: { ...process.env, PATH: `${stub}:/usr/bin` }   // narrowed
 *   env: { FOO: "bar" }                                 // replaced, PATH unset
 *
 * The second is the one that reads as innocent. With `PATH` unset, `execvp`
 * falls back to `confstr(_CS_PATH)` — `/bin:/usr/bin` — which is the real git
 * by a different door, not an absence of one. A hardcoded "sensible default"
 * list is the same shape wearing better clothes: it reads as deliberate and
 * complete, and still structurally cannot contain the guard.
 *
 * The invariant these helpers hold: **preserve, never add.** Only directories
 * already present on the ambient `PATH` are carried into the child. Where no
 * wrapper is installed — a CI runner, a developer laptop — every function here
 * is an identity on the caller's own entries, so adopting it cannot introduce
 * a resolution path the parent process did not already have.
 *
 * What this does NOT do, and must not be recorded as doing: it is a
 * mitigation, not a fix. A caller that does not use it is unaffected. The
 * durable close is PEN-4933's broker, where the credential is not in the
 * agent's mount namespace at all and `PATH` stops being the boundary.
 *
 * PEN-5030 decision -- where this lives, and why it is NOT in
 * `@paperclipai/shared`.
 *
 * `shared` is the obvious home: it is the lowest leaf the call sites can
 * reach, and `plugin-sdk` already depends on it, so `packages/plugins/*` get
 * it for free. That was the first shape of this change and it is wrong, for a
 * reason that is invisible from the workspace:
 *
 *   **`adapter-utils` may not depend on any workspace package.** The agent
 *   image builds it ALONE -- `COPY packages/adapter-utils /vendor/adapter-utils-src`,
 *   then `npm install --no-save typescript @types/node`, `tsc`, `npm pack`
 *   (Dockerfile, `vendor` stage) -- and installs the tarball into both
 *   vendored k8s adapters. Outside the workspace there is no pnpm to resolve
 *   `workspace:*`, so adding `"@paperclipai/shared": "workspace:*"` here fails
 *   the install outright with `EUNSUPPORTEDPROTOCOL: Unsupported URL Type
 *   "workspace:"`, before `tsc` is ever reached. Measured, not reasoned:
 *   reproducing that stage on the first draft of this change exited 1, and the
 *   same reproduction against `origin/master` exited 0. A plain semver range
 *   instead of `workspace:*` is worse, not better -- npm would install the
 *   PUBLISHED `@paperclipai/shared`, which does not carry this module, and the
 *   failure would move from the image build to a runtime
 *   `ERR_MODULE_NOT_FOUND` inside every agent pod.
 *
 * `standalone-deps.test.ts`, beside this file, holds that constraint down so
 * the next person does not rediscover it from a red image build.
 *
 * So the module lives here, in the package that already owned the literal
 * (`IMAGE_WRAPPER_DIR`, re-exported from `github-publish-broker.ts`) and that
 * hosts the egress runtime. The cost is one new edge:
 * `@paperclipai/plugin-fake-sandbox` depends on `adapter-utils` rather than on
 * `shared`. That edge is novel -- no other plugin has one -- and it is
 * accepted deliberately over the alternative, which was a second copy of the
 * guard logic and a second copy of the directory literal. A duplicated
 * security constant that can drift is worse than an unusual dependency in a
 * private, workspace-only package.
 */
import { delimiter } from "node:path";

/**
 * Where the agent image installs the egress wrappers.
 *
 * This is the one literal in the tree: `adapter-utils`' long-standing
 * `IMAGE_WRAPPER_DIR` is re-exported from here rather than declared twice.
 *
 * Deliberately a literal rather than a probe. Detecting "the directory holding
 * a `git` that is not the real `git`" would make the guarantee depend on
 * filesystem state at call time, and would fail open exactly when the mount is
 * broken — the case where preserving the entry matters most.
 */
export const EGRESS_GUARD_BIN_DIR = "/usr/local/libexec/paperclip/bin";

/** Every directory treated as holding egress wrappers. */
export const EGRESS_GUARD_BIN_DIRS: readonly string[] = [EGRESS_GUARD_BIN_DIR];

/**
 * `execvp`'s fallback when `PATH` is unset, per `confstr(_CS_PATH)` on glibc.
 *
 * Carried into the replaced-environment case so that dropping `PATH` from an
 * `env` map keeps resolving the tools it resolved before. Stated as glibc's
 * value rather than a universal one: musl and the BSDs do not all agree. Where
 * it differs this is still safe — the result is a narrowed PATH plus the
 * guard, never a silently guard-less one — but "exactly what the child would
 * have resolved anyway" is a glibc claim, not a portable one.
 */
export const CONFSTR_DEFAULT_PATH: readonly string[] = ["/bin", "/usr/bin"];

function split(value: string | undefined): string[] {
  return (value ?? "").split(delimiter).filter((entry) => entry.trim().length > 0);
}

/** The guard directories present on `ambient`, in the order `ambient` lists them. */
export function guardEntriesOn(ambient: string | undefined = process.env.PATH): readonly string[] {
  const seen = new Set<string>();
  return split(ambient).filter(
    (entry) => EGRESS_GUARD_BIN_DIRS.includes(entry) && !seen.has(entry) && seen.add(entry),
  );
}

/**
 * `entries` as a `PATH`, with every ambient guard directory kept ahead of them.
 *
 * Guard first, not caller first: a caller narrowing `PATH` is controlling what
 * a child can resolve, and a guard entry placed behind the caller's own
 * directories is one `git` stub away from being inert.
 *
 * That ordering has a cost worth stating plainly. The guard directory is
 * IMAGE-controlled, and on the live agent image it carries `google-chrome`
 * alongside the `git`/`gh` wrappers and the token helpers — so hoisting it can
 * shadow a caller's stub for any name the image happens to ship, not only for
 * `git`. The trade is taken deliberately (a guard a stub directory can
 * silently outrank is not a guard), but a caller stubbing a tool by name
 * should check what the image ships rather than trust a list written here.
 */
export function guardedPath(
  entries: readonly string[],
  ambient: string | undefined = process.env.PATH,
): string {
  const guard = guardEntriesOn(ambient);
  const rest = entries.filter((entry) => entry.trim().length > 0 && !guard.includes(entry));
  return [...guard, ...rest].join(delimiter);
}

/**
 * A child environment whose effective `PATH` still contains the guard.
 *
 * - `env.PATH` set   -> narrowed to its own entries, guard restored in front.
 * - `env.PATH` unset or empty -> `fallback` with the guard in front. Empty
 *   counts as unset because that is how `execvp` reads it, and because the
 *   callers adopting this already treated it that way. The default
 *   `fallback` is what the child would have resolved anyway
 *   ({@link CONFSTR_DEFAULT_PATH}); callers that already substitute a richer
 *   default of their own pass it here so their intent is preserved exactly.
 *
 * Passing `{}` is the whole point: the caller cannot express a guard-less
 * environment through this function.
 */
export function guardedChildEnv(
  env: NodeJS.ProcessEnv,
  options: { ambient?: string; fallback?: readonly string[] } = {},
): NodeJS.ProcessEnv {
  const ambient = options.ambient === undefined ? process.env.PATH : options.ambient;
  const fallback = options.fallback ?? CONFSTR_DEFAULT_PATH;
  const hasPath = typeof env.PATH === "string" && env.PATH.length > 0;
  const requested = hasPath ? split(env.PATH) : fallback;
  return { ...env, PATH: guardedPath(requested, ambient) };
}
