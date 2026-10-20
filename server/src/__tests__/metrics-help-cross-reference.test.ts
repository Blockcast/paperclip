import { beforeEach, describe, expect, it } from "vitest";
import {
  PROCESS_MAPPING_COUNT_METRIC,
  ROUTINE_DISPATCH_METRIC,
  ROUTINE_LAST_DONE_FIRE_AGE_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-4412: every `paperclip_*` metric named inside a HELP string must resolve
 * to a metric this process actually registers.
 *
 * Why this is registry-wide rather than one more per-metric assertion: #2856
 * renamed `paperclip_process_glibc_secondary_arena_count` ->
 * `..._arena_heap_count` and updated the registration but not the HELP text on
 * a SIBLING metric that cross-referenced the old name. The exposition kept
 * telling operators to read a selector that matches nothing, it shipped, and it
 * was caught by eye in review rather than by CI. A per-metric test cannot catch
 * that class: the defect is always in the help text of some OTHER metric than
 * the one being renamed, so the suite that would have to assert on it is the
 * one nobody is editing.
 *
 * This is a generalisation of the cross-reference check in
 * `start-lock-reap-disposition-metric.test.ts`, not a replacement for it. That
 * test, and the park-horizon ceiling list in
 * `overdue-scheduled-retry-metrics.test.ts`, assert SEMANTIC content -- that a
 * particular pointer is present, that a derived list is complete. This one only
 * asserts that whatever tokens are present resolve. Different failures; keep
 * all three.
 *
 * Scope, stated so nobody over-reads a green run: this catches DANGLING
 * SELECTORS, not inaccurate prose. #2863 corrected a claim in this very help
 * string where every token resolved and the sentence about it was still wrong
 * (`mapping_count` called the heap-count series "the heap count"; it counts
 * young, tailed heaps only). This guard would not have caught that, and must
 * not be sold as if it would.
 */

/**
 * Tokens allowed to name something this registry does not hold.
 *
 * Empty today, and deliberately present anyway: a legitimate forward reference
 * -- a pointer at a metric owned by another service, or one landing in a later
 * PR -- will otherwise tempt whoever trips this guard into deleting the
 * assertion. Adding a line with a reason is the cheaper escape hatch. Each
 * entry is a token mapped to why it cannot resolve here.
 */
const ALLOWED_UNRESOLVED_REFERENCES = new Map<string, string>([]);

/**
 * Metric-name-shaped tokens in help text.
 *
 * Anchored on the `paperclip_` prefix rather than on snake_case generally,
 * because help text is full of tokens that are not metric names: label values
 * (`mapping_class=anon_aligned_64m_full`), outcome enums, and field names would
 * all be swept in by a bare `[a-z0-9_]+`. Lowercase-only is load-bearing too --
 * it keeps env-var references such as `AGENT_START_LOCK_REAP_WAIT_BOUND_MS=0`
 * out without needing a second exclusion rule.
 *
 * `\b` keeps a longer identifier that merely ENDS in a metric name (say
 * `legacy_paperclip_foo`) from matching, since `_p` is not a word boundary.
 *
 * Only sound against UNESCAPED text -- see {@link unescapeHelp}. The exposition
 * renders a real newline as the two characters `\` + `n`, and `n` is a word
 * character, so a token immediately after one has no word boundary before it
 * and is silently missed. A false NEGATIVE in a guard is the dangerous
 * direction: it reports clean. (A lookbehind such as `(?<![A-Za-z0-9_])` does
 * NOT fix this -- it excludes exactly the same character class, so it misses
 * the same token. Measured against prom-client 15.1.3.)
 *
 * Shared at module scope only because every use below goes through
 * `String.prototype.match`, which resets `lastIndex` for a `/g` regex. Switch a
 * caller to `.exec()` or `.test()` and this becomes stateful across calls.
 */
const METRIC_TOKEN = /\bpaperclip_[a-z0-9_]+/g;

interface DanglingReference {
  /** The metric whose HELP line carries the unresolved token. */
  readonly owner: string;
  readonly token: string;
}

/**
 * Recover HELP text as it was written, before the exposition escaped it.
 *
 * Prometheus HELP escaping is `\` -> `\\` and newline -> `\` + `n`, so a
 * multi-line help string arrives on ONE line with literal backslash-n in it.
 * Matching without undoing that misses any metric named right after a newline.
 * No help string in `metrics.ts` is multi-line today, so this is hardening
 * against a latent false negative rather than a live one.
 *
 * One left-to-right pass, so a literal backslash followed by `n` (escaped
 * `\\n`) is NOT mistaken for a newline.
 */
function unescapeHelp(text: string): string {
  return text.replace(/\\([\\n])/g, (_, char: string) => (char === "n" ? "\n" : "\\"));
}

/**
 * Registered metric names, by exposition type.
 *
 * Read off the rendered exposition rather than the source text or
 * `getMetricsAsJSON()`, and both halves of that matter. Against the SOURCE, a
 * naive same-file grep false-positives: at `d0306817` `metrics.ts` carried 123
 * distinct `paperclip_*` tokens, and the one without a quoted literal --
 * `paperclip_plugin_status` -- sits in a JSDoc comment, not a HELP string.
 * Against `getMetricsAsJSON()`, three families are missed entirely:
 * `renderMetrics` appends hand-written `# HELP` lines for the dep-blocked,
 * blocker-resolved and routine-dispatch counters after the registry's own
 * output, so a registry-only read would never see the help text most likely to
 * drift (it is a template literal, not a registered `help` field).
 */
function registeredTypes(body: string): Map<string, string> {
  const types = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^# TYPE (\S+) (\S+)\s*$/.exec(line);
    if (match) types.set(match[1], match[2]);
  }
  return types;
}

