import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  asBoolean,
  isPlainRecord,
  asString,
  asStringArray,
  parseFrontmatterMarkdown,
} from "./frontmatter.js";
import type {
  CatalogManifest,
  CatalogSkill,
  CatalogSkillFile,
  CatalogSkillFileKind,
  CatalogSkillKind,
  CatalogSkillSource,
  CatalogTrustLevel,
} from "./types.js";

const CATALOG_PACKAGE_NAME = "@paperclipai/skills-catalog";
const CATALOG_SCHEMA_VERSION = 1;
const SKILL_ENTRYPOINT = "SKILL.md";
const CATALOG_REFERENCE_FILE = "catalog-ref.json";
const MAX_CATALOG_FILE_BYTES = 1024 * 1024;
const GITHUB_FETCH_TIMEOUT_MS = 15_000;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATALOG_KINDS = new Set<CatalogSkillKind>(["bundled", "optional"]);
const SUPPORTED_GITHUB_HOSTNAMES = new Set(["github.com", "www.github.com"]);
type ReferencedSkillResolution = "fetch" | "reuse-existing";

interface BaseSkillCandidate {
  kind: CatalogSkillKind;
  category: string;
  slug: string;
  absolutePath: string;
}

type SkillCandidate =
  | (BaseSkillCandidate & { source: "local" })
  | (BaseSkillCandidate & { source: "reference"; descriptorPath: string });

interface ReferencedGitHubSourceDescriptor {
  type: "github";
  hostname?: string;
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  path: string;
}

/**
 * Values the descriptor pins for the remote content it points at.
 *
 * `generated/catalog.json` cannot authenticate itself: the offline reuse path
 * rebuilds a referenced entry from the manifest, so recomputing `contentHash`
 * and `trustLevel` from the manifest's own file records only catches
 * *inconsistent* edits. A coordinated edit — change a `sha256` and refresh the
 * fields derived from it — stays self-consistent. These pins move the trust
 * anchor into `catalog-ref.json`, a small hand-written file that shows up in a
 * review diff and is itself covered by `descriptorSha256`.
 *
 * This does not make an offline check able to authenticate remote bytes: an
 * edit to both the descriptor and the manifest is still self-consistent. It
 * makes that edit visible in reviewed source instead of only in generated
 * output.
 */
interface PinnedReferencedSkillContent {
  name: string;
  description: string;
  inventorySha256: string;
}

interface ReferencedSkillDescriptor {
  source: ReferencedGitHubSourceDescriptor;
  descriptorSha256: string;
  pinned?: PinnedReferencedSkillContent;
  files?: string[];
  defaultInstall?: boolean;
  recommendedForRoles?: string[];
  requires?: string[];
  tags?: string[];
}

interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree" | string;
  size?: number;
}

interface BuildCatalogManifestOptions {
  packageDir: string;
  generatedAt?: string;
  referencedSkillResolution?: ReferencedSkillResolution;
  fetchTimeoutMs?: number;
}

interface BuildExpectedCatalogManifestOptions {
  referencedSkillResolution?: ReferencedSkillResolution;
  fetchTimeoutMs?: number;
}

interface BuildCatalogManifestResult {
  manifest: CatalogManifest;
  errors: string[];
}

export function formatCatalogManifest(manifest: CatalogManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function buildExpectedCatalogManifest(
  packageDir: string,
  options: BuildExpectedCatalogManifestOptions = {},
): Promise<BuildCatalogManifestResult> {
  const existing = await readExistingManifest(packageDir);
  const firstPass = await buildCatalogManifest({
    packageDir,
    generatedAt: existing?.generatedAt ?? new Date().toISOString(),
    referencedSkillResolution: options.referencedSkillResolution,
    fetchTimeoutMs: options.fetchTimeoutMs,
  });

  if (existing && sameManifestExceptGeneratedAt(existing, firstPass.manifest)) {
    return firstPass;
  }

  return buildCatalogManifest({
    packageDir,
    generatedAt: new Date().toISOString(),
    referencedSkillResolution: options.referencedSkillResolution,
    fetchTimeoutMs: options.fetchTimeoutMs,
  });
}

export async function buildCatalogManifest(
  options: BuildCatalogManifestOptions,
): Promise<BuildCatalogManifestResult> {
  const packageDir = path.resolve(options.packageDir);
  const packageJson = await readPackageJson(packageDir);
  const existingManifest = await readExistingManifest(packageDir);
  const existingSkillsById = new Map(existingManifest?.skills.map((skill) => [skill.id, skill]) ?? []);
  const errors: string[] = [];
  const candidates = await discoverSkillCandidates(packageDir, errors);
  const skills: CatalogSkill[] = [];
  const fetchTimeoutMs = options.fetchTimeoutMs ?? GITHUB_FETCH_TIMEOUT_MS;

  collectCandidateUniquenessErrors(candidates, errors);

  for (const candidate of candidates) {
    const skill = await buildCatalogSkill(
      packageDir,
      candidate,
      errors,
      existingSkillsById.get(skillIdForCandidate(candidate)) ?? null,
      options.referencedSkillResolution ?? "fetch",
      fetchTimeoutMs,
    );
    if (skill) skills.push(skill);
  }

  skills.sort((a, b) => a.id.localeCompare(b.id));
  collectUniquenessErrors(skills, errors);

  return {
    manifest: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      packageName: CATALOG_PACKAGE_NAME,
      packageVersion: packageJson.version,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      skills,
    },
    errors,
  };
}

