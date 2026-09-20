/**
 * The placeholder that stands in for a secret value that must not leave the server.
 *
 * This lives in `shared` rather than in `server/src/services/`, and the placement is load-bearing
 * rather than tidiness:
 *
 * - **Four rules match on this exact string** — the project env response mask and its write-merge
 *   (`server/src/routes/project-env-response.ts`, PEN-3033), `normalizeEnvConfig`'s refusal to
 *   persist it and the company-secret create refusal (`server/src/services/secrets.ts`), and the
 *   editor's masked-row detection (`ui/src/components/environment-variables-editor/model.ts`). A
 *   second, drifting copy would not fail loudly; it would silently stop the merge from matching and
 *   422 every project env save. So there must be exactly one.
 * - **The UI needs it too, and that is why `shared` rather than `server`.** PEN-3033's mask reaches
 *   the environment-variables editor, which must be able to tell "the server withheld this" from
 *   "the user typed this" — without that distinction the convert-to-secret flows store the
 *   placeholder as if it were the value, destroying the binding they were asked to protect. A
 *   server-only constant forced the client to either re-declare the string or infer masking some
 *   other way; both are the drift this module exists to prevent. `sensitive-env.ts` is the same
 *   shape for the same reason, and `ui/.../environment-variables-editor/sensitive.ts` re-exports it.
 * - **`server/src/services/secrets.ts` is mocked by 19 test files**, each with a factory returning
 *   only the handful of exports it needs. Sourcing the constant from there means every test that
 *   reaches a masking route through a mocked `secrets.js` fails with "No REDACTED_SENTINEL export is
 *   defined on the mock" — a failure about mock bookkeeping, not about behaviour. Keeping the single
 *   source of truth in a leaf nobody needs to mock gets every property at once.
 */
export const REDACTED_SENTINEL = "***REDACTED***";
