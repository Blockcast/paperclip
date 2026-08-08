export type AgentShellCommandDecision =
  | { action: "allow"; reason: "safe_env_inspection" | "not_environment_dump" }
  | { action: "block"; reason: "full_environment_dump" };

// The names-only helper is safe only as the complete command. A substring
// allowlist let shell composition run a full dump before the helper started.
const SAFE_ENV_INSPECTION_TARGET_RE = String.raw`(?:\.\/scripts\/safe-env-inspect\.mjs|scripts\/safe-env-inspect\.mjs|safe-env-inspect|paperclip-safe-env)`;
const SAFE_ENV_INSPECTION_ALLOWED_FLAG_RE = String.raw`(?:--json|--names-only)`;
const SAFE_ENV_INSPECTION_ONLY_RE = new RegExp(
  `^(?:(?:node|nodejs|bun|deno\\s+run|ts-node|tsx)\\s+)?${SAFE_ENV_INSPECTION_TARGET_RE}(?:\\s+${SAFE_ENV_INSPECTION_ALLOWED_FLAG_RE})*$`,
  "i",
);

const SHELL_COMMAND_PREFIX_RE = /^(?:\/bin\/)?(?:ba|z|)?sh\s+-l?c(?:\s+|$)/;

// Shell substitutions and redirections introduce command boundaries too:
// `$(printenv)`, backticks, and `printenv >file` are all full dumps.
const CMD_START_RE = String.raw`(?:^|[;&|(\x60]\s*)`;
const CMD_END_RE = String.raw`(?:\s*(?:[;&|)\x60<>]|$))`;
const FULL_ENV_DUMP_RE = new RegExp(
  [
    `${CMD_START_RE}(?:command\\s+)?(?:\\/usr\\/bin\\/)?(?:env|printenv)${CMD_END_RE}`,
    `${CMD_START_RE}(?:set)${CMD_END_RE}`,
    `${CMD_START_RE}export\\s+-p${CMD_END_RE}`,
    `${CMD_START_RE}declare\\s+-x${CMD_END_RE}`,
    `${CMD_START_RE}cat\\s+\\/proc\\/(?:self|\\d+)\\/environ${CMD_END_RE}`,
    String.raw`\/proc\/(?:self|\d+)\/environ`,
  ].join("|"),
  "i",
);

// A dynamic shell variable turns a per-key read into a full-environment dump
// when it is fed from a list of names.
const ENV_READ_BY_VARIABLE_RE = /\b(?:printenv|env)\b\s+["']?\$/i;
const XARGS_ENV_RE = /\bxargs\b[^;&|]*\b(?:printenv|env)\b/i;

// Node/Python inline evaluation is the bypass that motivated BLO-20989. Keep
// literal single-key reads allowed, but block bulk references and enumeration.
const INTERPRETER_PATH_PREFIX_RE = String.raw`(?:[\w./-]*\/)?`;
const SHELL_WORD_RE = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|()]+)`;
const FLAG_TOKEN_RE = String.raw`(?:--?[\w-]+(?:=${SHELL_WORD_RE})?)`;
const FLAG_WITH_OPTIONAL_VALUE_RE = String.raw`(?:${FLAG_TOKEN_RE}(?:\s+(?!-)${SHELL_WORD_RE})?)`;
const NODE_LIKE_RE = String.raw`(?:node|nodejs|bun|deno\s+run|ts-node|tsx)`;
const NODE_LIKE_BARE_RE = String.raw`(?:node|nodejs|bun|deno|ts-node|tsx)`;
const PYTHON_RE = String.raw`python3?(?:\.\d+)?`;
const INLINE_INTERPRETER_RE = new RegExp(
  [
    `(?:^|[\\s;&|()\\x60])${INTERPRETER_PATH_PREFIX_RE}${NODE_LIKE_RE}\\b(?:\\s+${FLAG_WITH_OPTIONAL_VALUE_RE})*\\s+-{1,2}(?:e|eval|p|print|pe|ep)\\b`,
    `(?:^|[\\s;&|()\\x60])${INTERPRETER_PATH_PREFIX_RE}${PYTHON_RE}\\b(?:\\s+${FLAG_WITH_OPTIONAL_VALUE_RE})*\\s+-{1,2}(?:c|command)\\b`,
    String.raw`(?:^|[\s;&|()\x60])${INTERPRETER_PATH_PREFIX_RE}(?:node|nodejs|bun|deno|python3?(?:\.\d+)?|ts-node|tsx)\s*(?:-\s*)?<<-?['"]?\S`,
    `\\|\\s*${INTERPRETER_PATH_PREFIX_RE}(?:${NODE_LIKE_BARE_RE}|${PYTHON_RE})\\b\\s*(?:[;&|]|$)`,
  ].join("|"),
  "i",
);

