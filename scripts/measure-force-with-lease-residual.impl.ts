// PEN-5734 residual measurement. Driven by measure-force-with-lease-residual.mjs;
// see that file for what each column means and why `expect` reads backwards.
import { scrubGitHubEgressText } from "../packages/adapter-utils/src/github-egress-scrub.js";

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

type Family = { name: string; gen: () => { ref: string; expect: string | null } };

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
for (const [name, alphabet] of [
  ["base36", ALPHABETS.base36 as string],
  ["lower-alnum", `${LOWER}${DIGIT}`],
  ["letters-mixed", ALPHABETS["letters-mixed"] as string],
] as const) {
  for (const run of [4, 6, 8]) {
    for (const joiner of ["/", "-"] as const) {
      families.push({
        name: `ref: ${name} chopped by '${joiner}' into ~${run}-char runs`,
        gen: () => {
          const groups = 3 + Math.floor(Math.random() * 3);
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
let worstAdmitted = 0;
let worstAdmittedName = "none";
let totalNewlyRefused = 0;
const rows: string[] = [];

for (const family of families) {
  let newlyAdmitted = 0;
  let newlyRefused = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    const { ref, expect } = family.gen();
    const before = passes(UNANCHORED(ref, expect));
    const after = passes(PINNED(ref, expect));
    if (after && !before) newlyAdmitted += 1;
    if (before && !after) newlyRefused += 1;
  }
  const rate = newlyAdmitted / TRIALS;
  if (rate > worstAdmitted) {
    worstAdmitted = rate;
    worstAdmittedName = family.name;
  }
  totalNewlyRefused += newlyRefused;
  rows.push(
    `${family.name.padEnd(46)} newly-admitted ${rate === 0 ? "0" : rate.toExponential(2)}` +
      `   newly-refused ${(newlyRefused / TRIALS).toExponential(2)}`,
  );
}

console.log(`# PEN-5734 --force-with-lease residual, ${TRIALS} trials per family\n`);
for (const row of rows) console.log(row);
console.log(`\nworst newly-admitted: ${worstAdmitted === 0 ? "0" : worstAdmitted.toExponential(2)} (${worstAdmittedName})`);
console.log(`total newly-refused across all families: ${totalNewlyRefused}`);
console.log(
  "\nFor scale: isLexicalIdentifier carries 2.96e-3 to 3.57e-3 NAME-FREE today;\n" +
    "the name-anchored Kubernetes rule carries up to 9.85e-3.",
);
