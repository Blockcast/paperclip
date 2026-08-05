import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogManifest, catalogSkills, resolveCatalogSkillRef } from "./index.js";

const EXPECTED_BUNDLED_KEYS = [
  "paperclipai/bundled/docs/doc-maintenance",
  "paperclipai/bundled/paperclip-operations/issue-triage",
  "paperclipai/bundled/paperclip-operations/reflection-coach",
  "paperclipai/bundled/paperclip-operations/summarize-status",
  "paperclipai/bundled/paperclip-operations/task-planning",
  "paperclipai/bundled/product/paperclip-capsules",
  "paperclipai/bundled/product/wireframe",
  "paperclipai/bundled/quality/qa-acceptance",
  "paperclipai/bundled/software-development/container-runtime",
  "paperclipai/bundled/software-development/github-pr-workflow",
];

const EXPECTED_OPTIONAL_KEYS = [
  "paperclipai/optional/browser/agent-browser",
  "paperclipai/optional/content/release-announcement",
  "paperclipai/optional/finance/ramp",
  "paperclipai/optional/product/design-critique",
  "paperclipai/optional/research/last30days",
];

const MAX_FRONTMATTER_DESCRIPTION_LENGTH = 300;
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SKILL_FRONTMATTER_ROOTS = [
  path.join(REPO_ROOT, ".agents"),
  path.join(REPO_ROOT, "skills"),
  path.join(REPO_ROOT, "packages/adapters"),
  path.join(REPO_ROOT, "packages/plugins"),
  path.join(REPO_ROOT, "packages/skills-catalog/catalog"),
  path.join(REPO_ROOT, "packages/teams-catalog/catalog"),
];

const GITHUB_PR_WORKFLOW_SKILL = new URL(
  "../catalog/bundled/software-development/github-pr-workflow/SKILL.md",
  import.meta.url,
);

/** Fence info strings whose contents a reader is expected to actually run. */
const EXECUTABLE_FENCE_INFO = new Set(["sh", "bash", "shell", "zsh", "console", "shell-session"]);

/**
 * Operations whose credential must stay the default App token: they author,
 * publish, or formally review a PR.
 */
const AUTHORING_COMMAND_PATTERNS = [
  // `git` accepts global options before the subcommand, and the historical
  // seat-authoring recipe used exactly that form
  // (`git -c http.https://github.com/.extraheader=… push`). Matching a bare
  // `git push` would let that spelling slip a credential past the scan below.
  { name: "git push", pattern: /\bgit\s+(?:-[cC]\s+\S+\s+|--\S+\s+)*push\b/ },
  { name: "gh pr create", pattern: /\bgh\s+pr\s+create\b/ },
  { name: "gh pr merge", pattern: /\bgh\s+pr\s+merge\b/ },
  { name: "gh pr review", pattern: /\bgh\s+pr\s+review\b/ },
];

/**
 * Any attempt to point git/gh at a non-default credential. The agent image's
 * `gh` wrapper re-reads `PAPERCLIP_GITHUB_TOKEN_FILE` on every invocation, so a
 * token file is the only selector that works — but `GH_TOKEN`, `--with-token`
 * and `gh auth` recipes are rejected too: they silently do *nothing* in these
 * pods, so documenting one next to an authoring command is a bug either way.
 */
const CREDENTIAL_SELECTOR_PATTERNS = [
  { name: "token-file selection", pattern: /PAPERCLIP_GITHUB_TOKEN_FILE\s*=/ },
  { name: "literal seat-token path", pattern: /github-merge-token/ },
  { name: "GH_TOKEN assignment", pattern: /\bGH_TOKEN\s*=/ },
  { name: "GITHUB_TOKEN assignment", pattern: /\bGITHUB_TOKEN\s*=/ },
  { name: "gh auth --with-token", pattern: /--with-token\b/ },
  { name: "gh auth login/switch", pattern: /\bgh\s+auth\s+(?:login|switch)\b/ },
];

