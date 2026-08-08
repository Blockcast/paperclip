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

const INLINE_EVAL_SOURCE_RE = new RegExp(
  [
    `(?:^|[\\s;&|()\\x60])${INTERPRETER_PATH_PREFIX_RE}${NODE_LIKE_RE}\\b(?:\\s+${FLAG_WITH_OPTIONAL_VALUE_RE})*\\s+-{1,2}(?:e|eval|p|print|pe|ep)\\b(?:=|\\s+)`,
    `(?:^|[\\s;&|()\\x60])${INTERPRETER_PATH_PREFIX_RE}${PYTHON_RE}\\b(?:\\s+${FLAG_WITH_OPTIONAL_VALUE_RE})*\\s+-{1,2}(?:c|command)\\b(?:=|\\s+)`,
  ].join("|"),
  "i",
);
const PIPE_SOURCE_RE = /(?:^|[;&|]\s*)(?:printf|echo)\s+/i;
const PIPE_TO_INTERPRETER_RE = new RegExp(
  String.raw`\|\s*${INTERPRETER_PATH_PREFIX_RE}(?:${NODE_LIKE_BARE_RE}|${PYTHON_RE})\b`,
  "i",
);

const JS_ENV_REFERENCE_RE = /\bprocess\s*(?:\.\s*|\?\.\s*)env\b/gi;
const JS_ENV_ALIAS_DECLARATION_RE = /\{[^{}]*?\benv\s*(?::\s*([$A-Z_a-z][$\w]*))?[^{}]*?\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/gi;
const JS_PROCESS_ALIAS_DECLARATION_RE = /(?:\b(?:const|let|var)\s+)?([$A-Z_a-z][$\w]*)\s*=\s*(?:globalThis\s*\.\s*)?process\b/gi;
const PYTHON_ENV_REFERENCE_RE = /\bos\s*\.\s*environ\b/gi;
const PYTHON_ENV_IMPORT_RE = /\bfrom\s+os\s+import\s+(?:environ(?:\s+as\s+([A-Za-z_][\w]*))?|\*)/gi;
const PYTHON_OS_ALIAS_IMPORT_RE = /\bimport\s+os\s+as\s+([A-Za-z_][\w]*)/gi;

// Full-environment access forms whose source is not a normal `.env` member
// reference. These are only applied at non-literal source positions below.
const JS_PROCESS_ENV_BRACKET_RE = /\bprocess\s*\[\s*(["'`])env\1\s*\]/gi;
const JS_REFLECT_PROCESS_ENV_RE = /\bReflect\s*\.\s*get\s*\(\s*(?:globalThis\s*\.\s*)?process\s*,\s*(["'`])env\1(?=\s*(?:,|\)))/gi;
const JS_REQUIRE_PROCESS_ENV_RE = /\brequire\s*\(\s*(["'])(?:node:)?process\1\s*\)\s*(?:\.\s*env\b|\[\s*(["'`])env\2\s*\])/gi;
const PYTHON_GETATTR_ENV_RE = /\bgetattr\s*\(\s*os\s*,\s*(["'])environ\1(?=\s*(?:,|\)))/gi;
const PYTHON_IMPORT_ENV_RE = /\b__import__\s*\(\s*(["'])os\1\s*\)\s*\.\s*environ\b/gi;

function maskInlineLanguageLiterals(source: string): string {
  const masked = source.split("");
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;
  let templateExpressionDepth = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (lineComment) {
      masked[i] = " ";
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      masked[i] = " ";
      if (ch === "*" && next === "/") {
        masked[i + 1] = " ";
        i += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      masked[i] = " ";
      if (ch === "\\" && i + 1 < source.length) {
        i += 1;
        masked[i] = " ";
        continue;
      }
      if (quote === "`" && ch === "$" && next === "{") {
        masked[i + 1] = " ";
        i += 1;
        quote = undefined;
        templateExpressionDepth = 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (templateExpressionDepth > 0) {
      if (ch === "{") {
        templateExpressionDepth += 1;
        continue;
      }
      if (ch === "}") {
        templateExpressionDepth -= 1;
        if (templateExpressionDepth === 0) {
          masked[i] = " ";
          quote = "`";
        }
        continue;
      }
    }
    if (ch === "/" && next === "/") {
      masked[i] = " ";
      masked[i + 1] = " ";
      i += 1;
      lineComment = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      masked[i] = " ";
      masked[i + 1] = " ";
      i += 1;
      blockComment = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      masked[i] = " ";
      quote = ch;
    }
  }

  return masked.join("");
}

function hasStaticLiteralIndex(input: string): boolean {
  let index = 0;
  while (/\s/.test(input[index] ?? "")) index += 1;
  if (input[index] !== "[") return false;
  index += 1;
  while (/\s/.test(input[index] ?? "")) index += 1;
  const quote = input[index];
  if (quote !== "'" && quote !== '"' && quote !== "`") return false;
  index += 1;

  for (; index < input.length; index += 1) {
    const ch = input[index] ?? "";
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (quote === "`" && ch === "$" && input[index + 1] === "{") return false;
    if (ch !== quote) continue;
    index += 1;
    while (/\s/.test(input[index] ?? "")) index += 1;
    return input[index] === "]";
  }

  return false;
}

function hasScopedJavaScriptEnvironmentRead(input: string): boolean {
  return /^\s*(?:\.|\?\.)\s*[$A-Z_a-z][$\w]*/.test(input) || hasStaticLiteralIndex(input);
}

function hasScopedPythonEnvironmentRead(input: string): boolean {
  return hasStaticLiteralIndex(input) || /^\s*\.\s*get\s*\(\s*(?:key\s*=\s*)?(["'])(?:\\.|(?!\1)[\s\S])*\1/.test(input);
}

function hasUnsafeEnvironmentReference(
  source: string,
  maskedSource: string,
  reference: RegExp,
  isScopedRead: (input: string) => boolean,
): boolean {
  reference.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = reference.exec(maskedSource))) {
    if (!isScopedRead(source.slice(reference.lastIndex))) return true;
  }
  return false;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUnsafeEnvironmentAliasReference(
  source: string,
  maskedSource: string,
  declaration: RegExp,
  defaultAlias: string,
  isScopedRead: (input: string) => boolean,
): boolean {
  declaration.lastIndex = 0;
  let declarationMatch: RegExpExecArray | null;
  while ((declarationMatch = declaration.exec(maskedSource))) {
    const alias = declarationMatch[1] ?? defaultAlias;
    const sourceRemainder = source.slice(declaration.lastIndex);
    const maskedRemainder = maskedSource.slice(declaration.lastIndex);
    const reference = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "g");
    let referenceMatch: RegExpExecArray | null;
    while ((referenceMatch = reference.exec(maskedRemainder))) {
      if (!isScopedRead(sourceRemainder.slice(reference.lastIndex))) return true;
    }
  }
  return false;
}

function hasUnsafeJavaScriptProcessAliasReference(source: string, maskedSource: string): boolean {
  JS_PROCESS_ALIAS_DECLARATION_RE.lastIndex = 0;
  let declarationMatch: RegExpExecArray | null;
  while ((declarationMatch = JS_PROCESS_ALIAS_DECLARATION_RE.exec(maskedSource))) {
    const alias = declarationMatch[1] ?? "process";
    const sourceRemainder = source.slice(JS_PROCESS_ALIAS_DECLARATION_RE.lastIndex);
    const maskedRemainder = maskedSource.slice(JS_PROCESS_ALIAS_DECLARATION_RE.lastIndex);
    const reference = new RegExp(`\\b${escapeRegExp(alias)}\\s*(?:\\.\\s*|\\?\\.\\s*)env\\b`, "g");
    let referenceMatch: RegExpExecArray | null;
    while ((referenceMatch = reference.exec(maskedRemainder))) {
      if (!hasScopedJavaScriptEnvironmentRead(sourceRemainder.slice(reference.lastIndex))) return true;
    }
  }
  return false;
}

function hasUnsafePythonOsAliasReference(source: string, maskedSource: string): boolean {
  PYTHON_OS_ALIAS_IMPORT_RE.lastIndex = 0;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = PYTHON_OS_ALIAS_IMPORT_RE.exec(maskedSource))) {
    const sourceRemainder = source.slice(PYTHON_OS_ALIAS_IMPORT_RE.lastIndex);
    const maskedRemainder = maskedSource.slice(PYTHON_OS_ALIAS_IMPORT_RE.lastIndex);
    const reference = new RegExp(`\\b${escapeRegExp(importMatch[1] ?? "os")}\\s*\\.\\s*environ\\b`, "g");
    let referenceMatch: RegExpExecArray | null;
    while ((referenceMatch = reference.exec(maskedRemainder))) {
      if (!hasScopedPythonEnvironmentRead(sourceRemainder.slice(reference.lastIndex))) return true;
    }
  }
  return false;
}

function hasCodePattern(source: string, maskedSource: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (maskedSource[match.index] !== " ") return true;
  }
  return false;
}

function hasUnsafeInlineEnvironmentAccess(source: string): boolean {
  const maskedSource = maskInlineLanguageLiterals(source);
  return (
    hasCodePattern(source, maskedSource, JS_PROCESS_ENV_BRACKET_RE)
    || hasCodePattern(source, maskedSource, JS_REFLECT_PROCESS_ENV_RE)
    || hasCodePattern(source, maskedSource, JS_REQUIRE_PROCESS_ENV_RE)
    || hasCodePattern(source, maskedSource, PYTHON_GETATTR_ENV_RE)
    || hasCodePattern(source, maskedSource, PYTHON_IMPORT_ENV_RE)
    || hasUnsafeEnvironmentReference(source, maskedSource, JS_ENV_REFERENCE_RE, hasScopedJavaScriptEnvironmentRead)
    || hasUnsafeEnvironmentReference(source, maskedSource, PYTHON_ENV_REFERENCE_RE, hasScopedPythonEnvironmentRead)
    || hasUnsafeEnvironmentAliasReference(
      source,
      maskedSource,
      JS_ENV_ALIAS_DECLARATION_RE,
      "env",
      hasScopedJavaScriptEnvironmentRead,
    )
    || hasUnsafeEnvironmentAliasReference(
      source,
      maskedSource,
      PYTHON_ENV_IMPORT_RE,
      "environ",
      hasScopedPythonEnvironmentRead,
    )
    || hasUnsafeJavaScriptProcessAliasReference(source, maskedSource)
    || hasUnsafePythonOsAliasReference(source, maskedSource)
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

function extractInlineInterpreterSource(command: string): string {
  const evalMatch = INLINE_EVAL_SOURCE_RE.exec(command);
  if (evalMatch) return readShellCommandArgument(command.slice(evalMatch.index + evalMatch[0].length));
  if (PIPE_TO_INTERPRETER_RE.test(command)) {
    const sourceMatch = PIPE_SOURCE_RE.exec(command);
    if (sourceMatch) return readShellCommandArgument(command.slice(sourceMatch.index + sourceMatch[0].length));
  }
  return command;
}

export function classifyAgentShellCommand(command: string): AgentShellCommandDecision {
  const normalized = unwrapShell(command).trim();
  if (!normalized) return { action: "allow", reason: "not_environment_dump" };
  if (FULL_ENV_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (ENV_READ_BY_VARIABLE_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (XARGS_ENV_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  if (INLINE_INTERPRETER_RE.test(normalized) && hasUnsafeInlineEnvironmentAccess(extractInlineInterpreterSource(normalized))) {
    return { action: "block", reason: "full_environment_dump" };
  }
  if (SAFE_ENV_INSPECTION_ONLY_RE.test(normalized)) return { action: "allow", reason: "safe_env_inspection" };
  return { action: "allow", reason: "not_environment_dump" };
}
