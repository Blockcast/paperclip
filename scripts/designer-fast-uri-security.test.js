import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const lockfile = JSON.parse(
  await readFile(
    new URL("../packages/services/designer/package-lock.json", import.meta.url),
    "utf8",
  ),
);
const fastUri = lockfile.packages["node_modules/fast-uri"];

assert.ok(fastUri, "designer lockfile missing fast-uri resolution");

const [major, minor, patch] = fastUri.version.split(".").map(Number);
assert.ok(
  major > 3 || (major === 3 && (minor > 1 || (minor === 1 && patch >= 5))),
  `designer lockfile resolved vulnerable fast-uri ${fastUri.version}`,
);
