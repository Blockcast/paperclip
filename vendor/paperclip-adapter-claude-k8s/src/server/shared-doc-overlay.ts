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
  /**
   * Execution workspace the docs were materialized into.
   *
   * Retained, but no longer the delivery mechanism for a run-isolated pod — see
   * `contents` below. Still used by the fallback copy, which is correct for any pod that
   * does mount this directory.
   */
  sourceCwd: string;
  /** Repo-relative POSIX paths under `docs/`. */
  paths: string[];
  /**
   * Document bodies, keyed by the same repo-relative path.
   *
   * THE SOURCE PATH CANNOT CROSS INTO A RUN-ISOLATED POD, AND THAT IS BY DESIGN.
   * Measured 2026-10-29 from a live `isolation-mode: run` pod carrying the first fix:
   * every one of the 14 declared docs was reported absent, because `sourceCwd`
   * (`/paperclip/instances/default/projects/...`) does not exist inside the pod at all.
   * `/paperclip/instances/default` is an `emptyDir`, and only named PVC subPaths
   * (`skills/`, `run-logs/`, `prompt-cache/`, `work/`, `wt/`) are re-mounted over it —
   * the projects tree is not among them. Not mounting the server's workspace is the
   * property `run` isolation exists to enforce, so the first fix was asking the pod for
   * something it must not have.
   *
   * So the content travels instead of a path to it: the server reads each body and the
   * adapter stages it as a per-Job Secret volume, the same way `mcp.json` is staged
   * "regardless of size" (BLO-17980/BLO-17973). A value delivered this way is
   * mount-shape-independent, which is exactly the dimension the path-based attempt was
   * fragile on.
   *
   * Optional, so an older server paired with a newer adapter degrades to the path copy
   * rather than failing: the two deploy on different cadences.
   */
  contents?: Record<string, string>;
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
  // Bodies are keyed by the same repo-relative path, and both the key and the value are
  // re-checked here: the key against the same charset as `paths` (it becomes a Secret
  // projection path), the value as a string (it becomes a file). A body that is not a
  // string is dropped rather than coerced — "undefined" is not a document.
  const rawContents =
    record.contents && typeof record.contents === "object" && !Array.isArray(record.contents)
      ? (record.contents as Record<string, unknown>)
      : {};
  const contents: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawContents)) {
    if (!isSafeSharedDocPath(key)) continue;
    if (typeof value !== "string") continue;
    contents[key] = value;
  }
  // A doc the server sent a body for is deliverable even if it is absent from `paths`,
  // and vice versa, so the declared set is the union. Sorted for a stable pod command:
  // the command string feeds the prompt cache key, so an unstable order would miss.
  const paths = [...new Set([...rawPaths.filter(isSafeSharedDocPath), ...Object.keys(contents)])].sort(
    (left, right) => left.localeCompare(right),
  );
  if (paths.length === 0) return null;
  return { sourceCwd, paths, ...(Object.keys(contents).length > 0 ? { contents } : {}) };
}

/** Where the staged Secret is mounted in the pod. Not under any other mount path. */
export const SHARED_DOC_SECRET_MOUNT_PATH = "/tmp/paperclip-shared-docs";

/** The Secret volume name, shared by the volume and its mount. */
export const SHARED_DOC_SECRET_VOLUME_NAME = "shared-docs-secret";

export type SharedDocSecretProjection = {
  /** `stringData` for the Secret: one entry per carried document. */
  data: Record<string, string>;
  /** `items` for the Secret volume, projecting each key back to its repo-relative path. */
  items: Array<{ key: string; path: string }>;
};

/**
 * Turns the carried bodies into a Secret plus the projection that restores their layout.
 *
 * Keys are positional (`doc-0`, `doc-1`, …) rather than derived from the path. A Secret
 * key may only contain `[-._a-zA-Z0-9]`, so a path has to be transformed to be usable as
 * one — and the obvious transform (`/` → `__`) is NOT injective over the charset
 * `isSafeSharedDocPath` admits: `docs/a/b.md` and `docs/a__b.md` are both legal and would
 * collide on one key, silently delivering one document's body under the other's name.
 * A positional key cannot collide, and `items[].path` carries the real layout anyway, so
 * nothing is lost by not encoding it twice.
 *
 * Returns null when nothing is carried, so callers stage no Secret at all.
 */