export async function validateCatalog(
  packageDir: string,
  options: BuildExpectedCatalogManifestOptions = {},
): Promise<BuildCatalogManifestResult> {
  const expected = await buildExpectedCatalogManifest(packageDir, options);
  const generatedPath = path.join(packageDir, "generated", "catalog.json");
  const errors = [...expected.errors];

  let generatedText: string | null = null;
  try {
    generatedText = await fs.readFile(generatedPath, "utf8");
    JSON.parse(generatedText);
  } catch (error) {
    errors.push(`generated/catalog.json is missing or invalid: ${errorMessage(error)}`);
  }

  if (generatedText !== null) {
    const expectedText = formatCatalogManifest(expected.manifest);
    if (generatedText !== expectedText) {
      errors.push("generated/catalog.json is stale. Run pnpm --filter @paperclipai/skills-catalog build:manifest.");
    }
  }

  return {
    manifest: expected.manifest,
    errors,
  };
}

export async function writeCatalogManifest(packageDir: string) {
  const result = await buildExpectedCatalogManifest(packageDir);
  if (result.errors.length > 0) return result;

  const generatedDir = path.join(packageDir, "generated");
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.writeFile(path.join(generatedDir, "catalog.json"), formatCatalogManifest(result.manifest), "utf8");
  return result;
}

async function readPackageJson(packageDir: string) {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { version?: unknown };
  const version = asString(packageJson.version);
  if (!version) throw new Error(`${packageJsonPath} must declare a package version.`);
  return { version };
}

async function readExistingManifest(packageDir: string): Promise<CatalogManifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(packageDir, "generated", "catalog.json"), "utf8")) as CatalogManifest;
  } catch {
    return null;
  }
}

async function discoverSkillCandidates(packageDir: string, errors: string[]) {
  const catalogDir = path.join(packageDir, "catalog");
  const candidates: SkillCandidate[] = [];

  if (!existsSync(catalogDir)) {
    errors.push("catalog directory is missing.");
    return candidates;
  }

  await collectMisplacedSkillFiles(catalogDir, errors);

  for (const kind of ["bundled", "optional"] as const) {
    const kindDir = path.join(catalogDir, kind);
    if (!existsSync(kindDir)) continue;

    for (const categoryEntry of await sortedDirEntries(kindDir)) {
      if (!categoryEntry.isDirectory()) continue;
      const category = categoryEntry.name;
      const categoryDir = path.join(kindDir, category);

      for (const slugEntry of await sortedDirEntries(categoryDir)) {
        if (!slugEntry.isDirectory()) continue;
        const slug = slugEntry.name;
        const skillDir = path.join(categoryDir, slug);
        const hasLocalSkill = existsSync(path.join(skillDir, SKILL_ENTRYPOINT));
        const descriptorPath = path.join(skillDir, CATALOG_REFERENCE_FILE);
        const hasReference = existsSync(descriptorPath);

        if (hasLocalSkill && hasReference) {
          errors.push(`${relativePackagePath(packageDir, skillDir)} must contain either SKILL.md or ${CATALOG_REFERENCE_FILE}, not both.`);
          continue;
        }
        if (!hasLocalSkill && !hasReference) {
          errors.push(`${relativePackagePath(packageDir, skillDir)} is missing SKILL.md or ${CATALOG_REFERENCE_FILE}.`);
          continue;
        }
        candidates.push(
          hasReference
            ? { kind, category, slug, absolutePath: skillDir, source: "reference", descriptorPath }
            : { kind, category, slug, absolutePath: skillDir, source: "local" },
        );
      }
    }
  }

  return candidates;
}

async function collectMisplacedSkillFiles(catalogDir: string, errors: string[]) {
  async function visit(dir: string) {
    for (const entry of await sortedDirEntries(dir)) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.name !== SKILL_ENTRYPOINT && entry.name !== CATALOG_REFERENCE_FILE) continue;

      const relativePath = toPosixPath(path.relative(catalogDir, absolutePath));
      const parts = relativePath.split("/");
      const kind = parts[0];
      if (parts.length !== 4 || !CATALOG_KINDS.has(kind as CatalogSkillKind)) {
        errors.push(`catalog/${relativePath} is not under catalog/<bundled|optional>/<category>/<slug>/{SKILL.md,${CATALOG_REFERENCE_FILE}}.`);
      }
    }
  }

  await visit(catalogDir);
}

async function buildCatalogSkill(
  packageDir: string,
  candidate: SkillCandidate,
  errors: string[],
  existingSkill: CatalogSkill | null,
  referencedSkillResolution: ReferencedSkillResolution,
  fetchTimeoutMs: number,
): Promise<CatalogSkill | null> {
  if (candidate.source === "reference") {
    return buildReferencedCatalogSkill(packageDir, candidate, errors, existingSkill, referencedSkillResolution, fetchTimeoutMs);
  }

  const prefix = relativePackagePath(packageDir, candidate.absolutePath);
  validateSlug("category", candidate.category, prefix, errors);
  validateSlug("slug", candidate.slug, prefix, errors);

  const id = `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`;
  const key = `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`;
  const skillMarkdownPath = path.join(candidate.absolutePath, SKILL_ENTRYPOINT);
  const parsed = parseFrontmatterMarkdown(await fs.readFile(skillMarkdownPath, "utf8"));

  if (!parsed.hasFrontmatter) {
    errors.push(`${prefix}/SKILL.md must start with YAML frontmatter.`);
  }

  const name = asString(parsed.frontmatter.name);
  if (!name) errors.push(`${prefix}/SKILL.md frontmatter must include name.`);

  const description = asString(parsed.frontmatter.description);
  if (!description) errors.push(`${prefix}/SKILL.md frontmatter must include description.`);

  const explicitKey = asString(parsed.frontmatter.key);
  if (explicitKey && explicitKey !== key) {
    errors.push(`${prefix}/SKILL.md key must be ${key}.`);
  }

  const explicitSlug = asString(parsed.frontmatter.slug);
  if (explicitSlug && explicitSlug !== candidate.slug) {
    errors.push(`${prefix}/SKILL.md slug must be ${candidate.slug}.`);
  }

  const defaultInstall = asBoolean(parsed.frontmatter.defaultInstall) ?? false;
  const recommendedForRoles = readStringArrayField(parsed.frontmatter.recommendedForRoles, "recommendedForRoles", prefix, errors);
  const requires = readStringArrayField(parsed.frontmatter.requires, "requires", prefix, errors);
  const tags = readStringArrayField(parsed.frontmatter.tags, "tags", prefix, errors);
  const files = await collectSkillFiles(packageDir, candidate.absolutePath, prefix, errors);

  if (!name || !description) return null;

  return {
    id,
    key,
    kind: candidate.kind,
    category: candidate.category,
    slug: candidate.slug,
    name,
    description,
    path: toPosixPath(path.relative(packageDir, candidate.absolutePath)),
    entrypoint: SKILL_ENTRYPOINT,
    trustLevel: deriveTrustLevel(files),
    compatibility: "compatible",
    defaultInstall,
    recommendedForRoles,
    requires,
    tags,
    files,
    contentHash: buildContentHash(files),
  };
}

