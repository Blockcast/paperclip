import { createHmac, timingSafeEqual } from "node:crypto";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface LocalAgentJwtClaims {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function jwtConfig() {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, defaultRunJwtTtlSeconds()),
    issuer: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    audience: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api",
    disableLegacyFallback: parseBooleanEnv(process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK),
  };
}

/**
 * How long a dispatched agent run is allowed to live, in seconds. Nothing
 * enforces this as a hard run deadline today (external-lifecycle runs are
 * bounded only by the silence watchdog) — it exists so the run JWT's `exp`
 * is derived from run-lifetime semantics instead of an arbitrary constant.
 */
const DEFAULT_RUN_MAX_DURATION_SECONDS = 24 * 60 * 60;

/**
 * Extra token lifetime past the run's max duration so a run that lives right
 * up to the bound can still persist its final writes (issue comment, status
 * transition, escalation) with a valid token.
 */
const RUN_JWT_EXP_MARGIN_SECONDS = 15 * 60;

/**
 * The run JWT is minted ONCE at Job dispatch and injected as a static
 * PAPERCLIP_API_KEY — nothing refreshes it mid-run. A TTL shorter than the
 * run's lifetime therefore cuts the agent off from every Paperclip API call
 * partway through (writes 401, escalations 403, completed work never
 * persists — BLO-16449). Derive the default from the run's max allowed
 * duration plus a persistence margin; PAPERCLIP_AGENT_JWT_TTL_SECONDS
 * remains an explicit operator override.
 */
function defaultRunJwtTtlSeconds() {
  const runMaxDurationSeconds = parseNumber(
    process.env.PAPERCLIP_AGENT_RUN_MAX_DURATION_SECONDS,
    DEFAULT_RUN_MAX_DURATION_SECONDS,
  );
  return runMaxDurationSeconds + RUN_JWT_EXP_MARGIN_SECONDS;
}

/**
 * Derive a per-company signing key from the master JWT secret and a companyId.
 *
 * In a multi-tenant deployment this ensures that a JWT signed for company A
 * cannot be reused to authenticate as an agent in company B, even if the raw
 * token leaks. The instance-wide master secret is never used to sign new
 * tokens — it is retained only as a verification fallback so that tokens
 * issued before this change continue to validate.
 *
 * The derivation domain-separates with the `jwt:` prefix so the same master
 * secret can safely be reused for other HMAC purposes without key reuse.
 */
function deriveCompanySigningKey(masterSecret: string, companyId: string): string {
  return createHmac("sha256", masterSecret).update(`jwt:${companyId}`).digest("hex");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createLocalAgentJwt(agentId: string, companyId: string, adapterType: string, runId: string) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };

  const header = {
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  // Sign with the per-company derived key so a leaked token cannot be reused
  // across tenants.
  const signingKey = deriveCompanySigningKey(config.secret, companyId);
  const signature = signPayload(signingKey, signingInput);

  return `${signingInput}.${signature}`;
}

export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const claimedCompanyId = typeof claims.company_id === "string" ? claims.company_id : null;
  if (!claimedCompanyId) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  // Try the per-company derived key first (current tokens). Fall back to the
  // raw master secret so tokens issued before per-company derivation existed
  // continue to verify — this preserves backward compatibility for any
  // outstanding tokens (TTL bounds the legacy window naturally).
  //
  // Operators should set `PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK=true`
  // approximately one JWT TTL (run-max-duration + margin — ~24h15m by default —
  // or the explicit PAPERCLIP_AGENT_JWT_TTL_SECONDS override) after deploying
  // per-company signing. Once set, the master-secret fallback
  // is disabled and only tokens validating under the per-company derived key
  // are accepted — closing the window in which a leaked master secret could
  // be used to forge tokens with arbitrary future `exp` values for any tenant.
  const perCompanyKey = deriveCompanySigningKey(config.secret, claimedCompanyId);
  const perCompanySig = signPayload(perCompanyKey, signingInput);
  let signatureOk = safeCompare(signature, perCompanySig);
  if (!signatureOk && !config.disableLegacyFallback) {
    const legacySig = signPayload(config.secret, signingInput);
    signatureOk = safeCompare(signature, legacySig);
  }
  if (!signatureOk) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !adapterType || !runId || !iat || !exp) return null;
  const companyId = claimedCompanyId;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
