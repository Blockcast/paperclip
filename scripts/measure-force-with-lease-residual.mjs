#!/usr/bin/env node
// PEN-5734: measure the residual the `--force-with-lease` anchor carries.
//
// The egress-scrub family requires every new exemption to state, in numbers,
// what it NEWLY admits — the fraction of random values the shipped detector
// refuses that the patched one passes. `docs/security/PEN-3920-egress-entropy-identifier-decision.md`
// §6.5 is the standard, and §10 records the BLO-45350 / BLO-45605 lesson this
// rule is built against: a composite whose segments are bounded one at a time
// can still exonerate an arbitrary token in whichever gap nobody bounded.
//
// So this measures BOTH halves, independently and jointly:
//
//   ref        the value in `--force-with-lease=<HERE>:<oid>`, which
//              `isGitRefName` exonerates
//   expect     the value in `--force-with-lease=<ref>:<HERE>`, which
//              `LEASE_EXPECTED_OID_RE` exonerates
//   whole      the composite, to show no construction passes as a unit
//              without each half passing on its own
//
// ⚠ The `expect` column moves in the OPPOSITE direction to every other
// measurement in this family, and reading it as a widening is the mistake to
// avoid. Before PEN-5734 nothing tested that half at all — `:` is outside
// `ASSIGNMENT_RE`'s value alphabet, so the capture stopped at the colon and
// the bytes after it were never offered to any detector. Its "newly admitted"
// figure is therefore 0 by construction and the interesting number is the
// NEWLY REFUSED one, printed beside it.
//
// Usage:
//   node scripts/measure-force-with-lease-residual.mjs [trials]
//
// Reads the scrubber through tsx so it measures the SOURCE, not a build.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const TRIALS = Number(process.argv[2] ?? 200_000);

const child = spawnSync(
  process.execPath,
  [
    path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(here, "measure-force-with-lease-residual.impl.ts"),
    String(TRIALS),
  ],
  { stdio: "inherit" },
);
process.exit(child.status ?? 1);
