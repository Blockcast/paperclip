/**
 * Adapter-managed Claude Code runtime.
 *
 * Why this exists: Job pods inherit the paperclip image, whose Dockerfile
 * installs `@anthropic-ai/claude-code@latest` into a root-owned, layer-cached
 * `/usr/local/lib/node_modules`. The fleet therefore runs whatever version that
 * cached layer froze — 2.1.210 on 2026-10-06, four months behind — until the
 * image is rebuilt, and `claude update` cannot fix it because Job pods run as
 * uid 1000 without write access to /usr/local. The Anthropic API refuses old
 * clients for new models ("Claude Code 2.1.210 does not support this model;
 * version 2.1.280 or newer is required"), so a stale bundled CLI blocks every
 * model launch for the whole fleet.
 *
 * This module pins the CLI version in adapter config instead of in the image.
 * The Job's main command installs the pinned `@anthropic-ai/claude-code` once
 * into a shared, versioned directory on the data PVC and prepends its bin dir
 * to PATH. Installs are serialized with a mkdir lock, staged into a temp dir
 * and renamed into place only after the binary answers `--version`, so
 * concurrent Jobs never execute a half-written runtime. When the install cannot
 * be completed (registry unreachable, quota) the run falls back to the image's
 * bundled CLI with a loud stderr line rather than failing outright — a model
 * the old CLI supports keeps working, and a model it does not support fails
 * with the same API error it fails with today.
 *
 * Trust assumption. On a broad read-write data mount the runtime root is
 * derived from the data mount, not from the isolation root, so one installed
 * copy serves every Job on the PVC across isolation keys, agents and companies.
 * That makes the managed `claude` the first executable on PATH shared across
 * the isolation split: a file one Job wrote, run by every other Job ahead of the
 * image's CLI. It is accepted there because it grants no write that mount does
 * not already grant: such a Job can already rewrite another key's
 * CLAUDE_CONFIG_DIR (whose settings hooks run commands) or HOME. Its content is
 * never agent-chosen either: only this snippet writes it, from the registry, at
 * an exact version.
 *
 * A Job whose data mount is narrowed (BLO-32734: read-only volume, rw `subPath`
 * re-mounts of its own trees only) cannot write that shared root at all, and
 * re-opening it would be exactly the hole that narrowing closes: one company's
 * pod writing the binary every other company runs. Such a Job passes its
 * `companyId`, which moves the root to
 * `<RUNTIMES_DIR_RELATIVE>/companies/<id>/claude-code`;
 * job-manifest.ts adds that root to the Job's derived writable mounts. The
 * runtime is therefore shared per company, the same boundary the shared pnpm
 * store and the `work`/`wt` scratch remap hold, at one install per company per
 * version. Not per isolation key: a `run`-mode HOME is on the per-run emptyDir,
 * so a HOME-rooted runtime would reinstall the CLI on every run. The isolation
 * contract in job-manifest.ts (where HOME is set) points back here.
 */

/** npm package that ships the Claude Code CLI. */
export const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";

/**
 * Default pinned CLI version. Bump this when a model launch needs a newer
 * client (the API error names the minimum). Operators can override per agent
 * with adapterConfig.claudeCodeVersion.
 */
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.292";

/** Config sentinel: run the CLI bundled in the container image, no bootstrap. */
export const CLAUDE_CODE_RUNTIME_FROM_IMAGE = "image";

/** Shared runtimes root, relative to the data PVC mount (HOME for Job pods). */
export const RUNTIMES_DIR_RELATIVE = ".local/lib/paperclip-k8s-runtimes";

/** Exact npm versions only — the value is interpolated into a shell command. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Resolve adapterConfig.claudeCodeVersion.
 *
 * - unset / blank  → DEFAULT_CLAUDE_CODE_VERSION (adapter-managed)
 * - "image"        → "" (use the image's bundled CLI, legacy behaviour)
 * - "x.y.z"        → that exact version (adapter-managed)
 *
 * Anything else throws: the value is shell-interpolated, so a range, tag or
 * stray character must never reach the Job command.
 */
