/**
 * PEN-1305 Layer 1 — enforced pre-execution block for full-environment dumps.
 *
 * Background: agent heartbeats repeatedly ran unrestricted environment
 * inspection (`env` / `printenv` / `set` / `export -p` / `declare -x` /
 * `cat /proc/<pid>/environ`), dumping live secret-bearing runtime variables into
 * the run transcript. The Paperclip server ships a transcript-redaction layer
 * (defense-in-depth, catches the persisted values), but the *preventive*
 * command guard (`classifyAgentShellCommand`) was never wired into a runtime
 * hook — so agents kept running the dumps and self-reporting incidents.
 *
 * This module wires that block into the claude_k8s runtime via a Claude Code
 * `PreToolUse` hook. Hooks fire even under `--dangerously-skip-permissions`
 * (which Job pods use, since there is no human to answer permission prompts),
 * so this is the correct enforcement point for unattended runs.
 *
 * This module is the ENFORCED copy — the one a Job pod actually runs. A second
 * copy of the same classifier lives at `server/src/agent-shell-guard.ts`.
 * An earlier version of this comment claimed the two were "locked in
 * behavioural parity" by `env-guard.test.ts`; that was never true — the test
 * does not reference that file, and nothing imports it in production either.
 *
 * A later version of this comment then over-corrected, calling that file simply
 * "four bypasses behind". Also wrong: the divergence runs in BOTH directions.
 * The server copy was *ahead* on the unquoted-shell-wrapper bypass, which a
 * human closed there in `993bf304c` (2026-08-04) while this copy still had it —
 * and this copy was ahead on CR/LF separators, flag-only dumps and command
 * substitution, which that copy still lacks. Neither file is the reference
 * implementation, and a fix in one does not land in the other.
 *
 * So: check the other copy before assuming a bypass is novel here, and do not
 * describe either as authoritative. Tracked for removal-or-resync as BLO-22840.
 */

export type AgentShellCommandDecision =
  | { action: "allow"; reason: "safe_env_inspection" | "not_environment_dump" }
  | { action: "block"; reason: "full_environment_dump" };

/**
 * The safe-helper exception. This MUST match the *whole* command, not merely
 * contain the helper somewhere in it: the exception is evaluated before the
 * full-dump detector, so a substring match would let `paperclip-safe-env && env`
 * or `safe-env-inspect; printenv` return `allow` and defeat the entire guard.
 * Arguments are permitted, but no shell metacharacter that could chain, expand,
 * or redirect into a second command (`; & | ( ) < > $ \``) may follow.
 *
 * A newline chains commands exactly like `;`, so the separator and the argument
 * tail are `[ \t]` / non-newline rather than `\s` — otherwise
 * `paperclip-safe-env\nenv` is a *whole-command* match (JS `$` without `m` is
 * end-of-input, and `\s` spans the newline) and the dump on line 2 rides in
 * under the exception.
 */
const SAFE_ENV_INSPECTION_RE =
  /^(?:node[ \t]+)?(?:[^\s;&|()<>]*\/)?(?:safe-env-inspect(?:\.mjs)?|paperclip-safe-env)(?:[ \t]+[^;&|()<>$\x60\r\n]*)?$/;

/**
 * Matches the `sh -c` / `bash -lc` prefix, WITHOUT requiring the payload to be
 * quoted.
 *
 * This deliberately mirrors `SHELL_COMMAND_PREFIX_RE` +
 * `readShellCommandArgument` in `server/src/agent-shell-guard.ts`, where the
 * same unquoted-wrapper bypass was closed in `993bf304c`. Converging on that
 * shape rather than inventing a third one is a point of vendoring.
 *
 * The previous pattern required a quoted payload (`(["'])([\s\S]*)\1`), so
 * `sh -c env` was never unwrapped at all and reached the detector intact.
 */
const SHELL_COMMAND_PREFIX_RE = /^(?:\/bin\/)?(?:ba|z|)?sh\s+-l?c(?:\s+|$)/;

/**
 * Reads the argument to `sh -c`, quoted or bare.
 *
 * A bare argument is the first whitespace-delimited token, which is what the
 * shell itself does: in `sh -c env ls`, `env` is the command and `ls` becomes
 * `$0`. Taking only the first token is accurate, not a shortcut.
 */
function readShellCommandArgument(input: string): string {
  const rest = input.trimStart();
  if (!rest) return "";
  const quote = rest[0];
  if (quote === "'" || quote === '"') {
    let out = "";
    for (let i = 1; i < rest.length; i += 1) {
      const ch = rest[i];
      if (ch === quote) return out;
      if (quote === '"' && ch === "\\" && i + 1 < rest.length) {
        i += 1;
        out += rest[i] ?? "";
      } else {
        out += ch;
      }
    }
    return out;
  }
  return /^[^\s]+/.exec(rest)?.[0] ?? "";
}