export function buildSharedDocSecretProjection(overlay: SharedDocOverlay): SharedDocSecretProjection | null {
  const contents = overlay.contents;
  if (!contents) return null;
  const data: Record<string, string> = {};
  const items: Array<{ key: string; path: string }> = [];
  // Drive from `paths` (already sorted and safe) so key assignment is deterministic for a
  // given overlay rather than dependent on object insertion order.
  for (const docPath of overlay.paths) {
    const body = contents[docPath];
    if (typeof body !== "string") continue;
    const key = `doc-${items.length}`;
    data[key] = body;
    items.push({ key, path: docPath });
  }
  if (items.length === 0) return null;
  return { data, items };
}

/**
 * Builds the bootstrap step, or `""` when there is nothing to carry.
 *
 * Every property below is load-bearing:
 *
 *   * **Never overwrites.** `[ -e ] || [ -L ]` short-circuits, so a doc the clone already
 *     carries as a tracked file keeps the cloned revision's content. This step fills
 *     absences only. `-L` is tested as well as `-e` because `-e` follows symlinks, so a
 *     tracked *dangling* symlink at `docs/<name>.md` reads as absent. GNU `cp` refuses
 *     that write on its own ("not writing through dangling symlink"), so the `-L` test is
 *     not what stops the escape there — it stops `cp` exiting 1 and the step reporting a
 *     copy failure that is really a file already being present. It does close the escape
 *     under a `cp` that follows the link, which POSIX permits and busybox does.
 *   * **Never writes through a symlinked directory.** Where some earlier bootstrap step
 *     has already symlinked `docs/` at a shared source — the opencode tree's
 *     `sharedDocsBridge` (BLO-10315) links the whole company `docs/` in when the repo has
 *     none of its own — a `cp` into it would land in that shared directory, outside this
 *     run, and a placeholder would overwrite the real company document for every later
 *     run. So each destination's ancestors are checked and a symlinked one is reported and
 *     stepped over. This is also what makes the bridge and this step compose: the bridge
 *     runs first and serves the whole directory, and this step then fills nothing, which
 *     is correct — the bridge covers transitively-referenced docs that are not in the
 *     declared set, and this step cannot.
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
  /**
   * Directory the documents are read from inside the POD.
   *
   * Pass the Secret mount when one is staged. Omitted, this falls back to
   * `overlay.sourceCwd` — the server-side path — which is only readable from a pod that
   * mounts the execution workspace. A run-isolated pod does not, which is the whole of
   * PEN-3329's second round; see the `contents` field above.
   */
  sourceDir?: string;
}): string {
  const { overlay, workspaceRoot, quote } = input;
  if (!workspaceRoot || overlay.paths.length === 0) return "";
  const sourceDir = input.sourceDir?.trim() || overlay.sourceCwd;
  if (!sourceDir.startsWith("/")) return "";
  const src = "$__pcdocs_src/$__pcdoc";
  const dst = "$__pcdocs_dst/$__pcdoc";
  return [
    `__pcdocs_src=${quote(sourceDir)};`,
    `__pcdocs_dst=${quote(workspaceRoot)};`,
    `for __pcdoc in ${overlay.paths.map(quote).join(" ")}; do`,
    // `-L` as well as `-e`: `-e` follows symlinks, so a dangling one reads as absent.
    // Either shape means "something is already here" and must not be touched.
    `if [ -e "${dst}" ] || [ -L "${dst}" ]; then continue; fi;`,
    // Walk the destination's ancestors under the workspace root and refuse to write when
    // any of them is a symlink: the copy would land outside this run, in whatever shared
    // directory the link points at. Reached when a doc is absent from a symlinked `docs/`,
    // which is exactly the case the opencode tree's `sharedDocsBridge` creates.
    `__pcdoc_dir="$(dirname "$__pcdoc")"; __pcdoc_linked=0;`,
    `while [ "$__pcdoc_dir" != "." ] && [ "$__pcdoc_dir" != "/" ]; do`,
    `if [ -L "$__pcdocs_dst/$__pcdoc_dir" ]; then __pcdoc_linked=1; break; fi;`,
    `__pcdoc_dir="$(dirname "$__pcdoc_dir")";`,
    `done;`,
    `if [ "$__pcdoc_linked" = 1 ]; then echo "[paperclip] shared doc $__pcdoc is absent under a symlinked docs/ directory; not copying, because that would write into the shared directory the link points at" >&2; continue; fi;`,
    `if [ ! -f "${src}" ]; then echo "[paperclip] shared doc $__pcdoc was not delivered to this pod; the run workspace will not have it" >&2; continue; fi;`,
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