/**
 * Stub `gh` for the recovery-recipe failure-path tests. Logs every argv to
 * $GH_LOG and scripts one failure per $GH_SCENARIO, so a test can assert what
 * the recipe did — above all whether it closed the original PR before it had
 * validated everything the replacement needs.
 */
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "api user")
    if [ "$GH_SCENARIO" = "seat-identity" ]; then echo '{"login":"allyblockcast"}'; exit 0; fi
    if [ "$GH_SCENARIO" = "gh-broken" ]; then echo "dial tcp: lookup api.github.com" >&2; exit 1; fi
    echo '{"message":"Resource not accessible by integration","status":"403"}' >&2; exit 1 ;;
  "pr view")
    if [ "$3" = "7" ]; then
      [ "$GH_SCENARIO" = "view-fails" ] && { echo "gh: HTTP 500" >&2; exit 1; }
      if [[ "$*" == *"--json state"* ]]; then
        case "$GH_SCENARIO" in
          close-applied-error|create-applied-error|signal-after-close) echo "CLOSED" ;;
          *) echo "OPEN" ;;
        esac
        exit 0
      fi
      case "$GH_SCENARIO" in
        null-sha|blank-both) echo '{"headRefName":"feat","baseRefName":"main","headRefOid":null,"title":"T","body":"B"}'; exit 0 ;;
      esac
      echo '{"headRefName":"feat","baseRefName":"main","headRefOid":"'"$ORIG"'","title":"T","body":"B"}'; exit 0
    fi
    case "$GH_SCENARIO" in
      seat-author) echo '{"headRefOid":"'"$ORIG"'","baseRefName":"main","author":{"login":"allyblockcast"}}' ;;
      wrong-base)  echo '{"headRefOid":"'"$ORIG"'","baseRefName":"release","author":{"login":"app/allyblockcast"}}' ;;
      moved-head)  echo '{"headRefOid":"'"$MOVED"'","baseRefName":"main","author":{"login":"app/allyblockcast"}}' ;;
      *) echo '{"headRefOid":"'"$ORIG"'","baseRefName":"main","author":{"login":"app/allyblockcast"}}' ;;
    esac ;;
  "api repos"*)
    [ "$GH_SCENARIO" = "ref-fails" ] && { echo "gh: HTTP 404" >&2; exit 1; }
    [ "$GH_SCENARIO" = "blank-both" ] && { echo ""; exit 0; }
    [ "$GH_SCENARIO" = "moved" ] && { echo "$MOVED"; exit 0; }
    echo "$ORIG" ;;
  "pr close")
    if [ "$3" = "7" ] && [ "$GH_SCENARIO" = "close-applied-error" ]; then
      echo "gh: connection reset after close" >&2
      exit 1
    fi
    if [ "$3" = "7" ] && [ "$GH_SCENARIO" = "signal-after-close" ]; then
      kill -TERM "$PPID"
      sleep 0.1
    fi
    exit 0 ;;
  "pr create")
    [ "$GH_SCENARIO" = "create-fails" ] && { echo "gh: no commits between branches" >&2; exit 1; }
    [ "$GH_SCENARIO" = "create-applied-error" ] && { echo "gh: connection reset after create" >&2; exit 1; }
    [ "$GH_SCENARIO" = "blank-url" ] && { echo ""; exit 0; }
    echo "https://github.com/acme/widgets/pull/8" ;;
  "pr list")
    [ "$GH_SCENARIO" = "create-applied-error" ] && { echo "8"; exit 0; }
    echo "" ;;
  *) exit 0 ;;
