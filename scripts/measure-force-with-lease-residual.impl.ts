// PEN-5734 residual measurement. Driven by measure-force-with-lease-residual.mjs;
// see that file for what each column means and why `expect` reads backwards.
import { scrubGitHubEgressText } from "../packages/adapter-utils/src/github-egress-scrub.js";
import {
  classifyCell,
  dilution,
  familyAverage,
  formatCell,
  populationRate,
  trialRate,
  worstShape,
} from "./residual-report.mjs";

const TRIALS = Number(process.argv[2] ?? 200_000);

// The patched detector is what we import. The SHIPPED one is reconstructed by
// denying the anchor its name: `--force-with-leaseX=` is byte-identical input
// of the same length and alphabet that no rule in this file anchors, so it
// exercises every other detector exactly as before while the PEN-5734 rule
// cannot fire. That is cheaper and less forgeable than vendoring a copy of the
// old source, which would silently drift.
const PINNED = (ref: string, expect: string | null) =>
  expect === null
    ? `git push --force-with-lease=${ref}`
    : `git push --force-with-lease=${ref}:${expect}`;
const UNANCHORED = (ref: string, expect: string | null) =>
  expect === null
    ? `git push --force-with-leaseX=${ref}`
    : `git push --force-with-leaseX=${ref}:${expect}`;

const passes = (text: string) => !scrubGitHubEgressText(text).redacted;

function rand(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)] as string;
  }
  return out;
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGIT = "0123456789";
const ALPHABETS: Record<string, string> = {
  base64url: `${LOWER}${UPPER}${DIGIT}-_`,
  base62: `${LOWER}${UPPER}${DIGIT}`,
  base36: `${LOWER}${DIGIT}`,
  base32: `${UPPER}234567`,
  "hex-lower": "0123456789abcdef",
  "hex-upper": "0123456789ABCDEF",
  "letters-mixed": `${LOWER}${UPPER}`,
  alnum: `${LOWER}${UPPER}${DIGIT}`,
};

/** The clean halves held constant while the OTHER half is under test.
 *
 *  ⚠ BASELINE ISOLATION, and the first version of this script got it wrong in
 *  a way worth recording — it is PEN-4425's measurement trap wearing different
 *  clothes. The held-constant ref was a realistic branch
 *  (`chore/PEN-…-egress-force-with-lease`), which is PRECISELY a value the
 *  shipped detector redacts; that is the false positive this row exists to
 *  fix. So every `expect:` family measured a baseline that was already failing
 *  for a reason having nothing to do with the expectation half, and the ref
 *  exemption alone moved the whole composite from refused to passed —
 *  reporting 1.00e+0 "newly admitted" for families where the expectation rule
 *  had not fired at all.
 *
 *  The ref held constant for the expectation column is therefore `main`: four
 *  characters, below `ASSIGNMENT_RE`'s 16-character capture floor, so it is
 *  byte-identical-clean under the shipped detector AND the patched one and
 *  contributes nothing to either verdict. Symmetrically, the OID held constant
 *  for the ref column is short enough that neither detector touches it. */
const CLEAN_REF_FOR_EXPECT_COLUMN = "main";
const CLEAN_OID = "ff113077";

/** `shapeOf` groups the per-group-count cells back into the family they were
 *  split out of, so the report can print the family average BESIDE the worst
 *  shape and show the dilution. Absent for families that have only one shape. */
type Family = {
  name: string;
  shapeOf?: string;
  gen: () => { ref: string; expect: string | null };
};

const families: Family[] = [];

// --- the ref half -----------------------------------------------------------
for (const [name, alphabet] of Object.entries(ALPHABETS)) {
  for (const length of [24, 32, 43, 64]) {
    families.push({
      name: `ref: ${name}@${length}`,
      gen: () => ({ ref: rand(alphabet, length), expect: CLEAN_OID }),
    });
  }
}
families.push({
  name: "ref: uuid-v4 layout",
  gen: () => ({
    ref: [8, 4, 4, 4, 12].map((n) => rand("0123456789abcdef", n)).join("-"),
    expect: CLEAN_OID,
  }),
});

