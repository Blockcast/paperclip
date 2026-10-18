import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { AlertCircle, KeyRound, Plus, RotateCcw, Save, UserRound } from "lucide-react";
import type { CompanySecret, EnvBinding, UserSecretDefinition } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useOptionalToastActions } from "@/context/ToastContext";
import { EnvironmentVariableRow } from "./Row";
import { parseDotenv } from "./parse-dotenv";
import {
  computeDuplicateNames,
  computeRowHealth,
  computeUserSecretRowHealth,
  emptyRow,
  envKeyFromSecretName,
  maskedRenameBlockerMessage,
  maskedRenameBlockers,
  maskedRenameIssue,
  rowsFromValue,
  validateName,
  valueFromRows,
  type EnvRow,
} from "./model";
import type { EnvironmentVariableDirtyFields } from "./Row";

const DEFAULT_RESERVED_PREFIXES = ["PAPERCLIP_"];

const DEFAULT_HINT =
  "Set the KEY to the env var name the process expects, for example GH_TOKEN. Choose a secret to resolve a stored value at run start. PAPERCLIP_* variables are injected automatically.";

// Canonical entries for dirty comparison. Must mirror the emit semantics of
// valueFromRows (trimmed names, incomplete refs dropped, last-writer-wins on
// trimmed duplicates) — otherwise a saved value that round-trips lossily shows
// a phantom "Unsaved changes" banner the moment the form opens.
function normalizedEnvEntries(
  value: Record<string, EnvBinding> | null | undefined,
): Array<[string, Record<string, unknown>]> {
  if (!value || typeof value !== "object") return [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const [rawName, binding] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name) continue;
    if (typeof binding === "string") {
      byName.set(name, { type: "plain", value: binding });
    } else if (binding?.type === "secret_ref") {
      const secretId = typeof binding.secretId === "string" ? binding.secretId : "";
      if (!secretId) continue; // incomplete ref — never emitted by the editor
      byName.set(name, {
        type: "secret_ref",
        secretId,
        version: typeof binding.version === "number" ? binding.version : "latest",
      });
    } else if (binding?.type === "user_secret_ref") {
      const key = typeof binding.key === "string" ? binding.key.trim() : "";
      if (!key) continue; // incomplete ref — never emitted by the editor
      byName.set(name, {
        type: "user_secret_ref",
        key,
        version: typeof binding.version === "number" ? binding.version : "latest",
        required: binding.required !== false,
      });
    } else if (binding?.type === "plain") {
      byName.set(name, { type: "plain", value: typeof binding.value === "string" ? binding.value : "" });
    } else {
      byName.set(name, { type: "plain", value: "" });
    }
  }
  return [...byName.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function normalizedEnvKey(value: Record<string, EnvBinding> | null | undefined): string {
  return JSON.stringify(normalizedEnvEntries(value));
}

const CHANGE_SUMMARY_MAX_NAMES = 3;

function formatChangedNames(names: readonly string[]): string {
  const shown = names.slice(0, CHANGE_SUMMARY_MAX_NAMES).join(", ");
  return names.length > CHANGE_SUMMARY_MAX_NAMES
    ? `${shown} +${names.length - CHANGE_SUMMARY_MAX_NAMES} more`
    : shown;
}

/**
 * Elements that bound "one thing the user is about to submit".
 *
 * A `<form>` is the real boundary. A dialog is the boundary for a consumer that renders the editor
 * in one without a form. `data-env-editor-scope` is for a consumer that is neither — a settings
 * panel assembled from plain `div`s, which is what every in-repo consumer actually is — and lets it
 * say where its own footer ends.
 */
const SUBMISSION_SCOPE_SELECTOR = 'form, dialog, [role="dialog"], [role="alertdialog"], [data-env-editor-scope]';

function submissionScopeOf(element: Element): Element | null {
  return element.closest(SUBMISSION_SCOPE_SELECTOR);
}

/**
 * Does an outside button belong to the same thing-being-submitted as the editor?
 *
 * This gates a *veto*, not a flush: on a refusal the outside-click listener cancels the click
 * (PEN-3358), and an unscoped cancel is a veto over the whole document — with a blocker open, a
 * sibling card's "Update" or a portaled dialog's "Create" would be swallowed by an editor they have
 * nothing to do with (PEN-4232).
 *
 * Scoping on the *resolved scope* covers both ways that listener claims a click — the
 * `type === "submit"` arm and the label arm — where an opt-in marker on the button would have fixed
 * only the second and left every stray submit button in the document vetoed.
 *
 * When the editor resolves no scope at all, keep the pre-existing reach (any button that also
 * resolves none). Degrading to "veto nothing" there would hand back the silent partial save
 * PEN-3358 closed. Most in-repo consumers are plain `div` panels that resolve no scope and rely on
 * that fallback; they narrow it to their own panel by marking it `data-env-editor-scope`.
 *
 * CORRECTION (PEN-4236) — an earlier revision of this comment said "no in-repo consumer wraps the
 * editor in a form or a dialog today". That was wrong. `PipelineSettings` renders its whole stage
 * editor inside a real `<form>` (`PipelineSettings.tsx`, the stage form around the
 * `<StageSecretsPanel>` render), and that panel renders this editor — so for that consumer both the
 * editor and the stage Save button resolve to that `<form>`, and the scope comparison below is doing
 * real work rather than idling on the no-scope fallback.
 *
 * ASSUMPTION — each side is compared on its *nearest* scope, by identity. That is exact only while no
 * consumer nests a scope inside another scope. A panel marked `data-env-editor-scope` that contains a
 * `<form>` or `role="dialog"` around the editor, with the panel's Save *outside* that inner element,
 * resolves two different scopes — editor to the inner element, Save to the panel — and the Save loses
 * the veto. No consumer is shaped like that today: the one form-wrapped consumer, `PipelineSettings`,
 * carries no `data-env-editor-scope` marker at all, so there is nothing to nest. The failure direction
 * is fail-*open*, back to the pre-PEN-3358 plain flush, so it degrades to the old behaviour rather
 * than losing data; that is why this stays an identity check. If such a consumer appears, match on
 * "the button's scope contains the editor root" instead of identity.
 */
function sharesSubmissionScope(button: Element, editorRoot: Element): boolean {
  return submissionScopeOf(button) === submissionScopeOf(editorRoot);
}

function cloneRows(rows: readonly EnvRow[]): EnvRow[] {
  return rows.map((row) => ({ ...row }));
}

function rowDirtyFields(row: EnvRow, committedRow: EnvRow | undefined): EnvironmentVariableDirtyFields {
  if (!committedRow) {
    return {
      name: Boolean(row.name.trim()),
      value:
        row.source !== "text" ||
        Boolean(row.textValue) ||
        Boolean(row.secretId) ||
        row.version !== "latest",
    };
  }

  return {
    name: row.name.trim() !== committedRow.name.trim(),
    value:
      row.source !== committedRow.source ||
      row.textValue !== committedRow.textValue ||
      row.secretId !== committedRow.secretId ||
      row.userSecretKey !== committedRow.userSecretKey ||
      row.required !== committedRow.required ||
      row.version !== committedRow.version,
  };
}

export interface EnvironmentVariablesEditorProps {
  value: Record<string, EnvBinding>;
  onChange: (next: Record<string, EnvBinding> | undefined) => void;
  secrets: readonly CompanySecret[];
  /**
   * Optional company user-secret definitions. When present, the "User secret"
   * source becomes a picker; otherwise operators can type the definition key.
   */
  userSecretDefinitions?: readonly UserSecretDefinition[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  /** Optional "Recently used" picker group + quick-bind chips. */
  recentlyUsedSecrets?: readonly CompanySecret[];
  /** Read-only rendering. */
  disabled?: boolean;
  /** Prefixes flagged as reserved/auto-provided. Default `["PAPERCLIP_"]`. */
  reservedPrefixes?: readonly string[];
  /** Context-specific hint line. `null` hides the default copy; omit for default. */
  footerHint?: ReactNode | null;
  /** Reports editor-local draft changes that are not yet promoted to the parent value. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * What an outer action learns when it asks the editor to promote its draft.
 *
 * Three outcomes, because the caller must treat them differently and a single nullable value
 * cannot tell them apart. `null` used to mean both "there was nothing to promote" and "there were
 * changes and I refused them", and every consumer read the pair as the first: on a refusal the
 * outer Save proceeded **without** the env edit, silently saving around a block the editor was
 * displaying at that moment. The discriminant exists so that mistake is not expressible.
 */
export type FlushPendingDraftResult =
  /** A draft existed and is now promoted; `env` is the value the parent has just been given. */
  | { status: "flushed"; env: Record<string, EnvBinding> }
  /** Nothing to promote — the editor is disabled, or the draft matches the committed value. */
  | { status: "idle" }
  /**
   * A draft existed and the editor refused it. The outer action **must not proceed**: the refusal
   * is the same one the editor's own Save button is disabled by, and `message` is the same sentence
   * its banner renders. The editor has already moved focus to the offending row.
   */
  | { status: "blocked"; message: string };

export interface EnvironmentVariablesEditorHandle {
  /**
   * Promote the editor-local draft into the controlled value before an outer action reads parent
   * state. See {@link FlushPendingDraftResult} — a `blocked` result must abort the outer action,
   * not fall through to the last committed value.
   */
  flushPendingDraft: () => FlushPendingDraftResult;
}

export const EnvironmentVariablesEditor = forwardRef<EnvironmentVariablesEditorHandle, EnvironmentVariablesEditorProps>(function EnvironmentVariablesEditor({
  value,
  onChange,
  secrets,
  userSecretDefinitions,
  onCreateSecret,
  recentlyUsedSecrets,
  disabled,
  reservedPrefixes = DEFAULT_RESERVED_PREFIXES,
  footerHint,
  onDirtyChange,
}: EnvironmentVariablesEditorProps, ref) {
  const toast = useOptionalToastActions();
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<EnvRow[]>(() => rowsFromValue(value));
  const rowsRef = useRef(rows);
  const [committedRows, setCommittedRows] = useState<EnvRow[]>(() => cloneRows(rows));
  const initialValueKey = useMemo(() => normalizedEnvKey(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const committedValueKeyRef = useRef(initialValueKey);
  const lastPropValueKeyRef = useRef(initialValueKey);
  const pendingSaveValueKeyRef = useRef<string | null>(null);
  const [committedValueKey, setCommittedValueKey] = useState(initialValueKey);
  // Seeded (already-committed) names are "touched" so a saved reserved/invalid
  // var surfaces its message on load; freshly-typed rows wait for blur (§6.2).
  const [touchedNames, setTouchedNames] = useState<ReadonlySet<string>>(
    () => new Set(rowsFromValue(value).map((row) => row.name.trim()).filter(Boolean)),
  );
  const [pendingFocus, setPendingFocus] = useState<{ rowId: string; field: "name" | "value" } | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  function markCommitted(nextValueKey: string, nextRows: readonly EnvRow[] = rowsRef.current) {
    committedValueKeyRef.current = nextValueKey;
    setCommittedValueKey(nextValueKey);
    setCommittedRows(cloneRows(nextRows));
  }

  function touchCommittedNames(nextRows: EnvRow[]) {
    setTouchedNames((prev) => {
      const next = new Set(prev);
      for (const row of nextRows) {
        const name = row.name.trim();
        if (name) next.add(name);
      }
      return next;
    });
  }

  function adoptExternalValue(nextValue: Record<string, EnvBinding>): EnvRow[] {
    const nextRows = rowsFromValue(nextValue);
    setRows(nextRows);
    touchCommittedNames(nextRows);
    return nextRows;
  }

  // Controlled sync: clean external changes replace the editor rows, but dirty
  // local drafts are never clobbered by refetches. A save echo only advances the
  // committed baseline so the focused row keeps its local id.
  useEffect(() => {
    const incomingValueKey = normalizedEnvKey(value);
    if (incomingValueKey === lastPropValueKeyRef.current) {
      return;
    }
    lastPropValueKeyRef.current = incomingValueKey;

    const draftValueKey = normalizedEnvKey(valueFromRows(rowsRef.current));
    const draftIsDirty = draftValueKey !== committedValueKeyRef.current;
    const matchesPendingSave = pendingSaveValueKeyRef.current === incomingValueKey;
    if (matchesPendingSave) {
      pendingSaveValueKeyRef.current = null;
    }

    if (!draftIsDirty) {
      const nextRows = adoptExternalValue(value);
      markCommitted(incomingValueKey, nextRows);
      return;
    }

    if (matchesPendingSave || draftValueKey === incomingValueKey) {
      touchCommittedNames(rowsRef.current);
      markCommitted(incomingValueKey);
    }
  }, [value]);

  const draftValue = useMemo(() => valueFromRows(rows), [rows]);
  const draftValueKey = useMemo(() => normalizedEnvKey(draftValue), [draftValue]);
  const hasUnsavedChanges = draftValueKey !== committedValueKey;
  // Declared up here, above `flushPendingDraft`, because that callback's dependency array is
  // evaluated during render — a `const` declared further down would be in its TDZ.
  const renameBlockers = useMemo(() => maskedRenameBlockers(rows), [rows]);
  const renameBlockerMessage = useMemo(() => maskedRenameBlockerMessage(renameBlockers), [renameBlockers]);

  useEffect(() => {
    onDirtyChange?.(!disabled && hasUnsavedChanges);
  }, [disabled, hasUnsavedChanges, onDirtyChange]);

  // Which variables differ from the committed baseline, so the unsaved-changes
  // banner can say *what* is unsaved instead of a bare label. A rename shows
  // as one addition plus one removal.
  const changeSummary = useMemo(() => {
    const committed = new Map(
      normalizedEnvEntries(valueFromRows(committedRows)).map(([name, binding]) => [name, JSON.stringify(binding)]),
    );
    const draft = new Map(
      normalizedEnvEntries(draftValue).map(([name, binding]) => [name, JSON.stringify(binding)]),
    );
    const added: string[] = [];
    const changed: string[] = [];
    for (const [name, bindingKey] of draft) {
      if (!committed.has(name)) added.push(name);
      else if (committed.get(name) !== bindingKey) changed.push(name);
    }
    const removed = [...committed.keys()].filter((name) => !draft.has(name));
    return { added, changed, removed };
  }, [committedRows, draftValue]);

  const changeSummaryText = useMemo(() => {
    const parts: string[] = [];
    if (changeSummary.added.length > 0) parts.push(`New: ${formatChangedNames(changeSummary.added)}`);
    if (changeSummary.changed.length > 0) parts.push(`Edited: ${formatChangedNames(changeSummary.changed)}`);
    if (changeSummary.removed.length > 0) parts.push(`Removed: ${formatChangedNames(changeSummary.removed)}`);
    return parts.join(" · ");
  }, [changeSummary]);

  // Warn before the tab unloads with a dirty draft (same guard as the skill
  // file editor). In-app navigation is not intercepted here.
  useEffect(() => {
    if (disabled || !hasUnsavedChanges) return;
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [disabled, hasUnsavedChanges]);

  const flushPendingDraft = useCallback((): FlushPendingDraftResult => {
    if (disabled || !hasUnsavedChanges) return { status: "idle" };
    // Same refusal as `saveDraft`, and it has to be repeated here rather than left to the button:
    // this is the path an *outer* Save/submit takes, so without it the very edit the row is
    // flagging would be promoted past the block the row is displaying.
    //
    // Reporting it is this function's job too. The outer action that called us renders somewhere
    // else on the page — a sticky header, a dialog footer — and the editor's banner may well be
    // scrolled out of view, so "the banner already says so" is not a signal the user receives.
    // Focus the offending row (same move the editor's own Save makes) and say it once out loud.
    // `renameBlockerMessage` is non-null exactly when `renameBlockers` is non-empty (`model.ts`),
    // so branching on the message is the same test and carries the sentence with it. The banner
    // renders this very value — one refusal, one phrasing, one memo.
    if (renameBlockerMessage) {
      setPendingFocus({ rowId: renameBlockers[0]!.id, field: "name" });
      toast?.pushToast({
        title: renameBlockerMessage,
        tone: "error",
        // Repeated Save presses are one unresolved problem, not a queue of them.
        dedupeKey: `env-editor-rename-blocked|${renameBlockerMessage}`,
      });
      return { status: "blocked", message: renameBlockerMessage };
    }
    pendingSaveValueKeyRef.current = draftValueKey;
    flushSync(() => {
      onChange(draftValue);
    });
    return { status: "flushed", env: draftValue ?? {} };
  }, [disabled, draftValue, draftValueKey, hasUnsavedChanges, onChange, renameBlockerMessage, renameBlockers, toast]);

  useImperativeHandle(ref, () => ({ flushPendingDraft }), [flushPendingDraft]);

  // This listener is LIVE, not dead weight — do not delete it as unreachable.
  //
  // `closest("form")` resolves for the `PipelineSettings` consumer: that page wraps its entire stage
  // editor in a real `<form>` whose submit runs `saveStage.mutate()`, and `<StageSecretsPanel>` —
  // which renders this editor — sits inside it. So on that surface a stage save really is a form
  // submit, and without this capture-phase guard a refused rename would let it through. Verified on
  // `master` @7bd3bd81 (PEN-4236).
  //
  // The other consumers (AgentConfigForm, CompanyEnvironments, ProjectProperties,
  // routine-sections/editable-sections, the DesignGuide showcase) are plain `div` panels with no
  // `<form>` above them. For those the early return fires and the protection comes from the
  // document-level capture `click` listener plus the consumer-side `flushPendingDraft().status ===
  // "blocked"` checks instead.
  useEffect(() => {
    const form = editorRootRef.current?.closest("form");
    if (!form) return;

    function handleSubmit(event: Event) {
      // Capture phase, so this runs before the form's own submit handler. A refusal has to stop
      // the submit outright rather than merely decline to contribute: letting it through would
      // submit the *last committed* env alongside every other field's new value, which is the
      // silent partial save this block exists to prevent. Consumers that read the handle directly
      // get the same answer from the return value; this covers the ones that never call it.
      if (flushPendingDraft().status === "blocked") {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    form.addEventListener("submit", handleSubmit, true);
    return () => form.removeEventListener("submit", handleSubmit, true);
  }, [flushPendingDraft]);

  useEffect(() => {
    const root = editorRootRef.current;
    if (!root) return;
    const currentRoot = root;

    function handleDocumentClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || currentRoot.contains(target)) return;
      const button = target.closest("button");
      if (!button || button.disabled) return;
      const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`;
      if (!(button.type === "submit" || /\b(save|create|update|test|import)\b/i.test(label))) return;

      if (!sharesSubmissionScope(button, currentRoot)) {
        // Someone else's submit. The flush is still worth doing — it is the pre-PEN-3358 behaviour
        // of this listener and costs the user nothing — but only when there is nothing to refuse:
        // a refusal here would toast and steal focus over an action that is not ours to refuse,
        // and we are deliberately not cancelling the click (PEN-4232).
        if (renameBlockers.length === 0) flushPendingDraft();
        return;
      }

      // Same reasoning as the form `submit` listener above: on a refusal, swallow the click in
      // the capture phase so the outer button's own handler never runs. Without this the button
      // would proceed on state the editor has just refused to update.
      if (flushPendingDraft().status === "blocked") {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    document.addEventListener("click", handleDocumentClick, true);
    return () => document.removeEventListener("click", handleDocumentClick, true);
  }, [flushPendingDraft, renameBlockers]);

  function updateDraft(nextRows: EnvRow[]) {
    setRows(nextRows);
  }

  function patchRow(id: string, patch: Partial<EnvRow>) {
    updateDraft(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    updateDraft(rows.filter((row) => row.id !== id));
  }

  function addRow() {
    const row = emptyRow();
    setRows([...rows, row]);
    setPendingFocus({ rowId: row.id, field: "name" });
  }

  function markTouched(id: string) {
    const rowName = rows.find((row) => row.id === id)?.name.trim();
    if (!rowName) return;
    setTouchedNames((prev) => {
      if (prev.has(rowName)) return prev;
      const next = new Set(prev);
      next.add(rowName);
      return next;
    });
  }

  function bulkImport(text: string, targetRowId: string): boolean {
    const pairs = parseDotenv(text);
    if (pairs.length === 0) return false;
    // Drop the empty row that received the paste, then upsert each pair.
    const working = rows.filter((row) => row.id !== targetRowId).map((row) => ({ ...row }));
    for (const { key, value: pairValue } of pairs) {
      const existing = working.find((row) => row.name.trim() === key);
      if (existing) {
        existing.name = key;
        existing.source = "text";
        existing.textValue = pairValue;
        existing.masked = false;
        existing.secretId = "";
        existing.sensitiveDismissed = false;
        existing.userSecretKey = "";
        existing.required = true;
      } else {
        working.push({ ...emptyRow(), name: key, textValue: pairValue });
      }
    }
    updateDraft(working);
    toast?.pushToast({ title: `Imported ${pairs.length} variable${pairs.length === 1 ? "" : "s"}`, tone: "success" });
    return true;
  }

  function bindRecentSecret(secret: CompanySecret) {
    const next = rows.map((row) => ({ ...row }));
    const trailing = next[next.length - 1];
    let target: EnvRow;
    if (trailing && !trailing.name && !trailing.textValue && !trailing.secretId && !trailing.userSecretKey) {
      target = trailing;
    } else {
      target = emptyRow();
      next.push(target);
    }
    target.source = "secret";
    target.secretId = secret.id;
    target.version = "latest";
    if (!target.name) target.name = envKeyFromSecretName(secret.name);
    updateDraft(next);
  }

  function saveDraft() {
    if (!hasUnsavedChanges) return;
    // Refuse rather than annotate. The row already renders why; sending anyway would 422 the whole
    // PATCH server-side and lose every other edit in this save along with it.
    if (renameBlockers.length > 0) {
      setPendingFocus({ rowId: renameBlockers[0]!.id, field: "name" });
      return;
    }
    pendingSaveValueKeyRef.current = draftValueKey;
    onChange(draftValue);
  }

  function revertDraft() {
    pendingSaveValueKeyRef.current = null;
    lastPropValueKeyRef.current = normalizedEnvKey(value);
    const nextRows = adoptExternalValue(value);
    markCommitted(lastPropValueKeyRef.current, nextRows);
  }

  const duplicateNames = useMemo(() => computeDuplicateNames(rows), [rows]);

  const attentionCount = useMemo(
    () =>
      rows.reduce(
        (count, row) =>
          computeRowHealth(row, secrets) || computeUserSecretRowHealth(row, userSecretDefinitions)
            ? count + 1
            : count,
        0,
      ),
    [rows, secrets, userSecretDefinitions],
  );

  const quickBind = useMemo(() => {
    const boundIds = new Set(rows.filter((row) => row.source === "secret" && row.secretId).map((row) => row.secretId));
    return (recentlyUsedSecrets ?? [])
      .filter((secret) => secret.status === "active" && !boundIds.has(secret.id))
      .slice(0, 8);
  }, [recentlyUsedSecrets, rows]);

  const hasRows = rows.length > 0;
  const hint = footerHint === undefined ? DEFAULT_HINT : footerHint;
  const committedRowsById = useMemo(
    () => new Map(committedRows.map((row) => [row.id, row])),
    [committedRows],
  );

  return (
    <TooltipProvider>
      <div ref={editorRootRef} className="@container/env space-y-2">
      {attentionCount > 1 ? (
        <p className="inline-flex items-center gap-1.5 text-(length:--text-micro) font-medium text-amber-700 dark:text-amber-400">
          <AlertCircle className="size-3.5" />
          {attentionCount} bindings need attention
        </p>
      ) : null}

      {hasRows ? (
        <>
          {/* Header (desktop only) */}
          <div className="hidden gap-x-1.5 @[40rem]/env:grid @[40rem]/env:grid-cols-(--gtc-14)">
            <span className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">Name</span>
            <span className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">Value</span>
            <span />
          </div>

          {rows.map((row, index) => {
            const nameIssue = validateName(row.name, duplicateNames, reservedPrefixes);
            // A renamed mask cannot be fixed by fixing the name, so a hard name error (unusable
            // name) still wins — that one is a precondition for everything else.
            const renameIssue = nameIssue?.level === "error" ? null : maskedRenameIssue(row);
            const issue = renameIssue ?? nameIssue;
            // `touchedNames` is seeded with the names the editor LOADED with and probed by the
            // row's CURRENT name, so a rename is never "touched" by construction — the gate would
            // hide this error exactly when it fires. Blur-gating is right for a name the user is
            // still typing; it is wrong for a condition that is already true.
            const touched = renameIssue !== null || touchedNames.has(row.name.trim());
            return (
              <EnvironmentVariableRow
                key={row.id}
                row={row}
                isLast={index === rows.length - 1}
                secrets={secrets}
                userSecretDefinitions={userSecretDefinitions}
                recentlyUsedSecrets={recentlyUsedSecrets}
                disabled={disabled}
                nameIssue={issue}
                showNameIssue={touched}
                dirtyFields={rowDirtyFields(row, committedRowsById.get(row.id))}
                onPatch={(patch) => patchRow(row.id, patch)}
                onRemove={() => removeRow(row.id)}
                onNameBlur={() => markTouched(row.id)}
                onNamePaste={(text) => bulkImport(text, row.id)}
                onEnterInValueLast={addRow}
                onCreateSecret={onCreateSecret}
                onToast={(message) => toast?.pushToast({ title: message, tone: "success" })}
                focusRequest={pendingFocus?.rowId === row.id ? pendingFocus.field : null}
                onFocusConsumed={() => setPendingFocus(null)}
              />
            );
          })}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No environment variables</p>
      )}

      {/* Footer bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add variable
        </button>

        {quickBind.length > 0 && !disabled ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground/70">
              <KeyRound className="size-3" />
              Recently used:
            </span>
            {quickBind.map((secret) => (
              <button
                key={secret.id}
                type="button"
                onClick={() => bindRecentSecret(secret)}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                title={`Bind ${secret.name}`}
              >
                + {secret.name}
              </button>
            ))}
          </div>
        ) : null}

      </div>

      {hasUnsavedChanges && !disabled ? (
        <div
          role="status"
          className="mt-3 flex w-full flex-col gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-amber-950 shadow-sm dark:bg-amber-500/15 dark:text-amber-100 @[34rem]/env:flex-row @[34rem]/env:items-center @[34rem]/env:justify-between"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="size-2 rounded-full bg-amber-500 shadow-(--shadow-extract-13)" />
              <span>Unsaved changes</span>
            </div>
            {changeSummaryText ? (
              <p className="min-w-0 truncate pl-4 text-xs text-amber-950/80 dark:text-amber-100/80" title={changeSummaryText}>
                {changeSummaryText}
              </p>
            ) : null}
            {renameBlockerMessage ? (
              <p className="min-w-0 pl-4 text-xs font-medium text-destructive">{renameBlockerMessage}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={revertDraft}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-amber-500/30 bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-amber-500/10 dark:bg-background/80"
            >
              <RotateCcw className="size-4" />
              Revert
            </button>
            <button
              type="button"
              onClick={saveDraft}
              disabled={renameBlockers.length > 0}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary"
            >
              <Save className="size-4" />
              Save
            </button>
          </div>
        </div>
      ) : null}

      {hint ? <p className="text-(length:--text-micro) text-muted-foreground/70">{hint}</p> : null}
      {rows.some((row) => row.source === "user_secret" && row.userSecretKey) ? (
        <p className="inline-flex items-start gap-1 text-(length:--text-micro) text-muted-foreground/70">
          <UserRound className="mt-0.5 size-3 shrink-0" />
          <span>
            User secrets resolve from the user responsible for the run. Required bindings fail until that user
            sets their value under Secrets → My secrets.
          </span>
        </p>
      ) : null}
      </div>
    </TooltipProvider>
  );
});

export type { EnvRow } from "./model";
export { EnvironmentVariableRow } from "./Row";
export { SecretPicker } from "./SecretPicker";
export { CreateSecretPopover, ConvertToSecretPopover } from "./CreateSecretPopover";
export { parseDotenv, looksLikeDotenv } from "./parse-dotenv";
export { isSensitiveEnv } from "./sensitive";
