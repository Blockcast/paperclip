export type AgentShellCommandDecision =
  | { action: "allow"; reason: "safe_env_inspection" | "not_environment_dump" }
  | { action: "block"; reason: "full_environment_dump" };

// BLO-20989 Ally review round 2 (critical, still-present): the trailing-args
// wildcard `(?:\s+\S+)*` accepted ANY whitespace-separated token after the
// helper path, including shell metacharacters — `scripts/safe-env-inspect.mjs
// $(printenv >&2)` matched this allowlist even though the shell still runs
// the substitution before the helper ever starts. The helper
// (scripts/safe-env-inspect.mjs) only recognizes `--json`; the allowlist now
// only recognizes that (and the pre-existing `--names-only` alias some
// callers use), so any other trailing text — including composition — falls
// out of "safe_env_inspection" and is re-evaluated by the dangerous-pattern
// checks below instead of riding through unconditionally.
const SAFE_ENV_INSPECTION_TARGET_RE = String.raw`(?:\.\/scripts\/safe-env-inspect\.mjs|scripts\/safe-env-inspect\.mjs|safe-env-inspect|paperclip-safe-env)`;
const SAFE_ENV_INSPECTION_ALLOWED_FLAG_RE = String.raw`(?:--json|--names-only)`;
const SAFE_ENV_INSPECTION_ONLY_RE = new RegExp(
  `^(?:(?:node|nodejs|bun|deno\\s+run|ts-node|tsx)\\s+)?${SAFE_ENV_INSPECTION_TARGET_RE}(?:\\s+${SAFE_ENV_INSPECTION_ALLOWED_FLAG_RE})*$`,
  "i",
);

// Preserved from master 7433a7e4 ("block indirect env reconstruction"): Bash
// indirect expansion (`for k in $(safe-env-inspect); do echo "${!k}"; done`)
// rebuilds the whole environment one key at a time out of the names-only
// inspector's own output. Master gated that rule on an *unanchored* "is the
// inspector mentioned anywhere" test; SAFE_ENV_INSPECTION_ONLY_RE above is
// anchored and by construction never matches a composed command, so it cannot
// carry the rule. Keeping master's mention test here — used only for this
// check, never to allow anything — preserves that protection through the merge.
const SAFE_ENV_INSPECTION_MENTION_RE = new RegExp(
  String.raw`(?:^|[\s;&|()])${SAFE_ENV_INSPECTION_TARGET_RE}(?=[\s;&|()]|$)`,
);
const BASH_INDIRECT_EXPANSION_RE = /\$\{![^}\r\n]+\}/;
const SHELL_COMMAND_PREFIX_RE = /^(?:\/bin\/)?(?:ba|z|)?sh\s+-l?c(?:\s+|$)/;

// BLO-20989 Ally review round 2 (critical): the original boundary classes
// (`^` or `[;&|]`) only recognized a dangerous verb at the start of a
// top-level shell statement. `$(`, backtick, and process-substitution `<(`
// `>(` all open a new command position mid-expression, and a redirection
// (`>`, `<`) after the verb is still a bare, argument-less full dump — it
// just sends the output somewhere other than stdout. `\x60` is a backtick;
// written as an escape so it doesn't collide with the template-literal
// delimiters used elsewhere in this file.
const CMD_START_RE = String.raw`(?:^|[;&|(\x60]\s*)`;
const CMD_END_RE = String.raw`(?:\s*(?:[;&|)\x60<>]|$))`;
const FULL_ENV_DUMP_RE = new RegExp(
  [
    `${CMD_START_RE}(?:command\\s+)?(?:\\/usr\\/bin\\/)?(?:env|printenv)(?:\\s+(?:-0|--null))?${CMD_END_RE}`,
    `${CMD_START_RE}(?:set)${CMD_END_RE}`,
    `${CMD_START_RE}export\\s+-p${CMD_END_RE}`,
    `${CMD_START_RE}declare\\s+-x${CMD_END_RE}`,
    `${CMD_START_RE}cat\\s+\\/proc\\/(?:self|\\d+)\\/environ${CMD_END_RE}`,
    String.raw`\/proc\/(?:self|\d+)\/environ`,
  ].join("|"),
  "i",
);

