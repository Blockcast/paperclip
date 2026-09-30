import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  type PaperclipSkillEntry,
  asString,
  ensurePaperclipSkillSymlink,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

/**
 * The bundle is the one prompt-cache artifact with a writer in THIS process and
 * a reader in the agent pod, and the two reach the shared volume at DIFFERENT
 * absolute paths (`SELF_POD_DATA_MOUNT_PATH` here, `config.workspaceMountPath`
 * there). Every field below is therefore explicitly one address space or the
 * other; `serverRootDir` exists so that distinction is visible in the type
 * rather than being a property a reader has to know (BLO-37760).
 */
export interface ClaudePromptBundle {
  bundleKey: string;
  /** POD address of the bundle root (contains .claude/skills/ and agent-instructions.md). */
  rootDir: string;
  /** POD address. Value to pass as --add-dir to the Claude CLI. */
  addDir: string;
  /** POD address of the materialized instructions file, or null if no instructions were provided. */
  instructionsFilePath: string | null;
  /**
   * SERVER address of the same bytes as `rootDir` — where this process actually
   * wrote them. Equal to `rootDir` whenever the two mounts coincide, which is
   * every deployment today. Anything server-side that touches the bundle must
   * use this; reaching for `rootDir` is the defect this field exists to prevent.
   */
  serverRootDir: string;
}

const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

/**
 * A declared skill's source tree is not usable as a skill at bundle-key time.
 *
 * Two producers, both instants of the one materialization race:
 *   - BLO-32055 (branch A) — a file vanished mid-walk, raising `ENOENT`.
 *   - BLO-32167 (branch B) — the walk completed cleanly over a tree with no
 *     `SKILL.md`. Nothing throws; see `assertSkillEntrypointPresent`.
 *
 * BLO-32055: `company-skills.ts materializeRuntimeSkillFiles` used to refresh a
 * runtime skill by `fs.rm(skillDir, {recursive:true})` -> `mkdir` -> per-file
 * `writeFile`. That was not atomic, so the rolling materialization sweep
 * published a window in which the directory exists and `SKILL.md` does not.
 * `hashPathContents` below walks that tree to derive the prompt-bundle cache
 * key, and its `readFile` used to be unguarded — so a sweep landing between the
 * `readdir` and the `readFile` threw a bare Node
 * `ENOENT ... open '<...>/__runtime__/<slug>/SKILL.md'` out of
 * `prepareClaudePromptBundle`, i.e. before the Claude CLI was ever spawned.
 *
 * (BLO-32167 has since made that publish atomic — staging tree, then rename —
 * so both windows should now be closed at the writer. These guards remain as
 * the observer-side backstop: the pod-local bundle copy is a separate snapshot
 * on a different code path, and `materializeVersionSnapshot` still has the
 * original non-atomic shape.)
 *
 * That is why the live instance carried `errorCode: adapter_failed` with both
 * `stdoutExcerpt` and `stderrExcerpt` null: there was no transcript, no result
 * event, and no `parsed` for `isClaudeSkillNotFoundError` to read. The BLO-7991
 * AC3 classifier is correct for the surface it targets (Claude-CLI-authored
 * text); this is a second path into the same user-visible failure on a layer it
 * never inspects.
 *
 * Carrying the owning skill lets `execute.ts` name the fault and — decisively —
 * separate the transient class from the permanent one. Only skills the server
 * resolved from a company-skill catalog row live under the sweep-rewritten
 * `__runtime__/`, so an ENOENT attributed to one of those means *materialization
 * pending*, which self-heals (the live instance's file appeared 43m36s later).
 * Routing that to `skill_not_found` would be wrong in the expensive direction:
 * that code is in `NON_RETRYABLE_CONTINUATION_ERROR_CODES` and would permanently
 * suppress retries on a self-healing condition.
 *
 * The set is NOT every desired skill — see `readCatalogBackedSkillKeys` below for
 * why `readPaperclipRuntimeSkillEntries` can also hand back bundled on-disk
 * skills, for which the same ENOENT is permanent.
 */