function skillIdForCandidate(candidate: BaseSkillCandidate) {
  return `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`;
}

async function buildReferencedCatalogSkill(
  packageDir: string,
  candidate: Extract<SkillCandidate, { source: "reference" }>,
  errors: string[],
  existingSkill: CatalogSkill | null,
  referencedSkillResolution: ReferencedSkillResolution,
  fetchTimeoutMs: number,
): Promise<CatalogSkill | null> {
  const errorStart = errors.length;
  const prefix = relativePackagePath(packageDir, candidate.absolutePath);
  validateSlug("category", candidate.category, prefix, errors);
  validateSlug("slug", candidate.slug, prefix, errors);

  const descriptor = await readReferencedSkillDescriptor(candidate.descriptorPath, prefix, errors);
  if (!descriptor) return null;

  const id = `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`;
  const key = `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`;
  const source = buildCatalogSkillSource(descriptor, errors, `${prefix}/${CATALOG_REFERENCE_FILE}`);
  if (!source) return null;
  const reusableErrors: string[] = [];
  const reusableSkill = canReuseExistingReferencedSkill(
    existingSkill,
    candidate,
    source,
    toPosixPath(path.relative(packageDir, candidate.absolutePath)),
  )
    ? rebuildReusableReferencedSkill(existingSkill!, candidate, descriptor, source, packageDir, reusableErrors)
    : null;
  const canReuseSkill = reusableSkill !== null && reusableErrors.length === 0;
  if (referencedSkillResolution === "reuse-existing") {
    if (canReuseSkill) return reusableSkill;
    errors.push(...reusableErrors);
    if (errors.length === errorStart) {
      errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} changed or is missing from generated/catalog.json. Run pnpm --filter @paperclipai/skills-catalog build:manifest.`);
    }
    return null;
  }
  const fetchCache = new Map<string, Buffer | null>();

  const files = await collectReferencedSkillFiles(source, descriptor.files ?? [SKILL_ENTRYPOINT], prefix, errors, fetchCache, fetchTimeoutMs);
  const skillMarkdown = await readReferencedFileText(source, SKILL_ENTRYPOINT, prefix, errors, fetchCache, fetchTimeoutMs);
  if (!skillMarkdown) {
    const nextErrors = errors.slice(errorStart);
    if (canReuseSkill && canFallbackToExistingReferencedSkill(nextErrors)) {
      errors.splice(errorStart, nextErrors.length);
      return reusableSkill;
    }
    return null;
  }

  const parsed = parseFrontmatterMarkdown(skillMarkdown);
  if (!parsed.hasFrontmatter) {
    errors.push(`${source.url}/${SKILL_ENTRYPOINT} must start with YAML frontmatter.`);
  }

  const name = asString(parsed.frontmatter.name);
  if (!name) errors.push(`${source.url}/${SKILL_ENTRYPOINT} frontmatter must include name.`);

  const description = asString(parsed.frontmatter.description);
  if (!description) errors.push(`${source.url}/${SKILL_ENTRYPOINT} frontmatter must include description.`);

  const explicitKey = asString(parsed.frontmatter.key);
  if (explicitKey && explicitKey !== key) {
    errors.push(`${source.url}/${SKILL_ENTRYPOINT} key must be ${key}.`);
  }

  const explicitSlug = asString(parsed.frontmatter.slug);
  if (explicitSlug && explicitSlug !== candidate.slug) {
    errors.push(`${source.url}/${SKILL_ENTRYPOINT} slug must be ${candidate.slug}.`);
  }

  const defaultInstall = asBoolean(descriptor.defaultInstall) ?? false;
  const recommendedForRoles = readStringArrayField(descriptor.recommendedForRoles, "recommendedForRoles", prefix, errors);
  const requires = readStringArrayField(descriptor.requires, "requires", prefix, errors);
  const tags = readStringArrayField(descriptor.tags, "tags", prefix, errors);

  const hasSkillEntrypoint = files.some((file) => file.path === SKILL_ENTRYPOINT && file.kind === "skill");
  if (!hasSkillEntrypoint) {
    errors.push(`${prefix} referenced inventory does not contain SKILL.md.`);
    const nextErrors = errors.slice(errorStart);
    if (canReuseSkill && canFallbackToExistingReferencedSkill(nextErrors)) {
      errors.splice(errorStart, nextErrors.length);
      return reusableSkill;
    }
  }
  if (!name || !description) {
    const nextErrors = errors.slice(errorStart);
    if (canReuseSkill && canFallbackToExistingReferencedSkill(nextErrors)) {
      errors.splice(errorStart, nextErrors.length);
      return reusableSkill;
    }
    return null;
  }

  // A partial fetch or an unusable tree response yields a partial inventory, so
  // a pin mismatch there would be a misleading second error on top of the
  // failure that caused it.
  if (!errors.slice(errorStart).some((error) => isIncompleteInventoryError(error))) {
    verifyPinnedReferencedContent(descriptor, prefix, name, description, files, errors);
  }

  return {
    id,
    key,
    kind: candidate.kind,
    category: candidate.category,
    slug: candidate.slug,
    name,
    description,
    path: toPosixPath(path.relative(packageDir, candidate.absolutePath)),
    entrypoint: SKILL_ENTRYPOINT,
    trustLevel: deriveTrustLevel(files),
    compatibility: "compatible",
    defaultInstall,
    recommendedForRoles,
    requires,
    tags,
    files,
    contentHash: buildContentHash(files),
    source,
  };
}

function canReuseExistingReferencedSkill(
  existingSkill: CatalogSkill | null,
  candidate: Extract<SkillCandidate, { source: "reference" }>,
  source: CatalogSkillSource,
  expectedPath: string,
) {
  if (!existingSkill || existingSkill.source?.type !== "github") return false;
  const existingSource = existingSkill.source;
  return (
    existingSkill.id === skillIdForCandidate(candidate) &&
    existingSkill.path === expectedPath &&
    existingSource.hostname === source.hostname &&
    existingSource.owner === source.owner &&
    existingSource.repo === source.repo &&
    existingSource.ref === source.ref &&
    existingSource.commit === source.commit &&
    existingSource.path === source.path &&
    existingSource.descriptorSha256 === source.descriptorSha256
  );
}

function rebuildReusableReferencedSkill(
  existingSkill: CatalogSkill,
  candidate: Extract<SkillCandidate, { source: "reference" }>,
  descriptor: ReferencedSkillDescriptor,
  source: CatalogSkillSource,
  packageDir: string,
  errors: string[],
): CatalogSkill | null {
  const prefix = relativePackagePath(packageDir, candidate.absolutePath);
  const files = validateReusableReferencedFiles(existingSkill, descriptor.files ?? [SKILL_ENTRYPOINT], prefix, errors);
  const name = asString(existingSkill.name);
  const description = asString(existingSkill.description);
  if (!name) errors.push(`${prefix} reused generated manifest entry must include a name.`);
  if (!description) errors.push(`${prefix} reused generated manifest entry must include a description.`);
  if (!name || !description) return null;

  const trustLevel = deriveTrustLevel(files);
  const contentHash = buildContentHash(files);
  if (existingSkill.trustLevel !== trustLevel) {
    errors.push(`${prefix} reused generated manifest entry has stale trustLevel. Run pnpm --filter @paperclipai/skills-catalog build:manifest.`);
  }
  if (existingSkill.contentHash !== contentHash) {
    errors.push(`${prefix} reused generated manifest entry has stale contentHash. Run pnpm --filter @paperclipai/skills-catalog build:manifest.`);
  }
  validateReusedEntryAgainstPins(descriptor, prefix, name, description, files, errors);

  return {
    id: skillIdForCandidate(candidate),
    key: `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`,
    kind: candidate.kind,
    category: candidate.category,
    slug: candidate.slug,
    name,
    description,
    path: toPosixPath(path.relative(packageDir, candidate.absolutePath)),
    entrypoint: SKILL_ENTRYPOINT,
    trustLevel,
    compatibility: "compatible",
    defaultInstall: descriptor.defaultInstall ?? false,
    recommendedForRoles: descriptor.recommendedForRoles ?? [],
    requires: descriptor.requires ?? [],
    tags: descriptor.tags ?? [],
    files,
    contentHash,
    source,
  };
}

/**
 * Reuse-path check: the metadata and inventory taken from the generated
 * manifest must match what `catalog-ref.json` pins. Without this the offline
 * rebuild is circular — it validates the manifest against itself.
 */
function validateReusedEntryAgainstPins(
  descriptor: ReferencedSkillDescriptor,
  prefix: string,
  name: string,
  description: string,
  files: CatalogSkillFile[],
  errors: string[],
) {
  const pinned = descriptor.pinned;
  if (!pinned) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} does not pin name, description, and inventorySha256, so the reused generated manifest entry cannot be verified offline. Run pnpm --filter @paperclipai/skills-catalog build:manifest, which reports the values to add.`);
    return;
  }
  if (pinned.name !== name) {
    errors.push(`${prefix} reused generated manifest entry name ${JSON.stringify(name)} does not match ${CATALOG_REFERENCE_FILE} pinned.name ${JSON.stringify(pinned.name)}.`);
  }
  if (pinned.description !== description) {
    errors.push(`${prefix} reused generated manifest entry description does not match ${CATALOG_REFERENCE_FILE} pinned.description.`);
  }
  const inventorySha256 = buildInventoryDigest(files);
  if (pinned.inventorySha256 !== inventorySha256) {
    errors.push(`${prefix} reused generated manifest entry inventory ${inventorySha256} does not match ${CATALOG_REFERENCE_FILE} pinned.inventorySha256 ${pinned.inventorySha256}. Run pnpm --filter @paperclipai/skills-catalog build:manifest.`);
  }
}

