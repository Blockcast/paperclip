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
  if (/[^a-zA-Z0-9]/.test(value)) classes += 1;
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
