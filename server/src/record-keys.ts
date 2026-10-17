/**
 * Key-assignment helpers for the masking boundary (PEN-4240).
 *
 * ## The defect
 *
 * `out[key] = …` on an ordinary `{}` accumulator does NOT add a key when `key === "__proto__"`:
 * it hits `Object.prototype`'s inherited `__proto__` SETTER and re-parents the accumulator, so
 * the key is absent from the output and from `JSON.stringify`. `JSON.parse` defines `__proto__`
 * as a real OWN data property, so any jsonb column or request body can carry one — this is
 * reachable input, not a curiosity.
 *
 * Dropping a key discloses strictly less than masking it, so nothing ever leaked. What it breaks
 * is the PEN-2370 ask-1 invariant this boundary exists to provide: key NAMES survive so a reader
 * can tell "withheld" from "never set", values elide. `middleware/redact-sensitive.ts` states
 * that invariant in its own header ("preserving structure and key names so a 4xx log still
 * records *which* variables were set") and then dropped the one key an attacker chooses.
 *
 * `__proto__` is the only accessor on `Object.prototype`, so a `key === "__proto__"` test is
 * complete — no allowlist is needed. Object SPREAD (`{ ...incoming }`) is already safe and is
 * deliberately left alone: spread uses CreateDataProperty, which defines an own `__proto__`
 * rather than invoking the setter.
 *
 * ## ⚠️ Why this defines the key instead of seeding a null prototype
 *
 * The obvious remedy — seeding the accumulator with `Object.create(null)` — also works, and has
 * a blast radius the defect never had. **It changes the output's TYPE**, and these accumulators
 * do not stay inside their module:
 *
 *   `log-redaction.ts` `redactCurrentUserValue(...)` is the last transform applied to
 *   `activity_log.details` in `services/activity-log.ts` `logActivity`, which hands it straight
 *   to drizzle `.values()`. `mapUpdateSet` calls drizzle's `is()` on every top-level value, and
 *   `is()` does `Object.getPrototypeOf(value).constructor` unguarded — `null.constructor` throws.
 *
 * Measured, not reasoned about: seeding these ten accumulators with `Object.create(null)` turned
 * **all six server test shards red** with 343 `TypeError: Cannot read properties of null
 * (reading 'constructor')` on shard 1 alone, in tests with nothing to do with masking. The same
 * seed is safe on a read-only projection (`maskWorkspaceRuntimeForRead` has carried one for
 * weeks) and crashes a write path. Precedent transfers only within the boundary it was measured
 * on.
 *
 * `Object.defineProperty` kills the setter at the one key that has one and changes nothing else,
 * so it is also the remedy whose OMISSION is survivable: forgetting `assignRecordKey` on a
 * future walk merely re-drops a key (the original low-severity bug), whereas adding a null
 * prototype to the wrong walk crashes a write.
 *
 * ## Related boundaries that deliberately do NOT route through here
 *
 *  - `services/secrets.ts` (PEN-3257) is a WRITE boundary and takes the opposite remedy:
 *    `ENV_KEY_RE` REFUSES an env key named `__proto__` with a 422, because a silently-dropped
 *    write is a `200` for a write that did nothing. Preserving the key there would convert that
 *    refusal back into a silent accept.
 *  - `redaction.ts` (PEN-3288) keeps a module-local `assignRecordKey` of its own. That call was
 *    made about `redaction.ts` vs `secrets.ts` and does not bind here; the five modules below
 *    share one copy because they share one invariant.
 */

/**
 * Assign `value` at `key`, creating an own property even when `key` is `__proto__`.
 *
 * Use this anywhere a key-accumulating walk may see a caller-supplied key name.
 */
export function assignRecordKey(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  out[key] = value;
}

/**
 * Read `record[key]`, but only if it is an OWN property — otherwise `undefined`.
 *
 * This is the READ half of the same hazard, and it needs its own remedy. Once an incoming
 * `__proto__` key SURVIVES a walk, a bare `record[key]` lookup resolves it up the chain to
 * `Object.prototype`, which is not `undefined` — so a "was anything stored here?" guard reads it
 * as "yes" and restores a withheld sentinel to `Object.prototype`, persisting as `{}`.
 *
 * Fixing the write side is not a substitute for this, and vice versa.
 */
export function ownRecordValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
