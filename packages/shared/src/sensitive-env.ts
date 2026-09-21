/**
 * The single spelling of a withheld value across the whole product.
 *
 * BLO-34631 review: the server masks rather than empties a withheld value, so a reader can tell
 * "withheld" from "absent" — but that contract only holds if the UI recognises the same string the
 * server writes. Both sides had their own literal, and nothing pinned them together: change one and
 * the viewer silently falls back to rendering a withheld log as an empty one.
 *
 * BLO-34738: it lives in this module for import-graph reasons, not because it is env-specific.
 * Every other export here classifies env-var NAMES and VALUES; this one does not. Its consumers are
 * product-wide and mostly non-env: `server/src/redaction.ts` re-exports it as
 * `REDACTED_EVENT_VALUE`, which `maskWorkspaceRuntimeTextForRead` writes over workspace-operation
 * `command`/`cwd`, run and operation LOG CONTENT, promoted runtime scalars and approval payloads;
 * `ui/src/pages/AgentDetail.tsx` re-aliases it as `REDACTED_ENV_VALUE` to recognise a withheld
 * value on read. Grep the alias names, not just this one — the two re-exports are where it is
 * actually used.
 */
export const REDACTED_VALUE_SENTINEL = "***REDACTED***";

/** Env-var names that conventionally hold credentials. */
export const SENSITIVE_ENV_KEY_RE =
  /token(?:$|[-_])|api[-_]?key|access[-_]?token|auth(?:entication|_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring/i;

/**
 * Whole-value credential shapes. Anchored, because these test a single env
 * value rather than scanning prose.
 *
 * Exported for PEN-3139: this is the longest of the repo's credential-shape
 * lists, and the free-text scrub on the run-log storage path
 * (`COMMAND_*` patterns in `@paperclipai/adapter-utils/command-redaction`) has
 * to stay in step with it. `server/src/__tests__/pen3139-transcript-credential-shapes.test.ts`
 * enforces that: adding a shape here without adding an unanchored counterpart
 * there fails the suite.
 */
export const CREDENTIAL_VALUE_RES: readonly RegExp[] = [
  /^sk-[A-Za-z0-9-_]{16,}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z\-_]{20,}$/,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/,
];

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key);
}

export function isPlausiblySensitiveEnvValue(value: string): boolean {
  const normalizedValue = value.trim();
  if (CREDENTIAL_VALUE_RES.some((re) => re.test(normalizedValue))) return true;
  if (normalizedValue.length < 24 || /\s/.test(normalizedValue)) return false;
  if (!/^[A-Za-z0-9+/=_\-.]+$/.test(normalizedValue)) return false;
  const classes = [
    /[a-z]/.test(normalizedValue),
    /[A-Z]/.test(normalizedValue),
    /[0-9]/.test(normalizedValue),
  ];
  return classes.filter(Boolean).length >= 2;
}

export function isSensitiveEnv(name: string, value: string): boolean {
  if (!value) return false;
  return isSensitiveEnvKey(name) || isPlausiblySensitiveEnvValue(value);
}
