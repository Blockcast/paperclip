import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_PROMETHEUS_READ_TIMEOUT_MS } from "./constants.js";
import type { AlertmanagerPluginConfig } from "./types.js";

/**
 * PEN-6236 — the one question Alertmanager cannot answer.
 *
 * ## Why a second instrument at all
 *
 * The cover close hold (BLO-42259) exists so that an alert which resolves and
 * immediately re-fires does not lose its cover in the gap. It is implemented
 * as a 15-minute wait plus a reopen branch in `reopenOpenCoverMembership`, and
 * the reopen branch is reachable only if the re-fire lands inside the hold.
 *
 * A re-fire cannot land inside the hold when `for:` is longer than it. A
 * Prometheus config reload replaces the rule group, which discards `activeAt`;
 * the alert drops back to `pending` and the earliest it may fire again is
 * `activeAt + for`. Measured on this estate 2026-11-09, median `for:` over
 * 1199 loaded alerting rules is 900 s — the hold exactly — and 347 of them
 * exceed it. So on more than a quarter of the estate the hold is structurally
 * incapable of doing its job, and the cover is cancelled underneath a
 * condition that never stopped holding.
 *
 * The close path could not see this because it had no instrument that could.
 * Every liveness read in this plugin goes to Alertmanager `/api/v2/alerts`,
 * and **Alertmanager has no representation of `pending`** — an alert enters
 * Alertmanager only once it fires. Prometheus does, and its `ALERTS` series
 * carries BOTH `pending` and `firing` — which is why this module asks for the
 * series without an `alertstate` matcher and reads presence as "not cleared".
 * That is the whole of it: a second, narrow read whose only consumer is the
 * cover close decision.
 *
 * ⚠ It is deliberately NOT wired into the ladder's liveness line. The rungs
 * ask "is this incident live?", for which Alertmanager is the right source;
 * only the close asks "has this source actually cleared?".
 *
 * ## Gate polarity
 *
 * `ALERTS` is a series that exists only while an alert is pending or firing,
 * so an empty result means "cleared" — which is the CLOSE-PERMITTING
 * answer. Every way this read can break (unset URL, wrong scheme, DNS failure,
 * timeout, non-2xx, unparseable body, a `status` that is not `"success"`, a
 * non-array `result`) therefore lands on the same shape as the good news, and
 * a naive implementation fails open on all of them.
 *
 * So `unknown` is a distinct third value, never folded into `cleared`, and
 * the caller treats it as "do not close yet" inside a bounded window. Nothing
 * here returns `cleared` unless an actual HTTP exchange completed, parsed,
 * and produced a well-formed vector that genuinely contained no sample at all for
 * this alertname.
 */
export type SourceAlertState =
  /**
   * An `ALERTS` sample exists for this alertname right now — `pending` OR
   * `firing`. Either way the condition has not cleared, so the cover must not
   * be closed on the evidence.
   */
  | { state: "live"; readAt: string; detail: string }
  /** A well-formed read completed and `ALERTS` carried nothing for this alertname. */
  | { state: "cleared"; readAt: string }
  /** The read did not happen, or did not produce an answer that can be trusted. */
  | { state: "unknown"; reason: string; unreachable?: boolean };

export type SourceStateReader = (alertname: string) => Promise<SourceAlertState>;

/**
 * Resolves the Prometheus base URL, config first and environment second —
 * the same precedence and the same trailing-slash normalisation as
 * `resolveAlertmanagerApiUrl`, so an operator configures the two the same way.
 */
export function resolvePrometheusApiUrl(
  config: AlertmanagerPluginConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = config.prometheusApiUrl?.trim() || env.PAPERCLIP_PROMETHEUS_API_URL?.trim() || "";
  return raw.replace(/\/+$/, "");
}

/**
 * True when the instance has a usable Prometheus endpoint configured at all.
 *
 * Exported so the close path can distinguish "configured, and it says the
 * source cleared" from "never configured" and name the difference in the verdict it
 * records. Folding the two would make an unconfigured estate indistinguishable
 * from a verified-clear one in the very record PEN-6236 adds to tell closes
 * apart.
 */
export function hasPrometheusEndpoint(config: AlertmanagerPluginConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const base = resolvePrometheusApiUrl(config, env);
  return base !== "" && ["http:", "https:"].includes(URL.parse(base)?.protocol ?? "");
}

