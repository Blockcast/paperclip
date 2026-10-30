/**
 * PEN-4932 stage 4b — carry the prompt bundle into a pod that does not share the
 * server's volume.
 *
 * `prepareClaudePromptBundle` writes the bundle through `SELF_POD_DATA_MOUNT_PATH`
 * and the Job pod reads it at `resolveDataMountPath(config)`. Its own comment states
 * the assumption exactly: *"One volume, TWO mount points"*. That is true today and
 * **false the moment the agent claim is per-agent** — same relative path, different
 * volume. The server would write a complete bundle into its own volume and the pod
 * would get the seeded, empty directory: `--add-dir` naming an empty tree and
 * `--append-system-prompt-file` naming a file that does not exist. Silently, because
 * nothing on the write side errors.
 *
 * So the content travels instead of a path to it, on PEN-3329's precedent
 * (`shared-doc-overlay.ts`): the server reads the bytes and the adapter stages them as
 * a per-Job Secret volume. A value delivered that way is mount-shape-independent,
 * which is precisely the property a per-agent claim takes away.
 *
 * WHAT IS PROJECTED, AND WHY IT IS THE RUN'S ENTRIES RATHER THAN THE COMPANY TREE.
 * `skills/<companyId>` is the obvious unit and it is the wrong one. A skill's source
 * is `resolveRuntimeSkillSource` → `resolveExistingSkillDirectory(normalizeSkillDirectory(skill))`,
 * and `normalizeSkillDirectory` resolves `skill.sourceLocator` for both `catalog` and
 * `local_path`. A `local_path` locator need not be under the managed root at all —
 * `company-skills.ts` branches on exactly that (`localSkillDir.startsWith(managedRoot)`
 * versus a `project_scan` source). A Secret built from the company tree would carry
 * catalog and managed-`local_path` skills and silently omit project-scan ones,
 * producing the dangling link this channel exists to prevent and indistinguishable
 * from the bug. Projecting the entries `prepareClaudePromptBundle` is actually handed
 * covers every `sourceType` by construction, and ships what the run uses rather than
 * everything the company owns.
 *
 * Adapter-bundled IMAGE paths are the one exclusion: they survive in the image at the
 * same absolute path in both namespaces, so projecting them would copy bytes the pod
 * already has. That is the same discriminator `prompt-cache.ts` already applies when
 * it decides whether to report `prompt_bundle_skill_off_volume`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

/**
 * The enforced Secret budget, verified against the Kubernetes source rather than
 * assumed — the quantity matters, and the obvious reading of it is wrong.
 *
 * `ValidateSecret` (`pkg/apis/core/validation/validation.go`) computes
 * `totalSize += len(value)` over `secret.Data`, which is `map[string][]byte` — i.e.
 * **decoded** bytes — and compares it against `MaxSecretSize = 1 * 1024 * 1024`
 * (`pkg/apis/core/types.go`). Two consequences, both load-bearing here:
 *
 *   * **`stringData` is measured decoded, not base64.** `Convert_v1_Secret_To_core_Secret`
 *     merges `StringData` into `Data` as `[]byte(v)` *before* validation runs
 *     (`pkg/apis/core/v1/conversion.go`), so a UTF-8 byte length is what the API server
 *     checks. Base64 is the *wire and etcd* encoding, not the budget.
 *   * **Keys do not count.** The loop validates each key as a ConfigMap key but adds
 *     only the value's length to `totalSize`.
 *
 * ⚠️ §4.2 of `docs/plans/2026-10-28-pen-4932-per-agent-volumes.md` sized the live
 * sample at "~176,397 bytes — 16.8 % of the 1 MiB Secret cap" against a 130,390-byte
 * tree. That ratio is 1.353, i.e. base64 expansion (4/3 plus padding): it measured the
 * encoded form against a limit that is enforced on the decoded one. The same sample is
 * **12.4 %** of the budget actually checked. The error is in the safe direction for the
 * *guard*, but not for the **escalation trigger** — a 50 % threshold evaluated on
 * base64 bytes fires at an effective 37.5 % of real capacity, which would move the
 * design to the init-container fetch a third of the way early. Both are computed on
 * `totalValueBytes` below so they cannot disagree about what is being measured.
 */
