import { REDACTED_SENTINEL } from "@paperclipai/shared";
import type { CompanySecret, EnvBinding, SecretVersionSelector, UserSecretDefinition } from "@paperclipai/shared";

export type RowSource = "text" | "secret" | "user_secret";

/** Local, per-row UI state. Only a subset is emitted upward (see {@link valueFromRows}). */
export interface EnvRow {
  /** Stable local id — used as React key and to target popovers/undo. */
  id: string;
  name: string;
  source: RowSource;
  textValue: string;
  secretId: string;
  userSecretKey: string;
  required: boolean;
  version: SecretVersionSelector;
  /** Session-local dismissal of the sensitive-value suggestion (§6.6). */
  sensitiveDismissed?: boolean;
  /**
   * The server withheld this row's value (PEN-3033): `textValue` holds
   * {@link REDACTED_SENTINEL}, not anything the user typed or is entitled to.
   *
   * Set once at {@link rowsFromValue} rather than re-derived by comparing `textValue` at each use
   * site, for two reasons. First, a user whose literal value happens to equal the sentinel would
   * otherwise have their real binding treated as withheld. Second, and the reason it is a field
   * rather than a helper: every consumer that treats `textValue` as *the user's value* has to ask
   * this question, and a flag on the row makes forgetting to ask visible at the type level in a way
   * that an easily-omitted `isMasked(row)` call does not.
   *
   * Cleared the moment the user edits the value — at that point `textValue` is theirs again.
   */
  masked?: boolean;
  /**
   * The key the mask was issued under, recorded alongside {@link masked}.
   *
   * A mask is only meaningful under its own key: the server's `restoreMaskedEnvBindings` merges the
   * stored value back by looking the *incoming* key up in what it already holds. Rename the row and
   * that lookup misses, the sentinel survives as a literal, and `normalizeEnvConfig` rejects the
   * whole PATCH — so every other edit in the same save is lost to an error that names an internal
   * placeholder rather than the row.
   *
   * Keeping the key (rather than a "renamed" boolean) is what lets a rename-and-rename-back stop
   * being an error, and it states the invariant in the shape the server enforces it in.
   */
  maskedKey?: string;
}

let rowCounter = 0;
export function nextRowId(): string {
  rowCounter += 1;
  return `env-row-${rowCounter}`;
}

export function emptyRow(source: RowSource = "text"): EnvRow {
  return {
    id: nextRowId(),
    name: "",
    source,
    textValue: "",
    secretId: "",
    userSecretKey: "",
    required: true,
    version: "latest",
  };
}

function isSecretRef(binding: unknown): binding is { type: "secret_ref"; secretId?: unknown; version?: unknown } {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "type" in binding &&
    (binding as { type?: unknown }).type === "secret_ref"
  );
}

function isPlainObj(binding: unknown): binding is { type: "plain"; value?: unknown } {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "type" in binding &&
    (binding as { type?: unknown }).type === "plain"
  );
}

function isUserSecretRef(
  binding: unknown,
): binding is { type: "user_secret_ref"; key?: unknown; version?: unknown; required?: unknown } {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "type" in binding &&
    (binding as { type?: unknown }).type === "user_secret_ref"
  );
}

/** Build editor rows from the controlled value. No implicit trailing ghost row. */
export function rowsFromValue(value: Record<string, EnvBinding> | null | undefined): EnvRow[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([name, binding]) => {
    if (typeof binding === "string") {
      const masked = binding === REDACTED_SENTINEL;
      return { ...emptyRow(), name, textValue: binding, masked, maskedKey: masked ? name : undefined };
    }
    if (isSecretRef(binding)) {
      const version: SecretVersionSelector = typeof binding.version === "number" ? binding.version : "latest";
      return {
        ...emptyRow(),
        name,
        source: "secret" as const,
        secretId: typeof binding.secretId === "string" ? binding.secretId : "",
        version,
      };
    }
    if (isUserSecretRef(binding)) {
      const version: SecretVersionSelector = typeof binding.version === "number" ? binding.version : "latest";
      return {
        ...emptyRow(),
        name,
        source: "user_secret" as const,
        userSecretKey: typeof binding.key === "string" ? binding.key : "",
        required: binding.required !== false,
        version,
      };
    }
    if (isPlainObj(binding)) {
      const value = typeof binding.value === "string" ? binding.value : "";
      return {
        ...emptyRow(),
        name,
        source: "text" as const,
        textValue: value,
        // Keep the sentinel in `textValue`: `valueFromRows` re-emits every row on save and the
        // server's `restoreMaskedEnvBindings` matches on it to merge the stored value back. The
        // flag is what stops the rest of the editor treating it as the user's own value.
        masked: value === REDACTED_SENTINEL,
        maskedKey: value === REDACTED_SENTINEL ? name : undefined,
      };
    }
    return { ...emptyRow(), name };
  });
}

