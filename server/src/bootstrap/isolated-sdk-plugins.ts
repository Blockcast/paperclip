import path from "node:path";

/**
 * Third-party npm packages that declare a real (non-fork) npm dependency on
 * `@paperclipai/plugin-sdk` — i.e. a plugin published outside this workspace
 * that npm-installs its own copy of the SDK rather than relying on the
 * fork we vendor into the shared plugins store.
 *
 * `server/src/index.ts` unconditionally re-copies the workspace SDK fork
 * (version `1.0.0`, with our labels/projects RPC extensions) over
 * `~/.paperclip/plugins/node_modules/@paperclipai/plugin-sdk` on every boot.
 * A plugin in this list would have its installed SDK torn from whatever
 * `package-lock.json` in the shared store says every time that copy runs
 * (BLO-20961 / BLO-18384). Installing it into its own directory instead
 * (see `resolveDefaultInstallDir` below) keeps its `node_modules` entirely
 * outside the path the fork-copy touches, so it is structurally immune
 * rather than merely reconciled-until-the-next-boot.
 *
 * Membership here is the *mechanism* opt-in (isolation), independent of
 * whether the package is also auto-installed on boot (`BUNDLED_PLUGIN_PACKAGES`
 * in `bundled-plugin-packages.ts`) — `paperclip-plugin-hindsight` is isolated
 * here but is operator-installed, not bundled.
 */
export const ISOLATED_SDK_PLUGIN_PACKAGES: readonly string[] = Object.freeze([
  // Confirmed recurring tear (BLO-18384/BLO-18405/BLO-20961): imports
  // @paperclipai/plugin-sdk directly and shares the store with the fork copy.
  "@lucitra/paperclip-plugin-secrets",
  "paperclip-plugin-hindsight",
  // Documented in scope for the isolation *mechanism* per BLO-20961 AC #3 —
  // both pin an SDK requirement that differs from both the fork (1.0.0) and
  // the upstream shared-store version (2026.513.0), so reconciling the
  // *shared* store can never satisfy them either way. Out of scope for this
  // issue's two-boot verification, which only covers the two rows above.
  "@lucitra/paperclip-plugin-chat",
  "@penstock/paperclip-plugin",
]);

/** Whether an npm package must live outside the shared plugin store. */
export function isIsolatedSdkPluginPackage(packageName: string | undefined): packageName is string {
  return packageName !== undefined && ISOLATED_SDK_PLUGIN_PACKAGES.includes(packageName);
}

/**
 * Directory under the plugins home that holds one isolated install per
 * package in `ISOLATED_SDK_PLUGIN_PACKAGES`. Sibling to (not inside) the
 * shared `plugins/node_modules` tree that `copyWorkspaceSdkFiles()` and the
 * full fork-copy in `index.ts` touch.
 */
export function isolatedPluginsRoot(pluginsHomeDir: string): string {
  return path.join(pluginsHomeDir, "plugins-isolated");
}

/** Filesystem-safe directory name for an (optionally scoped) npm package name. */
function sanitizePackageNameForPath(packageName: string): string {
  return packageName.replace(/^@/, "").replace(/\//g, "__");
}

/**
 * Resolve the install directory a package should use by default, absent an
 * explicit `installDir` from the caller. Returns the shared `localPluginDir`
 * unless the package is in `ISOLATED_SDK_PLUGIN_PACKAGES`, in which case it
 * returns that package's dedicated isolated directory.
 */
export function resolveDefaultInstallDir(packageName: string | undefined, localPluginDir: string): string {
  if (isIsolatedSdkPluginPackage(packageName)) {
    return path.join(isolatedPluginsRoot(path.dirname(localPluginDir)), sanitizePackageNameForPath(packageName));
  }
  return localPluginDir;
}
