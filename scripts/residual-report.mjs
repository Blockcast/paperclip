// PEN-5828: the reporting core for the egress-scrub residual measurements.
//
// WHY THIS IS A SEPARATE MODULE. It is the half of
// `measure-force-with-lease-residual.impl.ts` that can be WRONG WITHOUT BEING
// NOTICED, so it is the half that gets a test. The measurement loop fails
// loudly — a broken generator produces obvious garbage. The reporting layer
// fails QUIETLY: it turns a correct set of per-shape counts into one averaged
// number, and the averaged number looks exactly like a measurement.
//
// THE DEFECT THIS EXISTS TO PREVENT (PEN-5828). The chopped-token families
// drew their group count at random inside the trial loop and reported ONE
// figure per family — the average over a mixture whose bins are not equally
// reachable. For the worst family two of the three bins contribute exactly
// zero, so the published number was the hot bin divided by three. Both
// corrections below are required and NEITHER IS SUFFICIENT ALONE:
//
//   1. BIN BY GROUP COUNT. Averaging a live bin against a structurally empty
//      one understates the worst reachable shape by the number of empty bins.
//   2. CARRY A POPULATION DENOMINATOR. `admitted / trials` divides by draws the
//      shipped detector never redacted, which cannot become `after && !before`
//      at all. The honest denominator is `population` = the draws it DID
//      redact, i.e. the ones the exemption had the opportunity to admit.
//
// AND A THIRD THING, which is the population correction's own blind spot:
// a population denominator distinguishes the two kinds of zero only if the
// report PRINTS them differently. See `classifyCell`.
//
// Pure, dependency-free and `.mjs` on purpose: `node --test` can reach it with
// no toolchain, so the pin survives a tree with no `node_modules`.

/** Printed for a rate that is 0/0 — undefined, not zero. */
export const UNREACHABLE_RATE = "n/a";

/**
 * The two kinds of zero, which a single `0` collapses into one.
 *
 * `unreachable` — POPULATION-SIDE. The shipped detector redacted none of the
 *   draws, so `after && !before` is false by construction and the exemption was
 *   never consulted. `admitted / population` is 0/0. This is "WE NEVER LOOKED",
 *   and printing it as `0` claims a measurement that was not taken. Live
 *   example: `letters-mixed` chopped by `/` into ~6-char runs at 3 groups —
 *   17-23 characters, below HIGH_ENTROPY_MIN_LENGTH, never redacted at all.
 *
 * `refused` — ADMISSION-SIDE. The detector fired on every draw and the
 *   exemption admitted none of them. `admitted / population` is a measured 0.
 *   This is "WE LOOKED AND THE CONJUNCT HELD". Live example: the same family at
 *   5 groups — population 1.000, admitted 0, because GIT_REF_MAX_COMPONENTS
 *   refuses it. That zero is a conjunct doing its job and is EVIDENCE; the
 *   other zero is the absence of evidence.
 *
 * `admitted` — a non-zero rate.
 */
export function classifyCell({ admitted, population }) {
  if (population === 0) return "unreachable";
  return admitted === 0 ? "refused" : "admitted";
}

/**
 * Rate against the population denominator, or `null` when undefined (0/0).
 * `null` is deliberate: it cannot be summed, averaged or compared with `>`
 * by accident, where a `0` silently can.
 */
export function populationRate({ admitted, population }) {
  return population === 0 ? null : admitted / population;
}

/** Rate against the raw trial count — the denominator the published figures
 *  historically used. Kept so the new report can be compared against them. */
export function trialRate({ admitted, trials }) {
  return trials === 0 ? null : admitted / trials;
}

function renderRate(rate) {
  if (rate === null) return UNREACHABLE_RATE;
  return rate === 0 ? "0" : rate.toExponential(2);
}

/**
 * One measured cell as a line. The two zeros MUST render differently; a report
 * that cannot tell "we never looked" from "we looked and it held" is this
 * row's own defect one level down.
 */
export function formatCell(cell) {
  const { label, admitted, population, trials } = cell;
  const pop = trials === 0 ? 0 : population / trials;
  return (
    `${String(label).padEnd(44)}` +
    ` newly-admitted ${renderRate(trialRate(cell))}` +
    `   population ${pop.toFixed(4)}` +
    `   per-population ${renderRate(populationRate(cell))}` +
    `   [${classifyCell(cell)}]`
  );
}

/**
 * Worst cell by population rate. Cells whose rate is undefined are EXCLUDED
 * rather than treated as 0 — they are not a measurement of anything, so they
 * can neither win nor lose this comparison.
 */
export function worstShape(cells) {
  let best = null;
  for (const cell of cells) {
    const rate = populationRate(cell);
    if (rate === null) continue;
    if (best === null || rate > populationRate(best)) best = cell;
  }
  return best;
}

/**
 * Collapse per-shape cells back into the FAMILY average the old report
 * published. Retained ONLY so the report can print both and show the gap; it
 * is the number PEN-5828 found to be diluted, never the number to quote.
 */
export function familyAverage(cells) {
  const admitted = cells.reduce((n, c) => n + c.admitted, 0);
  const trials = cells.reduce((n, c) => n + c.trials, 0);
  return trials === 0 ? null : admitted / trials;
}

/**
 * The dilution a family average carries against its own worst shape, on the
 * SAME denominator. Reported beside both so a reader can see the gap rather
 * than having to derive it — the gap is the finding.
 */
export function dilution(cells) {
  const worst = worstShape(cells);
  if (worst === null) return null;
  const family = familyAverage(cells);
  if (family === null || family === 0) return null;
  return trialRate(worst) / family;
}