function validateReusableReferencedFiles(
  existingSkill: CatalogSkill,
  includePatterns: string[],
  prefix: string,
  errors: string[],
): CatalogSkillFile[] {
  const normalizedPatterns = includePatterns.flatMap((pattern) => {
    const normalized = normalizeReferencedPath(pattern);
    if (normalized === null) {
      errors.push(`${prefix} referenced include path is invalid: ${pattern}`);
      return [];
    }
    return normalized ? [normalized] : [];
  });
  const seen = new Set<string>();
  const matchedPatterns = new Set<string>();
  const files: CatalogSkillFile[] = [];

  for (const file of Array.isArray(existingSkill.files) ? (existingSkill.files as unknown[]) : []) {
    if (!isPlainRecord(file)) {
      errors.push(`${prefix} reused generated manifest entry contains a malformed file entry.`);
      continue;
    }
    const relativePath = typeof file.path === "string" ? normalizeReferencedPath(file.path) : null;
    if (!relativePath) {
      errors.push(`${prefix} reused generated manifest entry contains an invalid file path.`);
      continue;
    }
    if (seen.has(relativePath)) {
      errors.push(`${prefix}/${relativePath} appears more than once in the reused generated manifest entry.`);
      continue;
    }
    seen.add(relativePath);
    let isIncluded = false;
    for (const pattern of normalizedPatterns) {
      if (!referencedPathMatches(relativePath, pattern)) continue;
      matchedPatterns.add(pattern);
      isIncluded = true;
    }
    if (!isIncluded) {
      errors.push(`${prefix}/${relativePath} is not included by ${CATALOG_REFERENCE_FILE}.`);
    }
    const expectedKind = classifyCatalogFile(relativePath);
    const kind = asString(file.kind);
    const sizeBytes = typeof file.sizeBytes === "number" ? file.sizeBytes : Number.NaN;
    const digest = asString(file.sha256) ?? "";
    if (kind !== expectedKind) {
      errors.push(`${prefix}/${relativePath} has stale kind ${String(kind)}; expected ${expectedKind}.`);
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_CATALOG_FILE_BYTES) {
      errors.push(`${prefix}/${relativePath} has invalid sizeBytes.`);
    }
    if (!/^[0-9a-f]{64}$/i.test(digest)) {
      errors.push(`${prefix}/${relativePath} has invalid sha256.`);
    }
    files.push({
      path: relativePath,
      kind: expectedKind,
      sizeBytes: Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0,
      sha256: /^[0-9a-f]{64}$/i.test(digest) ? digest.toLowerCase() : "0".repeat(64),
    });
  }

  for (const pattern of normalizedPatterns) {
    if (!pattern.endsWith("/**") && !matchedPatterns.has(pattern)) {
      errors.push(`${prefix}/${pattern} is missing from the reused generated manifest entry.`);
    }
  }

  files.sort((a, b) => {
    if (a.path === SKILL_ENTRYPOINT) return -1;
    if (b.path === SKILL_ENTRYPOINT) return 1;
    return a.path.localeCompare(b.path);
  });
  if (!files.some((file) => file.path === SKILL_ENTRYPOINT && file.kind === "skill")) {
    errors.push(`${prefix} reused generated manifest entry does not contain SKILL.md.`);
  }
  return files;
}

