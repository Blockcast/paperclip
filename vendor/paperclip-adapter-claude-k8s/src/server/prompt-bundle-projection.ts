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
 * already has.
 *
 * ⚠️ IDENTIFYING ONE IS NOT A PATH-PREFIX TEST. `prompt-cache.ts:509-519` states the
 * reason: a catalog-backed source is a `PAPERCLIP_HOME` path, while the server mount is
 * `SELF_POD_DATA_MOUNT_PATH` — a hardcoded `/paperclip` against an env var defaulting to
 * `~/.paperclip`. Two variables that COINCIDE TODAY, not one. Where they diverge, a
 * prefix test alone calls every catalog skill an image path and drops it from the
 * projection with no signal: the exact silent dangling-skill outcome this channel exists
 * to prevent, and an under-count of `totalValueBytes` that biases §4.2's escalation
 * measurement low. So the discriminator is the one `prompt-cache.ts` actually keys on —
 * `catalogBackedSkillKeys` — OR'd with the mount prefix, and only the remainder is an
 * image path. See `skillSourceNeedsProjection`.
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
 *
 * One caveat on treating the cap as the practical ceiling: this Secret is one object
 * among the Job's, and etcd's own request limit (~1.5 MiB by default) applies to the
 * whole serialized object — keys, base64 expansion of `data`, metadata and all. So the
 * usable headroom sits slightly under the validation cap rather than at it, which is a
 * further reason the §4.2 escalation trigger is set at half rather than near the limit.
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
  /** The file's bytes, verbatim. Never a decoded string — see `collectSkillFiles`. */
  contents: Buffer;
  /**
   * `contents.length`, i.e. RAW bytes. This is what `ValidateSecret` sums, for a value
   * arriving through `stringData` (folded in as `[]byte(v)`) and through `data`
   * (base64-decoded) alike, so one quantity budgets both channels.
   */
  byteLength: number;
  /**
   * Strict UTF-8 decode of `contents`, or null when the bytes are not valid UTF-8 and
   * must travel base64. Computed once, at read time, and carried rather than recomputed.
   */
  utf8: string | null;
  /** Skill key this file came from, or null for the instructions file. */
  skillKey: string | null;
};

