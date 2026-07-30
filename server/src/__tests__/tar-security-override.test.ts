import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const rootPackageJson = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);

describe("tar security override", () => {
  it("keeps tar above the vulnerable decompression DoS range", () => {
    expect(rootPackageJson.pnpm.overrides.tar).toBe("^7.5.19");
  });
});
