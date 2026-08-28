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
 * ## Detection strategy: precision over recall
 *
 * The commands are arbitrary shell, so proving one runnable is undecidable in
 * general. We deliberately check only the narrow class that actually bit us:
 *
 *   an **absolute** path token, with a script-like extension, that does not
 *   exist on this filesystem.
 *
 * We do not resolve bare argv[0] against `PATH`, do not follow `$VAR`
 * interpolation, and do not look at relative paths — each of those can be
 * legitimately unresolvable at audit time (PATH differs per spawn, vars are
 * injected by the hook runner, relative paths depend on cwd) and flagging them
 * would train operators to ignore the signal.
 *
 * Two known limits, measured in the BLO-28872 review. Do not read this check as
 * stronger than it is:
 *
 *   - **False positives exist.** Position is not considered, so an absolute
 *     script-extension path in *argument* position is flagged even when the
 *     command legitimately creates it — `python3 /app/h.py --out /var/run/s.py`
 *     flags the `--out` target. Tracked in BLO-29505.
 *   - **Recall is narrow.** A quoted path containing a space, a case-variant
 *     extension (`.JS`), an extensionless wrapper, an interpreter outside
 *     SCRIPT_EXTENSIONS (`.rb`, `.pl`), or a token glued to a shell metachar
 *     (`/a.js;echo`) all pass silently. Also BLO-29505.
 *
 * A finding is therefore evidence, not a verdict, and no caller treats it as
 * one. A path *baked into the image* resolves the same on whichever tier audits
 * it — but a path on a **mounted volume** is per-pod, and a worker-only script
 * is genuinely missing when another tier stats it. Neither caller can tell those
 * two apart, which is why the boot audit only logs and the write path only
 * warns: the cost of a false positive must stay bounded at noise, never reach
 * refusing a write or stopping the instance from serving.
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
 * Extensions that mark a token as a script we expect to exist on disk. Kept
 * explicit rather than "any absolute path" so that absolute *arguments* with a
 * non-script extension (a socket the command creates, a log file it writes, a
 * directory it cds into) are not mistaken for missing executables. Note this
 * does *not* protect an argument that happens to carry a script extension —
 * see the false-positive limit in the module header.
 */
const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".py"] as const;

/** Shell metacharacters that mean a token is not a plain path. */
const SHELL_METACHARACTERS = /[$`*?[\]{}()<>|&;!~]/;

/**
 * Hard ceiling on tokens inspected per command. `fileExists` is a *synchronous*
 * stat, and the write path runs this inline in an HTTP handler, so the token
 * count is a direct multiplier on how long the API event loop blocks. The
 * validator caps the setting at 4 KiB, but the boot audit reads rows written
 * before that cap existed, so the bound is enforced here too (BLO-28872 review).
 */
const MAX_AUDITED_TOKENS = 64;

/** Concurrency ceiling for the boot audit's per-company activity writes. */
const ACTIVITY_WRITE_BATCH = 25;

export interface HookCommandAuditFinding {
  setting: LifecycleHookCommandSetting;
  command: string;
  /** Absolute script paths referenced by `command` that do not exist. */
  missingPaths: string[];
}

export interface HookCommandAuditDeps {
  fileExists?: (path: string) => boolean;
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function looksLikeScriptPath(token: string): boolean {
  if (!token.startsWith("/")) return false;
  // A token carrying shell syntax is not a literal path we can stat. `$VAR`
  // interpolation in particular is resolved by the shell at spawn time.
  if (SHELL_METACHARACTERS.test(token)) return false;
  return SCRIPT_EXTENSIONS.some((ext) => token.endsWith(ext));
}

/**
 * Absolute script paths in `command` that do not exist on this filesystem.
 * Returns `[]` for an empty/whitespace command — "nothing configured" is a
 * valid state, not a finding.
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

  for (const rawToken of trimmed.split(/\s+/, MAX_AUDITED_TOKENS)) {
    const token = stripQuotes(rawToken);
    if (!looksLikeScriptPath(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    if (!fileExists(token)) missing.push(token);
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
