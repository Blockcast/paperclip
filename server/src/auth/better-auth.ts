import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth, type Auth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import {
  classifyAuthOperation,
  classifyAuthResponse,
  recordAuthRequest,
} from "../services/metrics.js";
import {
  assertUsableAuthCapabilities,
  loadAuthCapabilities,
  resolveConfiguredDexProviderId,
} from "./capabilities.js";
import {
  loadDexRbacConfig,
  parseIdTokenGroups,
  reconcileDexUser,
} from "./oidc-rbac.js";

export { loadAuthCapabilities } from "./capabilities.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthGetSessionApi = {
  getSession?: (input: { headers: Headers }) => Promise<unknown>;
};

type BetterAuthHandlerTarget = Extract<Parameters<typeof toNodeHandler>[0], { handler: Auth["handler"] }>;

type BetterAuthSessionResolver = {
  api?: BetterAuthGetSessionApi;
};

type BetterAuthInstance = BetterAuthHandlerTarget & BetterAuthSessionResolver;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;
const DEFAULT_DEX_OIDC_SCOPES = ["openid", "email", "profile", "groups"] as const;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldEnableAuthRateLimit(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}): boolean {
  const override = input.override?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  return input.deploymentMode === "authenticated";
}

export function buildBetterAuthRateLimitOptions(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}) {
  return {
    enabled: shouldEnableAuthRateLimit(input),
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

export function buildDexOAuthProviderConfigFromEnv(): GenericOAuthConfig | null {
  const issuerRaw = process.env.PAPERCLIP_DEX_OIDC_ISSUER?.trim();
  const clientId = process.env.PAPERCLIP_DEX_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.PAPERCLIP_DEX_OIDC_CLIENT_SECRET?.trim();
  if (!issuerRaw || !clientId || !clientSecret) return null;

  const issuer = trimTrailingSlash(issuerRaw);
  const providerId = resolveConfiguredDexProviderId();
  if (!providerId) return null;
  const scopesRaw = process.env.PAPERCLIP_DEX_OIDC_SCOPES?.trim();
  const scopes = (scopesRaw
    ? scopesRaw.split(/\s+/)
    : [...DEFAULT_DEX_OIDC_SCOPES]
  ).filter((scope) => scope.length > 0);

  return {
    providerId,
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    clientId,
    clientSecret,
    scopes,
    pkce: true,
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  authBaseUrlMode: Config["authBaseUrlMode"];
  authPublicBaseUrl: string | undefined;
  publicUrl?: string | undefined;
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  const dexOAuthConfig = buildDexOAuthProviderConfigFromEnv();
  const dexRbacConfig = loadDexRbacConfig();
  const authCapabilities = loadAuthCapabilities();
  assertUsableAuthCapabilities(authCapabilities);

  const reconcileOauthAccountGroups = async (
    account: { providerId?: string; userId?: string; idToken?: string | null },
    hook: "create" | "update",
  ) => {
    if (!account?.userId) return;
    if (account.providerId !== dexRbacConfig.providerId) return;

    try {
      const groups = parseIdTokenGroups(account.idToken ?? null);
      if (groups.length === 0) return;
      await reconcileDexUser(db, account.userId, groups, dexRbacConfig);
    } catch (err) {
      console.error(`[better-auth] ${account.providerId} rbac reconcile (${hook}) failed:`, err);
    }
  };

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    ...(dexOAuthConfig
      ? {
          plugins: [
            genericOAuth({
              config: [dexOAuthConfig],
            }),
          ],
        }
      : {}),
    emailAndPassword: {
      enabled: authCapabilities.emailPasswordEnabled,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    databaseHooks: {
      account: {
        create: {
          after: async (account: { providerId?: string; userId?: string; idToken?: string | null }) => {
            await reconcileOauthAccountGroups(account, "create");
          },
        },
        update: {
          after: async (account: { providerId?: string; userId?: string; idToken?: string | null }) => {
            await reconcileOauthAccountGroups(account, "update");
          },
        },
      },
    },
    rateLimit: buildBetterAuthRateLimitOptions({
      deploymentMode: config.deploymentMode,
      deploymentExposure: config.deploymentExposure,
      override: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    }),
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthHandlerTarget): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    const operation = classifyAuthOperation(req.originalUrl);
    res.once("finish", () => {
      const outcome = classifyAuthResponse({
        operation,
        statusCode: res.statusCode,
        location: res.getHeader("location"),
      });
      recordAuthRequest({ operation, outcome });
      logger.info(
        {
          authOperation: operation,
          authOutcome: outcome,
          method: req.method,
          statusCode: res.statusCode,
        },
        "authentication request completed",
      );
    });
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthSessionResolver,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = auth.api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthSessionResolver,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
