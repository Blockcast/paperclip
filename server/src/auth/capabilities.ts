export type AuthCapabilities = {
  emailPasswordEnabled: boolean;
  oidcProviders: string[];
};

export function resolveEmailPasswordAuthEnabled(value = process.env.PAPERCLIP_AUTH_EMAIL_PASSWORD_ENABLED): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("PAPERCLIP_AUTH_EMAIL_PASSWORD_ENABLED must be 'true' or 'false'");
}

export function resolveConfiguredDexProviderId(): string | null {
  const issuer = process.env.PAPERCLIP_DEX_OIDC_ISSUER?.trim();
  const clientId = process.env.PAPERCLIP_DEX_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.PAPERCLIP_DEX_OIDC_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  return process.env.PAPERCLIP_DEX_OIDC_PROVIDER_ID?.trim() || "dex";
}

export function loadAuthCapabilities(): AuthCapabilities {
  const dexProviderId = resolveConfiguredDexProviderId();
  return {
    emailPasswordEnabled: resolveEmailPasswordAuthEnabled(),
    oidcProviders: dexProviderId ? [dexProviderId] : [],
  };
}

export function assertUsableAuthCapabilities(capabilities: AuthCapabilities): void {
  if (!capabilities.emailPasswordEnabled && capabilities.oidcProviders.length === 0) {
    throw new Error(
      "PAPERCLIP_AUTH_EMAIL_PASSWORD_ENABLED=false requires a complete Dex OIDC configuration",
    );
  }
}