export class ClaudeSkillSourceUnavailableError extends Error {
  readonly skillKey: string;
  readonly skillSource: string;
  readonly missingPath: string;
  /**
   * True when the failing path belongs to a skill the caller resolved from the
   * company-skill catalog. False is the defensive branch: a source that is not
   * attributable to a catalog-backed entry is a real configuration fault, not a
   * sweep race, and must stay non-retryable.
   */
  readonly catalogBacked: boolean;

  constructor(input: {
    skillKey: string;
    skillSource: string;
    missingPath: string;
    catalogBacked: boolean;
    cause: unknown;
  }) {
    super(
      `Skill "${input.skillKey}" source is incomplete: ${input.missingPath} disappeared while building the Claude prompt bundle.`,
    );
    this.name = "ClaudeSkillSourceUnavailableError";
    this.skillKey = input.skillKey;
    this.skillSource = input.skillSource;
    this.missingPath = input.missingPath;
    this.catalogBacked = input.catalogBacked;
    this.cause = input.cause;
  }
}

/**
 * ENOENT only. A permissions fault, an I/O error or a symlink loop is NOT a
 * materialization race and must keep its existing behaviour rather than being
 * laundered into a retryable skill code.
 */
function isMissingEntryError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * The skill keys the server resolved from company-skill catalog rows.
 *
 * `readPaperclipRuntimeSkillEntries` returns EITHER these injected entries OR,
 * when the config carries none, the adapter's own bundled on-disk skills. Only
 * the former live under `__runtime__/` where the rolling materialization sweep
 * rewrites them non-atomically, so only the former can produce the transient
 * race. Bundled skills sit in a read-only image path: a file missing there is a
 * packaging fault that no amount of retrying will fix.
 *
 * The body below is a literal transcription of the key-deriving half of
 * `normalizeConfiguredPaperclipRuntimeSkills` (server-utils) — same primitives,
 * same fallbacks, same drop rule — rather than an approximation of it. That
 * matters in both directions, and an earlier hand-rolled version got both wrong:
 *
 *   - `asString` falls back on an EMPTY string, not merely on a non-string, so
 *     `{key: "", name: "x"}` normalizes to key `x` upstream. A `typeof key ===
 *     "string"` test resolves it to `""` and drops the entry, marking a
 *     catalog-backed skill as un-backed — permanent retry suppression on a
 *     self-healing condition, which is the one direction this whole change
 *     exists to avoid.
 *   - Upstream also DISCARDS any entry missing `runtimeName` or `source`.
 *     Contributing those keys anyway would mark a bundled-skill packaging fault
 *     as retryable.
 *
 * Deriving both from the same predicate closes both at once. Do not re-hand-roll
 * this; if the upstream normalizer changes, change it here in the same commit.
 */
export function readCatalogBackedSkillKeys(config: Record<string, unknown>): ReadonlySet<string> {
  const raw = config.paperclipRuntimeSkills;
  if (!Array.isArray(raw)) return new Set<string>();
  const keys = new Set<string>();
  for (const rawEntry of raw) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    keys.add(key);
  }
  return keys;
}

function validatePathComponent(value: string, fieldName: string): void {
  if (value.trim().length === 0) throw new Error(`Invalid ${fieldName}: must not be empty`);
  if (value.includes("/") || value.includes("\\")) throw new Error(`Invalid ${fieldName}: must not contain path separators`);
  if (value.includes("..")) throw new Error(`Invalid ${fieldName}: must not contain ".."`);
  if (value.includes("\0")) throw new Error(`Invalid ${fieldName}: must not contain null bytes`);
}

function resolveManagedClaudePromptCacheRoot(companyId: string): string {
  const paperclipHome =
    (typeof process.env.PAPERCLIP_HOME === "string" && process.env.PAPERCLIP_HOME.trim().length > 0
      ? process.env.PAPERCLIP_HOME.trim()
      : null) ??
    path.resolve(os.homedir(), ".paperclip");
  const instanceId =
    (typeof process.env.PAPERCLIP_INSTANCE_ID === "string" && process.env.PAPERCLIP_INSTANCE_ID.trim().length > 0
      ? process.env.PAPERCLIP_INSTANCE_ID.trim()
      : null) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  validatePathComponent(companyId, "companyId");
  validatePathComponent(instanceId, "instanceId");
  return path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "claude-prompt-cache");
}

