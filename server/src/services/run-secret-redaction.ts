import { redactSecretValuesFromText } from "./plugin-config-masking.js";

/**
 * Run-scoped secret VALUE redaction for agent transcripts (BLO-39715).
 *
 * The pre-existing control is input-side: a PreToolUse guard that blocks commands it
 * recognises as full-environment dumps. It cannot close this class, because it has to
 * enumerate every way a byte can reach stdout and that set is unbounded — the three most
 * recent disclosures each evaded it by a different route (a name-keyed `sed` mask that
 * silently matched nothing, a `cat` of a projected Secret volume after the guard correctly
 * blocked the `env | grep`, and a password passed as a `kubectl exec` argument).
 *
 * The asymmetry that makes output-side redaction tractable: the set of *commands* is
 * unbounded, but the set of *secret values a given run can see* is finite, enumerable, and
 * already resolved by the runtime before the run starts.
 *
 * This is defence the guard cannot provide, NOT a replacement for it. Keep the guard.
 */

/** Replaces a matched secret value in persisted/streamed run output. */
export const RUN_SECRET_MASK = "[redacted:run-secret]";

/** At or above this length a value is redacted whatever its shape. */
export const ALWAYS_REDACT_MIN_LENGTH = 16;

/** Below this length a value is never redacted — it is reported instead. */
export const AMBIGUOUS_BAND_MIN_LENGTH = 8;

/**
 * Which values are safe to replace literally.
 *
 * `redactSecretValuesFromText` deliberately has no minimum length, documenting that
 * "over-redacting a diagnostic is harmless". That is true of a short, author-written plugin
 * warning. It is false of a run transcript, which is the fleet's primary debugging artifact
 * and is matched by replacing EVERY occurrence: a resolved secret set routinely contains
 * ordinary tokens (`POSTGRES_USER=postgres`, a `*_ENABLED=true`, a port, a region), and
 * masking every `true` in a 500 KB transcript does not make it safer — it makes it unusable,
 * which pushes debugging onto some out-of-band channel with no redaction at all.
 *
 * A single length floor does not work in either direction: 12 misses `Tr0ub4dor&3` (11, a
 * realistic password) and 8 collides with `postgres` (exactly 8). Length is only a proxy for
 * the real question — whether this particular value also occurs as ordinary transcript
 * vocabulary — so the ambiguous band is decided on character-class span instead.
 *
 * Note entropy is NOT the discriminator here: `postgres` is 7 distinct characters in 8 and
 * scores ~2.75 bits/char, as high as many real credentials. What distinguishes it is that it
 * is a plain lowercase word, i.e. spans one class.
 *
 * `_` and `-` do not count as a class, so `traffic_ops` and `blockcast-prod` span one class
 * and are spared alongside `postgres` — they are the same transcript vocabulary, and masking
 * every occurrence of a hostname or a DB user is the same unusable artifact. Be exact about
 * what that leaves: a lowercase-plus-digit identifier (`orc8r-staging`) still spans two and
 * is still redacted, because that is also the shape of a real lowercase-alphanumeric
 * password, and declining it would reopen the hole this band exists to close.
 *
 * Anything this returns false for MUST be reported by key name — see
 * {@link buildRunSecretRedactionPlan}. A residual gap that announces itself is a different
 * object from one that does not.
 */
export function isRedactableSecretValue(value: string): boolean {
  if (value.length >= ALWAYS_REDACT_MIN_LENGTH) return true;
  if (value.length < AMBIGUOUS_BAND_MIN_LENGTH) return false;
  return characterClassCount(value) >= 2;
}

function characterClassCount(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  // `_` and `-` are deliberately NOT symbols here. They are the separators of ordinary
  // transcript vocabulary — `traffic_ops`, `blockcast-prod` — and counting them promoted a
  // plain lowercase identifier to two classes, which is the exact `postgres` failure the doc
  // above argues against, just one punctuation mark along. `Tr0ub4dor&3` still scores 4.
  if (/[^\w-]/.test(value)) classes += 1;
  return classes;
}

/**
 * The JSON-escaped body of a string, without its surrounding quotes.
 *
 * Load-bearing: the agent's stdout is itself stream-JSON, so a secret containing `"` or `\`
 * reaches us already escaped and a literal match on the plaintext value misses it — silently,
 * which is the same failure shape as the `sed` mask that was keyed on the wrong variable name.
 */
function jsonEscapedBody(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, encoded.length - 1);
}

/**
 * The percent-encoded form, for the same reason as {@link jsonEscapedBody}.
 *
 * Be precise about what this buys, because the obvious motivating example is already covered:
 * a credential inside a URI-form DSN (`postgres://user:p%40ss@host/db`) is caught TODAY by the
 * pre-existing credentialed-URI scrub, which keys on the `scheme://user:…@host` shape and
 * needs no dictionary — measured, not assumed. The residue this closes is the encoded value
 * with no URI carrier beside it: a query-string fragment, a form body, a decoded-then-logged
 * payload. There the name-anchored scrub has nothing to anchor on and the plaintext needle
 * misses the encoded bytes silently.
 *
 * Returns null rather than throwing: `encodeURIComponent` raises `URIError` on a lone
 * surrogate, and a malformed secret must not be able to abort run setup.
 */
