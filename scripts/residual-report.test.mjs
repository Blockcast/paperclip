// PEN-5828. These tests pin the PER-SHAPE reporting so the bin split cannot
// silently collapse back to a family average.
//
// WHAT EACH ASSERTION CATCHES, named, because a test whose mutation nobody
// states is a test nobody can tell is working:
//
//   collapse-to-average  — someone re-draws the group count inside the trial
//                          loop, or sums the bins before reporting. Caught by
//                          `worstShape` disagreeing with `familyAverage` by
//                          the measured 3x on the real hot family.
//   zero-collapse        — someone renders a 0/0 rate as `0`. Caught by the
//                          two zero cells rendering DIFFERENTLY, and by
//                          `populationRate` returning `null` rather than 0.
//   unreachable-wins     — someone lets a 0/0 cell take part in the max.
//   trials-denominator   — someone drops the population denominator.
//
// THE FIXTURE COUNTS ARE REAL. They are this row's own 40,000-trial sweep of
// the shipped module at `master` (PEN-5828, 2026-11-11), not invented numbers,
// so a reader can re-derive them with
// `node scripts/measure-force-with-lease-residual.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UNREACHABLE_RATE,
  classifyCell,
  dilution,
  familyAverage,
  formatCell,
  populationRate,
  trialRate,
  worstByTrialRate,
  worstShape,
} from "./residual-report.mjs";

/** `letters-mixed` chopped by `/` into ~6-char runs — the worst family in the
 *  grid, and the one whose published 2.33e-3 was the hot bin divided by three.
 *  Measured 2026-11-11 at 40,000 trials per bin against the shipped module. */
const HOT_FAMILY = [
  { label: "letters-mixed '/' ~6 grp=3", admitted: 0, population: 0, trials: 40000 },
  { label: "letters-mixed '/' ~6 grp=4", admitted: 266, population: 39532, trials: 40000 },
  { label: "letters-mixed '/' ~6 grp=5", admitted: 0, population: 40000, trials: 40000 },
];

const UNREACHABLE = HOT_FAMILY[0];
const HOT = HOT_FAMILY[1];
const REFUSED = HOT_FAMILY[2];

test("the two kinds of zero are different kinds", () => {
  // Population-side: the detector never fired, so there is nothing to divide by.
  assert.equal(classifyCell(UNREACHABLE), "unreachable");
  assert.equal(populationRate(UNREACHABLE), null);

  // Admission-side: the detector fired on every draw and the cap refused them.
  assert.equal(classifyCell(REFUSED), "refused");
  assert.equal(populationRate(REFUSED), 0);

  // zero-collapse: these must not render alike. A report that prints `0` for
  // both cannot tell "we never looked" from "we looked and the conjunct held".
  const a = formatCell(UNREACHABLE);
  const b = formatCell(REFUSED);
  assert.notEqual(a, b);
  assert.match(a, new RegExp(`per-population ${UNREACHABLE_RATE}`));
  assert.match(b, /per-population 0\s/);
});

/** `base36` chopped by `-` into ~6-char runs. Included because its maximum is
 *  the LAST reachable bin, not the first: a fixture whose max happens to come
 *  first cannot tell "take the max" from "take the first", and a mutation of
 *  `worstShape` then passes. Measured in the same 40,000-trial sweep. */
const MAX_IS_LAST = [
  { label: "base36 '-' ~6 grp=3", admitted: 0, population: 0, trials: 40000 },
  { label: "base36 '-' ~6 grp=4", admitted: 34, population: 39308, trials: 40000 },
  { label: "base36 '-' ~6 grp=5", admitted: 179, population: 39964, trials: 40000 },
];

test("an unreachable cell cannot win the worst-shape comparison", () => {
  // unreachable-wins: `null` must be skipped, not coerced to 0 and compared.
  assert.equal(worstShape([UNREACHABLE]), null);
  assert.equal(worstShape(HOT_FAMILY).label, HOT.label);
  // ...and it still loses to a genuinely measured zero.
  assert.equal(worstShape([UNREACHABLE, REFUSED]).label, REFUSED.label);

  // collapse-to-average, the mutation that matters most: `worstShape` must
  // take the MAXIMUM, not the first reachable bin. On this family the maximum
  // is the last bin and is 5.2x the first, so "first" and "max" disagree.
  assert.equal(worstShape(MAX_IS_LAST).label, "base36 '-' ~6 grp=5");
  assert.ok(populationRate(MAX_IS_LAST[2]) > populationRate(MAX_IS_LAST[1]) * 4);
});