/**
 * Emit semantics (plan §4/§6.1): rows with empty (trimmed) names are dropped;
 * secret rows without a chosen secret are incomplete and dropped; an empty
 * result emits `undefined`. Duplicate names are last-writer-wins (unchanged).
 */
export function valueFromRows(rows: EnvRow[]): Record<string, EnvBinding> | undefined {
  const record: Record<string, EnvBinding> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.source === "secret") {
      if (!row.secretId) continue; // incomplete ref — not emitted
      record[name] = { type: "secret_ref", secretId: row.secretId, version: row.version };
    } else if (row.source === "user_secret") {
      const key = row.userSecretKey.trim();
      if (!key) continue;
      record[name] = {
        type: "user_secret_ref",
        key,
        version: row.version,
        required: row.required,
      };
    } else {
      record[name] = { type: "plain", value: row.textValue };
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type NameIssueLevel = "error" | "warn";
export interface NameIssue {
  level: NameIssueLevel;
  message: string;
}

/**
 * Validate a single row's name given the full set of names (for duplicate
 * detection). Returns null when the name is empty (not yet an error) or valid.
 */
export function validateName(
  name: string,
  duplicateNames: ReadonlySet<string>,
  reservedPrefixes: readonly string[],
): NameIssue | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!ENV_NAME_RE.test(trimmed)) {
    return { level: "error", message: "Invalid name — use letters, digits and _" };
  }
  if (duplicateNames.has(trimmed)) {
    return { level: "error", message: "Duplicate name" };
  }
  for (const prefix of reservedPrefixes) {
    if (prefix && trimmed.startsWith(prefix)) {
      return { level: "warn", message: "Reserved prefix — provided automatically and may be overridden" };
    }
  }
  return null;
}

/**
 * The one name-axis question that needs the whole row: has a withheld value been renamed away from
 * the key its mask was issued under?
 *
 * Caught here because this is where the information is. The server refuses the PATCH — correctly, a
 * client that cannot see a value cannot rebind it to a new key — but it refuses with
 * `Refusing to persist redacted placeholder for key: <newName>`, which names an internal concept,
 * arrives only after every *other* edit in the same save has been rejected along with it, and does
 * not say which row to fix. The client knows all three.
 *
 * Deliberately NOT fixed by clearing `masked`/`textValue` on rename. Clearing `masked` alone emits
 * the sentinel as a literal value under the new key — the value-destroying shape the rest of this
 * boundary exists to prevent. Clearing both empties the row, so a user who renames and saves
 * without re-reading silently replaces a live credential with `""`. Refusing and saying so is the
 * only branch that neither destroys the binding nor hides the choice from the person making it.
 */
export function maskedRenameIssue(row: EnvRow): NameIssue | null {
  if (!row.masked || !row.maskedKey) return null;
  // Gate on the branch that actually emits the sentinel, not on the flag alone. `valueFromRows`
  // only writes `{ type: "plain", value: textValue }` for a text row; a secret/user-secret row
  // emits a reference and never carries the placeholder, so the server has nothing to refuse.
  // This matters because the source switch does NOT clear `masked` (`Row.tsx` `to-secret` patches
  // source and leaves the flag), so keying off the flag alone would block a rename-and-rebind that
  // saves perfectly well. Asking what the row will emit also keeps this correct if a fourth source
  // is added later, which asking "is the flag set" would not.
  if (row.source !== "text") return null;
  if (row.name.trim() === row.maskedKey) return null;
  return {
    level: "error",
    message: `Re-enter the value to rename this variable — its stored value is hidden, so it cannot move to a new name. Renaming back to ${row.maskedKey} also clears this.`,
  };
}

/**
 * The rows a save must not be allowed to carry: withheld values renamed off their own key.
 *
 * Separate from {@link maskedRenameIssue} because the two answer different questions. That one is
 * per-row and drives what the name field renders; this one is the save-path predicate, and the
 * save path has to refuse rather than annotate. Rendering the message without refusing leaves
 * `valueFromRows` free to emit the sentinel as a literal under the new key — the editor would show
 * the user exactly what is wrong and then submit it anyway, and the 422 that comes back takes
 * every other edit in the same save with it.
 */