function percentEncoded(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}

export interface RunSecretRedactionPlan {
  /** Literal needles to replace, longest-first. Never logged. */
  needles: string[];
  /**
   * Keys whose value this plan does NOT cover, so the gap is visible and fixable by rotating
   * to a longer value. Contains key NAMES only — never a value.
   */
  uncoveredKeys: string[];
  /**
   * Keys named as secret-backed whose value could not be located in the resolved config at
   * all. Distinct from {@link uncoveredKeys}, and deliberately so: "too short to replace
   * literally" is fixed by rotating to a longer value, whereas "present in `secretKeys` but
   * nowhere in the config" means this module is reading the wrong namespace and the remedy is
   * a code change here. Conflating them would file a correct gap under a wrong remedy.
   * Key NAMES only — never a value.
   */
  unresolvedKeys: string[];
}

/**
 * Build the per-run redaction dictionary from the run's own resolved secret set.
 *
 * Takes the WHOLE resolved adapter config, not just its env map, because `secretKeys` is a
 * mixed namespace: `resolveAdapterConfigForRuntime` adds env-binding keys, whose value lands
 * in `resolved.env[key]`, AND adapter top-level schema secret fields (every config field with
 * `meta.secret === true`, plus `FALLBACK_ADAPTER_SCHEMA_SECRET_FIELDS`), whose value lands in
 * `resolved[key]`. Reading only the env map dropped the second class silently — neither
 * redacted nor reported — which is precisely what this module's own contract forbids.
 *
 * `resolvedConfig` comes from `resolveExecutionRunAdapterConfig`, the one point where every
 * value for a run is simultaneously in memory.
 */
export function buildRunSecretRedactionPlan(
  resolvedConfig: Readonly<Record<string, unknown>>,
  secretKeys: Iterable<string>,
): RunSecretRedactionPlan {
  const needles = new Set<string>();
  const uncoveredKeys = new Set<string>();
  const unresolvedKeys = new Set<string>();
  const env = (resolvedConfig.env ?? {}) as Record<string, unknown>;

  for (const key of secretKeys) {
    // Read BOTH namespaces rather than preferring one. A key can exist as an env binding AND
    // as an adapter top-level schema field carrying a different value; a precedence rule would
    // leave the loser neither redacted nor reported, which is the same hole one level down.
    const values = [env[key], resolvedConfig[key]].filter(
      (candidate): candidate is string => typeof candidate === "string",
    );
    if (values.length === 0) {
      unresolvedKeys.add(key);
      continue;
    }

    for (const value of values) {
      // An empty value is located and carries nothing to disclose, so it is neither a gap nor
      // an unresolved key.
      if (value.length === 0) continue;

      // Decide on the ORIGINAL value — an encoded variant is longer and differently shaped, so
      // thresholding the variant would quietly promote a value the rule just declined.
      if (!isRedactableSecretValue(value)) {
        uncoveredKeys.add(key);
        continue;
      }

      needles.add(value);
      for (const variant of [jsonEscapedBody(value), percentEncoded(value)]) {
        if (variant && variant !== value) needles.add(variant);
      }
    }
  }

  return {
    needles: [...needles].sort((a, b) => b.length - a.length),
    uncoveredKeys: [...uncoveredKeys].sort(),
    unresolvedKeys: [...unresolvedKeys].sort(),
  };
}

/**
 * Replace every occurrence of a known run secret value with {@link RUN_SECRET_MASK}.
 *
 * Delegates to the existing value-based primitive rather than re-deriving one: two
 * independent redactors would be two oracles that can silently drift, and the weaker one
 * would decide what a reader believes is covered.
 */
export function redactRunSecretValues(text: string, needles: readonly string[]): string {
  if (needles.length === 0) return text;
  return redactSecretValuesFromText(text, needles, RUN_SECRET_MASK);
}

