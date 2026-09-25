import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sharedDocSourceRoots } from "@paperclipai/adapter-opencode-local/server";

import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { resolveSharedDocSearchBoundaryPath } from "../services/shared-doc-search-boundary.js";

/**
 * PEN-3172. `materializeExternalK8sSharedDocs` probes ancestors of the instructions root
 * for `docs/<name>.md`, bounded by an admin-controlled root. Which root it picks is the
 * whole behaviour, and picking the wrong one fails *silently*: the probe is disabled, the
 * agent-dir-only lookup misses, and a placeholder is written that reads exactly like a
 * genuinely missing document.
 *
 * Every other shared-doc test roots its bundle in `os.tmpdir()`, which is outside any
 * boundary — so the probe is disabled there and a placeholder is the correct expectation.
 * That left this choice untested in the one configuration that matters, and it was wrong
 * in production for every Penstock agent while the suite stayed green.
 */
describe("shared-doc ancestor search boundary", () => {
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeEach(() => {
    process.env.PAPERCLIP_HOME = "/paperclip";
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
  });

  // Production layout: the curated instruction bundle is a *sibling* of the runtime
  // instance root, under the same admin-owned home.
  const bundleRoot = "/paperclip/.paperclip/instances/default/companies/Acme/agents/cto";
  const companyRoot = "/paperclip/.paperclip/instances/default/companies/Acme";

  it("admits the company root of a sibling-tree bundle when bounded at the home dir", () => {
    const roots = sharedDocSourceRoots(bundleRoot, resolveSharedDocSearchBoundaryPath());

    // `<company>/docs/pr-conventions.md` is only reachable if the company root is probed.
    expect(roots).toContain(companyRoot);
    expect(roots[0]).toBe(bundleRoot);
  });

  it("excludes that same bundle when bounded at the instance root (the PEN-3172 regression)", () => {
    // The runtime instance root is `<home>/instances/<id>`; the bundle lives under
    // `<home>/.paperclip/instances/<id>`, so it is not within it and the probe collapses
    // to the agent directory alone. Kept as an executable record of the defect: if this
    // ever stops being the failing configuration, the boundary choice has changed and the
    // assertion above needs re-deriving rather than trusting. Asserted against the
    // resolver rather than a literal path so a set PAPERCLIP_INSTANCE_ID cannot flip it.
    expect(sharedDocSourceRoots(bundleRoot, resolvePaperclipInstanceRoot())).toEqual([bundleRoot]);
  });

  it("still refuses to escape the home dir", () => {
    // The boundary is widened, not removed: a bundle outside the admin-owned home gets no
    // ancestors, so a shallow root can never let `/tmp/docs` or `/docs` dictate instructions.
    expect(sharedDocSourceRoots("/tmp/scratch/instructions", resolveSharedDocSearchBoundaryPath()))
      .toEqual(["/tmp/scratch/instructions"]);
    // A sibling path that merely shares a prefix with the home dir is not inside it.
    expect(sharedDocSourceRoots("/paperclip-evil/companies/Acme/agents/cto", resolveSharedDocSearchBoundaryPath()))
      .toEqual(["/paperclip-evil/companies/Acme/agents/cto"]);
  });
});