// GNU `env` prints the resulting environment when it has options and/or
// NAME=VALUE assignments but no command to launch. Keep the no-command case
// separate from FULL_ENV_DUMP_RE so that a real launcher such as
// `env FOO=bar node ...` remains available to the interpreter checks below.
// The option-value forms cover both separated and `=` spellings; shell-word
// quoting keeps values such as `env -S 'printf %s'` in one token.
const SHELL_WORD_RE = String.raw`(?:'[^']*'|"(?:\\.|[^"])*"|[^\s;&|()<>]+)`;
const ENV_NO_COMMAND_DUMP_ARGUMENT_RE = String.raw`(?:--(?:unset|chdir|split-string)(?:=${SHELL_WORD_RE}|\s+${SHELL_WORD_RE})?|--(?:ignore-environment|null)|--|-(?:[i0]*[uCS](?:${SHELL_WORD_RE}|\s+${SHELL_WORD_RE})?|[A-Za-z0-9]+)|[A-Za-z_][\w]*=${SHELL_WORD_RE}?)`;
const ENV_NO_COMMAND_DUMP_RE = new RegExp(
  `${CMD_START_RE}(?:command\\s+)?(?:\\/usr\\/bin\\/)?env(?:\\s+${ENV_NO_COMMAND_DUMP_ARGUMENT_RE})*${CMD_END_RE}`,
  "i",
);

