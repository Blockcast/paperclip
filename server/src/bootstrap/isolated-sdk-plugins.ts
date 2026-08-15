import path from "node:path";

/** Packages whose published SDK dependency must not share the boot-vendored store. */
export const ISOLATED_SDK_PLUGIN_PACKAGES: readonly string[] = Object.freeze([
  "@lucitra/paperclip-plugin-secrets",
  "paperclip-plugin-hindsight",
  // Included in the mechanism; excluded from BLO-20961's two-plugin rollout check.
  "@lucitra/paperclip-plugin-chat",
  "@penstock/paperclip-plugin",
]);

export function isolatedPluginsRoot(pluginsHomeDir: string): string {
  return path.join(pluginsHomeDir, "plugins-isolated");
}

function sanitizePackageNameForPath(packageName: string): string {
  return packageName.replace(/^@/, "").replace(/\//g, "__");
}

export function resolveDefaultInstallDir(packageName: string | undefined, localPluginDir: string): string {
  if (packageName && ISOLATED_SDK_PLUGIN_PACKAGES.includes(packageName)) {
    return path.join(isolatedPluginsRoot(path.dirname(localPluginDir)), sanitizePackageNameForPath(packageName));
  }
  return localPluginDir;
}

export function isIsolatedSdkPluginPackage(packageName: string): boolean {
  return ISOLATED_SDK_PLUGIN_PACKAGES.includes(packageName);
}
