/**
 * One gate fixture, shared by the two PEN-5766 payload-edit suites, plus the key
 * order Postgres actually returns it in.
 *
 * It lives in its own file because the two suites need it for OPPOSITE reasons and
 * the pair is what makes either of them meaningful:
 *
 *   - `approval-payload-edit-service.test.ts` writes this gate to a real jsonb
 *     column, reads it back, and asserts the read-back key order IS
 *     `JSONB_GATE_KEY_ORDER`. That is the empirical anchor — nothing here is
 *     asserted from memory about how Postgres orders jsonb keys.
 *   - `approval-payload-edit-routes.test.ts` has no database: its service is
 *     mocked, so whatever key order its fixture happens to be written in is the
 *     key order the route sees. Before PEN-5766's review it was written in SHAPE
 *     order, which no stored card can ever be in, and that is precisely why a
 *     `JSON.stringify` gate comparison passed every route test while refusing
 *     every real edit to a gated card.
 *
 * So the route suite builds its stored gate through `asStoredGate()` below, and
 * the service suite proves `asStoredGate()` tells the truth.
 */

/** A gate exactly as a caller submits it: `approvalGateSchema` shape order. */
export const LIVE_GATE = {
  kind: "github_pr_merged" as const,
  repoFullName: "Blockcast/paperclip",
  prNumber: 2958,
  url: "https://github.com/Blockcast/paperclip/pull/2958",
};

/**
 * The key order a `github_pr_merged` gate comes back in after a jsonb round-trip:
 * shortest key first, ties broken bytewise. Pinned against a real Postgres in the
 * service suite — if that assertion ever fails, this constant is the thing to fix,
 * not the assertion.
 */
export const JSONB_GATE_KEY_ORDER = ["url", "kind", "prNumber", "repoFullName"];

/**
 * The same gate as a STORED card holds it: same data, jsonb key order. Deliberately
 * rebuilt key by key rather than spread, because object spread would preserve the
 * source's insertion order and hand back the shape-ordered literal unchanged —
 * which is the bug this fixture exists to stop a test from hiding.
 */
export function asStoredGate(gate: Record<string, unknown>): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  const keys = Object.keys(gate).sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
  for (const key of keys) stored[key] = gate[key];
  return stored;
}