const JS_ENV_REFERENCE_RE = /\bprocess\s*\.\s*env\b/gi;
const JS_ENV_ALIAS_DECLARATION_RE = /\{[^{}]*?\benv\s*(?::\s*([$A-Z_a-z][$\w]*))?[^{}]*?\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/gi;
const PYTHON_ENV_REFERENCE_RE = /\bos\s*\.\s*environ\b/gi;
const PYTHON_ENV_IMPORT_RE = /\bfrom\s+os\s+import\s+environ(?:\s+as\s+([A-Za-z_][\w]*))?/gi;
const PYTHON_OS_ALIAS_IMPORT_RE = /\bimport\s+os\s+as\s+([A-Za-z_][\w]*)/gi;

// Explicit bulk forms which do not use a normal `process.env`/`os.environ`
// member reference, plus the dynamic-index variants.
const ENV_BULK_ACCESS_RE = new RegExp(
  [
    String.raw`process\.env\s*(?:[,)\]};'"]|$)`,
    String.raw`process\s*\[\s*["']env["']\s*\]`,
    String.raw`process\.env\s*\[\s*[^"'\]\s]`,
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

function isQuotedLiteralIndex(input: string): boolean {
  return /^\s*\[\s*(["'])(?:\\.|(?!\1)[\s\S])*\1\s*\]/.test(input);
}

function hasScopedJavaScriptEnvironmentRead(input: string): boolean {
  return /^\s*\.\s*[$A-Z_a-z][$\w]*/.test(input) || isQuotedLiteralIndex(input);
}

function hasScopedPythonEnvironmentRead(input: string): boolean {
  return isQuotedLiteralIndex(input) || /^\s*\.\s*get\s*\(\s*(["'])(?:\\.|(?!\1)[\s\S])*\1/.test(input);
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

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUnsafeEnvironmentAliasReference(
  command: string,
  declaration: RegExp,
  defaultAlias: string,
  isScopedRead: (input: string) => boolean,
): boolean {
  declaration.lastIndex = 0;
  let declarationMatch: RegExpExecArray | null;
  while ((declarationMatch = declaration.exec(command))) {
    const alias = declarationMatch[1] ?? defaultAlias;
    const remainder = command.slice(declaration.lastIndex);
    const reference = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "g");
    let referenceMatch: RegExpExecArray | null;
    while ((referenceMatch = reference.exec(remainder))) {
      if (!isScopedRead(remainder.slice(reference.lastIndex))) return true;
    }
  }
  return false;
}

function hasUnsafePythonOsAliasReference(command: string): boolean {
  PYTHON_OS_ALIAS_IMPORT_RE.lastIndex = 0;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = PYTHON_OS_ALIAS_IMPORT_RE.exec(command))) {
    const remainder = command.slice(PYTHON_OS_ALIAS_IMPORT_RE.lastIndex);
    const reference = new RegExp(`\\b${escapeRegExp(importMatch[1] ?? "os")}\\s*\\.\\s*environ\\b`, "g");
    let referenceMatch: RegExpExecArray | null;
    while ((referenceMatch = reference.exec(remainder))) {
      if (!hasScopedPythonEnvironmentRead(remainder.slice(reference.lastIndex))) return true;
    }
  }
  return false;
}

function hasUnsafeInlineEnvironmentAccess(command: string): boolean {
  return (
    ENV_BULK_ACCESS_RE.test(command)
    || hasUnsafeEnvironmentReference(command, JS_ENV_REFERENCE_RE, hasScopedJavaScriptEnvironmentRead)
    || hasUnsafeEnvironmentReference(command, PYTHON_ENV_REFERENCE_RE, hasScopedPythonEnvironmentRead)
    || hasUnsafeEnvironmentAliasReference(
      command,
      JS_ENV_ALIAS_DECLARATION_RE,
      "env",
      hasScopedJavaScriptEnvironmentRead,
    )
    || hasUnsafeEnvironmentAliasReference(
      command,
      PYTHON_ENV_IMPORT_RE,
      "environ",
      hasScopedPythonEnvironmentRead,
    )
    || hasUnsafePythonOsAliasReference(command)
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
  if (FULL_ENV_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (ENV_READ_BY_VARIABLE_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (XARGS_ENV_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (INLINE_INTERPRETER_RE.test(normalized) && hasUnsafeInlineEnvironmentAccess(normalized)) {
    return { action: "block", reason: "full_environment_dump" };
  }
  if (SAFE_ENV_INSPECTION_ONLY_RE.test(normalized)) return { action: "allow", reason: "safe_env_inspection" };
  return { action: "allow", reason: "not_environment_dump" };
}