test("the family average dilutes the worst shape by the number of dead bins", () => {
  // collapse-to-average: this is the whole finding. Two of three bins
  // contribute exactly zero, so the family figure is the hot bin over three.
  const family = familyAverage(HOT_FAMILY);
  const worst = trialRate(HOT);
  assert.ok(family < worst, "family average must be below the worst shape");
  // Exactly 3.000x, because the flanking bins are identically zero rather
  // than merely small. Pinned tightly: a near-miss here means a bin stopped
  // being empty, which is a finding and should fail rather than drift.
  assert.ok(Math.abs(dilution(HOT_FAMILY) - 3) < 1e-9, `dilution was ${dilution(HOT_FAMILY)}`);
});

test("the population denominator is carried, not assumed to be 1", () => {
  // trials-denominator: the hot cell's population is 0.988, not 1.000, so the
  // two rates must differ. They are close HERE and are not close everywhere —
  // `isLexicalIdentifier`'s worst cell runs a population of 0.43, where the
  // choice of denominator moves the figure by 2.3x. That is why both print.
  assert.notEqual(trialRate(HOT), populationRate(HOT));
  assert.ok(populationRate(HOT) > trialRate(HOT));
  assert.match(formatCell(HOT), /population 0\.9883/);
});

test("a family with no reachable bin reports nothing rather than zero", () => {
  // `letters-mixed` chopped by `-` into ~4-char runs: every bin is below
  // isLexicalIdentifier's 30-character content cap, so the whole family is
  // exonerated before the git-ref rule is consulted. Reporting `0` for that
  // would claim the rule was measured and held.
  const dead = [3, 4, 5].map((g) => ({
    label: `letters-mixed '-' ~4 grp=${g}`,
    admitted: 0,
    population: 0,
    trials: 40000,
  }));
  assert.equal(worstShape(dead), null);
  assert.equal(dilution(dead), null);
  for (const cell of dead) assert.equal(classifyCell(cell), "unreachable");
});

/** `isLexicalIdentifier`'s 3-7 character / `-` family, measured 2026-11-11 at
 *  100,000 trials per shape. Included because its worst-by-POPULATION cell and
 *  its worst-by-TRIAL cell are DIFFERENT cells — the bins run populations of
 *  0.43 and 0.96 — which is the only fixture that can catch a dilution factor
 *  built from half of each. */
const DENOMINATORS_DISAGREE = [
  { label: "3-7 chars '-' grp=4", admitted: 266, population: 42870, trials: 100000 },
  { label: "3-7 chars '-' grp=5", admitted: 388, population: 95800, trials: 100000 },
];

test("dilution is built from ONE denominator, end to end", () => {
  const [g4, g5] = DENOMINATORS_DISAGREE;
  // The premise: the two rankings genuinely disagree on this family.
  assert.equal(worstShape(DENOMINATORS_DISAGREE).label, g4.label);
  assert.equal(worstByTrialRate(DENOMINATORS_DISAGREE).label, g5.label);

  // mixed-denominator: `familyAverage` is a TRIAL rate, so the numerator must
  // be one too. Taking the worst-by-POPULATION cell's trial rate instead
  // reports 0.81 here — a "dilution" BELOW 1, i.e. a worst shape apparently
  // weaker than the average it is drawn from, which is impossible.
  const factor = dilution(DENOMINATORS_DISAGREE);
  assert.ok(factor >= 1, `dilution must never be < 1; got ${factor}`);
  assert.ok(Math.abs(factor - trialRate(g5) / familyAverage(DENOMINATORS_DISAGREE)) < 1e-12);
  assert.ok(Math.abs(factor - 1.187) < 0.01, `expected ~1.187, got ${factor}`);
});

test("dilution is never below 1 on any measured family", () => {
  // A worst shape cannot be weaker than the average that contains it. This is
  // the cheap invariant that catches any future denominator mix, on any
  // fixture, without needing one where the two rankings disagree.
  for (const family of [HOT_FAMILY, MAX_IS_LAST, DENOMINATORS_DISAGREE]) {
    const factor = dilution(family);
    if (factor === null) continue;
    assert.ok(factor >= 1, `dilution < 1 on ${family[0].label}: ${factor}`);
  }
});
