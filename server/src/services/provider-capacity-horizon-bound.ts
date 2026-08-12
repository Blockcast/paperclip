// BLO-18285: the single provider-capacity horizon bound, shared by the writer
// and the reader because they are not independently choosable.
//
// The write side (heartbeat.ts) refuses to park verbatim on a horizon further
// out than this, and an over-cap advertisement is instead parked at exactly
// `finalizationNow + PROVIDER_CAPACITY_MAX_HORIZON_MS`. The read side
// (recovery/service.ts) validates a recorded horizon against
// `finishedAt ± PROVIDER_CAPACITY_MAX_HORIZON_MS`. So an over-cap park lands
// precisely ON the reader's upper bound, and the two values agreeing is the
// only reason it survives the bounds check at all.
//
// They used to be two unrelated literals. Raising one alone fails silently and
// in the worst possible direction: the instant is simply refused on read, and
// every over-cap strand comment quietly reverts to the generic
// `BackoffLimitExceeded` text that sent operators to inspect the cluster
// instead of a provider window — the exact misdiagnosis this whole path exists
// to prevent. A shared constant makes that divergence unrepresentable rather
// than merely tested for.
//
// This lives in its own leaf module because heartbeat.ts already imports from
// recovery/service.ts, so the constant cannot be owned by either without a
// cycle.
//
// Why 24h: it comfortably covers the capacity windows we have measured directly
// (the BLO-18278 fault asked for ~2h40m) while bounding the blast radius of a
// bad parse — no single unverified estimate may sideline an issue for days. The
// BLO-18285 fault advertised 88.8h, and parking at this cap rather than
// discarding the reading is what keeps such a run on a live execution path.
export const PROVIDER_CAPACITY_MAX_HORIZON_MS = 24 * 60 * 60 * 1000;
