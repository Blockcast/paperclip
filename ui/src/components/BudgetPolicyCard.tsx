import { useEffect, useState } from "react";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { AlertTriangle, PauseCircle, PlayCircle, ShieldAlert, Wallet } from "lucide-react";
import { cn, formatCents } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function windowLabel(windowKind: BudgetPolicySummary["windowKind"]) {
  return windowKind === "lifetime" ? "Lifetime budget" : "Monthly UTC budget";
}

/**
 * What the card should *look* like, which is not the same question as what the
 * policy's utilization is.
 *
 * `summary.status` is derived from observed spend alone, and observed spend is
 * window-scoped: at the window roll a scope that is still paused drops to 0% and
 * its status falls back to "ok". Keying the pill, icon and bar off `status` alone
 * therefore turned a still-paused scope green at exactly the moment its pause
 * became durable, and held it green for the rest of the window -- the single
 * number a reviewer glances at to catch a failed resume was the number that
 * stopped reporting it (Penstock PEN-1972, defect 3).
 *
 * Folding `paused` in here rather than at each render site is deliberate: the
 * pill, the icon and the progress bar previously made this decision
 * independently, and the label already said "Paused" while the colour said
 * healthy.
 */
type BudgetDisplayStatus = BudgetPolicySummary["status"] | "paused";

function displayStatus(summary: BudgetPolicySummary): BudgetDisplayStatus {
  return summary.paused ? "paused" : summary.status;
}

function statusTone(status: BudgetDisplayStatus) {
  if (status === "hard_stop" || status === "paused") return "text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10";
  if (status === "warning") return "text-amber-700 dark:text-amber-200 border-amber-500/30 bg-amber-500/10";
  return "text-emerald-700 dark:text-emerald-200 border-emerald-500/30 bg-emerald-500/10";
}

function statusLabel(status: BudgetDisplayStatus) {
  if (status === "paused") return "Paused";
  if (status === "hard_stop") return "Hard stop";
  if (status === "warning") return "Warning";
  return "Healthy";
}

