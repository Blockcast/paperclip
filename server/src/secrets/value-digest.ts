/**
 * Does a stored secret version's `value_sha256` actually digest the secret VALUE?
 *
 * The column is overloaded, and that overload is the whole reason this module
 * exists. Providers that hold the plaintext at write time store `sha256(value)`
 * there. Providers that merely POINT at a secret living somewhere else store a
 * metadata fingerprint under the same column name — for AWS,
 * `sha256("aws_secrets_manager_v1:<external-ref>:<provider-version>")`
 * (`aws-secrets-manager-provider.ts` → `createExternalReferenceMaterial`), and
 * for the external stubs `externalFingerprint(externalRef, providerVersionRef)`
 * (`external-stub-providers.ts` → `prepareExternalReference`). Neither
 * fingerprint is derived from the secret value at all: the value was never
 * available to compute one.
 *
 * Comparing a presented credential against a fingerprint is not a weaker check,
 * it is a WRONG one — it can never match, so it rejects every genuine
 * credential while looking like an ordinary auth failure (BLO-20738).
 *
 * This is deliberately an ALLOWLIST, not a denylist. An unrecognized scheme —
 * a provider added later, or a version written by an older build — returns
 * `false`, so the caller reports "no value verifier available" instead of
 * silently failing every production verification. The failure mode of guessing
 * wrong in the permissive direction is a total, silent auth outage; in the
 * conservative direction it is an explicit, diagnosable error.
 */

/** Material written by `local-encrypted-provider.ts` (always plaintext-at-write). */
const LOCAL_ENCRYPTED_SCHEME = "local_encrypted_v1";
/** Material written by `aws-secrets-manager-provider.ts` (managed OR imported). */
const AWS_SECRETS_MANAGER_SCHEME = "aws_secrets_manager_v1";

export function versionMaterialHasValueDigest(material: unknown): boolean {
  if (!material || typeof material !== "object" || Array.isArray(material)) return false;
  const record = material as Record<string, unknown>;

  switch (record.scheme) {
    // Local encryption only ever stores versions it encrypted itself, so the
    // value is always in hand when the digest is computed.
    case LOCAL_ENCRYPTED_SCHEME:
      return true;
    // AWS holds the value only for versions Paperclip itself wrote
    // (`createSecret` / `createVersion`, both `source: "managed"`). An imported
    // `source: "external_reference"` version never saw the value.
    case AWS_SECRETS_MANAGER_SCHEME:
      return record.source === "managed";
    default:
      return false;
  }
}
