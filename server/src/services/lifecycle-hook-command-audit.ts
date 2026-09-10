/**
 * Resolvability audit for the instance-settings lifecycle hook commands
 * (`preRunCmd`, `postRunCmd`, `quotaExhaustedCmd`).
 *
 * ## Why this exists (BLO-28782)
 *
 * These three commands are free-form shell strings stored in
 * `instance_settings.general` — configuration, not code. That split is what
 * made the following outage invisible for 44+ days:
 *
 *   1. `quotaExhaustedCmd` was set to
 *      `node /app/server/dist/cli/ccrotate-relogin-trigger.js`.
 *   2. PRs #433 ("Remove local ccrotate from Paperclip image") and #551
 *      ("remove ccrotate account-lifecycle, keep recovery wake") deleted that
 *      module.
 *   3. Nothing pointed the config at a command that still existed.
 *
 * Every quota exhaustion from 2026-07-05 to 2026-08-18 therefore fired the
 * recovery hook straight into `MODULE_NOT_FOUND`: 500/500 sampled fires
 * `ok: false`, zero successes, across 11 distinct agents. Because
 * `runQuotaExhaustedHook` gates its `onSuccess` recovery wake on `result.ok`,
 * the honest recovery path never once ran.
 *
 * Typecheck, build, and the full test suite all stayed green throughout —
 * a deleted file cannot break a string in a database row. The load-bearing
 * guard is therefore a *boot-time* audit: config is unchanged, but the image
 * underneath it changed. Write-time validation (also wired here) only catches
 * the easier case of someone typing a path that is already wrong, and is
 * advisory for the same reason the boot audit is non-fatal — see below.
 *
 * ## Detection strategy: position, not pattern (BLO-29505)
 *
 * The commands are arbitrary shell, so proving one runnable is undecidable in
 * general. We check exactly one thing:
 *
 *   an **absolute**, literal path in **command position** that does not exist
 *   on this filesystem.
 *
 * "Command position" means the token the shell would actually execute:
 *
 *   - argv[0] of each simple command, after skipping `VAR=value` environment
 *     prefixes and pass-through wrappers (`exec`, `env`, `nohup`, `command`);
 *   - plus, when argv[0] names a known interpreter (`bash`, `node`, `python3`,
 *     `ruby`, …), the first non-flag argument — that argument *is* the script.
 *
 * Nothing else is stat'd. This is the correction for BLO-29505 Part A: the
 * previous implementation flagged **any** absolute token carrying a script-like
 * extension, with no notion of position, so
 * `python3 /app/hook.py --out /var/run/state.py` flagged the `--out` target — a
 * permanent warning on a *correct* configuration, which is precisely the "train
 * operators to ignore the signal" outcome this module argues against.
 *
 * Because position now carries the precision, the extension allow-list that
 * used to carry it is gone. A command-position absolute path must exist for the
 * command to run at all, whatever it is named, so `exec /app/bin/relogin`
 * (extensionless) and `ruby /app/x.rb` (interpreter outside the old list) are
 * now audited rather than silently passed (BLO-29505 Part B).
 *
 * Tokenization is quote-aware and metacharacter-aware: a quoted path containing
 * a space survives as one token, and `;`/`&&`/`|`/`(`/`)`/redirects **split**
 * the command into simple commands instead of disqualifying the token they are
 * glued to. Redirect targets are dropped — `node /a.js >/tmp/out` writes
 * `/tmp/out`, it does not execute it.
 *
 * ## Known limits — this check is weaker than it looks
 *
 * Do not reintroduce a claim that it has no false positives. It has one, and it
 * is structural:
 *
 *   - **False positive: cross-tier volume paths.** `existsSync` runs on the pod
 *     doing the audit, not the pod that spawns the hook. A path baked into the
 *     image resolves the same on either tier, but a path on a **mounted volume**
 *     is per-pod: a worker-only script is genuinely absent when the API tier
 *     stats it while being perfectly runnable where it fires. Neither caller can
 *     tell those two apart.
 *
 * And recall remains deliberately narrow — each of these passes silently, by
 * design, because flagging it would produce noise we cannot stand behind:
 *
 *   - bare argv[0] resolved through `PATH` (`ccrotate refresh-one`) — PATH
 *     differs per spawn;
 *   - relative paths (`node ./scripts/hook.js`) — cwd-dependent at spawn time;
 *   - any word carrying unquoted `$`, backtick, glob, brace, or a leading `~` —
 *     the shell rewrites it before exec;
 *   - the inner command of `bash -c '…'`, `eval`, or a `$(…)` substitution — not
 *     parsed;
 *   - the second and later arguments of an interpreter — only the first non-flag
 *     argument is treated as the script.
 *
 * A finding is therefore evidence, not a verdict, and no caller treats it as
 * one: the boot audit only logs and the write path only warns. The cost of a
 * false positive must stay bounded at noise, never reach refusing a write or
 * stopping the instance from serving.
 */