/**
 * BLO-39715: reassemble secret values that straddle two run-log chunks.
 *
 * {@link redactRunSecretValues} is a literal match, so it can only redact a needle wholly
 * contained in the chunk it is handed. Run-log chunks are not token-aligned on ANY path:
 * the sandbox tailer hands over byte-offset slices of a file being appended to live
 * (`sandbox-run-log-stream.ts`, 250 ms poll), and the local/k8s adapters forward whatever
 * Node's `stdout`/`stderr` `"data"` event produced (`server-utils.ts`), which is an
 * arbitrary buffer boundary. So a cut mid-value is the normal case, not an edge case, and
 * when it happens neither chunk contains the needle, neither is redacted, and the
 * reassembled transcript contains the plaintext.
 *
 * That miss is invisible: the key resolved fine and cleared the threshold, so it is absent
 * from both `uncoveredKeys` and `unresolvedKeys`. Nothing reports it. This is the same
 * failure `sanitizeRunLogChunkForStorage` already closes one layer down by redacting before
 * truncation — a split across the elided middle — and the identical reasoning applies to a
 * split across the chunk boundary upstream of it.
 *
 * The carry is the standard streaming-match fix: hold back the trailing
 * `longest needle - 1` characters and prepend them to the next chunk, so every byte is
 * matched in a window that could contain a complete needle.
 *
 * Two deliberate costs, stated rather than silently tuned away:
 *
 * 1. Persistence and the live log view lag by up to `holdbackChars`. That bound is the
 *    longest needle, so a large secret (a PEM key) holds back correspondingly more. It is
 *    NOT capped: a cap below the longest needle would reintroduce exactly the silent split
 *    this closes, for precisely the largest secrets. The lag is bounded in time by the
 *    flush at adapter settle, not just in size. `take` also backs each split up to the end
 *    of the last complete line, so it returns whole lines only: the excerpt filter and
 *    run-liveness both anchor per line, and a mid-line cut made every keepalive
 *    unclassifiable for as long as any needle existed. That extends the lag to the end of
 *    the current line, so a long unterminated line is held until its newline or the flush.
 *    Liveness must still not inherit the lag: the return value is empty while the window
 *    fills and releases held lines with a later arrival, so it is not arrival-aligned. A
 *    caller MUST derive activity stamps and progress classification from the chunk it was
 *    handed, never from what `take` returns; the heartbeat `onLog` does, because those
 *    stamps feed the external-lifecycle silence reaper. Only its excerpt filter classifies
 *    the returned bytes, because the excerpt is a copy of them.
 * 2. The flush is required. Without it the final `holdbackChars` of a run's output would be
 *    dropped, so the caller MUST call `take(stream, "", { flush: true })` once output has
 *    settled — trading a leak for silent log truncation would be a bad bargain, and callers
 *    get `holdbackChars` so a test can assert the flush actually happens.
 *
 * `holdbackChars === 0` (no needles, or a single one-character needle) makes `take` an
 * identity function, so a run with nothing to redact is byte-for-byte unchanged and pays
 * no latency.
 */
export interface RunSecretBoundaryCarry {
  /** Trailing characters withheld per stream. `0` disables the carry entirely. */
  readonly holdbackChars: number;
  /**
   * Returns text with run-secret values already redacted, ready to persist; may be empty
   * while the window is still filling. The carry redacts rather than returning a raw slice
   * for the ordering reason documented at the call site below — a caller that masked the
   * returned slice itself would leak any occurrence straddling the split.
   */
  take(stream: string, chunk: string, opts?: { flush?: boolean }): string;
}

export function createRunSecretBoundaryCarry(needles: readonly string[]): RunSecretBoundaryCarry {
  // Computed, not read off `needles[0]`. `buildRunSecretRedactionPlan` does sort
  // longest-first, but this helper is exported and a caller passing an unsorted array
  // would silently get a too-short window — a correctness bug that reads as working.
  const longestNeedle = needles.reduce((max, needle) => Math.max(max, needle.length), 0);
  const holdbackChars = Math.max(0, longestNeedle - 1);
  const carried = new Map<string, string>();

  return {
    holdbackChars,
    take(stream, chunk, opts) {
      const pending = (carried.get(stream) ?? "") + chunk;
      if (holdbackChars === 0 || opts?.flush) {
        carried.delete(stream);
        return redactRunSecretValues(pending, needles);
      }
      // Redact the WHOLE window before splitting it, not the emitted slice afterwards.
      // This ordering is the correctness argument, and getting it backwards is a silent
      // leak that still passes a two-chunk test. With K = holdbackChars every needle has
      // length L <= K + 1, and the split below is at most `len - K`. An occurrence starting
      // at p <= len - K - 1 therefore ends at p + L <= len, so it is complete inside
      // `pending` and merely straddles the split. Masking the emitted slice alone would
      // persist that occurrence's prefix in plaintext. Masking `pending` first means the
      // split can only ever fall inside a mask.
      const masked = redactRunSecretValues(pending, needles);
      const latestSplit = masked.length - Math.min(holdbackChars, masked.length);
      // Withhold at least K, then back up to the end of the last complete line so the
      // caller only ever sees whole lines (see the interface doc). Moving the split earlier
      // keeps the bound above. With no newline before `latestSplit` everything is held;
      // the `latestSplit === 0` guard matters because lastIndexOf clamps a negative
      // fromIndex to 0 and would otherwise emit a leading "\n".
      const split = latestSplit === 0 ? 0 : masked.lastIndexOf("\n", latestSplit - 1) + 1;
      // The retained tail may hold the prefix of a needle whose remainder has not arrived.
      // It is left as-is and re-matched next round; a prefix cannot match, so nothing is
      // lost by deferring it, and re-masking already-masked text is idempotent.
      carried.set(stream, masked.slice(split));
      return masked.slice(0, split);
    },
  };
}
