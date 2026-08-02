import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateCatalog } from "../src/catalog-builder.js";

/**
 * Scope: this is a full integrity check, not a shape-only one. `validateCatalog`
 * rebuilds the expected manifest from the catalog files on disk and compares the
 * rendered text to `generated/catalog.json`, so it fails on a stale `sizeBytes`,
 * `sha256`, or `contentHash` as well as on a malformed or unparseable manifest.
 *
 * The CI freshness test reuses committed pinned-reference inventory when the
 * descriptor hash is unchanged so it stays deterministic. This script keeps the
 * full validation behavior and refreshes remote pinned references with bounded,
 * cached GitHub fetches.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await validateCatalog(packageDir);

if (result.errors.length > 0) {
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Catalog manifest is valid with ${result.manifest.skills.length} catalog skills.`);
}
