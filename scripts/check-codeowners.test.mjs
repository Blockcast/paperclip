import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeErrors } from "./check-codeowners.mjs";

describe("summarizeErrors", () => {
  it("returns an empty list for no errors", () => {
    assert.deepEqual(summarizeErrors([]), []);
    assert.deepEqual(summarizeErrors(undefined), []);
    assert.deepEqual(summarizeErrors(null), []);
  });

  it("formats a line, kind, and suggestion into one string", () => {
    const errors = [
      {
        line: 15,
        column: 25,
        kind: "Unknown owner",
        suggestion: "make sure @cryppadotta exists and has write access to the repository",
        message: "Unknown owner on line 15: make sure @cryppadotta exists...",
        path: ".github/CODEOWNERS",
      },
    ];

    assert.deepEqual(summarizeErrors(errors), [
      "line 15: Unknown owner — make sure @cryppadotta exists and has write access to the repository",
    ]);
  });

  it("formats multiple errors preserving order", () => {
    const errors = [
      { line: 3, kind: "Unknown owner" },
      { line: 4, kind: "Unknown owner" },
    ];

    assert.deepEqual(summarizeErrors(errors), [
      "line 3: Unknown owner",
      "line 4: Unknown owner",
    ]);
  });

  it("omits the suggestion clause when absent", () => {
    assert.deepEqual(summarizeErrors([{ line: 1, kind: "Syntax error" }]), [
      "line 1: Syntax error",
    ]);
  });
});
