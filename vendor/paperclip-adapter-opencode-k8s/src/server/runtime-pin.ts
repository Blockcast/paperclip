/**
 * Adapter-managed OpenCode runtime.
 *
 * Why this exists: Job pods inherit the paperclip image, whose Dockerfile
 * installs `opencode-ai` into a root-owned, layer-cached
 * `/usr/local/lib/node_modules`. The fleet therefore runs whatever version
 * that cached layer froze (1.18.11 on 2026-10-06, 24 releases behind) until
 * the image is rebuilt; Job pods run as uid 1000 and cannot upgrade it in
 * place. Model and provider support in OpenCode is version-bound, so a stale
 * bundled binary silently caps which models (and which bug fixes) the fleet
 * gets. This mirrors the claude_k8s adapter's `claudeCodeVersion` pin.
 *
 * The Job's main command installs the pinned `opencode-ai` once into a shared,
 * versioned directory on the data PVC and prepends its bin dir to PATH before
 * anything calls `opencode` (the DB schema guard stamps `opencode --version`,
 * `/compact`, the launchers, the main run). Installs are serialized with a
 * mkdir lock, staged into a temp dir and renamed into place only after the
 * binary answers `--version`, so concurrent Jobs never execute a half-written
 * runtime. If the install cannot be completed the run falls back to the
 * image's bundled binary with a loud stderr line rather than failing outright.
 */

import { BAKED_HOOKS_DIR, hooksDirForDataMount } from "./github-git-hooks-path.js";

/** npm package that ships the OpenCode CLI. */
export const OPENCODE_PACKAGE = "opencode-ai";

/**
 * Default pinned OpenCode version. Bump deliberately: the db-reset guard in
 * job-manifest.ts resets a persistent opencode.db whenever the binary version
 * changes, so every bump costs each agent its local session DB once.
 */
export const DEFAULT_OPENCODE_VERSION = "1.18.35";

/** Config sentinel: run the binary bundled in the container image, no bootstrap. */
export const OPENCODE_RUNTIME_FROM_IMAGE = "image";

/** Shared runtimes root, relative to the data PVC mount (HOME for Job pods). */
export const RUNTIMES_DIR_RELATIVE = ".local/lib/paperclip-k8s-runtimes";

/** Exact npm versions only — the value is interpolated into a shell command. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Resolve adapterConfig.opencodeVersion.
 *
 * - unset / blank  → DEFAULT_OPENCODE_VERSION (adapter-managed)
 * - "image"        → "" (use the image's bundled binary, legacy behaviour)
 * - "x.y.z"        → that exact version (adapter-managed)
 *
 * Anything else throws: the value is shell-interpolated, so a range, tag or
 * stray character must never reach the Job command.
 */
