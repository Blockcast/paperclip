/** Env-var names that conventionally hold credentials. */
export const SENSITIVE_ENV_KEY_RE =
  /(?:^|[-_])token$|api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring/i;

const CREDENTIAL_VALUE_RES: RegExp[] = [
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
  if (CREDENTIAL_VALUE_RES.some((re) => re.test(value))) return true;
  if (value.length < 24 || /\s/.test(value)) return false;
  if (!/^[A-Za-z0-9+/=_\-.]+$/.test(value)) return false;
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /[0-9]/.test(value)];
  return classes.filter(Boolean).length >= 2;
}

export function isSensitiveEnv(name: string, value: string): boolean {
  if (!value) return false;
  return isSensitiveEnvKey(name) || isPlausiblySensitiveEnvValue(value);
}