/**
 * Characters that end one command and begin another, for the purposes of the
 * dump detector.
 *
 * `\r` / `\n` are separators for the same reason `;` is: in a multi-line command
 * string each line is its own command, so `echo ok\nenv` is a dump.
 *
 * `(` / `)` / a backtick (`\x60`, spelled as an escape because this file embeds
 * the same pattern inside a backtick-delimited `String.raw` template below) make
 * command *substitution* a boundary as well. Without them `echo "$(env)"`,
 * `X=$(printenv)` and `` `env` `` all reached the detector with `(` sitting
 * where a boundary was required, matched nothing, and returned `allow` — a full
 * dump straight into the transcript, which is the exact leak this guard exists
 * to stop.
 *
 * Like `;`, this is deliberately parser-free and errs toward blocking — a bare
 * `env` line inside a quoted string or heredoc also matches, exactly as
 * `echo "a; env"` already did. The safe helper remains the unblocked path.
 */
const CMD_BOUNDARY = String.raw`;&|()\x60\r\n`;

/**
 * Where a *new command word* may begin, for the leading side of the detector
 * only.
 *
 * `CMD_BOUNDARY` covers shell punctuation, but a dump is equally reachable as a
 * bare argument to a command-introducing wrapper, separated by nothing but a
 * space: `sh -c env`, `bash -c printenv`, `eval env`, `xargs env`,
 * `nohup env`, `timeout 5 env`, `su -c env`. Shell unwrapping only ever handles
 * a `sh -c` prefix (and, before `993bf304c`'s shape was adopted below, only a
 * *quoted* payload), so these reached the detector with a
 * space sitting where a boundary was required, matched nothing, and returned
 * `allow` — a full dump, which is the exact leak this guard exists to stop.
 * Measured before this change: 9 of 9 such payloads were allowed by the real
 * spawned pod script.
 *
 * Rather than enumerate wrapper utilities (an open-ended list — `nice`,
 * `stdbuf`, `setsid`, `flock`, `chroot`, `script -c`, … all qualify), treat
 * whitespace itself as a possible command start. This closes the whole class in
 * one rule instead of chasing each wrapper.
 *
 * Whitespace is deliberately NOT added to the *trailing* terminator, which stays
 * `CMD_BOUNDARY`: the trailing side is what distinguishes a dump from a command
 * that merely takes an operand, and `env NAME=value cmd` / `printenv HOME` /
 * `env -- ls` must stay allowed. Keeping the two classes distinct is what lets
 * `grep env file` through while blocking `sh -c env`.
 *
 * Residual over-block, accepted in the safe direction: operand-less mentions
 * such as `echo env`, `grep env` (reading stdin) and `command -v env` now block.
 * They are rare, harmless to block, and consistent with this file's existing
 * stance that a bare `env` inside a quoted string or heredoc also matches.
 */
const CMD_START = String.raw`${CMD_BOUNDARY} \t`;

/**
 * Option tokens that may follow `env` / `printenv` while the command is still a
 * full dump.
 *
 * `env` and `printenv` only stop dumping once given an *operand* — a command to
 * run (`env FOO=1 node x.js`) or a single variable to print (`printenv HOME`).
 * Flags alone do not: `env -0` / `printenv --null` dump the whole environment
 * NUL-separated, and `env -u PATH` dumps everything bar one variable. Requiring
 * a boundary immediately after the utility name therefore let every flag form
 * through. So: consume a run of option tokens, and treat the command as a dump
 * only if nothing but options separates the utility from the next boundary.
 *
 * `-u` / `--unset` are matched with their argument so that the NAME they consume
 * is not mistaken for an operand — otherwise `env -u PATH` would read as
 * "runs the command PATH" and be allowed.
 */
const ENV_DUMP_OPTION_RUN = String.raw`(?:[ \t]+(?:(?:-u|--unset)[ \t]+[^\s;&|()<>]+|-[^\s;&|()<>]*))*`;