// BLO-20989 review: `printenv`/`env` given a *variable* argument (rather than
// a literal known name like `printenv PATH`) reads an attacker-/loop-chosen
// key by value. Composed with any source of key names — safe-env-inspect's
// output, a manual list, another env var — this reconstructs the full
// environment one key at a time without any single call matching
// FULL_ENV_DUMP_RE. The scoped-read exception was only ever meant to cover a
// literal name typed by the agent, so any `$`-prefixed argument is blocked.
const ENV_READ_BY_VARIABLE_RE = /\b(?:printenv|env)\b\s+["']?\$/i;

// BLO-20989 Ally review round 2 (critical): `node scripts/safe-env-inspect.mjs
// | xargs -n1 printenv` reconstructs the full environment by invoking
// `printenv` once per name emitted by the (otherwise safe) inspector. No
// single boundary-anchored check above sees this because `printenv` sits
// after an `xargs` flag, not directly after a command boundary.
const XARGS_ENV_RE = /\bxargs\b[^;&|]*\b(?:printenv|env)\b/i;

// BLO-20989: env-guard blocked shell-native env dumps but not a Node/Python
// process reading its own environment inline. An agent that hits the guard
// above and improvises lands here within one tool call — that's exactly how
// DATABASE_URL leaked. Gate on the interpreter's inline-eval flag (so grep
// output that happens to contain "process.env)" isn't misclassified) and
// require a bulk-access shape: bare `process.env`/`os.environ`, or one of the
// enumeration idioms (Object.keys/values/entries, JSON.stringify, spread,
// for-in, dict()/list()/**-unpack, .items()/.keys()/.values()/.copy()). A
// single named property access (`process.env.FOO`, `os.environ['FOO']`)
// stays allowed, mirroring the existing `printenv PATH` scoped-read
// exception. Covers absolute/relative interpreter paths (`/usr/bin/node`),
// `-p`/`--print`, and stdin-script forms (`python3 - <<'PY'`).
//
// BLO-20989 Ally review round 2 (important): the flag had to sit immediately
// after the interpreter, so `node --no-warnings -e ...`, `node -pe ...`, and
// `python3 -I -c ...` all slipped through. The flag is now found by consuming
// any number of leading flag-shaped tokens first, and combined short flags
// (`-pe`/`-ep`) are recognized directly. Piped stdin (`... | node`, with no
// script file and no eval flag at all) is covered by its own alternative.
//
// The command-position prefix deliberately does not treat arbitrary
// whitespace as a new command. Launcher builtins are consumed explicitly so
// `command node ...` and `/usr/bin/env node ...` are normalized to the same
// interpreter invocation as a bare `node ...` command.
const COMMAND_POSITION_RE = String.raw`(?:^|[;&|()\x60]|\r?\n)\s*`;
const SHELL_ASSIGNMENT_RE = String.raw`(?:(?:[A-Za-z_][\w]*)=[^\s;&|()]+\s+)*`;
const COMMAND_BUILTIN_LAUNCHER_RE = String.raw`command(?:\s+(?:--|-[\w-]+))*\s+`;
const ENV_LAUNCHER_ARGUMENT_RE = String.raw`(?:-(?:u|C|S)\s+[^\s;&|()]+|--(?:unset|chdir|split-string)\s+[^\s;&|()]+|--(?:unset|chdir|split-string)=[^\s;&|()]+|--|-[\w-]+(?:=[^\s;&|()]+)?|[A-Za-z_][\w]*=[^\s;&|()]+)`;
const ENV_LAUNCHER_RE = String.raw`(?:\/usr\/bin\/)?env(?:\s+${ENV_LAUNCHER_ARGUMENT_RE})*\s+`;
// `env` can launch another env-dump command after applying its own options or
// assignments. The inner command must be bare (apart from null-format flags)
// so scoped forms such as `env -u NAME printenv PATH` remain allowed.
const ENV_WRAPPED_DUMP_RE = new RegExp(
  `${CMD_START_RE}(?:command\\s+)?(?:\\/usr\\/bin\\/)?env(?:\\s+${ENV_LAUNCHER_ARGUMENT_RE})*\\s+(?:\\/usr\\/bin\\/)?(?:env|printenv)(?:\\s+(?:-0|--null))?${CMD_END_RE}`,
  "i",
);
const INTERPRETER_LAUNCHER_RE = String.raw`${SHELL_ASSIGNMENT_RE}(?:(?:${COMMAND_BUILTIN_LAUNCHER_RE})|(?:${ENV_LAUNCHER_RE}))?`;
const INTERPRETER_PATH_PREFIX_RE = String.raw`(?:[\w./-]*\/)?`;
// Keep scanning past runtime options that carry either an attached value
// (`--input-type=commonjs`) or a separate value (`--input-type commonjs`).
// The negative lookahead prevents a value-consuming option from swallowing
// the next option or the eval flag itself.
const FLAG_TOKEN_RE = String.raw`(?:--?[\w-]+(?:=[^\s;&|()]+)?(?:\s+(?!-)[^\s;&|()]+)?)`;
const PIPED_INTERPRETER_OPTION_RE = String.raw`(?:--?[\w-]+(?:=[^\s;&|()]+|\s+(?!-)[^\s;&|()]+)?)`;
const PIPED_INTERPRETER_OPTIONS_RE = String.raw`(?:\s+${PIPED_INTERPRETER_OPTION_RE})*`;
const NODE_LIKE_RE = String.raw`(?:node|nodejs|bun|deno\s+run|ts-node|tsx)`;
const NODE_LIKE_BARE_RE = String.raw`(?:node|nodejs|bun|deno|ts-node|tsx)`;
const PYTHON_RE = String.raw`python3?(?:\.\d+)?`;
// Python accepts `-c` attached to its source, including combined short-option
// forms such as `-Ic'import os; print(os.environ)'`. The normal option loop
// treats that whole token as a runtime flag, so recognize the attached eval
// form explicitly before it can be consumed as one.
const PYTHON_ATTACHED_EVAL_RE = String.raw`-[A-Za-z]*c(?=\S)`;
const INLINE_INTERPRETER_RE = new RegExp(
  [
    `${COMMAND_POSITION_RE}${INTERPRETER_LAUNCHER_RE}${INTERPRETER_PATH_PREFIX_RE}${NODE_LIKE_RE}\\b(?:\\s+${FLAG_TOKEN_RE})*\\s+-{1,2}(?:e|eval|p|print|pe|ep)\\b`,
    `${COMMAND_POSITION_RE}${INTERPRETER_LAUNCHER_RE}${INTERPRETER_PATH_PREFIX_RE}${PYTHON_RE}\\b(?:\\s+${FLAG_TOKEN_RE})*\\s+-{1,2}(?:c|command)\\b`,
    `${COMMAND_POSITION_RE}${INTERPRETER_LAUNCHER_RE}${INTERPRETER_PATH_PREFIX_RE}${PYTHON_RE}\\b\\s+${PYTHON_ATTACHED_EVAL_RE}`,
    String.raw`${COMMAND_POSITION_RE}${INTERPRETER_LAUNCHER_RE}${INTERPRETER_PATH_PREFIX_RE}(?:node|nodejs|bun|deno|python3?(?:\.\d+)?|ts-node|tsx)\s*(?:-\s*)?<<-?['"]?\S`,
    `\\|\\s*${INTERPRETER_LAUNCHER_RE}${INTERPRETER_PATH_PREFIX_RE}(?:${NODE_LIKE_BARE_RE}|${PYTHON_RE})\\b${PIPED_INTERPRETER_OPTIONS_RE}\\s*(?:[;&|]|$)`,
  ].join("|"),
  "i",
);

// BLO-20989 Ally review round 2 (important): the bulk-access boundary was a
// finite spelling list that missed destructuring (`const {env} = process`),
// `require("node:process").env`, `from os import environ` (Python's import
// aliasing), and a *dynamically indexed* bracket/`.get()` read
// (`process.env[process.argv[1]]`, `os.environ[key]`) — which reconstructs
// every value the same way the blocked `printenv $VAR` shell form does, just
// in a host language. A literal-quoted index (`process.env['FOO']`,
// `os.environ.get("FOO")`) stays allowed as a scoped read.
// Accept redundant grouping around the process object as well as the direct
// spelling. Grouping does not change the value being read, so `(process).env`
// must receive the same bulk-access treatment as `process.env`.
const JS_PROCESS_ENV_PATH_RE = String.raw`(?:(?:(?:globalThis|global)\s*(?:\?\.\s*|\.\s*))?process\s*(?:\?\.\s*|\.\s*)env|(?:\(\s*)+(?:(?:globalThis|global)\s*(?:\?\.\s*|\.\s*))?process(?:\s*\))+\s*(?:\?\.\s*|\.\s*)env)`;
const ENV_BULK_ACCESS_RE = new RegExp(
  [
    String.raw`process\.env\s*(?:[,)\]};'"]|$)`,
    String.raw`process\s*\[\s*["']env["']\s*\]`,
    String.raw`process\.env\s*\[\s*[^"'\]\s]`,
    // Reflective access can return the environment object without spelling
    // `.env`; reject process-object lookups conservatively, including grouped
    // process expressions and the computed Reflect["get"] spelling.
    String.raw`\bReflect\s*(?:\.\s*get|\[\s*["']get["']\s*\])\s*\(\s*(?:\(\s*)*(?:globalThis\s*(?:\?\.\s*|\.\s*))?process(?:\s*\))*\s*,`,
    String.raw`Object\.(?:keys|values|entries|assign)\s*\(\s*process\.env\s*\)`,
    String.raw`JSON\.stringify\s*\(\s*process\.env\b`,
    String.raw`\.\.\.\s*process\.env\b`,
    String.raw`\bin\s+process\.env\b`,
    String.raw`\{\s*env\s*\}\s*=\s*process\b[\s\S]*?\benv\s*(?:[,)\]};'"]|$)`,
    String.raw`require\s*\(\s*["'](?:node:)?process["']\s*\)\s*\.env\s*(?:[,)\]};'"]|$)`,
    String.raw`os\.environ\s*(?:[,)\]};'"]|$)`,
    String.raw`os\.environ\s*\[\s*[^"'\]\s]`,
    String.raw`os\.environ\s*\.\s*get\s*\(\s*[^"'\)\s]`,
    String.raw`os\.environ\s*\.\s*(?:items|keys|values|copy)\s*\(\s*\)`,
    String.raw`dict\s*\(\s*os\.environ\s*\)`,
    String.raw`list\s*\(\s*os\.environ\s*\)`,
    String.raw`\*\*\s*os\.environ\b`,
    String.raw`from\s+os\s+import\s+environ\b[\s\S]*?\benviron\s*(?:[,)\]};'"]|$)`,
    String.raw`from\s+os\s+import\s+environ\b[\s\S]*?\benviron\s*\[\s*[^"'\]\s]`,
    String.raw`from\s+os\s+import\s+environ\b[\s\S]*?\benviron\s*\.\s*get\s*\(\s*[^"'\)\s]`,
    String.raw`from\s+os\s+import\s+environ\b[\s\S]*?\benviron\s*\.\s*(?:items|keys|values|copy)\s*\(\s*\)`,
    String.raw`from\s+os\s+import\s+environ\b[\s\S]*?\b(?:dict|list)\s*\(\s*environ\s*\)`,
    String.raw`from\s+os\s+import\s+environ\b[\s\S]*?\*\*\s*environ\b`,
  ].join("|"),
  "i",
);

// Ally review (PR #971): destructuring and module aliases can carry the
// complete environment object just as directly as process.env/os.environ.
// Keep literal single-key reads allowed, matching the unaliased forms above.
const JS_ENV_ALIAS_DECLARATION_RE = /\{[^{}]*?\benv\s*:\s*([$A-Z_a-z][$\w]*)[^{}]*?\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/gi;
const PYTHON_OS_ALIAS_IMPORT_RE = /\bimport\s+os\s+as\s+([A-Za-z_][\w]*)/gi;
const PYTHON_ENV_ALIAS_IMPORT_RE = /\bfrom\s+os\s+import\s+environ\s+as\s+([A-Za-z_][\w]*)/gi;
const JS_IDENTIFIER_RE = String.raw`[$A-Z_a-z][$\w]*`;
const PYTHON_IDENTIFIER_RE = String.raw`[A-Za-z_][\w]*`;
const JS_SIMPLE_ALIAS_ASSIGNMENT_RE = new RegExp(
  String.raw`(?:\b(?:const|let|var)\s+|(?<![$\w.]))(${JS_IDENTIFIER_RE})\s*=(?!=)\s*((?:\(\s*)*${JS_IDENTIFIER_RE}(?:\s*(?:\?\.\s*|\.\s*)${JS_IDENTIFIER_RE})*(?:\s*\))*)(?=\s*(?:[;,)'"\r\n]|$))`,
  "g",
);
const PYTHON_SIMPLE_ALIAS_ASSIGNMENT_RE = new RegExp(
  String.raw`(?<![\w.])(${PYTHON_IDENTIFIER_RE})\s*=(?!=)\s*((?:\(\s*)*${PYTHON_IDENTIFIER_RE}(?:\s*\.\s*${PYTHON_IDENTIFIER_RE})*(?:\s*\))*)(?=\s*(?:[;,)'"\r\n]|$))`,
  "g",
);

function escapeIdentifierForRegExp(input: string): string {
  return input.replaceAll("$", "\\$");
}

function quotedLiteralEnd(input: string, start: number): number | null {
  const quote = input[start];
  if (quote !== "'" && quote !== '"') return null;
  for (let i = start + 1; i < input.length; i += 1) {
    if (input[i] === "\\") {
      i += 1;
      continue;
    }
    if (input[i] === quote) return i + 1;
  }
  return null;
}

function hasStaticLiteralIndex(input: string): boolean {
  const prefix = /^\s*\[\s*/.exec(input);
  if (!prefix) return false;
  const end = quotedLiteralEnd(input, prefix[0].length);
  return end !== null && /^\s*\]/.test(input.slice(end));
}

function staticSimpleLiteralIndexValue(input: string): string | null {
  const prefix = /^\s*\[\s*/.exec(input);
  if (!prefix) return null;
  const start = prefix[0].length;
  const end = quotedLiteralEnd(input, start);
  if (end === null || !/^\s*\]/.test(input.slice(end))) return null;
  const value = input.slice(start + 1, end - 1);
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : null;
}

function hasUnsafeComputedJavaScriptProcessAccess(command: string): boolean {
  const processIndex = /\bprocess\s*(?:\?\.\s*)?\[/gi;
  let match: RegExpExecArray | null;
  while ((match = processIndex.exec(command))) {
    const property = staticSimpleLiteralIndexValue(command.slice(processIndex.lastIndex - 1));
    if (property === null || property === "env") return true;
  }

  const globalIndex = /\b(?:globalThis|global)\s*(?:\?\.\s*)?\[/gi;
  while ((match = globalIndex.exec(command))) {
    const property = staticSimpleLiteralIndexValue(command.slice(globalIndex.lastIndex - 1));
    if (property === null || property === "process") return true;
  }
  return false;
}

function hasUnsafeDynamicJavaScriptEnvironmentIndex(command: string): boolean {
  const indexStart = new RegExp(`${JS_PROCESS_ENV_PATH_RE}\\s*\\[`, "gi");
  let match: RegExpExecArray | null;
  while ((match = indexStart.exec(command))) {
    if (!hasStaticLiteralIndex(command.slice(indexStart.lastIndex - 1))) return true;
  }
  return false;
}

function hasStaticLiteralGet(input: string): boolean {
  const prefix = /^\s*\.\s*get\s*\(\s*(?:key\s*=\s*)?/.exec(input);
  if (!prefix) return false;
  const end = quotedLiteralEnd(input, prefix[0].length);
  return end !== null && /^\s*(?:\)|,)/.test(input.slice(end));
}

function hasScopedJavaScriptEnvironmentRead(input: string): boolean {
  return /^\s*(?:\.|\?\.)\s*[$A-Z_a-z][$\w]*/.test(input) || hasStaticLiteralIndex(input);
}

function hasScopedPythonEnvironmentRead(input: string): boolean {
  return hasStaticLiteralIndex(input) || hasStaticLiteralGet(input);
}

function hasUnsafeEnvironmentReference(
  command: string,
  reference: RegExp,
  isScopedRead: (input: string) => boolean,
): boolean {
  reference.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = reference.exec(command))) {
    if (!isScopedRead(command.slice(reference.lastIndex))) return true;
  }
  return false;
}

function hasUnsafeAliasedEnvironmentReference(
  command: string,
  declaration: RegExp,
  makeReference: (alias: string) => RegExp,
  isScopedRead: (input: string) => boolean,
): boolean {
  declaration.lastIndex = 0;
  let declarationMatch: RegExpExecArray | null;
  while ((declarationMatch = declaration.exec(command))) {
    const alias = declarationMatch[1];
    if (!alias) continue;
    const remainder = command.slice(declaration.lastIndex);
    const reference = makeReference(alias);
    let referenceMatch: RegExpExecArray | null;
    while ((referenceMatch = reference.exec(remainder))) {
      if (!isScopedRead(remainder.slice(reference.lastIndex))) return true;
    }
  }
  return false;
}

function simpleAssignedAliases(
  command: string,
  assignment: RegExp,
  initialAliases: ReadonlyMap<string, number>,
): Map<string, number> {
  const aliases = new Map(initialAliases);
  assignment.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(command))) {
    const alias = match[1];
    const value = match[2]?.replaceAll(/\s|[()]/g, "").replaceAll("?.", ".");
    if (!alias || !value || !aliases.has(value)) continue;
    aliases.set(alias, assignment.lastIndex);
  }
  return aliases;
}

