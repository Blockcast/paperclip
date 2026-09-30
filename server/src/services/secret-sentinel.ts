/**
 * Re-export of the single `REDACTED_SENTINEL` definition, which lives in
 * `@paperclipai/shared` because the environment-variables editor needs it too — see that module's
 * header for why there must be exactly one copy.
 *
 * This file stays as a leaf re-export rather than being deleted in favour of importing `shared`
 * directly at each site, for one reason worth keeping: **`services/secrets.ts` is mocked by 19 test
 * files**, each with a factory returning only the exports it needs. Sourcing the constant from
 * `secrets.js` would make every test that reaches a masking route through a mocked `secrets.js`
 * fail with "No REDACTED_SENTINEL export is defined on the mock" — a failure about mock
 * bookkeeping, not about behaviour. Importing it from a leaf nobody mocks avoids that.
 */
export { REDACTED_SENTINEL } from "@paperclipai/shared";