function canFallbackToExistingReferencedSkill(errors: string[]) {
  if (errors.length === 0) return false;
  const hasRecoverableFetchError = errors.some((error) => isRecoverableReferencedFetchError(error));
  return (
    hasRecoverableFetchError &&
    errors.every((error) =>
      isReferencedFetchError(error) ||
      error.includes("referenced inventory does not contain SKILL.md."),
    )
  );
}

function isReferencedFetchError(error: string) {
  return error.includes("failed to fetch GitHub tree:") || error.includes("failed to fetch pinned GitHub file:");
}

/**
 * Any error that means the fetched inventory is incomplete — a failed download,
 * or a tree response we could not read in full. Distinct from
 * `isReferencedFetchError`, which gates falling back to the previous manifest
 * entry and must stay limited to transient network failures.
 */
function isIncompleteInventoryError(error: string) {
  return (
    isReferencedFetchError(error) ||
    error.includes("GitHub tree response") ||
    error.includes("GitHub tree entry ")
  );
}

function isRecoverableReferencedFetchError(error: string) {
  if (!isReferencedFetchError(error)) return false;
  const statusMatch = /HTTP (\d+)/.exec(error);
  if (!statusMatch) return true;
  const status = Number(statusMatch[1]);
  return status === 403 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function readReferencedSkillDescriptor(
  descriptorPath: string,
  prefix: string,
  errors: string[],
): Promise<ReferencedSkillDescriptor | null> {
  let raw: unknown;
  let rawText: string;
  try {
    rawText = await fs.readFile(descriptorPath, "utf8");
    raw = JSON.parse(rawText);
  } catch (error) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} is missing or invalid JSON: ${errorMessage(error)}`);
    return null;
  }

  if (!isPlainRecord(raw) || !isPlainRecord(raw.source)) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} must include a source object.`);
    return null;
  }
  const sourceRaw = raw.source;
  if (asString(sourceRaw.type) !== "github") {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} source.type must be "github".`);
    return null;
  }

  const owner = asString(sourceRaw.owner);
  const repo = asString(sourceRaw.repo);
  const ref = asString(sourceRaw.ref);
  const commit = asString(sourceRaw.commit);
  const sourcePath = asString(sourceRaw.path);
  if (!owner || !repo || !ref || !commit || sourcePath === null) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} GitHub source must include owner, repo, ref, commit, and path.`);
    return null;
  }

  const descriptor: ReferencedSkillDescriptor = {
    descriptorSha256: sha256(Buffer.from(rawText)),
    source: {
      type: "github",
      hostname: asString(sourceRaw.hostname) ?? "github.com",
      owner,
      repo,
      ref,
      commit,
      path: sourcePath,
    },
    pinned: readPinnedReferencedContent(raw.pinned, prefix, errors),
    defaultInstall: asBoolean(raw.defaultInstall) ?? false,
    files: asStringArray(raw.files ?? undefined) ?? undefined,
    recommendedForRoles: asStringArray(raw.recommendedForRoles ?? undefined) ?? undefined,
    requires: asStringArray(raw.requires ?? undefined) ?? undefined,
    tags: asStringArray(raw.tags ?? undefined) ?? undefined,
  };

  if (raw.files !== undefined && !descriptor.files) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} files must be an array of strings.`);
  if (raw.recommendedForRoles !== undefined && !descriptor.recommendedForRoles) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} recommendedForRoles must be an array of strings.`);
  if (raw.requires !== undefined && !descriptor.requires) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} requires must be an array of strings.`);
  if (raw.tags !== undefined && !descriptor.tags) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} tags must be an array of strings.`);

  return descriptor;
}