export const PROMPT_BUNDLE_SECRET_MAX_BYTES = 1024 * 1024;

/**
 * §4.2's escalation trigger: once any run's projected Secret crosses half the budget,
 * the init-container API fetch becomes the design — chosen so the move is made against
 * a measurement rather than under an outage. Evaluated on the same `totalValueBytes`
 * the budget is, per the correction above.
 */
export const PROMPT_BUNDLE_ESCALATION_RATIO = 0.5;

/** Where the staged Secret is mounted in the pod. Not under any other mount path. */
export const PROMPT_BUNDLE_SECRET_MOUNT_PATH = "/tmp/paperclip-prompt-bundle";

/** The Secret volume name, shared by the volume and its mount. */
export const PROMPT_BUNDLE_SECRET_VOLUME_NAME = "prompt-bundle-secret";

/**
 * Bundle-relative path of the instructions file, matching what
 * `prepareClaudePromptBundle` writes and what `--append-system-prompt-file` names.
 */
export const PROMPT_BUNDLE_INSTRUCTIONS_PATH = "agent-instructions.md";

/** Bundle-relative root of the skill farm, matching `prepareClaudePromptBundle`. */
export const PROMPT_BUNDLE_SKILLS_DIR = ".claude/skills";

/**
 * Hard ceiling on files walked per skill entry.
 *
 * Not a budget — the budget is bytes, below — but a bound on the *walk itself*. A
 * skill source is a directory the server resolved from a catalog row or a project
 * scan; a pathological tree would otherwise make Job creation proportional to it. The
 * walk refuses rather than truncating, for the same reason the byte budget does: a
 * silently dropped skill file is the dangling-link failure this channel exists to
 * prevent.
 */
export const PROMPT_BUNDLE_MAX_FILES = 2000;

/** One projected file: where it goes in the bundle, and the bytes that go there. */
export type PromptBundleFile = {
  /** Bundle-relative POSIX path, e.g. `.claude/skills/dataviz/SKILL.md`. */
  bundlePath: string;
  /** UTF-8 contents. */
  contents: string;
  /** `Buffer.byteLength(contents)` — the quantity the API server budgets. */
  byteLength: number;
  /** Skill key this file came from, or null for the instructions file. */
  skillKey: string | null;
};

export type PromptBundleSecretProjection = {
  /** `stringData` for the Secret: one entry per projected file. */
  data: Record<string, string>;
  /** `items` for the Secret volume, projecting each key back to its bundle-relative path. */
  items: Array<{ key: string; path: string }>;
  /**
   * Sum of UTF-8 value bytes — exactly `ValidateSecret`'s `totalSize`. This is the
   * number the budget refuses on and the number the escalation trigger reads.
   */
  totalValueBytes: number;
  /** Number of projected files. */
  fileCount: number;
  /** Per-skill byte totals, so an over-budget verdict can name the contributor. */
  bytesBySkillKey: Record<string, number>;
  /** True once `totalValueBytes` crosses `PROMPT_BUNDLE_ESCALATION_RATIO` of the cap. */
  escalationThresholdCrossed: boolean;
};

/**
 * Raised when the projection would exceed the Secret budget.
 *
 * **Refuses; never truncates.** A dropped skill is exactly the silent dangling-link
 * failure this whole invariant exists to prevent, and it would be indistinguishable
 * from the bug — so the run fails with a verdict that names the company, the run and
 * the measured bytes, and the operator gets the escalation (§4.2) rather than an agent
 * that quietly came up missing half its instructions.
 */
export class PromptBundleOverBudgetError extends Error {
  readonly companyId: string;
  readonly runLabel: string;
  readonly totalValueBytes: number;
  readonly maxBytes: number;
  readonly fileCount: number;
  readonly bytesBySkillKey: Record<string, number>;