function identifierReference(alias: string): string {
  return `(?<![$\\w])${escapeIdentifierForRegExp(alias)}(?![$\\w])`;
}

function groupedIdentifierReference(alias: string): string {
  return `(?:\\(\\s*)*${identifierReference(alias)}(?:\\s*\\))*`;
}

// Ordinary assignments preserve access to the same host object. Resolve
// direct and chained aliases before applying the existing scoped-read rules.
function hasUnsafeSimpleAssignedEnvironmentAlias(command: string): boolean {
  const javascriptProcessAliases = simpleAssignedAliases(
    command,
    JS_SIMPLE_ALIAS_ASSIGNMENT_RE,
    new Map<string, number>([
      ["process", 0],
      ["globalThis.process", 0],
      ["global.process", 0],
    ]),
  );
  for (const [alias, assignedAt] of javascriptProcessAliases) {
    if (assignedAt === 0) continue;
    const remainder = command.slice(assignedAt);
    const object = groupedIdentifierReference(alias);
    const environmentReference = new RegExp(
      `${object}\\s*(?:(?:\\?\\.\\s*|\\.\\s*)env\\b|(?:\\?\\.\\s*)?\\[\\s*["']env["']\\s*\\])`,
      "g",
    );
    const computedReference = new RegExp(
      `${object}\\s*(?:\\?\\.\\s*)?\\[`,
      "g",
    );
    let computedMatch: RegExpExecArray | null;
    while ((computedMatch = computedReference.exec(remainder))) {
      const bracketStart = computedMatch.index + computedMatch[0].lastIndexOf("[");
      const property = staticSimpleLiteralIndexValue(remainder.slice(bracketStart));
      if (property === null) return true;
    }
    if (hasUnsafeEnvironmentReference(remainder, environmentReference, hasScopedJavaScriptEnvironmentRead)) {
      return true;
    }
    const reflectiveReference = new RegExp(
      `\\bReflect\\s*(?:\\.\\s*get|\\[\\s*["']get["']\\s*\\])\\s*\\(\\s*${object}\\s*,`,
      "g",
    );
    if (reflectiveReference.test(remainder)) return true;
  }

  const initialPythonOsAliases = new Map<string, number>([["os", 0]]);
  PYTHON_OS_ALIAS_IMPORT_RE.lastIndex = 0;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = PYTHON_OS_ALIAS_IMPORT_RE.exec(command))) {
    if (importMatch[1]) initialPythonOsAliases.set(importMatch[1], PYTHON_OS_ALIAS_IMPORT_RE.lastIndex);
  }
  const pythonOsAliases = simpleAssignedAliases(
    command,
    PYTHON_SIMPLE_ALIAS_ASSIGNMENT_RE,
    initialPythonOsAliases,
  );
  for (const [alias, assignedAt] of pythonOsAliases) {
    if (assignedAt === 0) continue;
    const environmentReference = new RegExp(
      `${identifierReference(alias)}\\s*\\.\\s*environ\\b`,
      "g",
    );
    if (
      hasUnsafeEnvironmentReference(
        command.slice(assignedAt),
        environmentReference,
        hasScopedPythonEnvironmentRead,
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsafeInlineEnvironmentAlias(command: string): boolean {
  return (
    hasUnsafeAliasedEnvironmentReference(
      command,
      JS_ENV_ALIAS_DECLARATION_RE,
      (alias) => new RegExp(`\\b${escapeIdentifierForRegExp(alias)}\\b`, "g"),
      hasScopedJavaScriptEnvironmentRead,
    )
    || hasUnsafeAliasedEnvironmentReference(
      command,
      PYTHON_OS_ALIAS_IMPORT_RE,
      (alias) => new RegExp(`\\b${escapeIdentifierForRegExp(alias)}\\s*\\.\\s*environ\\b`, "g"),
      hasScopedPythonEnvironmentRead,
    )
    || hasUnsafeAliasedEnvironmentReference(
      command,
      PYTHON_ENV_ALIAS_IMPORT_RE,
      (alias) => new RegExp(`\\b${escapeIdentifierForRegExp(alias)}\\b`, "g"),
      hasScopedPythonEnvironmentRead,
    )
  );
}

function hasUnsafeInlineEnvironmentReference(command: string): boolean {
  return (
    hasUnsafeComputedJavaScriptProcessAccess(command)
    || hasUnsafeDynamicJavaScriptEnvironmentIndex(command)
    || hasUnsafeSimpleAssignedEnvironmentAlias(command)
    || hasUnsafeEnvironmentReference(
      command,
      new RegExp(`${JS_PROCESS_ENV_PATH_RE}\\b`, "gi"),
      hasScopedJavaScriptEnvironmentRead,
    )
    || hasUnsafeEnvironmentReference(command, /\bos\.environ\b/g, hasScopedPythonEnvironmentRead)
    || hasUnsafeInlineEnvironmentAlias(command)
  );
}

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

function unwrapShell(command: string): string {
  let current = command.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = SHELL_COMMAND_PREFIX_RE.exec(current);
    if (!match) return current;
    current = readShellCommandArgument(current.slice(match[0].length));
  }
  return current;
}

export function classifyAgentShellCommand(command: string): AgentShellCommandDecision {
  const normalized = unwrapShell(command).trim();
  if (!normalized) return { action: "allow", reason: "not_environment_dump" };
  // Block checks run before the safe-inspection allow so a composed command
  // (inspector + something else) can never ride through on the substring
  // that used to match anywhere in the command — see SAFE_ENV_INSPECTION_ONLY_RE.
  if (FULL_ENV_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (ENV_NO_COMMAND_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (ENV_WRAPPED_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (ENV_READ_BY_VARIABLE_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (XARGS_ENV_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (
    INLINE_INTERPRETER_RE.test(normalized)
    && (ENV_BULK_ACCESS_RE.test(normalized) || hasUnsafeInlineEnvironmentReference(normalized))
  ) {
    return { action: "block", reason: "full_environment_dump" };
  }
  if (
    SAFE_ENV_INSPECTION_MENTION_RE.test(normalized) &&
    BASH_INDIRECT_EXPANSION_RE.test(normalized)
  ) {
    return { action: "block", reason: "full_environment_dump" };
  }
  if (SAFE_ENV_INSPECTION_ONLY_RE.test(normalized)) return { action: "allow", reason: "safe_env_inspection" };
  return { action: "allow", reason: "not_environment_dump" };
}