import { existsSync } from "node:fs";
import type { Db } from "@paperclipai/db";
import type { InstanceGeneralSettings } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";
import { logActivity } from "./activity-log.js";

/** The `instance_settings.general` keys that hold spawnable shell commands. */
export const LIFECYCLE_HOOK_COMMAND_SETTINGS = [
  "preRunCmd",
  "postRunCmd",
  "quotaExhaustedCmd",
] as const;

export type LifecycleHookCommandSetting = (typeof LIFECYCLE_HOOK_COMMAND_SETTINGS)[number];

/**
 * Hard ceiling on **words** tokenized per command. `fileExists` is a
 * *synchronous* stat, and the write path runs this inline in an HTTP handler, so
 * the word count is a direct multiplier on how long the API event loop blocks.
 * Each word can contribute at most one stat, so this is the stat bound too. The
 * validator caps the setting at 4 KiB, but the boot audit reads rows written
 * before that cap existed, so the bound is enforced here too (BLO-28872 review).
 * Do not remove it while narrowing detection — the two guards are independent.
 */
const MAX_AUDITED_TOKENS = 64;

/** Concurrency ceiling for the boot audit's per-company activity writes. */
const ACTIVITY_WRITE_BATCH = 25;

export interface HookCommandAuditFinding {
  setting: LifecycleHookCommandSetting;
  command: string;
  /** Absolute command-position paths referenced by `command` that do not exist. */
  missingPaths: string[];
}

export interface HookCommandAuditDeps {
  fileExists?: (path: string) => boolean;
}

/**
 * Words that wrap the real command rather than being it. Skipped during the
 * argv[0] scan so `exec /app/bin/relogin` resolves `/app/bin/relogin` and not
 * `exec`. Deliberately excludes wrappers that take their own positional
 * arguments (`timeout 30 …`, `xargs`), because skipping those would misread the
 * argument as argv[0].
 */
const COMMAND_PREFIXES = new Set(["exec", "env", "command", "nohup"]);

/**
 * argv[0] basenames whose first non-flag argument is a script path. This is what
 * makes `bash "/paperclip/my scripts/relogin.sh"` auditable while leaving the
 * `--out` target of `python3 /app/hook.py --out /var/run/state.py` untouched.
 */
const SCRIPT_INTERPRETERS = new Set([
  "sh",
  "bash",
  "dash",
  "ksh",
  "zsh",
  "node",
  "nodejs",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  "python",
  "ruby",
  "perl",
  "php",
  "pwsh",
  "powershell",
]);

/** `python3`, `python3.11`, `php8.2` — versioned aliases of the above. */
const VERSIONED_INTERPRETER = /^(?:python|php|ruby|perl|node)\d+(?:\.\d+)*$/;

function isScriptInterpreter(basename: string): boolean {
  return SCRIPT_INTERPRETERS.has(basename) || VERSIONED_INTERPRETER.test(basename);
}

/** A leading `VAR=value` environment assignment, which precedes argv[0]. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Characters that make the shell rewrite a word before exec, so the text we see
 * is not the path that will be opened. Checked only where they appear
 * *unquoted*; `~` additionally only counts at the start of a word, because
 * tilde expansion is positional — `/app/my~dir/gone.sh` is a literal path.
 */
const EXPANSION_CHARACTERS = "$`*?[]{}!";

/** Operators that end one simple command and begin another. */
const CONTROL_OPERATOR_CHARACTERS = ";|&()\n";

/** Operators whose following word is a file the command opens, not executes. */
const REDIRECT_OPERATORS = new Set([">", ">>", "<", "<<", ">|", "<>", ">&", "<&"]);

const TWO_CHAR_OPERATORS = new Set(["&&", "||", ">>", "<<", ">|", "<>", ">&", "<&", ";;"]);

interface ShellWord {
  /** Literal text after quote removal — what the shell would pass to exec. */
  value: string;
  /** The word carried unquoted expansion syntax, so `value` is not a real path. */
  expandable: boolean;
}

type ShellToken = { kind: "word"; word: ShellWord } | { kind: "operator"; value: string };

/**
 * Quote- and operator-aware split of a shell command into words and operators.
 *
 * Replaces the previous `split(/\s+/)`, which shredded a quoted path containing
 * a space into unrelated fragments and discarded any token a metacharacter was
 * glued to (`/a.js;echo` yielded nothing rather than `/a.js`) — BLO-29505 Part B.
 *
 * `maxWords` is checked before each new word begins, so words are never
 * truncated mid-path. Truncating one would invent a path that does not exist and
 * report it as missing, which is the failure mode a bound must not introduce.
 */