const FULL_ENV_DUMP_RE = new RegExp(
  [
    String.raw`(?:^|[${CMD_START}]\s*)(?:command\s+)?(?:\/usr\/bin\/)?(?:env|printenv)${ENV_DUMP_OPTION_RUN}(?:\s*(?:[${CMD_BOUNDARY}]|$))`,
    String.raw`(?:^|[${CMD_START}]\s*)(?:set)(?:\s*(?:[${CMD_BOUNDARY}]|$))`,
    String.raw`(?:^|[${CMD_START}]\s*)export\s+-p(?:\s*(?:[${CMD_BOUNDARY}]|$))`,
    String.raw`(?:^|[${CMD_START}]\s*)declare\s+-x(?:\s*(?:[${CMD_BOUNDARY}]|$))`,
    String.raw`(?:^|[${CMD_START}]\s*)cat\s+\/proc\/(?:self|\d+)\/environ(?:\s*(?:[${CMD_BOUNDARY}]|$))`,
    String.raw`\/proc\/(?:self|\d+)\/environ`,
  ].join("|"),
  "i",
);

function unwrapShell(command: string): string {
  let current = command.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = SHELL_COMMAND_PREFIX_RE.exec(current);
    if (!match) return current;
    current = readShellCommandArgument(current.slice(match[0].length));
  }
  return current;
}

/**
 * Classify an agent shell command. `block` for a full-environment dump; `allow`
 * for the allowlisted names-only helper or any non-dump command.
 */