  constructor(input: {
    companyId: string;
    runLabel: string;
    totalValueBytes: number;
    maxBytes: number;
    fileCount: number;
    bytesBySkillKey: Record<string, number>;
  }) {
    const largest = Object.entries(input.bytesBySkillKey).sort((a, b) => b[1] - a[1])[0];
    super(
      `prompt bundle projection is over the Kubernetes Secret budget: ` +
        `${input.totalValueBytes} bytes across ${input.fileCount} files exceeds ${input.maxBytes} ` +
        `(company ${input.companyId}, run ${input.runLabel})` +
        (largest ? `; largest contributor: skill "${largest[0]}" at ${largest[1]} bytes` : "") +
        `. Refusing rather than truncating: a dropped skill is indistinguishable from the ` +
        `missing-bundle fault this channel exists to prevent. See §4.2 of ` +
        `docs/plans/2026-10-28-pen-4932-per-agent-volumes.md for the init-container escalation.`,
    );
    this.name = "PromptBundleOverBudgetError";
    this.companyId = input.companyId;
    this.runLabel = input.runLabel;
    this.totalValueBytes = input.totalValueBytes;
    this.maxBytes = input.maxBytes;
    this.fileCount = input.fileCount;
    this.bytesBySkillKey = input.bytesBySkillKey;
  }
}

/** Raised when a skill's tree exceeds `PROMPT_BUNDLE_MAX_FILES`. Refuses, as above. */
export class PromptBundleTooManyFilesError extends Error {
  readonly skillKey: string;
  readonly limit: number;

  constructor(skillKey: string, limit: number) {
    super(
      `skill "${skillKey}" projects more than ${limit} files into the prompt bundle. ` +
        `Refusing rather than truncating.`,
    );
    this.name = "PromptBundleTooManyFilesError";
    this.skillKey = skillKey;
    this.limit = limit;
  }
}

function mountPrefix(mount: string): string {
  return mount.endsWith("/") ? mount : `${mount}/`;
}

/**
 * Whether this entry's bytes have to travel.
 *
 * An entry whose source is NOT under the server's data mount is an image path — the
 * adapter's own bundled skills, present at the same absolute path in the pod because
 * both come from the same image layer. Those are left alone: projecting them would
 * copy bytes the pod already has, and `prompt-cache.ts` already treats the same
 * distinction as the reason not to warn about them.
 *
 * With `serverDataMountPath` unknown nothing is derivable, so every entry is projected.
 * That is the direction to fail in — an unnecessary copy costs budget, a missing one
 * costs the agent its skill.
 */
export function skillSourceNeedsProjection(entry: PaperclipSkillEntry, serverDataMountPath?: string): boolean {
  if (!serverDataMountPath) return true;
  return entry.source.startsWith(mountPrefix(serverDataMountPath));
}

/** Depth-first walk of a skill source directory, yielding regular files only. */
async function collectSkillFiles(input: {
  entry: PaperclipSkillEntry;
  maxFiles: number;
}): Promise<Array<{ relPath: string; contents: string; byteLength: number }>> {
  const { entry, maxFiles } = input;
  const out: Array<{ relPath: string; contents: string; byteLength: number }> = [];
  // Iterative rather than recursive: a skill tree is operator-supplied and a symlink
  // cycle would otherwise be a stack overflow at Job-creation time. `withFileTypes`
  // reports the link itself, and `isFile()` is false for one, so links are stepped
  // over rather than followed — a skill that relies on an internal symlink projects
  // without it, which is visible, where following one could escape the tree.
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const absDir = relDir ? path.join(entry.source, relDir) : entry.source;
    const dirents = await fs.readdir(absDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const relPath = relDir ? path.posix.join(relDir, dirent.name) : dirent.name;
      if (dirent.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (out.length >= maxFiles) throw new PromptBundleTooManyFilesError(entry.key, maxFiles);
      const contents = await fs.readFile(path.join(entry.source, relPath), "utf-8");
      out.push({ relPath, contents, byteLength: Buffer.byteLength(contents, "utf8") });
    }
  }
  // Sorted so key assignment is deterministic for a given tree rather than dependent
  // on readdir order, which is filesystem-defined. The Job command feeds the prompt
  // cache key, so an unstable order would miss the cache on every run.
  out.sort((left, right) => left.relPath.localeCompare(right.relPath));
  return out;
}