/**
 * Whether `token` names something an operator could actually select.
 *
 * Histograms and summaries expose sample series the `# TYPE` line does not
 * name, so `paperclip_x_seconds_bucket` is a valid selector against a
 * registered histogram `paperclip_x_seconds`. The suffix is only accepted when
 * the base resolves to a type that really emits it -- `_bucket` against a
 * summary is still dangling.
 *
 * `_total` is deliberately NOT stripped. prom-client registers counters with
 * the suffix already on the name, so a counter reference resolves exactly;
 * stripping it would instead let `paperclip_some_gauge_total` resolve against a
 * gauge named `paperclip_some_gauge`, which is a wrong selector this guard
 * exists to reject.
 */
function resolves(token: string, types: ReadonlyMap<string, string>): boolean {
  if (types.has(token)) return true;
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    if (!token.endsWith(suffix)) continue;
    const kind = types.get(token.slice(0, -suffix.length));
    if (kind === "histogram") return true;
    if (kind === "summary" && suffix !== "_bucket") return true;
  }
  return false;
}

/** Every `paperclip_*` token in a HELP line that names no registered metric. */
function danglingHelpReferences(body: string): DanglingReference[] {
  const types = registeredTypes(body);
  const dangling: DanglingReference[] = [];
  for (const line of body.split("\n")) {
    const match = /^# HELP (\S+) (.*)$/.exec(line);
    if (!match) continue;
    const [, owner, text] = match;
    for (const token of unescapeHelp(text).match(METRIC_TOKEN) ?? []) {
      if (resolves(token, types)) continue;
      if (ALLOWED_UNRESOLVED_REFERENCES.has(token)) continue;
      dangling.push({ owner, token });
    }
  }
  return dangling;
}

/** Every `paperclip_*` token any HELP line mentions, resolved or not. */
function helpReferenceTokens(body: string): Set<string> {
  const tokens = new Set<string>();
  for (const line of body.split("\n")) {
    const match = /^# HELP (\S+) (.*)$/.exec(line);
    if (!match) continue;
    for (const token of unescapeHelp(match[2]).match(METRIC_TOKEN) ?? []) tokens.add(token);
  }
  return tokens;
}

