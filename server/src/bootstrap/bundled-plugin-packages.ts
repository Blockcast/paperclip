/**
 * Npm packages that should be auto-installed on startup when not already present.
 *
 * `@lucitra/paperclip-plugin-linear` is intentionally excluded: it is vendored
 * as a workspace package and installed from its local path by the kkroo bootstrap.
 */
export const BUNDLED_PLUGIN_PACKAGES = Object.freeze([
  "@lucitra/paperclip-plugin-chat",
  // @lucitra/paperclip-plugin-updater@0.5.0 depends on the unpublished
  // @lucitra/plugin-sdk and predates company-scoped config. Do not install a
  // worker that cannot resolve or activate; restore it when a compatible
  // @paperclipai/plugin-sdk release is published.
  "@lucitra/paperclip-plugin-secrets",
  // Penstock LLM-proxy connector: inert until configured (mode defaults to
  // "disabled"); live cutover is gated on the native serve (PEN-1039).
  "@penstock/paperclip-plugin",
]);
