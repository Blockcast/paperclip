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

export interface ClaudePromptBundle {
  bundleKey: string;
  /** Absolute path to the bundle root directory (contains .claude/skills/ and agent-instructions.md). */
  rootDir: string;
  /** Value to pass as --add-dir to the Claude CLI. */
  addDir: string;
  /** Path to the materialized instructions file, or null if no instructions were provided. */
  instructionsFilePath: string | null;
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

export async function prepareClaudePromptBundle(input: {
  companyId: string;
  skills: PaperclipSkillEntry[];
  instructionsContents: string | null;
  rootDir?: string | null;
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
  const { companyId, skills, instructionsContents, onLog } = input;
  const bundleKey = await buildClaudePromptBundleKey({
    skills,
    instructionsContents,
    catalogBackedSkillKeys: input.catalogBackedSkillKeys,
  });
  const rootDir = path.join(input.rootDir?.trim() || resolveManagedClaudePromptCacheRoot(companyId), bundleKey);
  const skillsHome = path.join(rootDir, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const entry of skills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      await ensurePaperclipSkillSymlink(entry.source, target);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const instructionsFilePath = instructionsContents ? path.join(rootDir, "agent-instructions.md") : null;
  if (instructionsFilePath && instructionsContents) {
    await ensureReadableFile(instructionsFilePath, instructionsContents);
  }

  return { bundleKey, rootDir, addDir: rootDir, instructionsFilePath };
}
