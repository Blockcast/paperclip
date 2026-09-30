import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROUTINE_VARIABLE_NAMES,
  extractRoutineVariableNames,
  getBuiltinRoutineVariableValues,
  interpolateRoutineTemplate,
  isBuiltinRoutineVariable,
  isRoutineDateVariableName,
  isValidRoutineDateString,
  syncRoutineVariablesWithTemplate,
} from "./routine-variables.js";

describe("routine variable helpers", () => {
  it("extracts placeholder names in first-appearance order", () => {
    expect(
      extractRoutineVariableNames("Review {{repo}} and {{priority}} for {{repo}}"),
    ).toEqual(["repo", "priority"]);
  });

  it("deduplicates placeholder names across the routine title and description", () => {
    expect(
      extractRoutineVariableNames([
        "Triage {{repo}}",
        "Review {{repo}} for {{priority}} bugs",
      ]),
    ).toEqual(["repo", "priority"]);
  });

  it("preserves existing metadata when syncing variables from a template", () => {
    expect(
      syncRoutineVariablesWithTemplate(["Triage {{repo}}", "Review {{repo}} and {{startDate}}"], [
        { name: "repo", label: "Repository", type: "text", defaultValue: "paperclip", required: true, options: [] },
        { name: "startDate", label: "Start", type: "text", defaultValue: "soon", required: false, options: [] },
      ]),
    ).toEqual([
      { name: "repo", label: "Repository", type: "text", defaultValue: "paperclip", required: true, options: [] },
      { name: "startDate", label: "Start", type: "text", defaultValue: "soon", required: false, options: [] },
    ]);
  });

  it("identifies routine date variable names by strict capital-Date suffix", () => {
    expect(isRoutineDateVariableName("startDate")).toBe(true);
    expect(isRoutineDateVariableName("endDate")).toBe(true);
    expect(isRoutineDateVariableName("fooDate")).toBe(true);
    expect(isRoutineDateVariableName("date")).toBe(false);
    expect(isRoutineDateVariableName("startdate")).toBe(false);
    expect(isRoutineDateVariableName("candidate")).toBe(false);
    expect(isRoutineDateVariableName("Date")).toBe(false);
  });

  it("defaults newly synced capital-Date variables to date type", () => {
    expect(
      syncRoutineVariablesWithTemplate("Compare {{startDate}} to {{endDate}} with {{date}}", []),
    ).toEqual([
      { name: "startDate", label: null, type: "date", defaultValue: null, required: true, options: [] },
      { name: "endDate", label: null, type: "date", defaultValue: null, required: true, options: [] },
    ]);
  });

  it("validates YYYY-MM-DD routine date strings as real calendar dates", () => {
    expect(isValidRoutineDateString("2024-02-29")).toBe(true);
    expect(isValidRoutineDateString("2024-02-30")).toBe(false);
    expect(isValidRoutineDateString("2023-02-29")).toBe(false);
    expect(isValidRoutineDateString("2024-13-01")).toBe(false);
    expect(isValidRoutineDateString("2024-1-01")).toBe(false);
  });

  it("interpolates provided variable values into the routine template", () => {
    expect(
      interpolateRoutineTemplate("Review {{repo}} for {{priority}}", {
        repo: "paperclip",
        priority: "high",
      }),
    ).toBe("Review paperclip for high");
  });

  it("identifies built-in variable names", () => {
    expect(isBuiltinRoutineVariable("date")).toBe(true);
    expect(isBuiltinRoutineVariable("timestamp")).toBe(true);
    expect(isBuiltinRoutineVariable("repo")).toBe(false);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("date")).toBe(true);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("timestamp")).toBe(true);
  });

  it("getBuiltinRoutineVariableValues returns date in YYYY-MM-DD format", () => {
    const values = getBuiltinRoutineVariableValues();
    expect(values.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(values.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("getBuiltinRoutineVariableValues returns a human-readable timestamp with year, time, and UTC", () => {
    const values = getBuiltinRoutineVariableValues();
    const year = String(new Date().getUTCFullYear());
    expect(values.timestamp).toContain(year);
    expect(values.timestamp).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(values.timestamp).toContain("UTC");
  });

  it("excludes built-in variables from syncRoutineVariablesWithTemplate", () => {
    const result = syncRoutineVariablesWithTemplate(
      "Daily report for {{date}} at {{timestamp}} — {{repo}}",
      [],
    );
    expect(result).toEqual([
      { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
    ]);
  });

  // A scheduled fire must render the window it BELONGS to, not the instant it was
  // dispatched: catch-up fires run minutes-to-hours late, and one catch-up pass can
  // dispatch several slots back to back. See BLO-34348.
  it("renders built-ins as of the supplied slot, not the current time", () => {
    const slot = new Date("2026-09-14T18:07:00.000Z");
    const values = getBuiltinRoutineVariableValues(slot);
    expect(values.scheduled_at).toBe("2026-09-14T18:07:00.000Z");
    expect(values.date).toBe("2026-09-14");
    expect(values.timestamp).toContain("September 14, 2026");
    // Guard against a silent regression to `new Date()`: the slot is in the past, so a
    // "now"-based implementation cannot produce any of the three values above.
    expect(values.date).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it("renders distinct values for distinct slots dispatched by one catch-up pass", () => {
    const first = getBuiltinRoutineVariableValues(new Date("2026-09-14T12:07:00.000Z"));
    const second = getBuiltinRoutineVariableValues(new Date("2026-09-14T18:07:00.000Z"));
    expect(first.scheduled_at).not.toBe(second.scheduled_at);
    expect(first.timestamp).not.toBe(second.timestamp);
  });

  it("falls back to the current time when no slot is supplied (manual/api fires)", () => {
    const values = getBuiltinRoutineVariableValues();
    expect(values.date).toBe(new Date().toISOString().slice(0, 10));
    expect(Date.parse(values.scheduled_at)).not.toBeNaN();
  });

  it("treats scheduled_at as built-in so templates need not declare it", () => {
    expect(isBuiltinRoutineVariable("scheduled_at")).toBe(true);
    expect(
      syncRoutineVariablesWithTemplate("Window {{scheduled_at}} — {{repo}}", []),
    ).toEqual([
      { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
    ]);
  });

  it("interpolates scheduled_at into a routine title", () => {
    expect(
      interpolateRoutineTemplate(
        "Agent health & stalled-issue check {{scheduled_at}}",
        getBuiltinRoutineVariableValues(new Date("2026-09-14T18:07:00.000Z")),
      ),
    ).toBe("Agent health & stalled-issue check 2026-09-14T18:07:00.000Z");
  });

  it("extracts snake_case variable names", () => {
    expect(extractRoutineVariableNames("Open {{pr_url}} for review")).toEqual(["pr_url"]);
  });

  it("extracts variable names whose underscores were markdown-escaped by a WYSIWYG editor", () => {
    // MDXEditor / mdast-util-to-markdown defensively escape intraword underscores
    // when serializing rich-text back to markdown, so `{{pr_url}}` is stored as `{{pr\_url}}`.
    expect(extractRoutineVariableNames("Open {{pr\\_url}} for review")).toEqual(["pr_url"]);
    expect(extractRoutineVariableNames("{{pr\\_url\\_v2}}")).toEqual(["pr_url_v2"]);
  });

  it("syncRoutineVariablesWithTemplate handles markdown-escaped underscores", () => {
    expect(
      syncRoutineVariablesWithTemplate("Open {{pr\\_url}}", []),
    ).toEqual([
      { name: "pr_url", label: null, type: "text", defaultValue: null, required: true, options: [] },
    ]);
  });

  it("interpolates variables that appear with markdown-escaped underscores", () => {
    expect(
      interpolateRoutineTemplate("Open {{pr\\_url}}", { pr_url: "https://example.com" }),
    ).toBe("Open https://example.com");
  });

  it("interpolates built-in variables alongside user variables", () => {
    const builtins = getBuiltinRoutineVariableValues();
    const allVars = { ...builtins, repo: "paperclip" };
    expect(
      interpolateRoutineTemplate("Report for {{date}} ({{timestamp}}) on {{repo}}", allVars),
    ).toBe(`Report for ${builtins.date} (${builtins.timestamp}) on paperclip`);
  });
});
