import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isOpenRoutineExecutionLockConflict } from "../services/issues.js";

/**
 * PEN-2395. `isOpenRoutineExecutionLockConflict` is the blast radius of the
 * routine-lock guard: everything it matches becomes a 409, everything else is
 * rethrown untouched. A silent widening here would convert unrelated failures
 * into 409s, so the load-bearing claim — "only a 23505 against this one named
 * constraint" — is pinned directly rather than inferred from the DB tests.
 *
 * No database needed: the predicate is pure error-shape inspection.
 */

const CONSTRAINT = "issues_open_routine_execution_uq";

function pgError(fields: { code?: string; constraint?: string; constraint_name?: string }) {
  return Object.assign(new Error("duplicate key value violates unique constraint"), fields);
}

describe("isOpenRoutineExecutionLockConflict (PEN-2395)", () => {
  it("matches a 23505 against the named constraint", () => {
    expect(isOpenRoutineExecutionLockConflict(pgError({ code: "23505", constraint: CONSTRAINT })))
      .toBe(true);
  });

  it("matches through a DrizzleQueryError wrapper", () => {
    // The reason the cause-chain walk exists: drizzle wraps the driver error, so
    // the constraint name is never on the outermost error and a naive
    // `error.constraint` check would never fire in production.
    const wrapped = new DrizzleQueryError(
      "update issues set execution_run_id = $1",
      [],
      pgError({ code: "23505", constraint: CONSTRAINT }),
    );

    expect(
      (wrapped as { constraint?: string }).constraint,
      "guards the premise: the wrapper itself carries no constraint",
    ).toBeUndefined();
    expect(isOpenRoutineExecutionLockConflict(wrapped)).toBe(true);
  });

  it("matches the constraint_name spelling", () => {
    expect(
      isOpenRoutineExecutionLockConflict(pgError({ code: "23505", constraint_name: CONSTRAINT })),
    ).toBe(true);
  });

  it("does NOT match a 23505 against a different constraint", () => {
    // The narrowing that keeps the guard from swallowing unrelated uniqueness
    // violations — those must stay 500s, not become retryable 409s.
    expect(
      isOpenRoutineExecutionLockConflict(
        pgError({ code: "23505", constraint: "issues_active_alert_escalation_cover_uq" }),
      ),
    ).toBe(false);
  });

  it("does NOT match a non-23505 carrying the constraint name", () => {
    expect(
      isOpenRoutineExecutionLockConflict(pgError({ code: "23503", constraint: CONSTRAINT })),
    ).toBe(false);
  });

  it("does NOT match unrelated errors", () => {
    expect(isOpenRoutineExecutionLockConflict(new Error("boom"))).toBe(false);
    expect(isOpenRoutineExecutionLockConflict(null)).toBe(false);
    expect(isOpenRoutineExecutionLockConflict(undefined)).toBe(false);
    expect(isOpenRoutineExecutionLockConflict("23505")).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    // The `seen` guard earns its place here: a self-referential cause would
    // otherwise hang the error path rather than fail it.
    const cyclic = pgError({ code: "42P01" }) as Error & { cause?: unknown };
    cyclic.cause = cyclic;

    expect(isOpenRoutineExecutionLockConflict(cyclic)).toBe(false);
  });

  it("finds the match at depth, not just one level down", () => {
    const deep = new DrizzleQueryError(
      "outer",
      [],
      new DrizzleQueryError("inner", [], pgError({ code: "23505", constraint: CONSTRAINT })),
    );

    expect(isOpenRoutineExecutionLockConflict(deep)).toBe(true);
  });
});
