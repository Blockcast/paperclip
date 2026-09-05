import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  type PaperclipSkillEntry,
  ensurePaperclipSkillSymlink,
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
 * A declared skill's source tree lost a file out from under the bundle-key walk.
 *
 * BLO-32055: `company-skills.ts materializeRuntimeSkillFiles` refreshes a runtime
 * skill by `fs.rm(skillDir, {recursive:true})` -> `mkdir` -> per-file `writeFile`.
 * That is not atomic, so the rolling materialization sweep publishes a window in
 * which the directory exists and `SKILL.md` does not. `hashPathContents` below
 * walks that tree to derive the prompt-bundle cache key, and its `readFile` used
 * to be unguarded — so a sweep landing between the `readdir` and the `readFile`
 * threw a bare Node `ENOENT ... open '<...>/__runtime__/<slug>/SKILL.md'` out of
 * `prepareClaudePromptBundle`, i.e. before the Claude CLI was ever spawned.
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
 */
export function readCatalogBackedSkillKeys(config: Record<string, unknown>): ReadonlySet<string> {
  const raw = config.paperclipRuntimeSkills;
  if (!Array.isArray(raw)) return new Set<string>();
  const keys = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const key = (entry as Record<string, unknown>).key;
    // Mirrors normalizeConfiguredPaperclipRuntimeSkills' key fallback in
    // server-utils, so the two cannot disagree about which entry is which.
    const name = (entry as Record<string, unknown>).name;
    const resolved = (typeof key === "string" ? key : typeof name === "string" ? name : "").trim();
    if (resolved) keys.add(resolved);
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
   * (the BLO-31794 hazard). Production always passes the set explicitly.
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
