import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `@paperclipai/adapter-utils` must declare NO workspace-internal dependency.
 *
 * PEN-5030. This is not a style rule, it is an image-build constraint that is
 * invisible from inside the workspace, where `workspace:*` resolves fine and
 * every suite stays green.
 *
 * The agent image builds this package ALONE. From the `vendor` stage of the
 * root Dockerfile:
 *
 *   COPY packages/adapter-utils /vendor/adapter-utils-src
 *   RUN cd /vendor/adapter-utils-src \
 *     && npm install --no-save typescript@^5.7.3 @types/node@^24.6.0 \
 *     && npx tsc && npm pack
 *
 * and the resulting tarball is then `npm install`ed into both vendored k8s
 * adapters. There is no pnpm out there and no sibling package to link, so a
 * `workspace:` range fails the install outright:
 *
 *   npm error code EUNSUPPORTEDPROTOCOL
 *   npm error Unsupported URL Type "workspace:": workspace:*
 *
 * That lands before `tsc` runs, so the whole stage dies and the build produces
 * no publishable agent image -- the PEN-4518 failure shape, reached by a
 * different door.
 *
 * Rewriting the range to plain semver does not fix it, it only moves the
 * failure later and makes it quieter: npm would then install the PUBLISHED
 * `@paperclipai/*` package, which lags this tree, and the first import of
 * anything added since that release fails at runtime inside every agent pod
 * with ERR_MODULE_NOT_FOUND. So the assertion below rejects workspace-internal
 * packages by NAME as well as by protocol.
 *
 * Practical consequence for anyone extending this package: code that
 * `adapter-utils` needs has to live IN `adapter-utils`. That is why
 * `egress-guard-path.ts` sits here rather than in `@paperclipai/shared`, where
 * it would otherwise belong -- see its module docstring for the full decision.
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

// Every field npm resolves when it installs this directory on its own. devDependencies
// is included deliberately: `npm install` in a project directory installs them too, so a
// `workspace:` range there breaks the image build exactly as a prod dependency would.
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

describe("@paperclipai/adapter-utils is installable outside the workspace", () => {
  it("declares no `workspace:` range in any dependency field", () => {
    const offenders: string[] = [];
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (typeof range === "string" && range.startsWith("workspace:")) {
          offenders.push(`${field}.${name} = ${range}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no workspace-internal package, under any range", () => {
    const offenders: string[] = [];
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        // @types/* are DefinitelyTyped packages from the public registry, not ours.
        if (name.startsWith("@paperclipai/")) {
          offenders.push(`${field}.${name} = ${range}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