/**
 * Escapes a label value for a PromQL double-quoted string.
 *
 * An alertname is conventionally `[a-zA-Z_][a-zA-Z0-9_]*`, but nothing in
 * Alertmanager enforces that and this value arrives from a webhook payload. An
 * unescaped `"` would terminate the matcher early and leave a selector that is
 * either a parse error (→ `unknown`, safe) or, worse, a valid selector for
 * something else.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n");
}

async function readSourceAlertStateOnce(
  base: string,
  alertname: string,
  now: Date,
  logger: PluginContext["logger"],
  timeoutMs: number,
): Promise<SourceAlertState> {
  // ⚠ DELIBERATELY NO `alertstate` MATCHER. An earlier draft asked only for
  // `alertstate="pending"` and that is a fail-OPEN: suppose the rule has
  // already re-fired in Prometheus but Alertmanager has not delivered the
  // firing webhook yet (`group_wait`/`group_interval`). Then
  // `reopenOpenCoverMembership` has not run, the cover is eligible, and there
  // is no PENDING series — so the read answered "not pending" and the cover
  // closed stamped `source_cleared`, the one verdict this plugin calls
  // positive evidence, over a live alert. The late webhook cannot undo it:
  // `reopenOpenCoverMembership` only touches covers with
  // `cancelled_at IS NULL AND closing_claimed_at IS NULL`, so it mints a new
  // cover instead — the empty re-mint of defect B, caused by the fix for
  // defect A.
  //
  // `ALERTS` exists only while an alert is pending or firing, so its mere
  // presence is the question: has the condition cleared? Both states answer
  // "no", and `detail` reports which was seen.
  const query = `ALERTS{alertname="${escapeLabelValue(alertname)}"}`;
  const url = `${base}/api/v1/query?query=${encodeURIComponent(query)}`;
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Body under the same signal as the headers, matching the Alertmanager
    // reader: a server that answers and then stalls must fail here rather than
    // hold the close path open for the host's own 30s fetch default.
    text = res.ok ? await res.text() : "";
  } catch (err) {
    const cause = err instanceof Error && err.cause !== undefined ? ` (cause: ${String(err.cause)})` : "";
    logger.warn(`alert-escalation: Prometheus source-state read for ${alertname} failed: ${String(err)}${cause}`);
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      state: "unknown",
      reason: timedOut
        ? `the Prometheus request did not complete within ${timeoutMs / 1_000}s`
        : "the Prometheus request failed; the error is in the plugin log",
      unreachable: true,
    };
  }
  if (!res.ok) return { state: "unknown", reason: `Prometheus returned HTTP ${res.status}` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { state: "unknown", reason: "Prometheus returned a body that is not valid JSON" };
  }
  const envelope = body as { status?: unknown; data?: { result?: unknown } } | null;
  // `status: "success"` is required rather than assumed: the v1 API answers a
  // bad query with HTTP 400 AND `status: "error"`, but a proxy in front of it
  // can turn that into a 200 carrying the error envelope, whose `data` is
  // absent — which would read as an empty vector, i.e. cleared.
  if (envelope?.status !== "success") {
    return { state: "unknown", reason: `Prometheus did not answer status=success (got ${JSON.stringify(envelope?.status ?? null)})` };
  }
  const result = envelope.data?.result;
  if (!Array.isArray(result)) return { state: "unknown", reason: "Prometheus returned a non-array result vector" };
  // Re-apply the matcher locally. Same belt-and-braces as the Alertmanager
  // reader, and here it guards the fail-CLOSED direction too: a proxy that
  // ignored the selector and returned every ALERTS series would otherwise read
  // as "live" for every alertname on the cluster and freeze every close.
  const matching = result.filter(
    (entry) => (entry as { metric?: Record<string, string> } | null)?.metric?.alertname === alertname,
  );
  const readAt = now.toISOString();
  if (matching.length === 0) return { state: "cleared", readAt };
  const states = [
    ...new Set(matching.map((e) => (e as { metric?: Record<string, string> } | null)?.metric?.alertstate ?? "unknown")),
  ].sort();
  return { state: "live", readAt, detail: `${matching.length} series, alertstate=${states.join("/")}` };
}

/**
 * One source-state reader per sweep pass, memoised by alertname and
 * short-circuited on transport failure.
 *
 * The close pass walks every ready cover sequentially, so without the
 * short-circuit an unreachable Prometheus costs one timeout per cover — during
 * exactly the correlated outage when many covers come ready together. Matches
 * `createSweepLivenessReader`'s structure deliberately: a non-2xx or a bad body
 * is alertname-specific and does not poison other alertnames, while a
 * transport failure is about the endpoint and does.
 */
export function createSweepSourceStateReader(
  config: AlertmanagerPluginConfig,
  now: Date,
  logger: PluginContext["logger"],
  env: NodeJS.ProcessEnv = process.env,
): SourceStateReader {
  const base = resolvePrometheusApiUrl(config, env);
  if (!base) {
    const unset: SourceAlertState = { state: "unknown", reason: "no prometheusApiUrl is configured for this instance" };
    return async () => unset;
  }
  // `fetch` accepts any scheme, and a `data:` URL would answer with a body of
  // the configurer's choosing — an empty vector reads as "cleared" and
  // would restore the exact fail-open this module exists to close.
  if (!["http:", "https:"].includes(URL.parse(base)?.protocol ?? "")) {
    const badScheme: SourceAlertState = { state: "unknown", reason: "prometheusApiUrl is not an http:// or https:// URL, so it was not read" };
    return async () => badScheme;
  }
  const timeoutMs = config.prometheusReadTimeoutMs ?? DEFAULT_PROMETHEUS_READ_TIMEOUT_MS;
  const reads = new Map<string, SourceAlertState>();
  let unreachable: SourceAlertState | null = null;
  return async (alertname) => {
    const cached = reads.get(alertname) ?? unreachable;
    if (cached) return cached;
    const read = await readSourceAlertStateOnce(base, alertname, now, logger, timeoutMs);
    reads.set(alertname, read);
    if (read.state === "unknown" && read.unreachable) unreachable = read;
    return read;
  };
}
