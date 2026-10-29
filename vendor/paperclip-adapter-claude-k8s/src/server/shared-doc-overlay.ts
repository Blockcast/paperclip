/**
 * PEN-3329 — carry the materialized shared docs into a run-isolated pod.
 *
 * Paperclip materializes the docs an agent's `AGENTS.md` tells it to read
 * (`docs/<name>.md`) into the **execution workspace** on the server, before the Job is
 * created. For `workspace` isolation that is enough: the pod mounts that directory, so
 * the writes are already visible. For `run` isolation it is not, and the gap is silent.
 *
 * A run-isolated pod bootstraps with `git clone --shared` from the execution workspace,
 * and **a clone carries tracked objects only**. The materialized docs are untracked by
 * construction — Paperclip even appends them to `info/exclude` so the workspace does not
 * read as dirty — so not one of them crosses. The fallback branch of that same bootstrap
 * (`rm -rf` + `mkdir -p`, taken when the source cwd is not a repository) is worse still:
 * the pod's cwd is an empty directory, so every `Read: docs/<name>.md` in the agent's
 * instructions resolves to nothing.
 *
 * Note the failure signature this leaves, because it is the reason the obvious check does
 * not work: Paperclip writes a `# Missing Shared Documentation: <path>` placeholder when a
 * doc cannot be resolved, so "assert no placeholder" **passes** against a directory where
 * the file is simply absent. Existence has to be asserted directly, which is what the
 * verdict lines emitted below do.
 *
 * The set is DECLARED rather than discovered. Copying `docs/` wholesale would overwrite
 * the clone's *tracked* docs with the base checkout's working-tree copies — a base that
 * may sit on an entirely different branch — so only the exact paths the server reports
 * are copied, and only where nothing already exists at the destination.
 */

/** What the server reports on `context.paperclipSharedDocs`. */
export type SharedDocOverlay = {
  /** Execution workspace the docs were materialized into; the pod copies from here. */
  sourceCwd: string;
  /** Repo-relative POSIX paths under `docs/`. */
  paths: string[];
};

/**
 * `extractReferencedSharedDocPaths` already constrains these server-side, so this is
 * defence in depth rather than the only gate — but the value arrives on the adapter
 * context and is turned into both shell and filesystem writes, so it is re-checked here
 * rather than trusted across the boundary.
 *
 * The accepted charset is deliberately narrower than "safe to quote". It excludes every
 * character `.git/info/exclude` treats as a pattern (`* ? [ ] \ ! #`), which is what lets
 * the generated script append `/<path>` as a literal exclude entry with no escaping.
 */
const SHARED_DOC_PATH_PATTERN = /^docs\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/;

export function isSafeSharedDocPath(candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false;
  if (!SHARED_DOC_PATH_PATTERN.test(candidate)) return false;
  // `..` cannot be spelled with the charset above *except* as a path segment, which the
  // pattern does admit (`docs/../x.md`). Reject it explicitly rather than relying on the
  // pattern to have excluded it.
  return !candidate.split("/").includes("..");
}

/** Returns null when the context carries no usable overlay, so callers emit nothing. */
export function parseSharedDocOverlay(raw: unknown): SharedDocOverlay | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const sourceCwd = typeof record.sourceCwd === "string" ? record.sourceCwd.trim() : "";
  // An absolute source is required: the copy runs with the pod's cwd already moved to the
  // run workspace, so a relative source would resolve against the destination.
  if (!sourceCwd.startsWith("/")) return null;
  const rawPaths = Array.isArray(record.paths) ? record.paths : [];
  const paths = [...new Set(rawPaths.filter(isSafeSharedDocPath))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (paths.length === 0) return null;
  return { sourceCwd, paths };
}

/**
 * Builds the bootstrap step, or `""` when there is nothing to carry.
 *
 * Every property below is load-bearing:
 *
 *   * **Never overwrites.** `[ -e ]` short-circuits, so a doc the clone already carries as
 *     a tracked file keeps the cloned revision's content. This step fills absences only.
 *   * **Never fails the run.** A missing source, an unwritable destination and a
 *     read-only `.git` are each reported on stderr and stepped over. The whole step ends
 *     `true`, so a caller can splice it into a `&&`/`|| exit` chain without the pod's
 *     startup becoming contingent on documentation.
 *   * **Re-excludes what it copies.** The clone gets a fresh `.git`, so the base's
 *     `info/exclude` entries do not come with it. Without re-adding them the copied docs
 *     read as new untracked files in the run workspace, where a broad `git add -A` would
 *     commit all of them into the agent's PR (the BLO-22984 failure, re-created one layer
 *     down). Skipped when `.git` is not a directory, which is the fallback branch's empty
 *     cwd — nothing there can stage a file either.
 *   * **States its verdict.** Absence and placeholder content are both reported, so the
 *     pod log answers "did the docs arrive" without re-deriving it from the workspace.
 */
export function buildSharedDocOverlayShell(input: {
  overlay: SharedDocOverlay;
  workspaceRoot: string;
  quote: (value: string) => string;
}): string {
  const { overlay, workspaceRoot, quote } = input;
  if (!workspaceRoot || overlay.paths.length === 0) return "";
  const src = "$__pcdocs_src/$__pcdoc";
  const dst = "$__pcdocs_dst/$__pcdoc";
  return [
    `__pcdocs_src=${quote(overlay.sourceCwd)};`,
    `__pcdocs_dst=${quote(workspaceRoot)};`,
    `for __pcdoc in ${overlay.paths.map(quote).join(" ")}; do`,
    `if [ -e "${dst}" ]; then continue; fi;`,
    `if [ ! -f "${src}" ]; then echo "[paperclip] shared doc $__pcdoc is absent from the execution workspace; the run workspace will not have it" >&2; continue; fi;`,
    `if mkdir -p "$(dirname "${dst}")" && cp -- "${src}" "${dst}"; then`,
    // info/exclude needs no glob escaping: `isSafeSharedDocPath` rejects every character
    // git would read as a pattern. A test pins that.
    `if [ -d "$__pcdocs_dst/.git" ]; then mkdir -p "$__pcdocs_dst/.git/info" 2>/dev/null && { grep -qxF "/$__pcdoc" "$__pcdocs_dst/.git/info/exclude" 2>/dev/null || printf '/%s\\n' "$__pcdoc" >> "$__pcdocs_dst/.git/info/exclude" 2>/dev/null; }; fi;`,
    `case "$(head -n 1 "${dst}" 2>/dev/null)" in "# Missing Shared Documentation:"*) echo "[paperclip] shared doc $__pcdoc is a Paperclip placeholder, not the real document; its source did not resolve on the server" >&2 ;; "") echo "[paperclip] shared doc $__pcdoc arrived empty" >&2 ;; esac;`,
    `else echo "[paperclip] shared doc $__pcdoc could not be copied into the run workspace" >&2; fi;`,
    `done;`,
    // The loop's status is the last iteration's; a reported-and-stepped-over failure must
    // not become this step's exit code.
    `true`,
  ].join(" ");
}
