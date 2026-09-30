// Redaction for HTTP log payloads.
//
// `customProps` in logger.ts copies `req.body` / `req.params` / `req.query`
// verbatim into the 4xx/5xx log lines so operators can diagnose. That means
// Better Auth's `POST /api/auth/sign-in/email` body (which has the user's
// plaintext password) and similar payloads (sign-up, reset-password, API
// keys via Authorization header equivalents) end up on disk.
//
// This walker returns a shallow copy of the input with values for sensitive
// keys replaced with the literal string "[REDACTED]". Recurses into nested
// objects/arrays. Caps depth so a hostile or accidental cycle can't pin
// the logger.

const SENSITIVE_KEYS = new Set<string>([
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "passwordconfirm",
  "password_confirm",
  "confirmpassword",
  "confirm_password",
  "secret",
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "private_key",
  "privatekey",
]);

// Keys whose *entire subtree* is credential material by construction
// (PEN-2370 series, door #11).
//
// The scalar set above is a denylist of key names, which works only for keys
// somebody could name in advance. It cannot work for agent configuration: the
// leaf names under `env` are arbitrary per-agent variable names, so no list
// will ever enumerate them. `logger.ts` logs the whole request body on every
// 4xx/5xx, and `PATCH /agents/:id` and the `hire_agent` approval path both
// accept `adapterConfig.env` in that body — so those values reached the log
// (and any reader of it) in the clear.
//
// Treating these as containers inverts the burden: instead of naming every
// secret leaf, we name the few places whose contents are secret by
// construction and mask every scalar beneath them. A new variable added to an
// agent's `env` next month is covered without anyone editing this file, which
// is the property a name denylist cannot have.
const SENSITIVE_CONTAINER_KEYS = new Set<string>([
  "adapterconfig",
  "runtimeconfig",
  "env",
  "mcpservers",
  "headers",
]);

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";
const URLISH_KEYS = new Set<string>([
  "href",
  "locator",
  "source",
  "source_locator",
  "sourcelocator",
  "source_url",
  "sourceurl",
  "uri",
  "url",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function isSensitiveContainerKey(key: string): boolean {
  return SENSITIVE_CONTAINER_KEYS.has(key.toLowerCase());
}

// Mask every scalar leaf beneath a credential-bearing container, preserving
// structure and key names so a 4xx log still records *which* variables were
// set — the diagnostic that makes the log worth keeping — without their values.
//
// Handles the two shapes that have bypassed walkers on this series before:
// an array-shaped container (a walk guarding only plain objects recurses past
// it and blanks nothing) and a scalar/JSON-string-shaped container (a walk
// handling only objects hands it back verbatim). Anything that is not an
// object is therefore masked outright rather than returned.
function redactContainer(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return REDACTED;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactContainer(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactContainer(entry, depth + 1);
  }
  return out;
}

function isUrlishKey(key: string): boolean {
  return URLISH_KEYS.has(key.toLowerCase());
}

function stripSecretBearingUrlParts(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash) return value;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (isSensitiveContainerKey(key)) {
      out[key] = redactContainer(entry, depth + 1);
      continue;
    }
    if (typeof entry === "string" && isUrlishKey(key)) {
      out[key] = stripSecretBearingUrlParts(entry);
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}
