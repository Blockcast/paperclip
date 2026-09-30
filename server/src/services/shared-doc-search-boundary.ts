import { resolvePaperclipHomeDir } from "../home-paths.js";

/**
 * Bound for the shared-doc ancestor probe in `materializeExternalK8sSharedDocs`.
 *
 * Deliberately the Paperclip HOME dir, not the runtime instance root. An external
 * instructions bundle is routinely curated in a *sibling* tree under the same
 * admin-owned home — e.g. home `/paperclip` carries the runtime instance root at
 * `/paperclip/instances/<id>` while the curated bundle sits at
 * `/paperclip/.paperclip/instances/<id>/companies/<Name>/agents/<role>`.
 *
 * Bounding at the instance root put every such bundle *outside* the boundary, so
 * `sharedDocSourceRoots` returned the agent directory alone and the company-root lookup
 * the probe exists to perform never ran. That failure is silent in the worst way: the
 * agent is handed a placeholder that reads exactly like a genuinely missing document.
 * Measured on Penstock (PEN-3172), where all 14 shared docs live at `<company>/docs`,
 * two hops above the agent root, and every one of them resolved to a placeholder.
 *
 * This widens the boundary without weakening the property it enforces: the home dir is
 * admin-controlled (`PAPERCLIP_HOME`, else `~/.paperclip`), so the probe still cannot
 * reach a world-writable `/tmp/docs` or `/docs`, and `SHARED_DOC_ANCESTOR_ROOT_DEPTH`
 * still caps the walk. A bundle configured outside the home dir keeps the previous
 * agent-directory-only behaviour.
 *
 * Extracted into its own module so the choice is assertable without importing the
 * database-coupled heartbeat service — see `shared-doc-search-boundary.test.ts`. The
 * previous code had no test that could tell the two boundaries apart, which is why the
 * wrong one shipped green.
 */
export function resolveSharedDocSearchBoundaryPath(): string {
  return resolvePaperclipHomeDir();
}