export function classifyAgentShellCommand(command: string): AgentShellCommandDecision {
  const normalized = unwrapShell(command).trim();
  if (!normalized) return { action: "allow", reason: "not_environment_dump" };
  if (SAFE_ENV_INSPECTION_RE.test(normalized)) return { action: "allow", reason: "safe_env_inspection" };
  if (FULL_ENV_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  return { action: "allow", reason: "not_environment_dump" };
}

/**
 * Standalone, zero-dependency Node script written into the agent pod and
 * invoked by the Claude Code PreToolUse hook. Reads the hook event JSON on
 * stdin; on a Bash full-environment dump it writes a value-free reason to
 * stderr and exits 2 (Claude Code blocks the tool and feeds stderr to the
 * model). Any parse/other error fails OPEN (exit 0) so the guard can never
 * wedge a run — the server-side redaction layer remains the backstop.
 *
 * Authored with regex *literals* (not `new RegExp(...)`) so the surrounding
 * `String.raw` preserves single backslashes verbatim — no double-escaping, no
 * backticks. Keep behaviourally identical to `classifyAgentShellCommand`
 * above; `env-guard.test.ts` runs the same command corpus through both.
 */
export const ENV_GUARD_SCRIPT = String.raw`#!/usr/bin/env node
// paperclip-env-guard.mjs — PEN-1305 Layer 1 PreToolUse guard. Generated by
// paperclip-adapter-claude-k8s; do not edit in the pod.
const SAFE_ENV_INSPECTION_RE =
  /^(?:node[ \t]+)?(?:[^\s;&|()<>]*\/)?(?:safe-env-inspect(?:\.mjs)?|paperclip-safe-env)(?:[ \t]+[^;&|()<>$\x60\r\n]*)?$/;
const SHELL_COMMAND_PREFIX_RE = /^(?:\/bin\/)?(?:ba|z|)?sh\s+-l?c(?:\s+|$)/;
function readShellCommandArgument(input) {
  const rest = String(input || "").replace(/^\s+/, "");
  if (!rest) return "";
  const quote = rest[0];
  if (quote === "'" || quote === '"') {
    let out = "";
    for (let i = 1; i < rest.length; i += 1) {
      const ch = rest[i];
      if (ch === quote) return out;
      if (quote === '"' && ch === "\\" && i + 1 < rest.length) {
        i += 1;
        out += rest[i] != null ? rest[i] : "";
      } else {
        out += ch;
      }
    }
    return out;
  }
  const m = /^[^\s]+/.exec(rest);
  return m ? m[0] : "";
}
const FULL_ENV_DUMP_RE = /(?:^|[;&|()\x60\r\n \t]\s*)(?:command\s+)?(?:\/usr\/bin\/)?(?:env|printenv)(?:[ \t]+(?:(?:-u|--unset)[ \t]+[^\s;&|()<>]+|-[^\s;&|()<>]*))*(?:\s*(?:[;&|()\x60\r\n]|$))|(?:^|[;&|()\x60\r\n \t]\s*)(?:set)(?:\s*(?:[;&|()\x60\r\n]|$))|(?:^|[;&|()\x60\r\n \t]\s*)export\s+-p(?:\s*(?:[;&|()\x60\r\n]|$))|(?:^|[;&|()\x60\r\n \t]\s*)declare\s+-x(?:\s*(?:[;&|()\x60\r\n]|$))|(?:^|[;&|()\x60\r\n \t]\s*)cat\s+\/proc\/(?:self|\d+)\/environ(?:\s*(?:[;&|()\x60\r\n]|$))|\/proc\/(?:self|\d+)\/environ/i;
function unwrapShell(command) {
  let current = String(command || "").trim();
  for (let i = 0; i < 3; i += 1) {
    const match = SHELL_COMMAND_PREFIX_RE.exec(current);
    if (!match) return current;
    current = readShellCommandArgument(current.slice(match[0].length));
  }
  return current;
}
function isFullEnvDump(command) {
  const normalized = unwrapShell(command).trim();
  if (!normalized) return false;
  if (SAFE_ENV_INSPECTION_RE.test(normalized)) return false;
  return FULL_ENV_DUMP_RE.test(normalized);
}
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const evt = JSON.parse(raw || "{}");
    const tool = evt.tool_name || evt.toolName || "";
    const input = evt.tool_input || evt.toolInput || {};
    const command = input.command || input.cmd || "";
    if (/^(?:Bash|Shell)$/i.test(String(tool)) && command && isFullEnvDump(String(command))) {
      const home = process.env.HOME || "/paperclip";
      process.stderr.write(
        "Blocked by Paperclip env-guard (PEN-1305): full-environment dumps " +
          "(env/printenv/set/export -p/declare -x/cat /proc/*/environ) are disallowed " +
          "because they leak secret-bearing runtime variables into the run transcript. " +
          "To inspect environment variable NAMES safely, run: node " +
          home + "/.claude/safe-env-inspect.mjs\n",
      );
      process.exit(2);
    }
  } catch (_e) {
    // Fail open: never wedge a run on guard error; server-side redaction backstops.
  }
  process.exit(0);
});
`;

/**
 * Names-only environment inspection helper — the allowlisted alternative the
 * guard whitelists (`safe-env-inspect`). Prints variable NAMES, never values.
 */
export const SAFE_ENV_INSPECT_SCRIPT = String.raw`#!/usr/bin/env node
// safe-env-inspect.mjs — PEN-1305 allowlisted env inspection: NAMES ONLY, never values.
for (const name of Object.keys(process.env).sort()) console.log(name);
`;

/**
 * Idempotent settings-merge script (runs via `node -`). Adds a Bash-matcher
 * PreToolUse hook to the runtime's `settings.json` only if an identical command
 * entry is not already present, preserving any existing hooks (e.g. Claude
 * Code's installed Stop hook).
 */
const SETTINGS_MERGE_SCRIPT = String.raw`const fs=require("fs"),p=require("path");const dir=process.env.CLAUDE_CONFIG_DIR||(process.env.HOME||"/paperclip")+"/.claude";const f=p.join(dir,"settings.json");let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))||{}}catch(e){}if(typeof s!=="object"||s===null)s={};s.hooks=s.hooks||{};const list=Array.isArray(s.hooks.PreToolUse)?s.hooks.PreToolUse:[];const cmd="node "+p.join(dir,"paperclip-env-guard.mjs");const has=list.some(g=>g&&Array.isArray(g.hooks)&&g.hooks.some(h=>h&&h.command===cmd));if(!has)list.push({matcher:"Bash",hooks:[{type:"command",command:cmd}]});s.hooks.PreToolUse=list;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(f,JSON.stringify(s,null,2));`;

/**
 * Build a `;`-joinable shell fragment that installs the guard + safe helper and
 * merges the PreToolUse hook into `settings.json`. Scripts are base64-embedded
 * so arbitrary JS survives `sh -c` with no quoting hazard. Runs in the MAIN
 * container (which has `node`; the init container is busybox). Fails open on
 * merge error so it can never block a run from starting.
 */
export function buildEnvGuardSetupShell(): string {
  const guardB64 = Buffer.from(ENV_GUARD_SCRIPT, "utf8").toString("base64");
  const helperB64 = Buffer.from(SAFE_ENV_INSPECT_SCRIPT, "utf8").toString("base64");
  const mergeB64 = Buffer.from(SETTINGS_MERGE_SCRIPT, "utf8").toString("base64");
  return [
    `GUARD_DIR="\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}"`,
    `mkdir -p "\$GUARD_DIR"`,
    `printf %s '${guardB64}' | base64 -d > "\$GUARD_DIR/paperclip-env-guard.mjs"`,
    `printf %s '${helperB64}' | base64 -d > "\$GUARD_DIR/safe-env-inspect.mjs"`,
    `printf %s '${mergeB64}' | base64 -d | node - 2>/dev/null || echo "[paperclip-env-guard] settings merge skipped" >&2`,
  ].join("; ");
}