export function resolveOpencodeVersion(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return DEFAULT_OPENCODE_VERSION;
  if (value === OPENCODE_RUNTIME_FROM_IMAGE) return "";
  if (!EXACT_VERSION_RE.test(value)) {
    throw new Error(
      `opencodeVersion must be an exact version such as ${DEFAULT_OPENCODE_VERSION}, or "${OPENCODE_RUNTIME_FROM_IMAGE}" to use the container image's binary; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Directory holding one installed OpenCode version on the shared data PVC. */
export function opencodeRuntimeDir(dataMountPath: string, version: string): string {
  return `${dataMountPath.replace(/\/+$/, "")}/${RUNTIMES_DIR_RELATIVE}/opencode/${version}`;
}

/**
 * Where the image installs the root-owned GitHub egress wrappers
 * (`Dockerfile`: `COPY docker/github-wrappers/`). The single declaration site:
 * job-manifest.ts imports it from here to make it `PATH[0]` on the Job env.
 * deploy/helm/paperclip/tests/agent-egress-path.test.mjs pins this literal to
 * the chart's `paperclip.imageWrapperBinDir`, the Dockerfiles and the wrapper
 * scripts, and asserts that job-manifest.ts imports it rather than restating it.
 *
 * Mirrors the identical constant in the claude_k8s adapter (PEN-3925): both
 * runtime-pin bootstraps key their PATH ordering off it, so both declare it
 * here, in the module job-manifest.ts already imports.
 *
 * Contains no shell metacharacter, which is what lets the `case` pattern below
 * interpolate it unquoted; `shellSingleQuote` still guards the assignment.
 */
export const IMAGE_WRAPPER_BIN_DIR = "/usr/local/libexec/paperclip/bin";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The wrapper programs `IMAGE_WRAPPER_BIN_DIR` is expected to contain, in the
 * order `docker/github-wrappers/` installs them.
 *
 * Only the first three are resolved off PATH by name. The other two are chained
 * *by* those three — the `git` wrapper execs `paperclip-github-token-env` and
 * names `github-token-credential-helper` as a `-c credential.helper` override —
 * so an image missing them is just as broken as one missing `gh`, and checking
 * only what PATH resolves would call that image healthy.
 */
export const IMAGE_WRAPPER_BINARIES = [
  "gh",
  "git",
  "github-mcp-server",
  "github-token-credential-helper",
  "paperclip-github-token-env",
] as const;

/** The subset an agent invokes by bare name, so PATH order decides who wins. */
export const IMAGE_WRAPPER_PATH_RESOLVED = ["gh", "git", "github-mcp-server"] as const;

/**
 * The shells the resolution half of the preflight asks, in report order. Only
 * the ones that resolve are probed; the verdict names which answered.
 *
 * `sh` is the baseline and proves the least: it is the Job's own shell, where
 * PATH is the Job env value `job-manifest.ts` has already forced to lead with
 * IMAGE_WRAPPER_BIN_DIR, and a non-interactive POSIX `sh` (dash on this image)
 * reads no startup file at all. So whenever the presence loop passes, `sh`
 * resolution agrees with it by construction — it is a tautology, kept only
 * because a disagreement would mean the forced PATH itself had been lost.
 *
 * `bash` and `zsh` are the shells that can actually dissent, and they are the
 * ones the agent's own commands run under — zsh is the tool shell on today's
 * image, bash is what a Bash-tool child gets. Both re-enter the PVC shell
 * dotfiles on every start (zsh reads `.zshenv` unconditionally; bash reads
 * `$BASH_ENV`, which this manifest sets and keeps reachable with `SHLVL=2`),
 * and those dotfiles front-prepend agent-writable directories. That is the
 * PEN-4357 hazard, and it is visible from here only by asking those shells.
 */
export const IMAGE_WRAPPER_PROBE_SHELLS = ["sh", "bash", "zsh"] as const;

/**
 * Stable leading tokens of the three preflight verdicts. Exported rather than
 * spelled inline because operators key log alerts to them: changing one is then
 * an edit to a value with a test on it, not a silent change to a string literal
 * something off-repo depends on.
 */
export const IMAGE_WRAPPER_PREFLIGHT_MARKER = "[paperclip] github-egress-wrappers";
export const IMAGE_WRAPPER_PREFLIGHT_OK = `${IMAGE_WRAPPER_PREFLIGHT_MARKER} ok`;
export const IMAGE_WRAPPER_PREFLIGHT_MISSING = `${IMAGE_WRAPPER_PREFLIGHT_MARKER} MISSING`;
export const IMAGE_WRAPPER_PREFLIGHT_NOT_ON_PATH = `${IMAGE_WRAPPER_PREFLIGHT_MARKER} NOT-ON-PATH`;

/**
 * POSIX sh snippet (no trailing separator) that makes every agent Job state, in
 * its own pod log, whether the root-owned GitHub egress wrappers are present in
 * this image and whether they still own `gh`/`git`/`github-mcp-server`
 * resolution in the shells the agent's own commands run under. PEN-4446.
 *
 * Why this is a *runtime* check when a static one already exists.
 * `deploy/helm/paperclip/tests/agent-egress-path.test.mjs` pins
 * IMAGE_WRAPPER_BIN_DIR in lockstep across the chart value, both Dockerfiles,
 * the wrapper scripts and this constant. That proves the repo is
 * self-consistent. It cannot say anything about a *running* image, because the
 * image is an input to a Job, not an output of this build: an agent Job can be
 * scheduled on a fork build, a `@sha256:` digest pin, or a `sha-<short>` tag
 * whose commit was rewritten away — none of which this repo ever built.
 *
 * Why not resolve the image reference to a commit instead. Because it does not
 * work, and the failure is silent. Measured 2026-10-21: `sha-3ec50bd` carried
 * 150 samples on the shared PVC and resolves to no commit in
 * `Blockcast/paperclip` at all — `compare/bb62073a...3ec50bd` 404, the ref 404,
 * an org-scoped commit search 0 hits — while the registry that could answer
 * needs credentials no agent seat holds (harbor `/v2/` → 401). Ancestry cannot
 * clear a reference it cannot place, and treating an unplaceable one as a pass
 * is the exact error `docs/runbooks/pen-3840-retire-pvc-wrapper-generation.md`
 * warns against. That runbook already names the right instrument — *"ask the
 * image the question directly; this is the authoritative check in every case,
 * because it tests the directory the fall-through actually needs rather than a
 * proxy for it"* — but makes it a manual `kubectl exec`, which only works while
 * a pod on that reference happens to be Running. `sha-3ec50bd`'s pods are gone,
 * so that question is now permanently unanswerable. Asking at startup, from
 * inside the pod, is the same question with the race removed: it needs no
 * registry credential and no commit archaeology, and it covers forks and digest
 * pins because it interrogates the filesystem rather than the reference.
 *
 * Why the resolution half spawns shells instead of asking this one. Because
 * asking this one is a tautology, and an `ok` built on it would overclaim. The
 * snippet runs inside the Job's `sh -c`, whose PATH is the Job env value
 * `job-manifest.ts` has already forced to lead with IMAGE_WRAPPER_BIN_DIR, and
 * a non-interactive POSIX `sh` reads no startup file — so a `command -v` here
 * cannot answer anything the `[ -x ]` loop above did not already answer, and a
 * dotfile-shadowed PATH is unreachable from it. The PEN-4357 hazard is in the
 * *agent's* shells: zsh is the tool shell on today's image and reads `.zshenv`
 * unconditionally, a Bash-tool child reads `$BASH_ENV`, and the PVC dotfiles
 * both of those chain front-prepend agent-writable directories. Measured
 * 2026-10-21 against this snippet with PATH leading with the wrapper directory
 * and a dotfile prepending a shadow dir: `sh` reported the wrapper, `bash` and
 * `zsh` both reported the shadow. So the probe asks each of
 * IMAGE_WRAPPER_PROBE_SHELLS that resolves, and the `ok` verdict names which
 * ones answered rather than claiming a victory it did not measure. It is still
 * a lower bound — it cannot speak for a shell it did not run, or for a PATH an
 * agent edits later in its own session — and the verdict is worded to say only
 * what it tested.
 *
 * Why it reports and does not refuse. Two reasons, and the second is the
 * binding one. (a) job-manifest.ts already settled the disposition at this seam
 * — *"Prepending rather than rejecting: a bad PATH here is an operator
 * misconfiguration that would otherwise fail a Job that has nothing to do with
 * GitHub"* — and a refusal here would reverse that unilaterally. (b) The
 * exposure is unmeasured, not merely small: every census so far is clean
 * (126/126 over 7d at the PEN-3840 entry gate, 4/4 live when this landed), so a
 * refusal would be a fleet-wide, cross-company failure mode bought against a
 * hazard nothing has yet observed. Escalating to fail-closed is a real option
 * but it needs its own evidence — specifically, at least one MISSING verdict
 * from this check — which is what this check exists to produce. Note the
 * refusal would also have to be narrower than it looks: denying `git` outright
 * breaks local commits, which are not egress at all.
 *
 * Always exits 0, and `unset`s its scratch variables, so neither the verdict
 * nor the probe can perturb the command it is spliced into.
 */
export function buildImageWrapperPreflightShell(): string {
  const dir = shellSingleQuote(IMAGE_WRAPPER_BIN_DIR);
  const all = IMAGE_WRAPPER_BINARIES.join(" ");
  const resolved = IMAGE_WRAPPER_PATH_RESOLVED.join(" ");
  const shells = IMAGE_WRAPPER_PROBE_SHELLS.join(" ");
  return [
    `__pcwrapdir=${dir}`,
    "__pcwrapmiss=",
    `for __pcwrapbin in ${all}; do [ -x "$__pcwrapdir/$__pcwrapbin" ] || __pcwrapmiss="$__pcwrapmiss $__pcwrapbin"; done`,
    'if [ -n "$__pcwrapmiss" ]; then ' +
      `echo "${IMAGE_WRAPPER_PREFLIGHT_MISSING} dir=$__pcwrapdir absent:$__pcwrapmiss - this image does not carry the root-owned GitHub egress wrappers, so GitHub traffic from this pod is NOT scrubbed (PEN-2527, PEN-4446)" >&2; ` +
    "else " +
      "__pcwrapbad=; __pcwrapshells=; " +
      `for __pcwrapsh in ${shells}; do ` +
        'command -v "$__pcwrapsh" >/dev/null 2>&1 || continue; ' +
        '__pcwrapshells="$__pcwrapshells $__pcwrapsh"; ' +
        `for __pcwrapbin in ${resolved}; do ` +
          // The binary travels as an environment variable rather than a
          // positional parameter: `sh -c script name arg` assigns from `$0` in
          // POSIX shells but zsh numbers the same arguments from `$1`, so one
          // spelling cannot address both. An exported name reads identically in
          // dash, bash and zsh, and an assignment prefix on an external command
          // does not leak into this shell.
          "__pcwrapres=$(__pcwrapq=\"$__pcwrapbin\" \"$__pcwrapsh\" -c 'command -v \"$__pcwrapq\" 2>/dev/null' 2>/dev/null); " +
          'case "$__pcwrapres" in "$__pcwrapdir/"*) ;; *) __pcwrapbad="$__pcwrapbad $__pcwrapsh:$__pcwrapbin=${__pcwrapres:-unresolved}" ;; esac; ' +
        "done; " +
      "done; " +
      'if [ -z "$__pcwrapshells" ]; then ' +
        `echo "${IMAGE_WRAPPER_PREFLIGHT_NOT_ON_PATH} dir=$__pcwrapdir resolved:none - the wrappers are present but no probe shell resolved, so nothing here established that they own resolution (PEN-4357, PEN-4446)" >&2; ` +
      'elif [ -n "$__pcwrapbad" ]; then ' +
        `echo "${IMAGE_WRAPPER_PREFLIGHT_NOT_ON_PATH} dir=$__pcwrapdir resolved:$__pcwrapbad - the wrappers are present but do not own resolution in every shell asked, so GitHub traffic from that shell bypasses the scrub (PEN-4357, PEN-4446)" >&2; ` +
      "else " +
        `echo "${IMAGE_WRAPPER_PREFLIGHT_OK} dir=$__pcwrapdir shells:$__pcwrapshells" >&2; ` +
      "fi; " +
    "fi",
    "unset __pcwrapdir __pcwrapmiss __pcwrapbin __pcwrapres __pcwrapbad __pcwrapsh __pcwrapshells __pcwrapq",
  ].join("; ");
}

/**
 * POSIX sh snippet (no trailing separator) that makes the pinned binary the
 * `opencode` on PATH for the rest of the Job command.
 *
 * Layout on the PVC:
 *   <data>/.local/lib/paperclip-k8s-runtimes/opencode/<version>/   installed prefix
 *   .../<version>/.complete                                        written last
 *   .../.lock-<version>                                            mkdir lock
 *   .../.tmp-<version>-<pid>                                       staging dir
 *
 * Properties:
 * - idempotent: a complete install is reused by every later Job, any isolation key;
 * - serialized: `mkdir` of the lock dir is atomic on CephFS/NFS; losers wait
 *   (up to 5 min) for the winner's `.complete` marker instead of installing twice;
 * - crash-safe: a lock older than 20 min is reclaimed, a dir without `.complete`
 *   is rebuilt, and the staging dir is renamed into place only after the fresh
 *   binary answers `--version`;
 * - fail-open: if nothing usable exists afterwards the image binary is used and
 *   the pod log says so.
 */
export function buildOpencodeRuntimeShell(opts: { version: string; dataMountPath: string }): string {
  const { version, dataMountPath } = opts;
  if (!EXACT_VERSION_RE.test(version)) throw new Error(`invalid opencode version: ${JSON.stringify(version)}`);
  const root = `${dataMountPath.replace(/\/+$/, "")}/${RUNTIMES_DIR_RELATIVE}/opencode`;
  const spec = `${OPENCODE_PACKAGE}@$__pover`;
  return [
    `__pover=${shellSingleQuote(version)}`,
    `__poroot=${shellSingleQuote(root)}`,
    '__podir="$__poroot/$__pover"',
    '__pobin="$__podir/node_modules/.bin/opencode"',
    'if [ ! -f "$__podir/.complete" ] || [ ! -x "$__pobin" ]; then ' +
      'mkdir -p "$__poroot" 2>/dev/null; __polock="$__poroot/.lock-$__pover"; ' +
      'if [ -d "$__polock" ] && [ -n "$(find "$__polock" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then ' +
        'echo "[paperclip] reclaiming stale opencode install lock $__polock" >&2; rmdir "$__polock" 2>/dev/null; fi; ' +
      'if mkdir "$__polock" 2>/dev/null; then ' +
        '__potmp="$__poroot/.tmp-$__pover-$$"; rm -rf "$__potmp" "$__podir"; mkdir -p "$__potmp"; ' +
        `echo "[paperclip] installing ${spec} into $__podir" >&2; ` +
        `if npm install --prefix "$__potmp" --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error "${spec}" >&2 ` +
          '&& "$__potmp/node_modules/.bin/opencode" --version >/dev/null 2>&1; then ' +
          'mv "$__potmp" "$__podir" && : > "$__podir/.complete"; ' +
        `else echo "[paperclip] ${spec} install failed" >&2; rm -rf "$__potmp"; fi; ` +
        'rmdir "$__polock" 2>/dev/null; ' +
      'else ' +
        `echo "[paperclip] waiting for a concurrent ${spec} install" >&2; ` +
        '__poi=0; while [ ! -f "$__podir/.complete" ] && [ -d "$__polock" ] && [ "$__poi" -lt 300 ]; do sleep 1; __poi=$((__poi+1)); done; ' +
      'fi; ' +
    'fi',
    'if [ -f "$__podir/.complete" ] && [ -x "$__pobin" ]; then ' +
      // PEN-3925, mirroring PEN-3714 in the claude_k8s adapter. The managed
      // binary goes ahead of the image's `opencode` - but NOT ahead of the
      // root-owned GitHub egress wrappers. job-manifest.ts makes
      // IMAGE_WRAPPER_BIN_DIR `PATH[0]` on the Job env; this snippet runs later,
      // in the Job's own shell, so a bare prepend here silently demoted it.
      //
      // That matters because the wrapper directory is the one control over
      // `gh`/`git`/`github-mcp-server` that a PVC write cannot reach: it lives in
      // the image, root-owned, precisely so the shared-PVC trust assumption does
      // NOT extend to it. The runtime root IS agent-writable by construction, so
      // a Job shadows a wrapper by CREATING a file, not only by replacing one -
      // reopening exactly what that directory closed.
      //
      // Keyed off $PATH rather than the filesystem so the branch is a pure
      // function of the env this snippet inherits: an image that predates the
      // wrappers has the directory on neither, and gains no phantom PATH entry.
      // Re-prepending one already-present entry is a no-op for resolution.
      'case ":$PATH:" in ' +
        '*":' + IMAGE_WRAPPER_BIN_DIR + ':"*) ' +
          'PATH=' + shellSingleQuote(IMAGE_WRAPPER_BIN_DIR) + '":$__podir/node_modules/.bin:$PATH" ;; ' +
        '*) PATH="$__podir/node_modules/.bin:$PATH" ;; ' +
      'esac; export PATH; ' +
      'echo "[paperclip] opencode runtime $(opencode --version 2>/dev/null | head -n1) (adapter-managed, pinned $__pover)" >&2; ' +
    'else ' +
      'echo "[paperclip] opencode $__pover unavailable; falling back to the image opencode $(opencode --version 2>/dev/null | head -n1)" >&2; ' +
    'fi',
  ].join("; ");
}

/**
 * Stable leading tokens of the pre-push hook preflight verdicts. Same contract
 * as the wrapper markers above: operators key alerts to them, so they are
 * exported values with tests rather than inline literals.
 */
export const PRE_PUSH_HOOK_PREFLIGHT_MARKER = "[paperclip] pre-push-publish-guard";
export const PRE_PUSH_HOOK_PREFLIGHT_OK = `${PRE_PUSH_HOOK_PREFLIGHT_MARKER} ok`;
export const PRE_PUSH_HOOK_PREFLIGHT_MASKED = `${PRE_PUSH_HOOK_PREFLIGHT_MARKER} MASKED`;
export const PRE_PUSH_HOOK_PREFLIGHT_OFF_MOUNT = `${PRE_PUSH_HOOK_PREFLIGHT_MARKER} OFF-MOUNT`;
export const PRE_PUSH_HOOK_PREFLIGHT_NOT_EXECUTABLE = `${PRE_PUSH_HOOK_PREFLIGHT_MARKER} NOT-EXECUTABLE`;

/**
 * POSIX sh snippet (no trailing separator) that makes every agent Job state, in
 * its own pod log, whether the PEN-3156 pre-push publish guard is actually
 * reachable FROM INSIDE THIS POD. PEN-4518.
 *
 * Why a runtime check when three static ones already exist. The path is
 * spelled by four consumers (see `github-git-hooks-path.ts`), and each of the
 * three suites that touch it compares SOURCE STRINGS:
 *
 *   - the chart suite joins the seed to the runtime constant by regex;
 *   - the Job-manifest suite pins the subPath into `ROOT_TOOLCHAIN_SUBPATHS`;
 *   - the runtime suite pins `hooksDirectory()`.
 *
 * All three were green throughout PEN-4518. They had to be: every string was
 * individually correct. What was wrong was the composition — an emptyDir over
 * the PVC root (BLO-32734 phase 2b) masked a path that all four consumers
 * agreed on, and no suite owns the join between "the seed wrote it" and "the
 * Job can see it". The seed's own success log is not evidence of the latter:
 * it writes to the PVC, and the Job pod sees an overlay.
 *
 * This asks the deployed pod instead of comparing strings, which is the only
 * form that survives a change in any of the four spellings OR in the mount
 * topology underneath them.
 *
 * ADVISORY, NOT FATAL, and the asymmetry is deliberate. The push path already
 * fails closed — that is how PEN-4518 was found — so this cannot be what makes
 * the guard binding, and there is nothing to gain by also killing the Job.
 * There is something to lose: a false positive here would take the whole fleet
 * down at second zero, whereas a missed verdict costs one confusing push
 * refusal. What this buys is TIME-TO-DIAGNOSIS. During PEN-4518 the verdict
 * arrived as a push refusal 90 minutes into a run, in one agent's transcript,
 * and cost ~2h17m of fleet-wide publishing to trace back to a mount. The same
 * fact, emitted at startup by every pod, is greppable across the fleet before
 * any work is stranded.
 *
 * Four verdicts, each naming a different fix:
 *   ok              — executable hook where the runtime will look. Nothing to do.
 *   MASKED          — nothing at either path. Both planes are broken at once:
 *                     the image carries no baked hook AND the seeded copy is
 *                     not visible. Check the image first, then
 *                     `ROOT_TOOLCHAIN_SUBPATHS` and `/proc/mounts`.
 *   OFF-MOUNT       — the SEEDED hook is on the data volume but the IMAGE
 *                     carries none, and a PEN-4932-or-later runtime reads the
 *                     image (`BAKED_HOOKS_DIR`). This pod is running an
 *                     agent image from before the bake, or one whose
 *                     `COPY --from=server` produced an empty directory. The
 *                     fix is to roll the image forward; the chart is not
 *                     involved. Before PEN-4932 this verdict meant a
 *                     `persistence.mountPath` divergence, which the repoint
 *                     retired — the name was kept because the SHAPE it
 *                     reports is unchanged: a hook exists, but not where the
 *                     runtime looks.
 *
 *                     ⚠️ This is the one verdict whose CONSEQUENCE does not
 *                     follow from the file layout alone, so its text does not
 *                     assert one. This shell is built SERVER-side, but the
 *                     Job's image is `asString(config.image, "") ||
 *                     selfPod.image` (`job-manifest.ts`) — an agent can pin an
 *                     image OLDER than the server that wrote this check. A new
 *                     server in front of a pre-bake pinned image emits
 *                     OFF-MOUNT for a pod that publishes perfectly well:
 *                     that image's runtime still reads the SEEDED path, and
 *                     the seed is still written and still mounted. Claiming a
 *                     refusal here would send an operator to debug a working
 *                     pod, so the text names both branches and the one remedy
 *                     they share. The other three verdicts are safe to state
 *                     flatly because each is decided by what the pod's own
 *                     runtime will find, not by which runtime it is.
 *   NOT-EXECUTABLE  — present but without +x. The runtime's presence check is
 *                     an `X_OK` access, so this refuses pushes exactly as
 *                     MASKED does — it is not a silent unscanned-publish. The
 *                     remedy differs, though, which is why it is its own
 *                     verdict: the mount is fine, the file needs +x.
 *
 * The verdict text deliberately carries no bare `git` token — not style:
 * `job-manifest.test.ts` scans the whole container command for unclassified
 * `git` in command position, and prose in an echo is indistinguishable from a
 * call to that scan. Backtick-quoting it the way the breadcrumbs do is not
 * available here either, since these strings sit inside a double-quoted
 * `echo` where a backtick is command substitution. Reword instead; do not
 * widen the scanner, which is what bounds every real `git` call in the Job.
 *
 * It reports presence and executability, NOT that the file is the real scanner
 * — exactly the limit `prePushHookPresent` documents. Note the reason given
 * there no longer applies to the path this reads: the seeded copy is written
 * by a uid-1000 init container and so cannot be made agent-unwritable, but the
 * baked copy is `root:root 0755` in the image. The limit survives anyway,
 * because presence and executability are all an `[ -x ]` test can observe.
 * Named for what it observes.
 */
export function buildPrePushHookPreflightShell(opts: { dataMountPath: string }): string {
  const runtimeDir = shellSingleQuote(BAKED_HOOKS_DIR);
  const mountDir = shellSingleQuote(hooksDirForDataMount(opts.dataMountPath));
  return [
    `__pchookrt=${runtimeDir}`,
    `__pchookmnt=${mountDir}`,
    'if [ -x "$__pchookrt/pre-push" ]; then ' +
      `echo "${PRE_PUSH_HOOK_PREFLIGHT_OK} dir=$__pchookrt" >&2; ` +
    'elif [ -e "$__pchookrt/pre-push" ]; then ' +
      `echo "${PRE_PUSH_HOOK_PREFLIGHT_NOT_EXECUTABLE} dir=$__pchookrt - a pre-push file is there but is not executable, so the egress runtime will refuse every push from this pod; restore +x on the seeded hook — the mount is fine, unlike MASKED (PEN-3156, PEN-4518)" >&2; ` +
    'elif [ -e "$__pchookmnt/pre-push" ]; then ' +
      `echo "${PRE_PUSH_HOOK_PREFLIGHT_OFF_MOUNT} runtime=$__pchookrt data=$__pchookmnt - the seeded hook is on the data volume but the agent image carries none. Whether this pod can publish depends on which egress runtime that image carries: one from PEN-4932 or later reads the image copy and will refuse every push from this pod, while an older one reads the seeded copy, which is still mounted, and publishes normally. Do not read this line on its own as an outage - this preflight is built by the server, and an agent can pin an image older than the server that wrote it. The remedy is the same either way: roll the image forward rather than touching the chart (PEN-4518, PEN-4932)" >&2; ` +
    "else " +
      `echo "${PRE_PUSH_HOOK_PREFLIGHT_MASKED} runtime=$__pchookrt data=$__pchookmnt - no pre-push hook is visible at either path, so this pod cannot publish at all; check the agent image first - the runtime reads the baked copy - and only then the seeded one, where a narrowed Job pod sees an overlay over the PVC so ROOT_TOOLCHAIN_SUBPATHS against /proc/mounts is the check, not the seed log (PEN-4518, PEN-4932, BLO-32734)" >&2; ` +
    "fi",
    "unset __pchookrt __pchookmnt",
  ].join("; ");
}