function tokenizeShellCommand(command: string, maxWords: number): ShellToken[] {
  const tokens: ShellToken[] = [];
  const length = command.length;
  let words = 0;
  let i = 0;

  while (i < length && words < maxWords) {
    const char = command[i];

    if (char === " " || char === "\t" || char === "\r") {
      i++;
      continue;
    }

    if (TWO_CHAR_OPERATORS.has(command.slice(i, i + 2))) {
      tokens.push({ kind: "operator", value: command.slice(i, i + 2) });
      i += 2;
      continue;
    }

    if (CONTROL_OPERATOR_CHARACTERS.includes(char) || char === ">" || char === "<") {
      tokens.push({ kind: "operator", value: char });
      i++;
      continue;
    }

    let value = "";
    let expandable = false;

    while (i < length) {
      const c = command[i];
      if (c === " " || c === "\t" || c === "\r") break;
      if (CONTROL_OPERATOR_CHARACTERS.includes(c) || c === ">" || c === "<") break;

      if (c === "\\") {
        // A backslash escape makes the next character literal.
        if (i + 1 < length) value += command[i + 1];
        i += 2;
        continue;
      }

      if (c === "'") {
        // Single quotes suppress every expansion.
        const end = command.indexOf("'", i + 1);
        if (end === -1) {
          value += command.slice(i + 1);
          i = length;
          break;
        }
        value += command.slice(i + 1, end);
        i = end + 1;
        continue;
      }

      if (c === '"') {
        i++;
        while (i < length && command[i] !== '"') {
          if (command[i] === "\\" && i + 1 < length) {
            value += command[i + 1];
            i += 2;
            continue;
          }
          // `$` and backtick still expand inside double quotes.
          if (command[i] === "$" || command[i] === "`") expandable = true;
          value += command[i];
          i++;
        }
        i++;
        continue;
      }

      if (EXPANSION_CHARACTERS.includes(c)) expandable = true;
      // Tilde expansion applies only at the start of a word.
      if (c === "~" && value.length === 0) expandable = true;

      value += c;
      i++;
    }

    tokens.push({ kind: "word", word: { value, expandable } });
    words++;
  }

  return tokens;
}

/**
 * Group tokens into simple commands, dropping redirect targets. `(`/`)`/`;`/`&&`
 * end the current command; `>`/`<` consume the word after them.
 */
function splitSimpleCommands(tokens: ShellToken[]): ShellWord[][] {
  const commands: ShellWord[][] = [];
  let current: ShellWord[] = [];
  let dropNextWord = false;

  for (const token of tokens) {
    if (token.kind === "operator") {
      if (REDIRECT_OPERATORS.has(token.value)) {
        dropNextWord = true;
        continue;
      }
      if (current.length > 0) commands.push(current);
      current = [];
      dropNextWord = false;
      continue;
    }
    if (dropNextWord) {
      dropNextWord = false;
      continue;
    }
    current.push(token.word);
  }

  if (current.length > 0) commands.push(current);
  return commands;
}

function isAbsoluteLiteral(word: ShellWord): boolean {
  return !word.expandable && word.value.startsWith("/");
}

function basenameOf(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

/**
 * The absolute literal paths one simple command must be able to execute: its
 * argv[0], plus the script argument when argv[0] is an interpreter, plus any
 * absolute pass-through wrapper ahead of them.
 *
 * Each word contributes at most one path, so the stat count across a whole
 * command is bounded by the word cap rather than by anything here.
 */
function resolveCommandPositionPaths(words: ShellWord[]): string[] {
  const paths: string[] = [];
  let i = 0;

  while (i < words.length) {
    const word = words[i];
    if (!word.expandable && ENV_ASSIGNMENT.test(word.value)) {
      i++;
      continue;
    }
    if (!word.expandable && COMMAND_PREFIXES.has(basenameOf(word.value))) {
      // An absolute wrapper (`/usr/bin/env`) still has to exist itself.
      if (isAbsoluteLiteral(word)) paths.push(word.value);
      i++;
      continue;
    }
    break;
  }

  const argv0 = words[i];
  if (!argv0) return paths;

  if (isAbsoluteLiteral(argv0)) paths.push(argv0.value);

  if (!argv0.expandable && isScriptInterpreter(basenameOf(argv0.value))) {
    for (let j = i + 1; j < words.length; j++) {
      const argument = words[j];
      // Skip options; stop at the first operand, script or not.
      if (!argument.expandable && argument.value.startsWith("-")) continue;
      if (isAbsoluteLiteral(argument)) paths.push(argument.value);
      break;
    }
  }

  return paths;
}

/**
 * Absolute command-position paths in `command` that do not exist on this
 * filesystem. Returns `[]` for an empty/whitespace command — "nothing
 * configured" is a valid state, not a finding.
 */
export function findMissingHookCommandPaths(
  command: string | null | undefined,
  deps: HookCommandAuditDeps = {},
): string[] {
  if (typeof command !== "string") return [];
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];

  const fileExists = deps.fileExists ?? existsSync;
  const missing: string[] = [];
  const seen = new Set<string>();

  const tokens = tokenizeShellCommand(trimmed, MAX_AUDITED_TOKENS);
  for (const words of splitSimpleCommands(tokens)) {
    for (const path of resolveCommandPositionPaths(words)) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (!fileExists(path)) missing.push(path);
    }
  }

  return missing;
}

