import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const lockfile = JSON.parse(
  await readFile(
    new URL("../packages/services/designer/package-lock.json", import.meta.url),
    "utf8",
  ),
);
const fastUriResolutions = Object.entries(lockfile.packages).filter(
  ([path]) =>
    path === "node_modules/fast-uri" || path.endsWith("/node_modules/fast-uri"),
);

assert.ok(
  fastUriResolutions.length > 0,
  "designer lockfile missing fast-uri resolution",
);

for (const [path, fastUri] of fastUriResolutions) {
  const [major, minor, patch] = fastUri.version.split(".").map(Number);
  assert.ok(
    major > 3 || (major === 3 && (minor > 1 || (minor === 1 && patch >= 5))),
    `designer lockfile ${path} resolved vulnerable fast-uri ${fastUri.version}`,
  );
}
