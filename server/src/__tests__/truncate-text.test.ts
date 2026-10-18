import { describe, expect, it } from "vitest";
import { truncateSectionText, truncateText } from "../services/truncate-text.js";

describe("truncateText", () => {
  it("returns short values untouched apart from trimming", () => {
    expect(truncateText("  already short  ", 100)).toBe("already short");
  });

  it("keeps the causal tail of a long single-line error (BLO-31142)", () => {
    const cause = "error: could not lock config file /workspace/.git/config.lock: File exists";
    const value = `${"/very/long/workspace/path/".repeat(30)}${cause}`;
    const result = truncateText(value, 240);

    expect(result.length).toBeLessThanOrEqual(240);
    expect(result).toContain("could not lock config file");
  });

  it("does not split a word at either end of the elision (PEN-4311)", () => {
    const value = `${"alpha bravo charlie delta echo ".repeat(40)}foxtrot golf hotel india juliett`;
    const result = truncateText(value, 200);
    const [head, tail] = result.split("...");

    expect(result.length).toBeLessThanOrEqual(200);
    expect(value.startsWith(head)).toBe(true);
    expect(value.endsWith(tail)).toBe(true);
    // The character after the head, and the one before the tail, are the whitespace the cut
    // landed on — so neither end is a word fragment.
    expect(value.charAt(head.length)).toMatch(/\s/);
    expect(value.charAt(value.length - tail.length - 1)).toMatch(/\s/);
  });

  it("still truncates a single unbroken token, since there is no boundary to find", () => {
    const result = truncateText("x".repeat(500), 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain("...");
  });

  it("honours an explicit marker and separator", () => {
    const result = truncateText("a ".repeat(400).trim(), 80, "[truncated]", "\n");
    expect(result).toContain("\n[truncated]\n");
    expect(result.length).toBeLessThanOrEqual(80);
  });
});

describe("truncateSectionText", () => {
  const section = [
    "## Outcome",
    "",
    "Implement the thing. ".repeat(40),
    "",
    "> Plan anchor: do not re-point to the storage tip.",
    "",
    "Trailing paragraph that the budget cannot fit. ".repeat(30),
  ].join("\n");

  it("returns short sections untouched apart from trimming", () => {
    expect(truncateSectionText("  short section  ", 500)).toBe("short section");
  });

  it("marks and counts the cut instead of eliding silently", () => {
    const result = truncateSectionText(section, 1_200);

    expect(result.length).toBeLessThanOrEqual(1_200);
    expect(result).toMatch(/\[\.\.\. [\d,]+ characters elided; read the issue description for the full text \.\.\.\]$/);
  });

  it("keeps an unbroken prefix, so no two spans are welded by an unmarked ellipsis", () => {
    const result = truncateSectionText(section, 1_200);
    const kept = result.slice(0, result.indexOf("\n\n[..."));

    expect(section.startsWith(kept)).toBe(true);
    expect(section.charAt(kept.length)).toMatch(/\s/);
  });

  it("reports the number of characters actually removed", () => {
    const result = truncateSectionText(section, 1_200);
    const kept = result.slice(0, result.indexOf("\n\n[..."));
    const reported = Number(/\[\.\.\. ([\d,]+) characters/.exec(result)?.[1]?.replace(/,/g, ""));

    expect(reported).toBe(section.trim().length - kept.length);
  });

  it("names the source it was cut from", () => {
    expect(truncateSectionText(section, 600, "the run log")).toContain("read the run log for the full text");
  });

  it("is idempotent once a value already fits", () => {
    const once = truncateSectionText(section, 1_200);
    expect(truncateSectionText(once, 1_200)).toBe(once);
  });
});