/** Audit every configured lifecycle hook command in one general-settings blob. */
export function auditHookCommands(
  general: Pick<InstanceGeneralSettings, LifecycleHookCommandSetting>,
  deps: HookCommandAuditDeps = {},
): HookCommandAuditFinding[] {
  const findings: HookCommandAuditFinding[] = [];
  for (const setting of LIFECYCLE_HOOK_COMMAND_SETTINGS) {
    const command = general[setting];
    const missingPaths = findMissingHookCommandPaths(command, deps);
    if (missingPaths.length > 0) {
      findings.push({ setting, command: (command as string).trim(), missingPaths });
    }
  }
  return findings;
}

/** Human-readable one-liner, reused by the boot log and the write-time warning. */
export function describeHookCommandFinding(finding: HookCommandAuditFinding): string {
  const subject =
    finding.missingPaths.length === 1 ? "a path that does not exist" : "paths that do not exist";
  return `${finding.setting} references ${subject}: ${finding.missingPaths.join(", ")}`;
}

export const LIFECYCLE_HOOK_COMMAND_UNRESOLVED_ACTION =
  "instance.lifecycle_hook_command_unresolved";

/**
 * Boot-time drift check. Non-fatal by design: a broken hook must not stop the
 * instance from serving, but it must stop being silent. Emits one activity row
 * per company per finding under
 * `instance.lifecycle_hook_command_unresolved`, which is the same surface an
 * operator already queries to see hook fires — so the drift shows up next to
 * the failures it causes.
 */
export async function auditConfiguredHookCommandsOnBoot(input: {
  db: Db;
  getGeneral: () => Promise<Pick<InstanceGeneralSettings, LifecycleHookCommandSetting>>;
  listCompanyIds: () => Promise<string[]>;
  deps?: HookCommandAuditDeps;
}): Promise<HookCommandAuditFinding[]> {
  let findings: HookCommandAuditFinding[];
  try {
    findings = auditHookCommands(await input.getGeneral(), input.deps);
  } catch (err) {
    logger.warn({ err }, "lifecycle hook command audit could not read instance settings");
    return [];
  }

  if (findings.length === 0) {
    logger.info("lifecycle hook commands resolve; no unresolved paths");
    return [];
  }

  for (const finding of findings) {
    logger.error(
      {
        setting: finding.setting,
        // The command is operator-supplied and routinely carries a credential
        // (`curl -H 'Authorization: Bearer …' && bash /x.sh`). pino redacts only
        // `req.headers.authorization` and writes to stdout *and* server.log on
        // disk, so this must go through the shared command redactor explicitly.
        // The activity row below gets it for free — `sanitizeRecord` matches on
        // the key name `command` — but this logger call does not (BLO-28872).
        command: redactSensitiveText(finding.command),
        missingPaths: finding.missingPaths,
      },
      `Configured lifecycle hook is dead: ${describeHookCommandFinding(finding)}. It will fail on every fire until the setting or the image is corrected.`,
    );
  }

  try {
    const companyIds = await input.listCompanyIds();
    // Sequential batches, not one `Promise.all` over companies × findings. Each
    // `logActivity` issues an uncached settings read plus an INSERT, so the
    // unbounded form was `companies × findings × ~3` concurrent queries against
    // a pool that is also serving traffic — on every boot, and again on every
    // crashloop restart (BLO-28872 review).
    const rows = companyIds.flatMap((companyId) =>
      findings.map((finding) => ({ companyId, finding })),
    );
    for (let i = 0; i < rows.length; i += ACTIVITY_WRITE_BATCH) {
      await Promise.all(
        rows.slice(i, i + ACTIVITY_WRITE_BATCH).map(({ companyId, finding }) =>
          logActivity(input.db, {
            companyId,
            actorType: "system",
            actorId: "lifecycle-hook-command-audit",
            action: LIFECYCLE_HOOK_COMMAND_UNRESOLVED_ACTION,
            entityType: "instance_settings",
            entityId: finding.setting,
            details: {
              setting: finding.setting,
              command: finding.command,
              missingPaths: finding.missingPaths,
              detectedAt: "boot",
            },
          }),
        ),
      );
    }
  } catch (err) {
    logger.warn({ err }, "failed to record lifecycle hook command audit activity");
  }

  return findings;
}