function readPinnedReferencedContent(
  raw: unknown,
  prefix: string,
  errors: string[],
): PinnedReferencedSkillContent | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainRecord(raw)) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} pinned must be an object.`);
    return undefined;
  }
  const name = asString(raw.name);
  const description = asString(raw.description);
  const rawDigest = asString(raw.inventorySha256);
  const inventorySha256 = rawDigest && /^sha256:[0-9a-f]{64}$/i.test(rawDigest) ? rawDigest.toLowerCase() : null;
  if (!name) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} pinned.name must be a non-empty string.`);
  if (!description) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} pinned.description must be a non-empty string.`);
  if (!inventorySha256) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} pinned.inventorySha256 must be "sha256:" followed by 64 hex characters.`);
  }
  if (!name || !description || !inventorySha256) return undefined;
  return { name, description, inventorySha256 };
}

/**
 * Digest over the full file inventory — path, kind, size, and content digest.
 *
 * Deliberately wider than `contentHash` (path + sha256 only) so a tampered
 * `sizeBytes` or `kind` in the generated manifest is caught too. Sorted by code
 * point rather than `localeCompare`, which is locale- and ICU-dependent and so
 * cannot anchor a digest that has to reproduce on every machine.
 */
function buildInventoryDigest(files: CatalogSkillFile[]) {
  const hashInput = [...files]
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256.toLowerCase(),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `sha256:${sha256(Buffer.from(JSON.stringify(hashInput)))}`;
}

function formatPinnedSuggestion(name: string, description: string, files: CatalogSkillFile[]) {
  return JSON.stringify({ name, description, inventorySha256: buildInventoryDigest(files) });
}

/**
 * Fetch-path check: the freshly fetched content must agree with what the
 * descriptor claims. A stale pin left behind after a commit bump would
 * otherwise only surface later, as an unexplained failure of the offline
 * freshness check in CI.
 */
function verifyPinnedReferencedContent(
  descriptor: ReferencedSkillDescriptor,
  prefix: string,
  name: string,
  description: string,
  files: CatalogSkillFile[],
  errors: string[],
) {
  const pinned = descriptor.pinned;
  if (!pinned) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} must include a pinned object so the generated manifest can be verified offline. Add "pinned": ${formatPinnedSuggestion(name, description, files)}`);
    return;
  }
  if (pinned.name !== name) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} pinned.name is ${JSON.stringify(pinned.name)} but the pinned commit provides ${JSON.stringify(name)}.`);
  }
  if (pinned.description !== description) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} pinned.description does not match the description at the pinned commit (${JSON.stringify(description)}).`);
  }
  const inventorySha256 = buildInventoryDigest(files);
  if (pinned.inventorySha256 !== inventorySha256) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} pinned.inventorySha256 is stale; the pinned commit yields ${inventorySha256}.`);
  }
}

