import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { FAST_URI_ADVISORY, isVulnerableFastUri } from "./fast-uri-advisory.js";

const designerRoot = new URL("../packages/services/designer/", import.meta.url);

const lockfile = JSON.parse(
  await readFile(new URL("package-lock.json", designerRoot), "utf8"),
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
  assert.ok(
    !isVulnerableFastUri(fastUri.version),
    `designer lockfile ${path} resolved fast-uri ${fastUri.version}, vulnerable per ${FAST_URI_ADVISORY}`,
  );
}

// The lockfile above is a committed artifact; the manifest override is what
// keeps the next `npm install` from drifting back into a vulnerable range.
// Assert it too, otherwise the two can silently disagree.
const manifest = JSON.parse(
  await readFile(new URL("package.json", designerRoot), "utf8"),
);
assert.equal(
  manifest.overrides?.["fast-uri"],
  "^3.1.6",
  "designer package.json must pin the fast-uri override that keeps npm off the vulnerable range",
);