/**
 * Reads the run's resolved bundle contents and turns them into a Secret plus the
 * projection that restores their layout.
 *
 * Keys are positional (`bundle-0`, `bundle-1`, …) rather than derived from the path,
 * for the reason `buildSharedDocSecretProjection` gives: a Secret key may only contain
 * `[-._a-zA-Z0-9]`, and the obvious transform (`/` → `__`) is not injective, so two
 * lawful paths can collide on one key and silently deliver one file's bytes under the
 * other's name. `items[].path` carries the real layout anyway.
 *
 * Throws `PromptBundleOverBudgetError` / `PromptBundleTooManyFilesError` rather than
 * returning a partial projection. Returns null when there is nothing to carry, so
 * callers stage no Secret at all.
 */
export async function buildPromptBundleSecretProjection(input: {
  companyId: string;
  runLabel: string;
  skills: PaperclipSkillEntry[];
  instructionsContents: string | null;
  /** Where THIS process reaches the data volume (`SELF_POD_DATA_MOUNT_PATH`). */
  serverDataMountPath?: string;
  maxBytes?: number;
  maxFilesPerSkill?: number;
}): Promise<PromptBundleSecretProjection | null> {
  const maxBytes = input.maxBytes ?? PROMPT_BUNDLE_SECRET_MAX_BYTES;
  const maxFiles = input.maxFilesPerSkill ?? PROMPT_BUNDLE_MAX_FILES;
  const files: PromptBundleFile[] = [];

  if (input.instructionsContents) {
    files.push({
      bundlePath: PROMPT_BUNDLE_INSTRUCTIONS_PATH,
      contents: input.instructionsContents,
      byteLength: Buffer.byteLength(input.instructionsContents, "utf8"),
      skillKey: null,
    });
  }

  const bytesBySkillKey: Record<string, number> = {};
  // Sorted by runtimeName so the projection is stable across runs with the same skill
  // set, for the same prompt-cache reason the per-tree sort above has.
  const projected = input.skills
    .filter((entry) => skillSourceNeedsProjection(entry, input.serverDataMountPath))
    .slice()
    .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));

  for (const entry of projected) {
    const skillFiles = await collectSkillFiles({ entry, maxFiles });
    let entryBytes = 0;
    for (const file of skillFiles) {
      files.push({
        bundlePath: path.posix.join(PROMPT_BUNDLE_SKILLS_DIR, entry.runtimeName, file.relPath),
        contents: file.contents,
        byteLength: file.byteLength,
        skillKey: entry.key,
      });
      entryBytes += file.byteLength;
    }
    bytesBySkillKey[entry.key] = entryBytes;
  }

  if (files.length === 0) return null;

  const data: Record<string, string> = {};
  const items: Array<{ key: string; path: string }> = [];
  let totalValueBytes = 0;
  for (const file of files) {
    const key = `bundle-${items.length}`;
    data[key] = file.contents;
    items.push({ key, path: file.bundlePath });
    totalValueBytes += file.byteLength;
  }

  if (totalValueBytes > maxBytes) {
    throw new PromptBundleOverBudgetError({
      companyId: input.companyId,
      runLabel: input.runLabel,
      totalValueBytes,
      maxBytes,
      fileCount: files.length,
      bytesBySkillKey,
    });
  }

  return {
    data,
    items,
    totalValueBytes,
    fileCount: files.length,
    bytesBySkillKey,
    escalationThresholdCrossed: totalValueBytes >= maxBytes * PROMPT_BUNDLE_ESCALATION_RATIO,
  };
}
