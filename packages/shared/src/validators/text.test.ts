import { describe, expect, it } from "vitest";

import { addApprovalCommentSchema, resolveApprovalSchema } from "./approval.js";
import {
  addIssueCommentSchema,
  createIssueSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
} from "./issue.js";
import { multilineTextSchema } from "./text.js";

/**
 * PEN-5954 oracle. Every entry is a literal backslash followed by the named
 * characters — never a JavaScript escape — so each one is the exact byte
 * sequence a caller would have had to be able to store.
 */
const LITERAL_ESCAPE_SHAPES: ReadonlyArray<readonly [string, string]> = [
  // The three shapes the removed transform rewrote to a single U+000A.
  ["backslash n", String.raw`\n`],
  ["backslash r", String.raw`\r`],
  ["backslash r backslash n", String.raw`\r\n`],
  // The shape that looked like an escape hatch and was not: the transform was
  // not backslash-aware, so it consumed the second backslash and stored one
  // backslash plus U+000A.
  ["backslash backslash n", String.raw`\\n`],
  // Shapes that were already passed through; kept so a reintroduced transform
  // with a wider rule is caught too.
  ["backslash t", String.raw`\t`],
  ["backslash backslash", String.raw`\\`],
  ["backslash quote", String.raw`\"`],
  ["backslash u0041", String.raw`A`],
  ["backslash U00000041", String.raw`\U00000041`],
  ["backslash x41", String.raw`\x41`],
  ["backslash zero", String.raw`\0`],
  ["backslash b", String.raw`\b`],
  ["backslash f", String.raw`\f`],
  ["backslash v", String.raw`\v`],
  ["backslash a", String.raw`\a`],
  ["backslash slash", String.raw`\/`],
  ["backslash apostrophe", String.raw`\'`],
  ["backslash N", String.raw`\N`],
  ["backslash z", String.raw`\z`],
];

const SPECIMEN_BLOCK = LITERAL_ESCAPE_SHAPES.map(
  ([name, shape], index) => `SPEC-${index} ${name} -> ${shape}`,
).join("\n");

describe("multilineTextSchema", () => {
  it("is not a transform: every literal escape shape round-trips byte-identical", () => {
    for (const [name, shape] of LITERAL_ESCAPE_SHAPES) {
      expect(multilineTextSchema.parse(shape), name).toBe(shape);
    }
  });

  it("stores a literal backslash-n rather than a line break", () => {
    const parsed = multilineTextSchema.parse(String.raw`line one\nline two`);

    expect(parsed).toBe(String.raw`line one\nline two`);
    expect(parsed).not.toContain("\n");
    expect(parsed).toHaveLength(18);
  });

  it("leaves a real line break alone", () => {
    expect(multilineTextSchema.parse("line one\nline two")).toBe("line one\nline two");
  });

  it("keeps a carriage return a carriage return", () => {
    // The removed transform mapped a literal backslash-r to U+000A, which is
    // destruction rather than reinterpretation.
    expect(multilineTextSchema.parse("head\r\ntail")).toBe("head\r\ntail");
    expect(multilineTextSchema.parse(String.raw`head\rtail`)).toBe(String.raw`head\rtail`);
  });
});

describe("multiline fields store the specimen block verbatim", () => {
  it("issue description", () => {
    expect(
      createIssueSchema.parse({ title: "Specimen", description: SPECIMEN_BLOCK }).description,
    ).toBe(SPECIMEN_BLOCK);
  });

  it("issue title", () => {
    // `title` never carried the transform; it is here as the control that the
    // assertion can discriminate a field that was always verbatim.
    expect(createIssueSchema.parse({ title: String.raw`ship\nit` }).title).toBe(
      String.raw`ship\nit`,
    );
  });

  it("issue update comment", () => {
    expect(updateIssueSchema.parse({ comment: SPECIMEN_BLOCK }).comment).toBe(SPECIMEN_BLOCK);
  });

  it("issue comment body", () => {
    expect(addIssueCommentSchema.parse({ body: SPECIMEN_BLOCK }).body).toBe(SPECIMEN_BLOCK);
  });

  it("issue document body", () => {
    expect(upsertIssueDocumentSchema.parse({ format: "markdown", body: SPECIMEN_BLOCK }).body).toBe(
      SPECIMEN_BLOCK,
    );
  });

  it("approval comment body", () => {
    expect(addApprovalCommentSchema.parse({ body: SPECIMEN_BLOCK }).body).toBe(SPECIMEN_BLOCK);
  });

  it("approval decision note", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: SPECIMEN_BLOCK }).decisionNote).toBe(
      SPECIMEN_BLOCK,
    );
  });
});
