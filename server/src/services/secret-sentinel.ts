/**
 * The placeholder that stands in for a secret value that must not leave the server.
 *
 * This lives in its own leaf module rather than in `services/secrets.ts`, and that placement is
 * load-bearing rather than tidiness:
 *
 * - **Three rules match on this exact string** — the project env response mask and its write-merge
 *   (`routes/project-env-response.ts`, PEN-3033) and `normalizeEnvConfig`'s refusal to persist it
 *   (`services/secrets.ts`). A second, drifting copy would not fail loudly; it would silently stop
 *   the merge from matching and 422 every project env save. So there must be exactly one.
 * - **`services/secrets.ts` is mocked by 19 test files**, each with a factory returning only the
 *   handful of exports it needs. Sourcing the constant from there means every test that reaches a
 *   masking route through a mocked `secrets.js` fails with "No REDACTED_SENTINEL export is defined
 *   on the mock" — a failure about mock bookkeeping, not about behaviour. Keeping the single source
 *   of truth in a leaf nobody needs to mock gets both properties at once.
 */
export const REDACTED_SENTINEL = "***REDACTED***";