function buildCatalogSkillSource(
  descriptor: ReferencedSkillDescriptor,
  errors: string[],
  prefix: string,
): CatalogSkillSource | null {
  const source = descriptor.source;
  if (!/^[0-9a-f]{40}$/i.test(source.commit)) {
    errors.push(`${prefix} source.commit must be a 40-character Git commit SHA.`);
  }
  const sourcePath = normalizeReferencedPath(source.path);
  if (sourcePath === null) {
    errors.push(`${prefix} source.path must be a portable path within the repository.`);
  }
  const rawHostname = source.hostname ?? "github.com";
  const normalizedHostname = rawHostname.toLowerCase();
  const hostname = normalizedHostname === "www.github.com" ? "github.com" : normalizedHostname;
  if (!SUPPORTED_GITHUB_HOSTNAMES.has(normalizedHostname)) {
    errors.push(`${prefix} source.hostname must be github.com.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(source.commit) || sourcePath === null || !SUPPORTED_GITHUB_HOSTNAMES.has(normalizedHostname)) {
    return null;
  }
  const url = `https://${hostname}/${source.owner}/${source.repo}/tree/${source.ref}/${sourcePath ?? ""}`.replace(/\/$/, "");
  return {
    type: "github",
    hostname,
    owner: source.owner,
    repo: source.repo,
    ref: source.ref,
    commit: source.commit,
    path: sourcePath ?? "",
    url,
    descriptorSha256: descriptor.descriptorSha256,
  };
}

async function collectReferencedSkillFiles(
  source: CatalogSkillSource,
  includePatterns: string[],
  prefix: string,
  errors: string[],
  fetchCache: Map<string, Buffer | null>,
  fetchTimeoutMs: number,
): Promise<CatalogSkillFile[]> {
  const tree = await fetchGitHubTree(source, prefix, errors, fetchTimeoutMs);
  const sourceRoot = source.path ? `${source.path}/` : "";
  const normalizedPatterns: string[] = [];
  for (const pattern of includePatterns) {
    const normalizedPattern = normalizeReferencedPath(pattern);
    if (normalizedPattern === null) {
      errors.push(`${prefix} referenced include path is invalid: ${pattern}`);
      continue;
    }
    if (normalizedPattern) normalizedPatterns.push(normalizedPattern);
  }
  const files: CatalogSkillFile[] = [];

  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    if (!entry.path.startsWith(sourceRoot)) continue;
    const relativePath = entry.path.slice(sourceRoot.length);
    if (!normalizedPatterns.some((pattern) => referencedPathMatches(relativePath, pattern))) continue;
    if ((entry.size ?? 0) > MAX_CATALOG_FILE_BYTES) {
      errors.push(`${prefix}/${relativePath} exceeds ${MAX_CATALOG_FILE_BYTES} bytes.`);
      continue;
    }

    const bytes = await fetchReferencedFileBytes(source, relativePath, prefix, errors, fetchCache, fetchTimeoutMs);
    if (!bytes) continue;
    files.push({
      path: relativePath,
      kind: classifyCatalogFile(relativePath),
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }

  files.sort((a, b) => {
    if (a.path === SKILL_ENTRYPOINT) return -1;
    if (b.path === SKILL_ENTRYPOINT) return 1;
    return a.path.localeCompare(b.path);
  });
  return files;
}

async function fetchGitHubTree(
  source: CatalogSkillSource,
  prefix: string,
  errors: string[],
  fetchTimeoutMs: number,
): Promise<GitHubTreeEntry[]> {
  const url = `${githubApiBase(source.hostname)}/repos/${source.owner}/${source.repo}/git/trees/${source.commit}?recursive=1`;
  try {
    const { response, body } = await fetchJsonWithTimeout<{ tree?: unknown; truncated?: boolean }>(
      url,
      { headers: { accept: "application/vnd.github+json" } },
      fetchTimeoutMs,
    );
    if (!response.ok) {
      errors.push(`${prefix} failed to fetch GitHub tree: HTTP ${response.status}.`);
      return [];
    }
    if (body?.truncated) errors.push(`${prefix} GitHub tree response was truncated.`);
    return parseGitHubTreeEntries(body?.tree, prefix, errors);
  } catch (error) {
    errors.push(`${prefix} failed to fetch GitHub tree: ${errorMessage(error)}.`);
    return [];
  }
}

/**
 * The tree walk dereferences `entry.type` and `entry.path`, so an untyped
 * response member (`null`, or a blob whose `path` is not a string) would throw
 * a TypeError out of manifest generation instead of reporting which entry was
 * malformed.
 */
function parseGitHubTreeEntries(rawTree: unknown, prefix: string, errors: string[]): GitHubTreeEntry[] {
  if (rawTree === undefined || rawTree === null) {
    errors.push(`${prefix} GitHub tree response did not include a tree array.`);
    return [];
  }
  if (!Array.isArray(rawTree)) {
    errors.push(`${prefix} GitHub tree response tree must be an array.`);
    return [];
  }

  const entries: GitHubTreeEntry[] = [];
  rawTree.forEach((raw, index) => {
    if (!isPlainRecord(raw)) {
      errors.push(`${prefix} GitHub tree entry ${index} is not an object.`);
      return;
    }
    const entryPath = asString(raw.path);
    if (!entryPath) {
      errors.push(`${prefix} GitHub tree entry ${index} is missing a string path.`);
      return;
    }
    const type = asString(raw.type);
    if (!type) {
      errors.push(`${prefix} GitHub tree entry ${index} (${entryPath}) is missing a string type.`);
      return;
    }
    if (raw.size !== undefined && raw.size !== null) {
      if (typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 0) {
        errors.push(`${prefix} GitHub tree entry ${index} (${entryPath}) has an invalid size.`);
        return;
      }
      entries.push({ path: entryPath, type, size: raw.size });
      return;
    }
    entries.push({ path: entryPath, type });
  });
  return entries;
}

async function readReferencedFileText(
  source: CatalogSkillSource,
  relativePath: string,
  prefix: string,
  errors: string[],
  fetchCache: Map<string, Buffer | null>,
  fetchTimeoutMs: number,
) {
  const bytes = await fetchReferencedFileBytes(source, relativePath, prefix, errors, fetchCache, fetchTimeoutMs);
  return bytes ? bytes.toString("utf8") : null;
}

async function fetchReferencedFileBytes(
  source: CatalogSkillSource,
  relativePath: string,
  prefix: string,
  errors: string[],
  fetchCache: Map<string, Buffer | null>,
  fetchTimeoutMs: number,
): Promise<Buffer | null> {
  const normalizedPath = normalizeReferencedPath(relativePath);
  if (!normalizedPath) {
    errors.push(`${prefix} referenced file path is invalid: ${relativePath}`);
    return null;
  }
  if (fetchCache.has(normalizedPath)) {
    return fetchCache.get(normalizedPath) ?? null;
  }
  const url = rawGitHubUrl(source, normalizedPath);
  try {
    const { response, body } = await fetchArrayBufferWithTimeout(url, {}, fetchTimeoutMs);
    if (!response.ok) {
      errors.push(`${prefix}/${normalizedPath} failed to fetch pinned GitHub file: HTTP ${response.status}.`);
      fetchCache.set(normalizedPath, null);
      return null;
    }
    const bytes = Buffer.from(body ?? new ArrayBuffer(0));
    fetchCache.set(normalizedPath, bytes);
    return bytes;
  } catch (error) {
    errors.push(`${prefix}/${normalizedPath} failed to fetch pinned GitHub file: ${errorMessage(error)}.`);
    fetchCache.set(normalizedPath, null);
    return null;
  }
}

async function collectSkillFiles(
  packageDir: string,
  skillDir: string,
  prefix: string,
  errors: string[],
): Promise<CatalogSkillFile[]> {
  const files: CatalogSkillFile[] = [];
  const skillRoot = await fs.realpath(skillDir);

  async function visit(dir: string) {
    for (const entry of await sortedDirEntries(dir)) {
      const absolutePath = path.join(dir, entry.name);
      const lstat = await fs.lstat(absolutePath);
      let stat = lstat;
      let realPath = absolutePath;

      if (lstat.isSymbolicLink()) {
        try {
          realPath = await fs.realpath(absolutePath);
          stat = await fs.stat(absolutePath);
        } catch {
          errors.push(`${relativePackagePath(packageDir, absolutePath)} is a broken symlink.`);
          continue;
        }
        if (!isPathInside(skillRoot, realPath)) {
          errors.push(`${relativePackagePath(packageDir, absolutePath)} points outside its skill directory.`);
          continue;
        }
        if (stat.isDirectory()) {
          errors.push(`${relativePackagePath(packageDir, absolutePath)} is a directory symlink; copy files into the skill directory instead.`);
          continue;
        }
      }

      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;

      const relativePath = toPosixPath(path.relative(skillDir, absolutePath));
      if (path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
        errors.push(`${prefix}/${relativePath} has an invalid inventory path.`);
        continue;
      }
      if (stat.size > MAX_CATALOG_FILE_BYTES) {
        errors.push(`${prefix}/${relativePath} exceeds ${MAX_CATALOG_FILE_BYTES} bytes.`);
      }

      const contents = await fs.readFile(absolutePath);
      files.push({
        path: relativePath,
        kind: classifyCatalogFile(relativePath),
        sizeBytes: stat.size,
        sha256: sha256(contents),
      });
    }
  }

  await visit(skillDir);
  files.sort((a, b) => {
    if (a.path === SKILL_ENTRYPOINT) return -1;
    if (b.path === SKILL_ENTRYPOINT) return 1;
    return a.path.localeCompare(b.path);
  });

  if (!files.some((file) => file.path === SKILL_ENTRYPOINT && file.kind === "skill")) {
    errors.push(`${prefix} inventory does not contain SKILL.md.`);
  }

  return files;
}

function readStringArrayField(
  value: unknown,
  field: string,
  prefix: string,
  errors: string[],
) {
  const parsed = asStringArray(value);
  if (!parsed) {
    errors.push(`${prefix}/SKILL.md frontmatter field ${field} must be an array of strings.`);
    return [];
  }
  return parsed;
}

function classifyCatalogFile(relativePath: string): CatalogSkillFileKind {
  if (relativePath === SKILL_ENTRYPOINT) return "skill";
  if (relativePath.startsWith("references/")) return "reference";
  if (relativePath.startsWith("scripts/")) return "script";
  if (relativePath.startsWith("assets/")) return "asset";
  if (relativePath.endsWith(".md") || relativePath.endsWith(".mdx")) return "markdown";
  return "other";
}

function deriveTrustLevel(files: CatalogSkillFile[]): CatalogTrustLevel {
  if (files.some((file) => file.kind === "script")) return "scripts_executables";
  if (files.some((file) => file.kind === "asset" || file.kind === "other")) return "assets";
  return "markdown_only";
}

function buildContentHash(files: CatalogSkillFile[]) {
  const hashInput = files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
  }));
  return `sha256:${sha256(Buffer.from(JSON.stringify(hashInput)))}`;
}

