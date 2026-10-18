import { act } from "react";

/**
 * Shared React test driving helpers.
 *
 * Before this module there were 110 private `flush*` helpers and 26 private
 * `waitFor*` helpers across `ui/src`, and only 18 of the 110 actually drove
 * React's `act`. The rest were either a bare macrotask loop or a local
 * `function act(cb) { flushSync(cb) }` shim that *looked* act-wrapped at the
 * call site. `flushSync` does not drain React's act queue — pending passive
 * effects and scheduler continuations survive it — which is the defect class
 * PEN-4249 fixed in the WorkTimelineChart axis test.
 *
 * Import these instead of rolling a per-file copy.
 */

// React's `act` logs "The current testing environment is not configured to
// support act(...)" unless the environment advertises itself. That flag is now
// armed once for the whole suite in `ui/vitest.setup.ts` (PEN-4255), so this
// module no longer carries its own copy and neither does any test file.

/**
 * Drain React's work loop: microtasks, then one macrotask turn, inside `act`
 * so queued passive effects and scheduler continuations run to completion.
 *
 * `cycles` repeats the drain for surfaces that settle over several render
 * passes (a query resolving, which renders, which starts another query).
 * Prefer `waitForAssertion` over guessing a cycle count.
 */
export async function flushReact(cycles = 1): Promise<void> {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

/**
 * Run `assertion` until it stops throwing, draining React between attempts.
 * Rethrows the last failure once `attempts` is exhausted, so the test reports
 * the real assertion error rather than a timeout.
 *
 * The default of 50 is the median of the budgets it replaced; files that had
 * a smaller private default (20) are simply more patient on the failure path,
 * which cannot turn a passing test red. Budgets ABOVE 50 are pinned at the
 * call site instead, because shrinking one could.
 */
export async function waitForAssertion(assertion: () => void, attempts = 50): Promise<void> {
  if (attempts < 1) throw new RangeError(`waitForAssertion needs at least one attempt, got ${attempts}`);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

/**
 * Run `predicate` until it returns true, draining React between attempts.
 * The assertion form above is preferred — it reports *why* it failed — but
 * several suites were already written against a boolean predicate.
 */
export async function waitForCondition(
  predicate: () => boolean,
  attempts = 50,
  description = "condition",
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushReact();
  }
  throw new Error(`waitForCondition: ${description} did not become true within ${attempts} attempts`);
}