export function BudgetPolicyCard({
  summary,
  onSave,
  isSaving,
  compact = false,
  variant = "card",
}: {
  summary: BudgetPolicySummary;
  onSave?: (amountCents: number) => void;
  isSaving?: boolean;
  compact?: boolean;
  variant?: "card" | "plain";
}) {
  const [draftBudget, setDraftBudget] = useState(centsInputValue(summary.amount));

  useEffect(() => {
    setDraftBudget(centsInputValue(summary.amount));
  }, [summary.amount]);

  const parsedDraft = parseDollarInput(draftBudget);
  const canSave = typeof parsedDraft === "number" && parsedDraft !== summary.amount && Boolean(onSave);
  const progress = summary.amount > 0 ? Math.min(100, summary.utilizationPercent) : 0;
  const status = displayStatus(summary);
  const StatusIcon =
    status === "paused" ? PauseCircle : status === "hard_stop" ? ShieldAlert : status === "warning" ? AlertTriangle : Wallet;
  const isPlain = variant === "plain";

  const observedBudgetGrid = isPlain ? (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Observed</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {summary.amount > 0 ? `${summary.utilizationPercent}% of limit` : "No cap configured"}
        </div>
      </div>
      <div>
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Budget</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatCents(summary.amount) : "Disabled"}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Soft alert at {summary.warnPercent}%{summary.paused && summary.pauseReason ? ` · ${summary.pauseReason} pause` : ""}
        </div>
      </div>
    </div>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Observed</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {summary.amount > 0 ? `${summary.utilizationPercent}% of limit` : "No cap configured"}
        </div>
      </div>
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Budget</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatCents(summary.amount) : "Disabled"}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Soft alert at {summary.warnPercent}%{summary.paused && summary.pauseReason ? ` · ${summary.pauseReason} pause` : ""}
        </div>
      </div>
    </div>
  );

  const progressSection = (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Remaining</span>
        <span>{summary.amount > 0 ? formatCents(summary.remainingAmount) : "Unlimited"}</span>
      </div>
      <div
        className={cn(
          "h-2 overflow-hidden rounded-full",
          // A scope paused after a window roll reads 0%, so the fill is
          // zero-width and cannot carry the signal on its own -- the track has to.
          status === "paused" ? "bg-red-500/30" : isPlain ? "bg-border/70" : "bg-muted/70",
        )}
      >
        <div
          className={cn(
            "h-full rounded-full transition-(--tp-width-background-color) duration-200",
            status === "hard_stop" || status === "paused"
              ? "bg-(--status-task-blocked)"
              : status === "warning"
                ? "bg-(--status-task-todo)"
                : "bg-(--status-task-done)",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );

  const pausedPane = summary.paused ? (
    <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-900 dark:text-red-100">
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        {summary.scopeType === "project"
          ? "Execution is paused for this project until the budget is raised or the incident is dismissed."
          : "Heartbeats are paused for this scope until the budget is raised or the incident is dismissed."}
      </div>
    </div>
  ) : null;

  /**
   * A forgiven scope is over its cap and still running, by decision (PEN-4742).
   *
   * Utilization deliberately keeps reporting TRUE window spend, so without this
   * line the card shows a red bar past 100% on a scope that is working normally
   * and nothing anywhere says why. That reads as a broken gauge, and a broken
   * gauge is how the board stops trusting the one number it checks -- the same
   * failure mode as a paused scope rendering green, pointed the other way.
   *
   * Suppressed while `paused` is set: a re-latched scope is genuinely stopped,
   * and `pausedPane` is the accurate statement then.
   */
  const forgivenPane = !summary.paused && summary.hardStopForgivenSince ? (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
      <PlayCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        Resumed by the board on {new Date(summary.hardStopForgivenSince).toLocaleString()} without
        raising the cap. Spend above is this window&rsquo;s true total; for the rest of the window
        the hard stop is measured from that decision, and resets at the window roll.
      </div>
    </div>
  ) : null;

  const saveSection = onSave ? (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end", isPlain ? "" : "rounded-xl border border-border/70 bg-background/50 p-3")}>
      <div className="min-w-0 flex-1">
        <label className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
          Budget (USD)
        </label>
        <Input
          value={draftBudget}
          onChange={(event) => setDraftBudget(event.target.value)}
          className="mt-2"
          inputMode="decimal"
          placeholder="0.00"
        />
      </div>
      <Button
        onClick={() => {
          if (typeof parsedDraft === "number" && onSave) onSave(parsedDraft);
        }}
        disabled={!canSave || isSaving || parsedDraft === null}
      >
        {isSaving ? "Saving..." : summary.amount > 0 ? "Update budget" : "Set budget"}
      </Button>
    </div>
  ) : null;

  if (isPlain) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
            </div>
            <div className="mt-2 text-xl font-semibold">{summary.scopeName}</div>
            <div className="mt-2 text-sm text-muted-foreground">{windowLabel(summary.windowKind)}</div>
          </div>
          <div
            className={cn(
              "inline-flex items-center gap-2 text-(length:--text-micro) uppercase tracking-(--tracking-caps)",
              status === "hard_stop" || status === "paused"
                ? "text-red-700 dark:text-red-300"
                : status === "warning"
                  ? "text-amber-800 dark:text-amber-200"
                  : "text-muted-foreground",
            )}
          >
            <StatusIcon className="h-3.5 w-3.5" />
            {statusLabel(status)}
          </div>
        </div>

        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {forgivenPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">Enter a valid non-negative dollar amount.</p>
        ) : null}
      </div>
    );
  }

  return (
    <Card className={cn("overflow-hidden border-border/70 bg-card/80", compact ? "" : "shadow-(--shadow-extract-2)")}>
      <CardHeader className={cn("gap-3", compact ? "px-4 pt-4 pb-2" : "px-5 pt-5 pb-3")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
            </div>
            <CardTitle className="mt-1 text-base">{summary.scopeName}</CardTitle>
            <CardDescription className="mt-1">{windowLabel(summary.windowKind)}</CardDescription>
          </div>
          <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-(length:--text-micro) uppercase tracking-(--tracking-caps)", statusTone(status))}>
            <StatusIcon className="h-3.5 w-3.5" />
            {statusLabel(status)}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4 pt-0" : "px-5 pb-5 pt-0")}>
        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {forgivenPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">Enter a valid non-negative dollar amount.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