esac
`;

/** Fenced blocks in a Markdown document, with info string and 1-based opening line. */function fencedBlocks(markdown: string): { info: string; body: string; line: number }[] {
  const blocks: { info: string; body: string; line: number }[] = [];
  let open: { info: string; line: number; body: string[] } | null = null;

  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (!fence) {
      open?.body.push(line);
      continue;
    }
    if (open) {
      blocks.push({ info: open.info, body: open.body.join("\n"), line: open.line });
      open = null;
    } else {
      open = { info: fence[1]!.trim().toLowerCase(), line: index + 1, body: [] };
    }
  }
  return blocks;
}

/**
 * Shell fences that run an authoring/review command, paired with any credential
 * selector appearing beside it. Takes markdown rather than reading the skill so
 * the detector itself can be tested against known-bad fixtures — a scan that
 * only ever sees a passing file cannot show it would catch a regression.
 */
function credentialViolations(markdown: string): { authoringBlocks: number; violations: string[] } {
  const authoringBlocks = fencedBlocks(markdown)
    .filter((block) => EXECUTABLE_FENCE_INFO.has(block.info))
    .filter((block) => AUTHORING_COMMAND_PATTERNS.some(({ pattern }) => pattern.test(block.body)));

  const violations = authoringBlocks.flatMap((block) => {
    const commands = AUTHORING_COMMAND_PATTERNS.filter(({ pattern }) => pattern.test(block.body))
      .map(({ name }) => name)
      .join(", ");
    return CREDENTIAL_SELECTOR_PATTERNS.filter(({ pattern }) => pattern.test(block.body)).map(
      ({ name }) => `fence at line ${block.line} (${commands}): ${name}`,
    );
  });

  return { authoringBlocks: authoringBlocks.length, violations };
}

/** The destructive seat-authored-PR recovery, ready to run against a stub `gh`. */
function extractRecoveryRecipe(markdown: string): string | null {
  const recovery = fencedBlocks(markdown)
    .filter((block) => EXECUTABLE_FENCE_INFO.has(block.info))
    .find((block) => /\bgh\s+pr\s+close\b/.test(block.body));
  if (!recovery) return null;
  return recovery.body.replace("REPO=<org>/<repo>", "REPO=acme/widgets").replace("NUM=<number>", "NUM=7");
}

const ORIG_SHA = "a".repeat(40);
const MOVED_SHA = "b".repeat(40);

/**
 * Runs the shipped recovery recipe against a stub `gh` so its failure paths are
 * exercised, not merely pattern-matched. Returns the exit code and the exact
 * `gh` argv sequence the recipe issued, which is what makes "did it close the PR
 * before validating?" and "did it roll back?" answerable.
 */
function runRecovery(scenario: string): { status: number; stderr: string; ghCalls: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-recovery-"));
  try {
    const logPath = path.join(dir, "gh.log");
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "gh"), GH_STUB, { mode: 0o755 });

    const recipe = extractRecoveryRecipe(readFileSync(fileURLToPath(GITHUB_PR_WORKFLOW_SKILL), "utf8"));
    if (!recipe) throw new Error("no recovery recipe found in the skill");
    const recipePath = path.join(dir, "recipe.sh");
    writeFileSync(recipePath, recipe);

    const result = spawnSync("bash", [recipePath], {
      encoding: "utf8",
      env: {
        ...process.env,
        // The pods export this by default pointing at the App token, so the
        // recipe must not key off its mere presence.
        PAPERCLIP_GITHUB_TOKEN_FILE: "/paperclip/.secrets/github-token/token",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GH_LOG: logPath,
        GH_SCENARIO: scenario,
        ORIG: ORIG_SHA,
        MOVED: MOVED_SHA,
      },
    });

    const ghCalls = existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
      : [];
    return { status: result.status ?? -1, stderr: result.stderr ?? "", ghCalls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const closedOriginal = (calls: string[]) => calls.some((call) => /^pr close 7\b/.test(call));
const reopenedOriginal = (calls: string[]) => calls.some((call) => /^pr reopen 7\b/.test(call));
const closedReplacement = (calls: string[]) => calls.some((call) => /^pr close 8\b/.test(call));

function listSkillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSkillFiles(entryPath);
    if (entry.isFile() && entry.name === "SKILL.md") return [entryPath];
    return [];
  });
}

function readFrontmatterDescription(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const lines = match[1]!.split(/\r?\n/);
  const descriptionIndex = lines.findIndex((line) => line.startsWith("description:"));
  if (descriptionIndex === -1) return null;

  const inlineValue = lines[descriptionIndex]!.slice("description:".length).trim();
  if (/^[>|][+-]?$/.test(inlineValue)) {
    const descriptionLines: string[] = [];
    for (let index = descriptionIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^[A-Za-z0-9_-]+:/.test(line)) break;
      descriptionLines.push(line.trim());
    }
    return descriptionLines.join(" ").replace(/\s+/g, " ").trim();
  }

  return inlineValue.replace(/^['"]|['"]$/g, "");
}

describe("shipped skills catalog", () => {
  it("ships the summarize-status streaming protocol", () => {
    const skill = readFileSync(
      path.join(
        REPO_ROOT,
        "packages/skills-catalog/catalog/bundled/paperclip-operations/summarize-status/SKILL.md",
      ),
      "utf8",
    );

    expect(skill).toContain("Post the first status update immediately, before doing anything else.");
    expect(skill).toContain('STATUS: considering "Fix login redirect loop"…');
    expect(skill).toContain("STATUS: reading the current slot revision…");
    expect(skill).toContain("<<<SUMMARY-DRAFT>>>");
    expect(skill).toContain("<<<END-SUMMARY-DRAFT>>>");
    expect(skill).toContain("Assistant prose streams token-by-token to the UI; tool-call arguments do not");
    expect(skill).toContain("UI gracefully falls back to its spinner");
    expect(skill).toContain("**Review:**");
    expect(skill).toContain("approve on a skim");
    expect(skill).toContain("**Recent work:**");
    expect(skill).toContain("Not a changelog");
  });

  it("keeps repo and catalog skill descriptions within the prompt budget cap", () => {
    const violations: string[] = [];
    for (const skillFile of SKILL_FRONTMATTER_ROOTS.flatMap(listSkillFiles)) {
      const description = readFrontmatterDescription(readFileSync(skillFile, "utf8"));
      if (!description) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} is missing a frontmatter description`);
      } else if (description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(`${path.relative(REPO_ROOT, skillFile)} description is ${description.length} chars`);
      }
    }
    for (const skill of catalogSkills) {
      if (skill.description.length > MAX_FRONTMATTER_DESCRIPTION_LENGTH) {
        violations.push(`${skill.key} generated description is ${skill.description.length} chars`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("ships the expected bundled and optional skill set", () => {
    const bundledKeys = catalogSkills
      .filter((skill) => skill.kind === "bundled")
      .map((skill) => skill.key)
      .sort();
    const optionalKeys = catalogSkills
      .filter((skill) => skill.kind === "optional")
      .map((skill) => skill.key)
      .sort();

    expect(bundledKeys).toEqual(EXPECTED_BUNDLED_KEYS);
    expect(optionalKeys).toEqual(EXPECTED_OPTIONAL_KEYS);
  });

  it("keeps script-bearing shipped skills explicit so install stays audit-gated", () => {
    // The real install-time security boundary audits materialized bytes and blocks
    // hard-stop findings. Static assets (svg/html templates, e.g. the wireframe skill)
    // carry the "assets" trust level and are installable.
    const scriptBearing = catalogSkills.filter((skill) => skill.trustLevel === "scripts_executables");
    expect(scriptBearing.map((skill) => skill.key)).toEqual([
      "paperclipai/optional/research/last30days",
    ]);
  });

  it("populates browse/search-relevant fields for every shipped skill", () => {
    const issues: string[] = [];
    for (const skill of catalogSkills) {
      if (skill.compatibility !== "compatible") {
        issues.push(`${skill.key} compatibility=${skill.compatibility}`);
      }
      if (!skill.description || skill.description.length < 40) {
        issues.push(`${skill.key} description must be at least 40 characters for catalog browse/search`);
      }
      if (skill.recommendedForRoles.length === 0) {
        issues.push(`${skill.key} must list recommendedForRoles`);
      }
      if (skill.tags.length === 0) {
        issues.push(`${skill.key} must list tags`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("uses canonical paperclipai keys derived from kind/category/slug", () => {
    const violations: string[] = [];
    for (const skill of catalogSkills) {
      const expectedKey = `paperclipai/${skill.kind}/${skill.category}/${skill.slug}`;
      const expectedId = `paperclipai:${skill.kind}:${skill.category}:${skill.slug}`;
      if (skill.key !== expectedKey) violations.push(`${skill.key} should be ${expectedKey}`);
      if (skill.id !== expectedId) violations.push(`${skill.id} should be ${expectedId}`);
    }
    expect(violations).toEqual([]);
  });

  it("exposes a stable manifest header for downstream consumers", () => {
    expect(catalogManifest.schemaVersion).toBe(1);
    expect(catalogManifest.packageName).toBe("@paperclipai/skills-catalog");
    expect(catalogSkills.length).toBe(EXPECTED_BUNDLED_KEYS.length + EXPECTED_OPTIONAL_KEYS.length);
  });

  it("resolves shipped skills by id, key, and unique slug", () => {
    const sample = catalogSkills.find((skill) => skill.key === "paperclipai/bundled/software-development/github-pr-workflow");
    expect(sample, "expected github-pr-workflow to ship in the bundled catalog").toBeDefined();
    if (!sample) return;

    expect(resolveCatalogSkillRef(sample.id)).toMatchObject({ key: sample.key });
    expect(resolveCatalogSkillRef(sample.key)).toMatchObject({ key: sample.key });
    expect(resolveCatalogSkillRef(sample.slug)).toMatchObject({ key: sample.key });
  });

  it("keeps the Ramp wrapper fail-closed on mixed-provenance playbooks", () => {
    const rampSkill = readFileSync(new URL("../catalog/optional/finance/ramp/SKILL.md", import.meta.url), "utf8");

    expect(rampSkill).toContain("mixes Official and Community playbooks");
    expect(rampSkill).toContain("do not execute them inside Paperclip unless a Paperclip approval explicitly names the playbook");
    expect(rampSkill).toContain("third-party browser automation, MCP server, CLI, or connector");
  });

  it("keeps the Ramp wrapper clear of remote-fetch execution hard-stop patterns", () => {
    const rampSkill = readFileSync(new URL("../catalog/optional/finance/ramp/SKILL.md", import.meta.url), "utf8");
    const remoteExecPattern = /\b(?:curl|wget)\b[\s\S]{0,160}\|\s*(?:sh|bash)|\b(?:bash|sh)\s+-c\b|\beval\b|\bpython\s+-c\b|\bnode\s+-e\b/i;

    expect(remoteExecPattern.test(rampSkill)).toBe(false);
  });

  it("authors PRs under the App token and never under the user seat", async () => {
    const content = await readFile(GITHUB_PR_WORKFLOW_SKILL, "utf8");

    // The review bot's formal APPROVE comes from the `allyblockcast` user seat, so a
    // seat-authored PR makes author == approver and can never clear `review/ally-complete`.
    expect(content).toContain("Author and push under the default App token.");
    expect(content).not.toContain("author your PR under it");

    // The seat is not a reviewing credential either.
    expect(content).toContain("Never submit a formal review under the user-seat token.");
  });

  it("documents stacked PR constraints and retargeting before merge queue", async () => {
    const content = await readFile(GITHUB_PR_WORKFLOW_SKILL, "utf8");

    expect(content).toContain("Use stacked PRs only when a follow-up change truly depends");
    expect(content).toContain("reviewed as an incremental diff against that base branch");
    expect(content).toContain("Stack: parent #<number>");
    expect(content).toMatch(/Retarget to <default-branch> after #<number>\s+merges/);
    expect(content).toContain("only then put it in the merge queue");
    expect(content).toMatch(/Protected branch\s+rules not configured for this branch/);
  });

  it("never selects a non-default credential in an authoring or review recipe", async () => {
    const content = await readFile(GITHUB_PR_WORKFLOW_SKILL, "utf8");
    const { authoringBlocks, violations } = credentialViolations(content);

    // Anti-vacuity guard: if the fence extractor or the fence languages drift, the
    // scan below would "pass" having inspected nothing. Pin that it found recipes.
    expect(authoringBlocks, "expected >=1 shell fence running git push / gh pr create|merge|review").toBeGreaterThan(0);

    expect(violations).toEqual([]);
  });

  it("rejects the historical seat-authoring recipes it is meant to keep out", () => {
    // A green scan proves nothing unless the scanner would fail on the bad input.
    // These are the two forms that actually shipped before BLO-18997: a token-file
    // selector beside `gh pr create`, and the `git -c …extraheader= push` spelling
    // that a bare /\bgit\s+push\b/ detector walks straight past.
    const seatCreate = ["```sh", 'PAPERCLIP_GITHUB_TOKEN_FILE="$USER_TOKEN_FILE" \\', "  gh pr create --fill", "```"].join("\n");
    const seatGitPush = [
      "```sh",
      "git -c http.https://github.com/.extraheader= push -u origin HEAD",
      'GH_TOKEN="$(cat /paperclip/.secrets/github-merge-token/token)"',
      "```",
    ].join("\n");

    expect(credentialViolations(seatCreate).violations).not.toEqual([]);

    const gitPushResult = credentialViolations(seatGitPush);
    expect(gitPushResult.authoringBlocks, "git -c … push must register as an authoring command").toBe(1);
    expect(gitPushResult.violations).not.toEqual([]);
  });

  describe("seat-authored PR recovery", () => {
    it("is present, SHA-preserving, and fails closed on its own reads", async () => {
      const content = await readFile(GITHUB_PR_WORKFLOW_SKILL, "utf8");
      const recipe = extractRecoveryRecipe(content);
      expect(recipe, "expected a shell fence recovering a seat-authored PR").toBeTruthy();
      // `set -e` is what makes an unanticipated failure reach the rollback trap
      // rather than falling through to the next destructive line.
      expect(recipe).toMatch(/set\s+-euo\s+pipefail/);
      expect(recipe).toMatch(/trap\s+rollback\s+EXIT/);
      expect(recipe).toMatch(/trap\s+'handle_signal INT'\s+INT/);
      expect(recipe).toMatch(/trap\s+'handle_signal TERM'\s+TERM/);
    });

    // Every pre-close failure must abort with the review artifact still open.
    // These are the fail-open cases: a read that errors, or one that returns a
    // null field, leaves an empty SHA that compares equal to an empty remote SHA.
    it.each([
      ["seat-identity", "a user-seat login instead of the App"],
      ["gh-broken", "an identity probe that cannot reach GitHub"],
      ["view-fails", "a failed metadata read"],
      ["null-sha", "a null headRefOid"],
      ["blank-both", "a null headRefOid AND an empty remote read, which compare equal"],
      ["ref-fails", "a failed remote-ref read"],
      ["moved", "a branch that moved since capture"],
    ])("never closes the original on %s (%s)", (scenario) => {
      const { status, ghCalls } = runRecovery(scenario);
      expect(status, "recipe must exit non-zero").not.toBe(0);
      expect(closedOriginal(ghCalls), "must not reach `gh pr close` on the original").toBe(false);
    });

    // Past the close, every unsuccessful exit must put the original back — and
    // take any replacement it managed to open back down with it.
    it.each([
      ["create-fails", false],
      ["blank-url", false],
      ["seat-author", true],
      ["wrong-base", true],
      ["moved-head", true],
    ])("rolls the original back open after %s", (scenario, expectReplacement) => {
      const { status, ghCalls } = runRecovery(scenario);
      expect(status, "recipe must exit non-zero").not.toBe(0);
      expect(closedOriginal(ghCalls), "scenario should have reached the close").toBe(true);
      expect(reopenedOriginal(ghCalls), "must reopen the original").toBe(true);
      expect(closedReplacement(ghCalls), "must not leave a bad replacement open").toBe(expectReplacement);
    });

    it("rolls the original back open when interrupted after close", () => {
      const { status, stderr, ghCalls } = runRecovery("signal-after-close");
      expect(status, "recipe must exit non-zero").not.toBe(0);
      expect(stderr).toContain("interrupted by TERM");
      expect(closedOriginal(ghCalls), "scenario should have reached the close").toBe(true);
      expect(reopenedOriginal(ghCalls), "must reopen the original").toBe(true);
    });

    it.each([
      ["close-applied-error", false],
      ["create-applied-error", true],
    ])("reconciles applied remote mutation after %s", (scenario, expectReplacement) => {
      const { status, ghCalls } = runRecovery(scenario);
      expect(status, "recipe must exit non-zero").not.toBe(0);
      expect(closedOriginal(ghCalls), "scenario should have reached the close").toBe(true);
      expect(reopenedOriginal(ghCalls), "must reopen the original").toBe(true);
      expect(closedReplacement(ghCalls), "must not leave a bad replacement open").toBe(expectReplacement);
    });

    it("recovers onto the captured head and base when everything holds", () => {
      const { status, ghCalls } = runRecovery("happy");
      expect(status).toBe(0);
      expect(closedOriginal(ghCalls)).toBe(true);
      expect(reopenedOriginal(ghCalls), "a successful run must not roll back").toBe(false);
      // The captured base, never a hardcoded `master`.
      expect(ghCalls.some((call) => /^pr create .*--head feat .*--base main\b/.test(call))).toBe(true);
    });
  });
});