describe("Prometheus HELP cross-references", () => {
  /** The bytes `GET /metrics` serves, from a registry no other suite has touched. */
  let expositionBody = "";

  beforeEach(async () => {
    __resetMetricsForTest();
    expositionBody = (await renderMetrics()).body;
  });

  it("names no metric this process does not register", () => {
    // Positive controls, in the order the parse depends on them. A
    // registry-walking guard's characteristic failure is going vacuous: if the
    // exposition is empty, or the `# TYPE`/`# HELP` shapes change, every set
    // below is empty and the difference is trivially empty too. Each control
    // below fails loudly in that case instead.
    const types = registeredTypes(expositionBody);
    expect(types.size).toBeGreaterThan(0);
    // Imported rather than spelled out, so a rename moves this with it.
    expect([...types.keys()]).toContain(PROCESS_MAPPING_COUNT_METRIC);
    // The extractor sees the live corpus, not just a well-formed empty string.
    // A non-empty TYPE set does not establish this -- the HELP parse and the
    // token regex are a separate code path, and an exposition with zero
    // cross-references would pass the whole assertion below while proving
    // nothing.
    expect(helpReferenceTokens(expositionBody).size).toBeGreaterThan(0);

    expect(danglingHelpReferences(expositionBody)).toEqual([]);
  });

  it("reads the exposition, which carries metrics the registry object does not", () => {
    // Pins the "render, do not walk `getMetricsAsJSON()`" decision, because the
    // difference is live rather than theoretical. `renderMetrics` appends three
    // counters -- dep-blocked, blocker-resolved, routine-dispatch -- as
    // hand-built template literals AFTER prom-client's output; none is a
    // registered `Counter`, so none appears in `getMetricsAsJSON()`.
    expect([...registeredTypes(expositionBody).keys()]).toContain(ROUTINE_DISPATCH_METRIC);

    // And the gap bites in both directions at once: a REGISTERED gauge's help
    // points AT one of those unregistered counters. A registry-walking guard
    // would therefore report this correct, live cross-reference as dangling --
    // a false positive on good code, which is how a guard gets deleted.
    const owner = expositionBody
      .split("\n")
      .find((line) => line.startsWith(`# HELP ${ROUTINE_LAST_DONE_FIRE_AGE_METRIC} `));
    expect(owner).toBeDefined();
    expect(owner).toContain(ROUTINE_DISPATCH_METRIC);
  });

  it("reports a help string that points at a metric nobody registers", () => {
    // The negative control, and the reason this file is not merely decorative:
    // the assertion above is a set difference, and a detector that extracts
    // nothing produces an empty difference forever. This replays #2856's exact
    // shape -- a sibling metric's help still naming the pre-rename series --
    // against a synthetic exposition, so it stays reproducible after the real
    // defect is long fixed.
    const renamed = [
      "# HELP paperclip_process_mapping_count Mappings per class; this is NOT the heap"
        + " count -- read paperclip_process_glibc_secondary_arena_count for that.",
      "# TYPE paperclip_process_mapping_count gauge",
      "# HELP paperclip_process_glibc_secondary_arena_heap_count Young heaps.",
      "# TYPE paperclip_process_glibc_secondary_arena_heap_count gauge",
      "",
    ].join("\n");

    expect(danglingHelpReferences(renamed)).toEqual([
      {
        owner: "paperclip_process_mapping_count",
        token: "paperclip_process_glibc_secondary_arena_count",
      },
    ]);
  });

  it("sees a metric named right after a newline in multi-line help", () => {
    // Found by review on this PR. The exposition renders a real newline as the
    // two characters `\` + `n`, so a token straight after one is preceded by a
    // word character and `\b` never matches it -- the guard would report clean
    // on a genuinely dangling reference, which is the one direction a guard
    // must not fail in.
    //
    // The escaping is asserted here rather than assumed: this is what
    // prom-client 15.1.3 actually emits, and the assertion below fails if a
    // future version stops escaping or escapes differently, which would make
    // `unescapeHelp` silently wrong rather than silently unnecessary.
    const escaped = "first line\\npaperclip_after_newline ends it.";
    expect(escaped).toContain("\\n");
    expect(escaped).not.toContain("\n");

    const multiline = [
      `# HELP paperclip_pointer_metric ${escaped}`,
      "# TYPE paperclip_pointer_metric gauge",
      "",
    ].join("\n");

    expect(danglingHelpReferences(multiline)).toEqual([
      { owner: "paperclip_pointer_metric", token: "paperclip_after_newline" },
    ]);

    // A literal backslash-then-n (escaped `\\n`) is not a newline, and the
    // single left-to-right pass must not turn it into one.
    expect(unescapeHelp("a \\\\n b")).toBe("a \\n b");
    expect(unescapeHelp("a \\n b")).toBe("a \n b");
  });

  it("reads metric names, not label values or env vars", () => {
    // The second sharp edge: help text is denser in snake_case non-metrics than
    // in metrics. A regex anchored on any snake_case token rather than on the
    // `paperclip_` prefix would flag all three of these, and the guard would be
    // reverted within a day for crying wolf.
    const noisy = [
      "# HELP paperclip_process_mapping_count Counted under"
        + " mapping_class=anon_aligned_64m_full; AGENT_START_LOCK_REAP_WAIT_BOUND_MS=0"
        + " disables the bound; see legacy_paperclip_process_mapping_count_old.",
      "# TYPE paperclip_process_mapping_count gauge",
      "",
    ].join("\n");

    expect(danglingHelpReferences(noisy)).toEqual([]);
  });

  it("accepts the sample series a histogram emits but does not name", () => {
    const histogram = [
      "# HELP paperclip_pointer_metric Read paperclip_phase_seconds_bucket and"
        + " paperclip_phase_seconds_count; paperclip_phase_seconds_total is not a series.",
      "# TYPE paperclip_pointer_metric gauge",
      "# HELP paperclip_phase_seconds Phase duration.",
      "# TYPE paperclip_phase_seconds histogram",
      "",
    ].join("\n");

    // `_bucket`/`_count` resolve against the histogram; `_total` does not,
    // because prom-client would have registered that name outright had it been
    // a counter.
    expect(danglingHelpReferences(histogram)).toEqual([
      { owner: "paperclip_pointer_metric", token: "paperclip_phase_seconds_total" },
    ]);
  });
});