export type PromptBundleSecretProjection = {
  /**
   * `stringData` for the Secret: the projected files whose bytes are valid UTF-8.
   *
   * Split from `base64Data` because `stringData` cannot carry arbitrary bytes. A skill
   * tree may hold a PNG, a font or a stray Latin-1 file, and routing one through a
   * string would substitute U+FFFD for every invalid byte — delivering corrupted bytes
   * and, worse for a measurement-only change, inflating the measured length to 3 bytes
   * per invalid byte. Neither the budget guard nor any log would notice.
   */
  stringData: Record<string, string>;
  /**
   * `data` for the Secret: base64 of the projected files whose bytes are NOT valid
   * UTF-8. Kubernetes base64-decodes these before `ValidateSecret` sums them, so they
   * count the same decoded length against `MaxSecretSize` as a `stringData` entry does
   * and the budget arithmetic above is unchanged.
   *
   * ⚠️ WHOEVER WIRES THIS UP MUST CARRY BOTH MAPS. `createOrAdoptRunSecret` takes a
   * single `data` record and writes it to `stringData` — correct for the shared-doc
   * Secret it was built for, which carries only text. Reaching for that signature by
   * analogy here would drop every entry in this map, i.e. exactly the silent missing
   * file this channel exists to prevent, and `items[]` would then project a key the
   * Secret does not have. The projection is deliberately two maps so that omission is
   * a type error rather than a quiet one.
   */
  base64Data: Record<string, string>;
  /** `items` for the Secret volume, projecting each key back to its bundle-relative path. */
  items: Array<{ key: string; path: string }>;
  /**
   * Sum of raw value bytes — exactly `ValidateSecret`'s `totalSize`, across both
   * channels. This is the number the budget refuses on and the number the escalation
   * trigger reads.
   */
  totalValueBytes: number;
  /** Number of projected files. */
  fileCount: number;
  /** How many of `fileCount` had to travel base64 because they are not valid UTF-8. */
  binaryFileCount: number;
  /**
   * Symlinks stepped over by the walk, summed across every projected tree.
   *
   * Reported rather than merely skipped: a skipped link is a file the pod will not get,
   * and leaving it out of both the log and `bytesBySkillKey` would under-count the
   * measurement in silence — which is the same class of fault as a dropped skill, just
   * smaller. The PR's claim that stepping over links is "visible rather than silent" is
   * only true because this is counted.
   */
  skippedSymlinkCount: number;
  /** Non-regular, non-directory, non-symlink entries stepped over (fifo, socket, …). */
  skippedNonRegularCount: number;
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
  /**
   * Narrowed to a literal so `name` is a usable discriminant in the TYPE system as
   * well as at runtime. Callers must key on it rather than on `instanceof`: a
   * prototype check compares class identity, which is per module instance, and this
   * module is imported down more than one path in a partially-mocked graph — where
   * the same class is two objects and `instanceof` silently reports false.
   * `declare` emits nothing; the constructor below still does the assigning.
   */
  declare readonly name: "PromptBundleOverBudgetError";
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
  /** A literal discriminant, for the reason given on `PromptBundleOverBudgetError`. */
  declare readonly name: "PromptBundleTooManyFilesError";
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
 * Only ONE class may be left alone: an adapter-bundled IMAGE path, present at the same
 * absolute path in the pod because both come from the same image layer. Projecting one
 * would copy bytes the pod already has.
 *
 * Identifying that class is the whole difficulty, and a path prefix on the server mount
 * does not do it. `prompt-cache.ts:509-519` records why: a catalog-backed source is a
 * `PAPERCLIP_HOME` path and the server mount is `SELF_POD_DATA_MOUNT_PATH`, two
 * variables that coincide in today's deployment but are not one. Under a
 * `PAPERCLIP_HOME` outside `/paperclip` the prefix test calls every catalog skill an
 * image path and silently drops it. So this mirrors the test `prompt-cache.ts` actually
 * applies — the catalog discriminator — and takes the union with the mount prefix:
 *
 *   * catalog-backed  => must travel (a `PAPERCLIP_HOME` path, wherever that resolves);
 *   * under the mount => must travel (it lives on the volume the pod stops sharing);
 *   * neither         => image path, left alone.
 *
 * BOTH unknowns fail toward projecting, deliberately and in the same direction as
 * `prompt-cache.ts`'s own `?? true`: with `serverDataMountPath` absent nothing is
 * derivable, and with `catalogBackedSkillKeys` absent no caller has distinguished the
 * image set. An unnecessary copy costs budget; a missing one costs the agent its skill.
 */
export function skillSourceNeedsProjection(
  entry: PaperclipSkillEntry,
  serverDataMountPath?: string,
  catalogBackedSkillKeys?: ReadonlySet<string>,
): boolean {
  if (!serverDataMountPath) return true;
  if (catalogBackedSkillKeys?.has(entry.key) ?? true) return true;
  return entry.source.startsWith(mountPrefix(serverDataMountPath));
}

/**
 * Strict UTF-8 decode, or null when the bytes are not valid UTF-8.
 *
 * `fatal: true` is what makes this a *test* rather than a lossy conversion:
 * `buf.toString("utf8")` and a non-fatal decoder both substitute U+FFFD for every
 * invalid byte and report success. `ignoreBOM: true` is equally load-bearing in the
 * other direction — the default STRIPS a leading U+FEFF, which would silently drop
 * three bytes from a BOM-prefixed file and break the round-trip this relies on. With
 * both set, a non-null result re-encodes to exactly the input bytes.
 */
const UTF8_STRICT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeUtf8Strict(buf: Buffer): string | null {
  try {
    return UTF8_STRICT_DECODER.decode(buf);
  } catch {
    return null;
  }
}

/** One file the walk collected: its bytes verbatim, plus how they must be carried. */
type CollectedSkillFile = {
  relPath: string;
  contents: Buffer;
  byteLength: number;
  /** Strict decode, or null when the bytes are not valid UTF-8 and must go base64. */
  utf8: string | null;
};

type CollectedSkillTree = {
  files: CollectedSkillFile[];
  skippedSymlinkCount: number;
  skippedNonRegularCount: number;
};

/** Depth-first walk of a skill source directory, yielding regular files only. */
async function collectSkillFiles(input: {
  entry: PaperclipSkillEntry;
  maxFiles: number;
}): Promise<CollectedSkillTree> {
  const { entry, maxFiles } = input;
  const out: CollectedSkillFile[] = [];
  let skippedSymlinkCount = 0;
  let skippedNonRegularCount = 0;
  // Iterative rather than recursive: a skill tree is operator-supplied and a symlink
  // cycle would otherwise be a stack overflow at Job-creation time. `withFileTypes`
  // reports the link itself, and `isFile()` is false for one, so links are stepped
  // over rather than followed — a skill that relies on an internal symlink projects
  // without it, where following one could escape the tree. Counted, not merely
  // skipped: the caller surfaces the total, so "projects without it" is an observable
  // fact rather than a claim.
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
      if (!dirent.isFile()) {
        if (dirent.isSymbolicLink()) skippedSymlinkCount += 1;
        else skippedNonRegularCount += 1;
        continue;
      }
      if (out.length >= maxFiles) throw new PromptBundleTooManyFilesError(entry.key, maxFiles);
      // Read as bytes, never as a string. A skill tree may legitimately hold a PNG, a
      // font, or a file in some other encoding; decoding one as UTF-8 would corrupt
      // the bytes delivered AND inflate the measured length (3 bytes per substituted
      // U+FFFD), which is wrong for exactly the trees this measurement most needs to
      // size correctly. `byteLength` is therefore the raw buffer length, which is the
      // quantity `ValidateSecret` sums whichever channel the value travels on.
      const contents = await fs.readFile(path.join(entry.source, relPath));
      out.push({ relPath, contents, byteLength: contents.length, utf8: decodeUtf8Strict(contents) });
    }
  }
  // Sorted so key assignment is deterministic for a given tree rather than dependent
  // on readdir order, which is filesystem-defined. The Job command feeds the prompt
  // cache key, so an unstable order would miss the cache on every run.
  out.sort((left, right) => left.relPath.localeCompare(right.relPath));
  return { files: out, skippedSymlinkCount, skippedNonRegularCount };
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
  /**
   * Skill keys the caller resolved from the company-skill catalog, i.e. the same
   * discriminator `prepareClaudePromptBundle` takes. Omitting it projects every entry;
   * see `skillSourceNeedsProjection` for why that is the direction to fail in.
   */
  catalogBackedSkillKeys?: ReadonlySet<string>;
  maxBytes?: number;
  maxFilesPerSkill?: number;
}): Promise<PromptBundleSecretProjection | null> {
  const maxBytes = input.maxBytes ?? PROMPT_BUNDLE_SECRET_MAX_BYTES;
  const maxFiles = input.maxFilesPerSkill ?? PROMPT_BUNDLE_MAX_FILES;
  const files: PromptBundleFile[] = [];

  if (input.instructionsContents) {
    // Already a string in the caller's hands, so this one has no encoding question:
    // `Buffer.from(…, "utf8")` is the exact wire form, and it rejoins the byte-shaped
    // path every other file takes.
    const instructions = Buffer.from(input.instructionsContents, "utf8");
    files.push({
      bundlePath: PROMPT_BUNDLE_INSTRUCTIONS_PATH,
      contents: instructions,
      byteLength: instructions.length,
      // Decoded from the buffer rather than reusing the input string, so the value
      // carried is provably what the bytes counted above say — the same identity every
      // other file gets, with no special case to go stale.
      utf8: decodeUtf8Strict(instructions),
      skillKey: null,
    });
  }

  const bytesBySkillKey: Record<string, number> = {};
  let skippedSymlinkCount = 0;
  let skippedNonRegularCount = 0;
  // Sorted by runtimeName so the projection is stable across runs with the same skill
  // set, for the same prompt-cache reason the per-tree sort above has.
  const projected = input.skills
    .filter((entry) => skillSourceNeedsProjection(entry, input.serverDataMountPath, input.catalogBackedSkillKeys))
    .slice()
    .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));

  for (const entry of projected) {
    const tree = await collectSkillFiles({ entry, maxFiles });
    skippedSymlinkCount += tree.skippedSymlinkCount;
    skippedNonRegularCount += tree.skippedNonRegularCount;
    let entryBytes = 0;
    for (const file of tree.files) {
      files.push({
        bundlePath: path.posix.join(PROMPT_BUNDLE_SKILLS_DIR, entry.runtimeName, file.relPath),
        contents: file.contents,
        byteLength: file.byteLength,
        utf8: file.utf8,
        skillKey: entry.key,
      });
      entryBytes += file.byteLength;
    }
    bytesBySkillKey[entry.key] = entryBytes;
  }

  if (files.length === 0) return null;

  const stringData: Record<string, string> = {};
  const base64Data: Record<string, string> = {};
  const items: Array<{ key: string; path: string }> = [];
  let totalValueBytes = 0;
  let binaryFileCount = 0;
  for (const file of files) {
    const key = `bundle-${items.length}`;
    // Valid UTF-8 travels as `stringData` — readable in a `kubectl get -o yaml` and
    // byte-identical, because the strict decoder above ruled out any substitution.
    // Anything else travels base64 through `data`, which is the only Secret channel
    // that can carry arbitrary bytes. Each key appears in exactly one map, and
    // Kubernetes merges both into `Data` before validating, so `items[].path` projects
    // them identically and the budget below sees one total.
    if (file.utf8 === null) {
      base64Data[key] = file.contents.toString("base64");
      binaryFileCount += 1;
    } else {
      stringData[key] = file.utf8;
    }
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
    stringData,
    base64Data,
    items,
    totalValueBytes,
    fileCount: files.length,
    binaryFileCount,
    skippedSymlinkCount,
    skippedNonRegularCount,
    bytesBySkillKey,
    escalationThresholdCrossed: totalValueBytes >= maxBytes * PROMPT_BUNDLE_ESCALATION_RATIO,
  };
}