export function resolveClaudeCodeVersion(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return DEFAULT_CLAUDE_CODE_VERSION;
  if (value === CLAUDE_CODE_RUNTIME_FROM_IMAGE) return "";
  if (!EXACT_VERSION_RE.test(value)) {
    throw new Error(
      `claudeCodeVersion must be an exact version such as ${DEFAULT_CLAUDE_CODE_VERSION}, or "${CLAUDE_CODE_RUNTIME_FROM_IMAGE}" to use the container image's CLI; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Root holding every installed CLI version on the data PVC. Pass `companyId`
 *  when the Job's data mount is narrowed: see the trust note above. */
export function claudeCodeRuntimeRoot(dataMountPath: string, companyId?: string): string {
  const base = `${dataMountPath.replace(/\/+$/, "")}/${RUNTIMES_DIR_RELATIVE}`;
  return companyId ? `${base}/companies/${companyId}/claude-code` : `${base}/claude-code`;
}

/** Directory holding one installed CLI version on the data PVC. */
export function claudeCodeRuntimeDir(dataMountPath: string, version: string, companyId?: string): string {
  return `${claudeCodeRuntimeRoot(dataMountPath, companyId)}/${version}`;
}

/**
 * Where the image installs the root-owned GitHub egress wrappers
 * (`Dockerfile`: `COPY docker/github-wrappers/`). The single declaration site:
 * job-manifest.ts imports it from here to make it `PATH[0]` on the Job env.
 * deploy/helm/paperclip/tests/agent-egress-path.test.mjs pins this literal to
 * the chart's `paperclip.imageWrapperBinDir`, the Dockerfiles and the wrapper
 * scripts, and asserts that job-manifest.ts imports it rather than restating it.
 *
 * Contains no shell metacharacter, which is what lets the `case` pattern above
 * interpolate it unquoted; `shellSingleQuote` still guards the assignment.
 */
export const IMAGE_WRAPPER_BIN_DIR = "/usr/local/libexec/paperclip/bin";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * POSIX sh snippet (no trailing separator) that makes the pinned CLI the
 * `claude` on PATH for the rest of the Job command.
 *
 * Layout on the PVC:
 *   <data>/.local/lib/paperclip-k8s-runtimes/claude-code/<version>/   installed prefix
 *   .../<version>/.complete                                            written last
 *   .../.lock-<version>/owner                                          mkdir lock + owner token
 *   .../.tmp-<version>-<owner>                                         staging dir
 * (under `.../paperclip-k8s-runtimes/companies/<companyId>/claude-code/` instead
 * when `companyId` is passed.)
 *
 * Properties:
 * - idempotent: a complete install is reused by every later Job, any isolation key;
 * - serialized: `mkdir` of the lock dir is atomic on CephFS/NFS; losers wait
 *   (up to 5 min) for the winner's `.complete` marker instead of installing twice,
 *   and the holder re-checks `.complete` once it has the lock, so an install that
 *   finished in between is reused rather than torn down;
 * - owned: the lock holds a random owner token (`$$` alone is useless — the
 *   Job's `sh -c` is PID 1 in every pod) and is released only by its owner, so
 *   an installer whose lock was reclaimed cannot free its successor's, and the
 *   holder re-reads its token before it deletes anything;
 * - reclaimed atomically: a stale lock is renamed to a name only this installer
 *   uses, so of two installers reclaiming it exactly one wins. The winner then
 *   re-tests the age of the directory it actually renamed: if another installer
 *   reclaimed and re-took the lock between this one's age check and its rename,
 *   that fresh lock is put back rather than deleted, and this installer waits;
 * - crash-safe: a lock older than 20 min is reclaimed, a dir without `.complete`
 *   is rebuilt, and the lock holder clears every `.tmp-<version>-*` staging dir
 *   before installing (only lock holders create them, so any it finds belong to
 *   a dead or reclaimed installer; a crash always leaves the runtime incomplete,
 *   so the next install runs this cleanup). The staging dir is renamed into
 *   place only after the fresh
 *   binary answers `--version`, with `mv -T` so that a runtime a concurrent
 *   installer already published makes the rename fail (that runtime is reused
 *   and the staging dir removed) instead of nesting the staging dir inside it;
 * - fail-open: if nothing usable exists afterwards the image CLI is used and
 *   the pod log says so;
 * - deterministic: DISABLE_AUTOUPDATER=1 keeps the managed copy at the pin
 *   unless the operator set that variable themselves.
 */
export function buildClaudeCodeRuntimeShell(opts: { version: string; dataMountPath: string; companyId?: string }): string {
  const { version, dataMountPath, companyId } = opts;
  if (!EXACT_VERSION_RE.test(version)) throw new Error(`invalid claude-code version: ${JSON.stringify(version)}`);
  const root = claudeCodeRuntimeRoot(dataMountPath, companyId);
  const pkg = CLAUDE_CODE_PACKAGE;
  const spec = `${pkg}@$__pcver`;
  return [
    `__pcver=${shellSingleQuote(version)}`,
    `__pcroot=${shellSingleQuote(root)}`,
    '__pcdir="$__pcroot/$__pcver"',
    '__pcbin="$__pcdir/node_modules/.bin/claude"',
    'if [ ! -f "$__pcdir/.complete" ] || [ ! -x "$__pcbin" ]; then ' +
      'mkdir -p "$__pcroot" 2>/dev/null; __pclock="$__pcroot/.lock-$__pcver"; ' +
      '__pcown="$(cat /proc/sys/kernel/random/uuid 2>/dev/null)-$$"; ' +
      'if [ -d "$__pclock" ] && [ -n "$(find "$__pclock" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then ' +
        '__pcstale="$__pclock.stale-$__pcown"; ' +
        'if mv "$__pclock" "$__pcstale" 2>/dev/null; then ' +
          'if [ -n "$(find "$__pcstale" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then ' +
            'echo "[paperclip] reclaiming stale claude-code install lock $__pclock" >&2; ' +
          'elif mv -T "$__pcstale" "$__pclock" 2>/dev/null; then __pcstale=; fi; ' +
          '[ -z "$__pcstale" ] || rm -rf "$__pcstale"; ' +
        'fi; ' +
      'fi; ' +
      'if mkdir "$__pclock" 2>/dev/null; then ' +
        'echo "$__pcown" > "$__pclock/owner"; ' +
        'if { [ ! -f "$__pcdir/.complete" ] || [ ! -x "$__pcbin" ]; } && [ "$(cat "$__pclock/owner" 2>/dev/null)" = "$__pcown" ]; then ' +
          '__pctmp="$__pcroot/.tmp-$__pcver-$__pcown"; rm -rf "$__pcroot/.tmp-$__pcver-"* "$__pcdir"; mkdir -p "$__pctmp"; ' +
          `echo "[paperclip] installing ${spec} into $__pcdir" >&2; ` +
          `if npm install --prefix "$__pctmp" --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error "${spec}" >&2 ` +
            '&& "$__pctmp/node_modules/.bin/claude" --version >/dev/null 2>&1; then ' +
            'if mv -T "$__pctmp" "$__pcdir" 2>/dev/null; then : > "$__pcdir/.complete"; ' +
            'else echo "[paperclip] $__pcdir was published by a concurrent install; reusing it" >&2; rm -rf "$__pctmp"; fi; ' +
          `else echo "[paperclip] ${spec} install failed" >&2; rm -rf "$__pctmp"; fi; ` +
        'fi; ' +
        '[ "$(cat "$__pclock/owner" 2>/dev/null)" = "$__pcown" ] && rm -rf "$__pclock"; ' +
      'else ' +
        `echo "[paperclip] waiting for a concurrent ${spec} install" >&2; ` +
        '__pci=0; while [ ! -f "$__pcdir/.complete" ] && [ -d "$__pclock" ] && [ "$__pci" -lt 300 ]; do sleep 1; __pci=$((__pci+1)); done; ' +
      'fi; ' +
    'fi',
    'if [ -f "$__pcdir/.complete" ] && [ -x "$__pcbin" ]; then ' +
      // PEN-3714. The managed CLI goes ahead of the image's `claude` - but NOT
      // ahead of the root-owned GitHub egress wrappers. job-manifest.ts makes
      // IMAGE_WRAPPER_BIN_DIR `PATH[0]` on the Job env; this snippet runs later,
      // in the Job's own shell, so a bare prepend here silently demoted it.
      //
      // That matters because the wrapper directory is the one control over
      // `gh`/`git`/`github-mcp-server` that a PVC write cannot reach: it lives in
      // the image, root-owned, precisely so the shared-PVC trust assumption above
      // does NOT extend to it. The runtime root IS agent-writable by construction,
      // and its directory mode means a Job shadows a wrapper by CREATING a file,
      // not only by replacing one - reopening exactly what that directory closed.
      //
      // Keyed off $PATH rather than the filesystem so the branch is a pure
      // function of the env this snippet inherits: an image that predates the
      // wrappers has the directory on neither, and gains no phantom PATH entry.
      // Re-prepending one already-present entry is a no-op for resolution.
      'case ":$PATH:" in ' +
        '*":' + IMAGE_WRAPPER_BIN_DIR + ':"*) ' +
          'PATH=' + shellSingleQuote(IMAGE_WRAPPER_BIN_DIR) + '":$__pcdir/node_modules/.bin:$PATH" ;; ' +
        '*) PATH="$__pcdir/node_modules/.bin:$PATH" ;; ' +
      'esac; export PATH; ' +
      '[ -n "${DISABLE_AUTOUPDATER+x}" ] || export DISABLE_AUTOUPDATER=1; ' +
      'echo "[paperclip] claude-code runtime $(claude --version 2>/dev/null) (adapter-managed, pinned $__pcver)" >&2; ' +
    'else ' +
      'echo "[paperclip] claude-code $__pcver unavailable; falling back to the image claude $(claude --version 2>/dev/null)" >&2; ' +
    'fi',
  ].join("; ");
}
