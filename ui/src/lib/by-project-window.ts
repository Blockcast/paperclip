import { ApiError } from "@/api/client";
import { costsApi } from "@/api/costs";
import type { CostByProject } from "@paperclipai/shared";

/**
 * PEN-6038: keep the Costs date-range presets usable now that `by-project`
 * refuses a window wider than the server's cap (PEN-5591).
 *
 * The presets are NOT narrowed to the cap. `useDateRange` has one consumer,
 * but its range drives nine aggregates -- summary, by-agent, by-agent-model,
 * by-provider, by-biller and the four finance routes -- and only `by-project`
 * is capped. Cutting the menu to the cap would delete month-to-date and
 * year-to-date spend reporting for the whole page to accommodate one card.
 *
 * Instead this clamps the `by-project` REQUEST to the trailing N days of
 * whatever the user selected, so no preset can produce a window the server
 * refuses, and the card reports the window it actually answered for.
 *
 * The cap itself is never written down here. It is read out of the `400`
 * payload (`details.maxWindowDays`), so retuning the one server constant
 * needs no change on this side.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `details.code` values that carry a `maxWindowDays` we can clamp to. */
const CAP_CODES = new Set(["window_too_wide", "window_unbounded"]);

export interface ByProjectWindow {
  /** iso string; always present once clamped */
  from: string;
  /** iso string, or "" meaning "through now" */
  to: string;
}

export interface ByProjectResult {
  rows: CostByProject[];
  /** the window the server actually answered for */
  window: ByProjectWindow;
  /** the server's cap, once learned; null while the selection fits */
  capDays: number | null;
  /** true when `window` is narrower than the range the user selected */
  clamped: boolean;
}

/**
 * Pull the server's window cap out of a refusal.
 *
 * Returns null for anything that is not a cap refusal -- a 500, an auth
 * failure and a network error all have to keep surfacing as errors rather
 * than being silently retried against a narrower window.
 */
export function readWindowCapDays(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.body as { details?: { code?: string; maxWindowDays?: unknown } } | null)
    ?.details;
  if (!details || !CAP_CODES.has(details.code ?? "")) return null;
  const max = details.maxWindowDays;
  return typeof max === "number" && Number.isFinite(max) && max > 0 ? max : null;
}

/**
 * Narrow a selection to the trailing `capDays` ending at its upper bound.
 *
 * The trailing end is the one worth keeping: on a cost dashboard the recent
 * days are what anyone is looking at, and every preset here is anchored to
 * "now" at its upper end anyway.
 *
 * An empty `to` means "through now", and an empty `from` means unbounded --
 * the `all` preset -- which is exactly the full-history scan the cap exists
 * to refuse, so it clamps to the trailing window like any other.
 */
export function clampWindowToCap(
  from: string,
  to: string,
  capDays: number,
  now: Date = new Date(),
): ByProjectWindow {
  const end = to ? new Date(to) : now;
  const capStart = new Date(end.getTime() - capDays * MS_PER_DAY);
  const selectedStart = from ? new Date(from) : null;
  // A selection already inside the cap is left alone; only a wider one moves.
  const start = selectedStart && selectedStart.getTime() > capStart.getTime()
    ? selectedStart
    : capStart;
  return { from: start.toISOString(), to: end.toISOString() };
}

/** True when the clamp actually moved the lower bound. */
export function isClamped(from: string, window: ByProjectWindow): boolean {
  if (!from) return true; // unbounded selection, now bounded
  return new Date(window.from).getTime() > new Date(from).getTime();
}

// The cap, once a refusal has told us what it is. Remembered per tab so a
// wide selection costs one probe, not one per refetch tick -- `by-project`
// polls, and the page re-requests on every preset change.
//
// Not seeded with a literal: until the server has refused something we do not
// claim to know the cap, and an unclamped request is the correct way to find
// out. The refusal is cheap by construction -- PEN-5591 rejects before
// touching the database, which is the whole point of it being a 400.
let rememberedCapDays: number | null = null;

export function getRememberedCapDays(): number | null {
  return rememberedCapDays;
}

export function rememberCapDays(days: number): void {
  rememberedCapDays = days;
}

/** Test-only: drop the learned cap so each case starts cold. */
export function __resetRememberedCapDays(): void {
  rememberedCapDays = null;
}

/**
 * Fetch `by-project` for a window the server will accept.
 *
 * Clamps up front when the cap is already known, and otherwise learns it from
 * the refusal and retries once. The retry is bounded at one attempt: if a
 * clamped window is refused too, that is a real failure and it propagates
 * rather than looping.
 */
export async function fetchByProjectWithinCap(
  companyId: string,
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<ByProjectResult> {
  const known = getRememberedCapDays();
  let window: ByProjectWindow = known != null
    ? clampWindowToCap(from, to, known, now)
    : { from, to };
  let capDays = known;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rows = await costsApi.byProject(
        companyId,
        window.from || undefined,
        window.to || undefined,
      );
      return {
        rows,
        window,
        capDays,
        clamped: capDays != null && isClamped(from, window),
      };
    } catch (error) {
      const learned = readWindowCapDays(error);
      // Not a cap refusal, or we already clamped and were refused anyway --
      // either way this is a genuine error and the card should say so.
      if (learned == null || attempt > 0) throw error;
      rememberCapDays(learned);
      capDays = learned;
      window = clampWindowToCap(from, to, learned, now);
    }
  }

  // Unreachable: the loop either returns or throws on its second pass.
  throw new Error("by-project window clamp did not settle");
}

/** Human-readable window for the card's explanatory state, e.g. "Nov 2 - Nov 7". */
export function formatWindow(window: ByProjectWindow): string {
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  return `${fmt.format(new Date(window.from))} - ${fmt.format(new Date(window.to))}`;
}

/**
 * The card's explanatory copy, kept here rather than inline in the page so the
 * one thing a reader actually sees is testable without standing up the whole
 * Costs page and its nine queries.
 *
 * Both strings name the limit. Neither names a number of its own -- the days
 * come from the server, via `ByProjectResult.capDays` or the refusal.
 */

/** Shown when the request was narrowed; null when the selection fit as-is. */
export function clampNotice(result: ByProjectResult | undefined): string | null {
  if (!result?.clamped || result.capDays == null) return null;
  return `Project attribution is limited to ${result.capDays} days, so this card covers `
    + `${formatWindow(result.window)} rather than the range selected above.`;
}

/**
 * Shown when a refusal reaches the card anyway -- possible only when the server
 * constant is retuned DOWNWARD while this tab still holds the previous cap.
 * Returns null for any error that is not a cap refusal, which keeps genuine
 * failures on the error path instead of being explained away.
 */
export function capRefusalNotice(error: unknown): string | null {
  const capDays = readWindowCapDays(error);
  if (capDays == null) return null;
  return `Project attribution is limited to ${capDays} days. `
    + `Pick a shorter range to see costs by project.`;
}
