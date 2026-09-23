import { describe, expect, it } from "vitest";
import { versionMaterialHasValueDigest } from "../secrets/value-digest.js";

/**
 * These cases mirror the material each provider actually writes. Keep them in
 * sync with the providers rather than with the implementation: the whole
 * purpose of the helper is to encode which providers hold the plaintext at
 * write time, and a test written against the implementation would happily
 * ratify a wrong answer (BLO-20738).
 */
describe("versionMaterialHasValueDigest", () => {
  it("accepts local-encrypted material, which always digests the value", () => {
    // `local-encrypted-provider.ts` → `prepareManagedVersion`: the provider
    // encrypts the value itself, so `valueSha256 = sha256(value)` always.
    expect(versionMaterialHasValueDigest({
      scheme: "local_encrypted_v1",
      ciphertext: "…",
      iv: "…",
    })).toBe(true);
  });

  it("accepts AWS material Paperclip wrote itself", () => {
    // `aws-secrets-manager-provider.ts` → `createSecret`/`createVersion` both
    // compute `sha256Hex(input.value)` and tag the material `managed`.
    expect(versionMaterialHasValueDigest({
      scheme: "aws_secrets_manager_v1",
      secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/x-AbCdEf",
      versionId: "11111111-2222-3333-4444-555555555555",
      source: "managed",
    })).toBe(true);
  });

  it("rejects imported AWS references, whose digest fingerprints the pointer", () => {
    // `createExternalReferenceMaterial` stores
    // `sha256("aws_secrets_manager_v1:<ref>:<version>")`. The value was never
    // available, so no value digest exists to compare against.
    expect(versionMaterialHasValueDigest({
      scheme: "aws_secrets_manager_v1",
      secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:imported-AbCdEf",
      versionId: null,
      source: "external_reference",
    })).toBe(false);
  });

  it("rejects external stub-provider references", () => {
    // `external-stub-providers.ts` → `prepareExternalReference`.
    expect(versionMaterialHasValueDigest({
      scheme: "external_reference_v1",
      provider: "vault",
      externalRef: "kv/data/webhook",
      providerVersionRef: null,
    })).toBe(false);
  });

  it("fails closed on an unrecognized or missing scheme", () => {
    // The allowlist posture: guessing "this one digests the value" for an
    // unknown provider rejects every genuine credential for it, silently.
    expect(versionMaterialHasValueDigest({ scheme: "some_future_provider_v1" })).toBe(false);
    expect(versionMaterialHasValueDigest({ source: "managed" })).toBe(false);
    expect(versionMaterialHasValueDigest({})).toBe(false);
  });

  it("fails closed on non-object material", () => {
    // `material` is `jsonb`, so a legacy or corrupted row can hold anything.
    expect(versionMaterialHasValueDigest(null)).toBe(false);
    expect(versionMaterialHasValueDigest(undefined)).toBe(false);
    expect(versionMaterialHasValueDigest("local_encrypted_v1")).toBe(false);
    expect(versionMaterialHasValueDigest(["local_encrypted_v1"])).toBe(false);
  });

  it("does not accept AWS material whose source is absent or unexpected", () => {
    // An AWS row that predates the `source` tag cannot be classified, and
    // guessing `managed` would break exactly the imported case this fixes.
    expect(versionMaterialHasValueDigest({
      scheme: "aws_secrets_manager_v1",
      secretId: "arn:…",
    })).toBe(false);
    expect(versionMaterialHasValueDigest({
      scheme: "aws_secrets_manager_v1",
      source: "something_else",
    })).toBe(false);
  });
});