// Chopped tokens: the ONLY construction that can reach a word-only rule, since
// a word-only rule admits no opaque run. PEN-4425's measurement trap applies —
// fixed-length groups make a cap look free — so the run lengths vary per value.
//
// ⚠ PEN-5828: THE GROUP COUNT IS A SEPARATE FAMILY, NOT A RANDOM DRAW. This
// loop used to pick `3 + Math.floor(Math.random() * 3)` INSIDE the trial and
// report one figure per alphabet/run/joiner — an average over a mixture whose
// bins are not equally reachable, and are unreachable for two DIFFERENT
// reasons, one at each end:
//
//   3 components  below HIGH_ENTROPY_MIN_LENGTH (24) at ~6-char runs, so the
//                 shipped detector never redacts it and `after && !before` is
//                 unreachable by construction. Word mass is never consulted.
//   4 components  the hot shape.
//   5 components  refused outright by GIT_REF_MAX_COMPONENTS, which is doing
//                 its job — population 1.000, admitted 0.
//
// Two of three bins contributed exactly zero, so the published family figure
// was the hot bin divided by three: a 3.000x dilution, exact rather than
// approximate. Binning here is half the fix; the population denominator in
// `residual-report.mjs` is the other half, and neither is sufficient alone.
//
// ⚠ THE `-` ARM IS POPULATION-BOUNDED BY A CONSTANT OUTSIDE `isGitRefName`,
// and that is why its empty bins are at the opposite end. `-` is not a ref
// component separator, so GIT_REF_MAX_COMPONENTS never fires on it; instead
// `isOpaqueSecretValue` bails on `isLexicalIdentifier`, which splits on
// `[-._]` and exonerates any value whose segments sum to at most
// LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH (30). So a `-`-joined draw is in
// population iff its summed run length exceeds 30, and `/`-joined iff its
// total length reaches 24. For `letters-mixed` that empties six of nine `-`
// bins; for the lowercase and base32 alphabets only three of nine, because
// their digits make the segments non-plain. Reported per bin, so the driver
// no longer has to claim a blanket bound that is false for two thirds of the
// cells it would cover.
const CHOPPED_ALPHABETS = [
  ["base36", ALPHABETS.base36 as string],
  // PEN-5828 / DevOps run `1624d780`: this slot used to be `lower-alnum`,
  // spelled `${LOWER}${DIGIT}` — BYTE-IDENTICAL to base36 above, so six of the
  // eighteen chopped families were exact duplicates of another six and the
  // grid looked a third broader than it was. It could not move a maximum, so
  // no published number was wrong, but it burned a third of the chopped
  // budget. base32 is genuinely distinct: uppercase plus `234567`, a 19%
  // digit density against base36's 28%, which moves the word-mass
  // distribution rather than just the bytes.
  ["base32", ALPHABETS.base32 as string],
  ["letters-mixed", ALPHABETS["letters-mixed"] as string],
] as const;
const CHOPPED_GROUP_COUNTS = [3, 4, 5] as const;

for (const [name, alphabet] of CHOPPED_ALPHABETS) {
  for (const run of [4, 6, 8]) {
    for (const joiner of ["/", "-"] as const) {
      for (const groups of CHOPPED_GROUP_COUNTS) {
        families.push({
          name: `ref: ${name} chopped by '${joiner}' into ~${run}-char runs x${groups}`,
          shapeOf: `ref: ${name} chopped by '${joiner}' into ~${run}-char runs`,
          gen: () => {
            const parts: string[] = [];
            for (let i = 0; i < groups; i += 1) {
              parts.push(rand(alphabet, run - 1 + Math.floor(Math.random() * 3)));
            }
            return { ref: parts.join(joiner), expect: CLEAN_OID };
          },
        });
      }
    }
  }
}

// --- the expectation half ---------------------------------------------------
for (const [name, alphabet] of Object.entries(ALPHABETS)) {
  for (const length of [24, 32, 43, 64]) {
    families.push({
      name: `expect: ${name}@${length}`,
      gen: () => ({ ref: CLEAN_REF_FOR_EXPECT_COLUMN, expect: rand(alphabet, length) }),
    });
  }
}

// --- the composite as a unit ------------------------------------------------
for (const [name, alphabet] of Object.entries(ALPHABETS)) {
  families.push({
    name: `whole: ${name}@32 both halves`,
    gen: () => ({ ref: rand(alphabet, 32), expect: rand(alphabet, 32) }),
  });
}

