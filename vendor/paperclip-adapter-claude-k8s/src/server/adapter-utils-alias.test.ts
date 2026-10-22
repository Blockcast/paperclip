import { describe, it, expect } from "vitest";

import { buildAdapterUtilsAlias } from "./adapter-utils-alias.js";

const resolveSrc = (sub: string) => `/repo/packages/adapter-utils/src/${sub}`;

describe("buildAdapterUtilsAlias", () => {
  // The regression this guards: PEN-4518 shipped an unconditional alias, and the
  // image build — which has no ../../packages — failed to resolve a package that
  // was installed and present, on every commit until it was fixed.
  it("emits no alias at all when the monorepo source is absent", () => {
    expect(buildAdapterUtilsAlias({ resolveSrc, exists: () => false })).toEqual(
      [],
    );
  });

  it("decides on the index module it would alias to, not on some other path", () => {
    const probed: string[] = [];
    buildAdapterUtilsAlias({
      resolveSrc,
      exists: (path) => {
        probed.push(path);
        return false;
      },
    });
    expect(probed).toEqual(["/repo/packages/adapter-utils/src/index.ts"]);
  });

  it("aliases the bare specifier and subpaths when the source is present", () => {
    const alias = buildAdapterUtilsAlias({ resolveSrc, exists: () => true });
    expect(alias).toHaveLength(2);
    expect(alias[0]!.replacement).toBe(
      "/repo/packages/adapter-utils/src/index.ts",
    );
    expect(alias[1]!.replacement).toBe("/repo/packages/adapter-utils/src/$1.ts");
  });

  it("matches the specifiers src/ actually imports, and keeps them distinct", () => {
    const [bare, subpath] = buildAdapterUtilsAlias({
      resolveSrc,
      exists: () => true,
    });
    // Both forms appear in this adapter's src/ (execute.ts imports each).
    expect("@paperclipai/adapter-utils").toMatch(bare!.find);
    expect("@paperclipai/adapter-utils/server-utils").toMatch(subpath!.find);
    // The bare pattern is anchored, so it must not swallow a subpath import and
    // redirect it to index.ts.
    expect("@paperclipai/adapter-utils/server-utils").not.toMatch(bare!.find);
    expect("@paperclipai/adapter-utils").not.toMatch(subpath!.find);
    // A package whose name merely starts the same way is not ours.
    expect("@paperclipai/adapter-utils-extra").not.toMatch(bare!.find);
  });
});