async function hashPathContents(
  candidate: string,
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}\n`);
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved) {
      hash.update("missing\n");
      return;
    }
    await hashPathContents(resolved, hash, relativePath, seenDirectories);
    return;
  }
  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }
  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

/**
 * The file whose presence makes a skill directory a *skill* rather than a
 * directory. Claude will not load a skill without it.
 */
const SKILL_ENTRYPOINT_FILENAME = "SKILL.md";

/**
 * A catalog-backed skill source must contain a readable `SKILL.md` at its root.
 *
 * BLO-32167 — the second branch of the BLO-32055 race, and the one that raises
 * no syscall error at all. `materializeRuntimeSkillFiles` used to publish
 * `rm -rf` -> `mkdir` -> per-file `writeFile`, so a reader could sample the tree
 * *after* the `mkdir` and *before* `SKILL.md` was written. `hashPathContents`
 * handles that state perfectly happily: it `lstat`s a directory that exists,
 * emits `dir:<path>`, `readdir`s an empty (or SKILL.md-less) listing, iterates
 * nothing that fails, and returns. The `isMissingEntryError` guard added for
 * branch A is never reached because nothing throws. A valid key is minted over
 * an unusable tree, the bundle is cached under it, and the run proceeds
 * *silently degraded* — which is BLO-7991's original harm (an agent behaves as
 * though a declared skill does not exist), now with no failure for anyone to
 * see. It is strictly more expensive than branch A's loud death.
 *
 * The primary fix is at the source: the materializer now publishes by rename,
 * so this state should no longer be reachable from that writer. This assertion
 * is the observer-side backstop, and it is not redundant — the pod-local copy of
 * the bundle is a *separate* snapshot taken by a different code path, and the
 * version-snapshot materializer has the same non-atomic shape. A backstop that
 * costs one `stat` per catalog-backed skill is worth having on the layer that
 * mints the cache key.
 *
 * Deliberately keyed on `SKILL.md` rather than on "the directory is empty".
 * The write loop iterates `fileInventory` in order and `SKILL.md` need not be
 * first, so the far commoner partial state is *some files, no entrypoint* — an
 * emptiness test would walk straight past it. Asserting the positive shape is
 * also the inversion BLO-31794 asks for generally: state what a valid tree must
 * contain, rather than enumerating the ways it can be broken.
 */
async function assertSkillEntrypointPresent(entry: PaperclipSkillEntry): Promise<void> {
  const entrypoint = path.join(entry.source, SKILL_ENTRYPOINT_FILENAME);
  // `stat`, not `lstat`: a symlinked entrypoint that resolves to a real file is
  // usable, and only the resolved target answers the question being asked.
  const stat = await fs.stat(entrypoint).catch((err: unknown) => {
    if (isMissingEntryError(err)) return null;
    throw err;
  });
  if (stat?.isFile()) return;
  throw new ClaudeSkillSourceUnavailableError({
    skillKey: entry.key,
    skillSource: entry.source,
    missingPath: entrypoint,
    // Only ever called for keys the caller resolved from a catalog row, so this
    // is the transient class by construction: retryable, and self-healing on the
    // next sweep. See the call site for why it is not called for anything else.
    catalogBacked: true,
    cause: null,
  });
}

async function buildClaudePromptBundleKey(input: {
  skills: PaperclipSkillEntry[];
  instructionsContents: string | null;
  catalogBackedSkillKeys?: ReadonlySet<string>;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("paperclip-claude-prompt-bundle:v1\n");
  if (input.instructionsContents) {
    hash.update("instructions\n");
    hash.update(input.instructionsContents);
    hash.update("\n");
  } else {
    hash.update("instructions:none\n");
  }
  const sortedSkills = [...input.skills].sort((a, b) => a.runtimeName.localeCompare(b.runtimeName));
  for (const entry of sortedSkills) {
    hash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    try {
      await hashPathContents(entry.source, hash, entry.runtimeName, new Set());
    } catch (err) {
      // Deliberately still fatal, and re-thrown rather than swallowed. Hashing a
      // half-written tree into a key would mint a bundle whose skills are silently
      // incomplete — which is BLO-7991's original harm (an agent that behaves as
      // though a declared skill does not exist), traded for a failure nobody sees.
      // A typed, correctly-classified death costs one bounded retry and self-heals.
      if (!isMissingEntryError(err)) throw err;
      throw new ClaudeSkillSourceUnavailableError({
        skillKey: entry.key,
        skillSource: entry.source,
        missingPath: (err as NodeJS.ErrnoException).path ?? entry.source,
        catalogBacked: input.catalogBackedSkillKeys?.has(entry.key) ?? true,
        cause: err,
      });
    }
    // BLO-32167. Only for keys KNOWN to be catalog-backed — never on the
    // `?? true` default the branch-A classifier above uses. That default is
    // correct there because it decides how to classify a fault that has already
    // happened, and over-retrying beats permanently suppressing a self-healing
    // one. Here the question is the opposite: whether to *manufacture* a fault.
    // Erring toward manufacturing one would fail runs whose skill trees are
    // legitimately shaped differently — bundled adapter skills in a read-only
    // image path, which the sweep never rewrites and which no caller has told us
    // about. That is the BLO-31794 over-suppression hazard, so this stays silent
    // unless the caller positively identified the entry as catalog-backed.
    if (input.catalogBackedSkillKeys?.has(entry.key)) {
      await assertSkillEntrypointPresent(entry);
    }
  }
  return hash.digest("hex");
}

async function ensureReadableFile(targetPath: string, contents: string): Promise<void> {
  try {
    await fs.access(targetPath, fsConstants.R_OK);
    return;
  } catch {
    // Fall through and materialize the file.
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    const targetReadable = await fs.access(targetPath, fsConstants.R_OK).then(() => true).catch(() => false);
    if (!targetReadable) throw err;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Translates a POD address on the shared data volume into the SERVER address
 * for the same bytes. Used for the roots, which are computed in pod space (they
 * are what the container is handed) while the writes happen here. `toPodAddress`
 * below is the inverse, needed for symlink *contents* (BLO-37961).
 *
 * Same arithmetic as `resolveLinkedWorktreeCommonDir`'s reader in
 * `job-manifest.ts`, which translates pod->server for exactly the same reason.
 *
 * Returns `podPath` unchanged in two cases, both deliberate:
 *  - either mount is unknown — no translation is derivable, and this is the
 *    shape every caller that omits the two params takes;
 *  - `podPath` is not under the pod mount. The
 *    `resolveManagedClaudePromptCacheRoot` fallback is a PAPERCLIP_HOME path
 *    with no pod counterpart at all, so rewriting it would relocate an
 *    already-server-side default to somewhere it has never been.
 *
 * That second case leaves the WRITE correct but not the READ: the container is
 * still handed `podPath`, which is not on its data mount, so it gets an absent
 * or empty bundle. It is also the shape an operator-set `promptCacheRoot`
 * takes when it is not under a custom `workspaceMountPath`. Neither is
 * derivable here, so `prepareClaudePromptBundle` reports it
 * (`claude_k8s.prompt_bundle_off_volume`) rather than letting this branch be
 * silent.
 *
 * There is deliberately NO `podMount === serverMount` fast path: the arithmetic
 * below already yields the identity in that case, so such a branch would have
 * no failing mutation — documentation wearing a guard's clothes.
 */
function toServerAddress(podPath: string, podMount?: string, serverMount?: string): string {
  if (!podMount || !serverMount) return podPath;
  const prefix = mountPrefix(podMount);
  if (!podPath.startsWith(prefix)) return podPath;
  return path.posix.join(serverMount, podPath.slice(prefix.length));
}

function mountPrefix(mount: string): string {
  return mount.endsWith("/") ? mount : `${mount}/`;
}

/**
 * Translates a SERVER address on the shared data volume into the POD address
 * for the same bytes. Inverse of `toServerAddress`.
 *
 * Needed for one thing only: the CONTENT of a symlink. `toServerAddress` gets
 * the bundle written to the right place, but a symlink's target is resolved by
 * whoever follows it — and that is the agent pod, in the pod's mount namespace.
 * A skill entry's `source` arrives here as a SERVER address
 * (`resolveManagedSkillsRoot` is a server service), so writing it verbatim
 * publishes a link the pod cannot follow: present, correctly named, and
 * dangling, with nothing in the bundle saying so (BLO-37961).
 *
 * Returns `serverPath` unchanged in two cases, and the SECOND ONE IS LOAD-BEARING:
 *  - either mount is unknown — no translation is derivable, same shape as
 *    `toServerAddress`;
 *  - `serverPath` is not under the server mount. This is the adapter's own
 *    bundled on-disk skills (`/app/skills/...`), which are an IMAGE path: the
 *    same absolute path in both namespaces because both come from the same
 *    image layer, not from the shared volume. Rewriting those would relocate a
 *    correct link onto the data volume, where nothing exists — turning the one
 *    set of links that works today into the broken set.
 *    It is NOT the only shape that reaches this return: a catalog-backed source
 *    whose PAPERCLIP_HOME is not under the server mount does too, and for that
 *    one the link dangles. Not derivable here, so `prepareClaudePromptBundle`
 *    reports it (`claude_k8s.prompt_bundle_skill_off_volume`).
 *
 * With `podMount === serverMount` (every deployment today) the arithmetic is the
 * identity, so every emitted target is byte-identical to the pre-BLO-37961 value.
 */
function toPodAddress(serverPath: string, podMount?: string, serverMount?: string): string {
  if (!podMount || !serverMount) return serverPath;
  const prefix = mountPrefix(serverMount);
  if (!serverPath.startsWith(prefix)) return serverPath;
  return path.posix.join(podMount, serverPath.slice(prefix.length));
}

export async function prepareClaudePromptBundle(input: {
  companyId: string;
  skills: PaperclipSkillEntry[];
  instructionsContents: string | null;
  /**
   * POD address of the prompt-cache root. The container is handed paths derived
   * from this, so it is expressed in the pod's address space; the writes below
   * go through `serverDataMountPath` instead. Omitted => the managed
   * PAPERCLIP_HOME default, which is server-side and is left untranslated.
   */
  rootDir?: string | null;
  /** Where the agent POD reaches the shared data volume (`resolveDataMountPath`). */
  podDataMountPath?: string;
  /** Where THIS process reaches it (`SELF_POD_DATA_MOUNT_PATH`). */
  serverDataMountPath?: string;
  /**
   * Skill keys the caller resolved from the company-skill catalog — the
   * discriminator between a transient materialization race and a permanent
   * configuration fault. `execute.ts` derives it from the server-injected
   * `paperclipRuntimeSkills`, so the adapter's own bundled on-disk skills (a
   * read-only image path the sweep never rewrites) are correctly excluded.
   *
   * Omitting it defaults every entry to catalog-backed, i.e. RETRYABLE. That is
   * the deliberate direction to fail in: an over-retry costs bounded attempts
   * against a condition that may clear, whereas an over-suppression is permanent
   * (the BLO-31794 hazard). The only call site is `execute.ts`, which passes it
   * — so a second caller appearing here is a contradiction to resolve, not
   * prose that has quietly gone stale.
   */
  catalogBackedSkillKeys?: ReadonlySet<string>;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<ClaudePromptBundle> {
  const { companyId, skills, instructionsContents, onLog, podDataMountPath, serverDataMountPath } = input;
  const bundleKey = await buildClaudePromptBundleKey({
    skills,
    instructionsContents,
    catalogBackedSkillKeys: input.catalogBackedSkillKeys,
  });
  // `bundleKey` is joined FIRST, so both addresses carry the identical
  // volume-relative subpath and cannot drift by construction.
  const rootDir = path.join(input.rootDir?.trim() || resolveManagedClaudePromptCacheRoot(companyId), bundleKey);
  // The server's writes reach the pod ONLY through the shared data volume, so a
  // bundle root the container is handed off its data mount is one it cannot
  // read. Not gated on the two mounts differing: with them equal, a root off
  // the mount is equally unreachable. Not gated on `storage` either, unlike
  // `warnIfPersistentTreeIsOffVolume`: the container is handed this path
  // (`--add-dir`) unconditionally, so there is no off-volume-by-design case.
  // Warned, not thrown, on that function's precedent: the run still completes,
  // it just loads no skills, which is unreadable without this (BLO-37760).
  if (podDataMountPath && !rootDir.startsWith(mountPrefix(podDataMountPath))) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "claude_k8s.prompt_bundle_off_volume",
        msg: "prompt bundle root is outside the pod's data mount; the container is handed --add-dir it cannot read, so no skill will load",
        rootDir,
        podDataMountPath,
        serverDataMountPath: serverDataMountPath ?? "",
      }),
    );
  }
  const serverRootDir = toServerAddress(rootDir, podDataMountPath, serverDataMountPath);
  const skillsHome = path.join(serverRootDir, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const entry of skills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      // `target` is a SERVER path (that is where this process writes), but the
      // link's CONTENT is resolved by the pod, so it must be a POD path.
      // `entry.source` arrives as a SERVER address — see `toPodAddress`.
      const desired = toPodAddress(entry.source, podDataMountPath, serverDataMountPath);
      // `toPodAddress`'s "not under the server mount" return is correct for an
      // IMAGE path only. A catalog-backed source is a PAPERCLIP_HOME path, and
      // the server mount is `SELF_POD_DATA_MOUNT_PATH`: two variables that
      // coincide today, not one. Where they diverge the source passes through
      // untranslated and the pod gets a dangling link, so report it. Keyed on
      // the pod mount alone, as `prompt_bundle_off_volume` above is; the
      // catalog discriminator is what keeps the image-path set silent.
      if (
        podDataMountPath &&
        (input.catalogBackedSkillKeys?.has(entry.key) ?? true) &&
        !desired.startsWith(mountPrefix(podDataMountPath))
      ) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "claude_k8s.prompt_bundle_skill_off_volume",
            msg: "catalog-backed skill link target is outside the pod's data mount; the pod cannot follow it, so this skill will not load",
            skillKey: entry.key,
            linkTarget: desired,
            podDataMountPath,
            serverDataMountPath: serverDataMountPath ?? "",
          }),
        );
      }
      // `ensurePaperclipSkillSymlink` keeps an existing link whose target still
      // stat()s — but it stats HERE, in server space, so a stale pre-fix link
      // carrying the old SERVER address resolves and is kept, leaving the pod
      // one it cannot follow. That is not hypothetical: `bundleKey` is derived
      // from skill CONTENT, and `serverRootDir` maps a moved pod mount back to
      // the same server directory, so the first run after an operator adopts a
      // custom `workspaceMountPath` lands on the existing bundle. Measured: the
      // stale link survived and the skill stayed dangling. Drop a mismatched
      // link first so the helper rewrites it (BLO-37961).
      //
      // `readlink` yields null on a non-symlink (EINVAL), so a real directory
      // parked at this path is left alone — the helper's own "skipped" branch
      // still owns that case.
      const current = await fs.readlink(target).catch(() => null);
      if (current !== null && current !== desired) {
        await fs.unlink(target).catch(() => {});
      }
      await ensurePaperclipSkillSymlink(desired, target);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Constructed once in POD space and translated, rather than joined twice
  // against two roots: two join sites are two things to keep in agreement, and
  // keeping them in agreement is the whole defect.
  const instructionsFilePath = instructionsContents ? path.join(rootDir, "agent-instructions.md") : null;
  if (instructionsFilePath && instructionsContents) {
    await ensureReadableFile(
      toServerAddress(instructionsFilePath, podDataMountPath, serverDataMountPath),
      instructionsContents,
    );
  }

  return { bundleKey, rootDir, addDir: rootDir, instructionsFilePath, serverRootDir };
}