// --- real credential formats ------------------------------------------------
const CREDENTIALS: Record<string, () => string> = {
  "github-pat-classic": () => `ghp_${rand(`${LOWER}${UPPER}${DIGIT}`, 36)}`,
  "github-pat-fine": () => `github_pat_${rand(`${LOWER}${UPPER}${DIGIT}_`, 71)}`,
  "github-oauth": () => `gho_${rand(`${LOWER}${UPPER}${DIGIT}`, 36)}`,
  "github-legacy-40hex": () => rand("0123456789abcdef", 40),
  slack: () => `xoxb-${rand(DIGIT, 13)}-${rand(`${LOWER}${UPPER}${DIGIT}`, 24)}`,
  "stripe-live": () => `sk_live_${rand(`${LOWER}${UPPER}${DIGIT}`, 24)}`,
  "stripe-restricted": () => `rk_live_${rand(`${LOWER}${UPPER}${DIGIT}`, 24)}`,
  "aws-key-id": () => `AKIA${rand(`${UPPER}${DIGIT}`, 16)}`,
  "aws-secret": () => rand(`${LOWER}${UPPER}${DIGIT}+/`, 40),
  google: () => `AIza${rand(`${LOWER}${UPPER}${DIGIT}-_`, 35)}`,
  anthropic: () => `sk-ant-api03-${rand(`${LOWER}${UPPER}${DIGIT}-_`, 95)}`,
  openai: () => `sk-${rand(`${LOWER}${UPPER}${DIGIT}`, 48)}`,
  "openai-project": () => `sk-proj-${rand(`${LOWER}${UPPER}${DIGIT}-_`, 64)}`,
  vault: () => `hvs.${rand(`${LOWER}${UPPER}${DIGIT}-_`, 64)}`,
  gitlab: () => `glpat-${rand(`${LOWER}${UPPER}${DIGIT}-_`, 20)}`,
  npm: () => `npm_${rand(`${LOWER}${UPPER}${DIGIT}`, 36)}`,
  grafana: () => `glsa_${rand(`${LOWER}${UPPER}${DIGIT}`, 32)}_${rand("0123456789abcdef", 8)}`,
  "totp-base32": () => rand(`${UPPER}234567`, 32),
  "k8s-bootstrap": () => `${rand(`${LOWER}${DIGIT}`, 6)}.${rand(`${LOWER}${DIGIT}`, 16)}`,
  digitalocean: () => `dop_v1_${rand("0123456789abcdef", 64)}`,
  "paperclip-service-key": () => `psk_${rand(`${LOWER}${UPPER}${DIGIT}-_`, 32)}`,
  "raw-hex-64": () => rand("0123456789abcdef", 64),
  "raw-base64-44": () => rand(`${LOWER}${UPPER}${DIGIT}+/`, 44),
  "raw-base64url-43": () => rand(`${LOWER}${UPPER}${DIGIT}-_`, 43),
};
for (const [name, gen] of Object.entries(CREDENTIALS)) {
  families.push({ name: `cred(ref, bare): ${name}`, gen: () => ({ ref: gen(), expect: CLEAN_OID }) });
  families.push({
    name: `cred(ref, branch-prefixed): ${name}`,
    gen: () => ({ ref: `release/${gen()}`, expect: CLEAN_OID }),
  });
  families.push({
    name: `cred(expect): ${name}`,
    gen: () => ({ ref: CLEAN_REF_FOR_EXPECT_COLUMN, expect: gen() }),
  });
}

// --- run --------------------------------------------------------------------
type Cell = { label: string; shapeOf?: string; admitted: number; population: number; trials: number; refused: number };

const cells: Cell[] = [];
let totalNewlyRefused = 0;

for (const family of families) {
  let newlyAdmitted = 0;
  let newlyRefused = 0;
  let population = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    const { ref, expect } = family.gen();
    const before = passes(UNANCHORED(ref, expect));
    const after = passes(PINNED(ref, expect));
    // POPULATION: the draws the SHIPPED detector redacts. Only these can ever
    // become `after && !before`, so they are the honest denominator. Dividing
    // by TRIALS instead mixes in draws the detector never looked at, which is
    // half of what diluted the published figures.
    if (!before) population += 1;
    if (after && !before) newlyAdmitted += 1;
    if (before && !after) newlyRefused += 1;
  }
  totalNewlyRefused += newlyRefused;
  cells.push({
    label: family.name,
    shapeOf: family.shapeOf,
    admitted: newlyAdmitted,
    population,
    trials: TRIALS,
    refused: newlyRefused,
  });
}