export function maskedRenameBlockers(rows: EnvRow[]): EnvRow[] {
  return rows.filter((row) => maskedRenameIssue(row) !== null);
}

/** Names that appear on more than one row (trimmed, non-empty). */
export function computeDuplicateNames(rows: EnvRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const dupes = new Set<string>();
  for (const [name, count] of counts) {
    if (count > 1) dupes.add(name);
  }
  return dupes;
}

/**
 * Pure decision for a source switch (§6.3), extracted so the value-preserving
 * behaviour is unit-testable without driving the Radix menu.
 */
export type SourceSwitchPlan =
  | { kind: "noop" }
  /** Text → Secret with a non-empty value: never discard it — open Store-as-secret. */
  | { kind: "open-store"; name: string; value: string }
  /** Text → Secret with an empty or withheld value: switch and open the picker. */
  | { kind: "to-secret" }
  /** Secret → Text: clear the ref; offer undo when a secret was bound. */
  | { kind: "to-text"; undoFrom: EnvRow | null };

export function planSourceSwitch(row: EnvRow, next: RowSource): SourceSwitchPlan {
  if (next === row.source) return { kind: "noop" };
  if (next === "secret") {
    // A withheld row is the EMPTY case, not the non-empty one. `textValue` holds the sentinel, and
    // `open-store` would pre-fill it into a read-only field and create a company secret holding the
    // placeholder — silently destroying the very binding the mask exists to protect (the mask is
    // read-only from the client's side, so there is nothing here it is entitled to store). Route to
    // the picker instead: binding an existing secret is the one convert that is still meaningful.
    if (!row.masked && row.textValue.trim()) {
      return { kind: "open-store", name: secretNameFromKey(row.name) || "secret", value: row.textValue };
    }
    return { kind: "to-secret" };
  }
  return { kind: "to-text", undoFrom: row.secretId ? { ...row } : null };
}

/**
 * Whether a row's `textValue` is the user's to store as a secret.
 *
 * The editor reaches `onCreateSecret` from three places — the source switch, the sensitive-value
 * suggestion, and the ⋯ menu — and each one independently decided to trust `textValue`. This is the
 * single question all three must ask, so that a fourth entry point added later is a call to a named
 * predicate rather than another open-coded `row.textValue` read.
 */
export function canStoreValueAsSecret(row: EnvRow): boolean {
  return row.source === "text" && !row.masked && row.textValue.trim().length > 0;
}

export interface SecretHealth {
  level: "error" | "warn";
  message: string;
  /** Short label for the summary line at the top of the editor. */
  kind: "missing" | "disabled";
}

/** Per-row secret-binding health (plan §6.8). Null when healthy or not a bound ref. */
export function computeRowHealth(row: EnvRow, secrets: readonly CompanySecret[]): SecretHealth | null {
  if (row.source !== "secret" || !row.secretId) return null;
  const secret = secrets.find((candidate) => candidate.id === row.secretId);
  if (!secret) {
    return {
      level: "error",
      kind: "missing",
      message: "This secret no longer exists — runs will fail until you rebind.",
    };
  }
  if (secret.status !== "active") {
    return {
      level: "warn",
      kind: "disabled",
      message: "Runs will fail until re-enabled or rebound.",
    };
  }
  return null;
}

/** Per-row user-secret health. Null when healthy or not a bound user-secret ref. */
export function computeUserSecretRowHealth(
  row: EnvRow,
  definitions: readonly UserSecretDefinition[] | undefined,
): SecretHealth | null {
  if (row.source !== "user_secret" || !row.userSecretKey || !definitions?.length) return null;
  const definition = definitions.find((candidate) => candidate.key === row.userSecretKey);
  if (!definition) {
    return {
      level: "error",
      kind: "missing",
      message: "This user secret definition no longer exists — runs will fail until you rebind.",
    };
  }
  if (definition.status !== "active") {
    return {
      level: "warn",
      kind: "disabled",
      message: "Runs will fail until this user secret definition is re-enabled or rebound.",
    };
  }
  return null;
}

/** Suggest a `lower_snake` secret name from an env KEY (plan §6.5). */
export function secretNameFromKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/** Suggest an env KEY (UPPER_SNAKE) from a secret name (for quick-bind). */
export function envKeyFromSecretName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