function collectUniquenessErrors(skills: CatalogSkill[], errors: string[]) {
  collectDuplicateErrors(skills, "id", errors);
  collectDuplicateErrors(skills, "key", errors);
  collectDuplicateErrors(skills, "slug", errors);
}

function collectCandidateUniquenessErrors(candidates: SkillCandidate[], errors: string[]) {
  const projected = candidates.map((candidate) => ({
    id: `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`,
    key: `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`,
    slug: candidate.slug,
    path: toPosixPath(path.join("catalog", candidate.kind, candidate.category, candidate.slug)),
  })) as CatalogSkill[];
  collectUniquenessErrors(projected, errors);
}

function collectDuplicateErrors(fieldSkills: CatalogSkill[], field: "id" | "key" | "slug", errors: string[]) {
  const seen = new Map<string, string>();
  for (const skill of fieldSkills) {
    const value = skill[field];
    const first = seen.get(value);
    if (first) {
      errors.push(`Duplicate catalog ${field} "${value}" in ${first} and ${skill.path}.`);
      continue;
    }
    seen.set(value, skill.path);
  }
}

function validateSlug(label: string, value: string, prefix: string, errors: string[]) {
  if (!SLUG_PATTERN.test(value)) {
    errors.push(`${prefix} has invalid ${label} "${value}"; use lowercase URL slugs.`);
  }
}

async function sortedDirEntries(dir: string) {
  return (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
}

function sameManifestExceptGeneratedAt(a: CatalogManifest, b: CatalogManifest) {
  return JSON.stringify({ ...a, generatedAt: "" }) === JSON.stringify({ ...b, generatedAt: "" });
}

function sha256(contents: Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

function relativePackagePath(packageDir: string, absolutePath: string) {
  return toPosixPath(path.relative(packageDir, absolutePath));
}

function toPosixPath(input: string) {
  return input.split(path.sep).join("/");
}

function normalizeReferencedPath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === "") return "";
  const parts = normalized.split("/");
  if (parts.includes("") || parts.includes(".") || parts.includes("..") || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function referencedPathMatches(relativePath: string, pattern: string) {
  if (pattern.endsWith("/**")) {
    const directory = pattern.slice(0, -3);
    return relativePath === directory || relativePath.startsWith(`${directory}/`);
  }
  return relativePath === pattern;
}

function githubApiBase(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (!SUPPORTED_GITHUB_HOSTNAMES.has(normalized)) {
    throw new Error(`Unsupported GitHub hostname: ${hostname}`);
  }
  return "https://api.github.com";
}

function rawGitHubUrl(source: CatalogSkillSource, relativePath: string) {
  const fullPath = source.path ? `${source.path}/${relativePath}` : relativePath;
  const encodedPath = fullPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const normalized = source.hostname.toLowerCase();
  if (!SUPPORTED_GITHUB_HOSTNAMES.has(normalized)) {
    throw new Error(`Unsupported GitHub hostname: ${source.hostname}`);
  }
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commit}/${encodedPath}`;
}

async function fetchJsonWithTimeout<T>(url: string, init: RequestInit = {}, timeoutMs = GITHUB_FETCH_TIMEOUT_MS) {
  return fetchWithTimeout(url, init, timeoutMs, async (response) => {
    if (!response.ok) return null;
    return await response.json() as T;
  });
}

async function fetchArrayBufferWithTimeout(url: string, init: RequestInit = {}, timeoutMs = GITHUB_FETCH_TIMEOUT_MS) {
  return fetchWithTimeout(url, init, timeoutMs, async (response) => {
    if (!response.ok) return null;
    return await response.arrayBuffer();
  });
}

async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consumeBody: (response: Response) => Promise<T | null>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await consumeBody(response);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function isPathInside(parent: string, child: string) {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