console.log(`# PEN-5734 --force-with-lease residual, ${TRIALS} trials per shape\n`);
console.log(
  "# Columns: newly-admitted is against TRIALS (the denominator the published\n" +
    "# figures historically used); per-population is against the draws the shipped\n" +
    "# detector actually redacts. PEN-5828: `n/a` means the detector never fired,\n" +
    "# so the rate is 0/0 and UNDEFINED — it is NOT a measured zero. A plain `0`\n" +
    "# means the detector fired and the exemption refused every draw, which is a\n" +
    "# conjunct doing its job. Collapsing the two loses the difference between\n" +
    '# "we never looked" and "we looked and it held".\n',
);
for (const cell of cells) console.log(formatCell(cell));

// --- per-family dilution ------------------------------------------------------
const shapes = new Map<string, Cell[]>();
for (const cell of cells) {
  if (cell.shapeOf === undefined) continue;
  const bucket = shapes.get(cell.shapeOf) ?? [];
  bucket.push(cell);
  shapes.set(cell.shapeOf, bucket);
}

console.log("\n# Per-family dilution: the FAMILY average the old report published,");
console.log("# beside the worst SHAPE inside it. The gap is the PEN-5828 finding.\n");
for (const [name, bucket] of shapes) {
  const worst = worstShape(bucket);
  const family = familyAverage(bucket);
  const factor = dilution(bucket);
  const reachable = bucket.filter((c) => classifyCell(c) !== "unreachable").length;
  console.log(
    `${name.padEnd(52)} family ${family === null || family === 0 ? "0" : family.toExponential(2)}` +
      `   worst shape ${worst === null ? "n/a" : (trialRate(worst) ?? 0).toExponential(2)}` +
      `   dilution ${factor === null ? "n/a" : `${factor.toFixed(2)}x`}` +
      `   reachable bins ${reachable}/${bucket.length}`,
  );
}

// --- headline -----------------------------------------------------------------
// BOTH lines, always. The worst FAMILY is what every earlier run of this script
// published; the worst SHAPE is what PEN-3920 6.5 now requires. Printing only
// the first is the defect PEN-5828 reports, and printing only the second would
// break comparison with every figure already in the tree.
const worstCell = worstShape(cells);
let worstFamilyRate = 0;
let worstFamilyName = "none";
for (const [name, bucket] of shapes) {
  const rate = familyAverage(bucket) ?? 0;
  if (rate > worstFamilyRate) {
    worstFamilyRate = rate;
    worstFamilyName = name;
  }
}
for (const cell of cells) {
  if (cell.shapeOf !== undefined) continue;
  const rate = trialRate(cell) ?? 0;
  if (rate > worstFamilyRate) {
    worstFamilyRate = rate;
    worstFamilyName = cell.label;
  }
}

console.log(
  `\nworst newly-admitted FAMILY: ${worstFamilyRate === 0 ? "0" : worstFamilyRate.toExponential(2)} (${worstFamilyName})`,
);
console.log(
  `worst newly-admitted SHAPE:  ${worstCell === null ? "n/a" : (trialRate(worstCell) ?? 0).toExponential(2)}` +
    ` (${worstCell === null ? "none reachable" : worstCell.label})` +
    `   per-population ${worstCell === null ? "n/a" : (populationRate(worstCell) ?? 0).toExponential(2)}`,
);
console.log(`total newly-refused across all families: ${totalNewlyRefused}`);
console.log(
  "\nFor scale, worst SHAPE against worst SHAPE and on the SAME denominator —\n" +
    "see PEN-3920 6.5, which is why these are no longer family averages:\n" +
    "  isLexicalIdentifier        6.21e-3 per-population (name-free)\n" +
    "  isKubernetesObjectName     2.02e-2 per-population (name-anchored)\n" +
    "⚠ Measure isKubernetesObjectName under an anchored name that is NOT `pod`:\n" +
    "  `pod` additionally carries isGeneratedPodName (PEN-5921), so anchoring\n" +
    "  there reports the UNION of two rules (1.43e-2) rather than this one.",
);
