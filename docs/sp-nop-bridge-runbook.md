# `sp_nop_bridge` operator runbook

> **Ticket:** [BLO-5400](https://paperclip/BLO/issues/BLO-5400) (parent
> [BLO-5298](https://paperclip/BLO/issues/BLO-5298), BEACON Phase 4).
>
> **Status:** Wave 1 manual bootstrap. Long-term path is the
> certifier-validator (BLO-5389); this runbook covers the one-time
> operator-provisioned step that decouples Phase 4 launch from the
> validator's internal completion.

## What this row is

`sp_nop_bridge` (canonical kind: `nop_bridge`; the `sp_` prefix is the
UUID namespace, not part of the kind) is a singleton row in the orc8r
`system_principals` table that represents NOP itself as a
**platform-side, non-tenant principal**. Its `sp_uuid` is the caller
identity NOP presents (via mTLS) to the orc8r `tenants_beacon` service
when minting `individual_beacon` members under the public umbrella
(`st_public`).

### BLO-5410 shipped status

This is the one statement of BLO-5410's status; every other section defers
to it. BLO-5410 is closed, and what shipped is the idempotent `MintMember`
RPC in magma `orc8r/cloud/go/services/tenants_beacon/servicers/protected/servicer.go`.
`MintGateway` is unimplemented. The shipped servicer does not read
`system_principals` or `revocation_blocklist`, so nothing on the
`MintMember` path checks this row, its `disabled_at`, or a blocklist entry.
(accessd's ACL projection reads `disabled_at` and `revocation_blocklist`, but
only for `per_tenant` principals; `sp_nop_bridge` is `global`.) Checked
against magma `main` at `a68ad7e`, 2026-10-01.

Consequences:

- The row is still required: the certifier rejects a SystemPrincipal CSR
  whose `sp_uuid` has no row, so NOP cannot obtain its bridge cert without it.
- Neither the soft-disable nor the blocklist INSERT below stops `MintMember`
  today.
- Wave 1 has no mechanism that invalidates an already-issued bridge cert
  before its `notAfter`. The orc8r code at `a68ad7e` has no CRL or OCSP check
  for client certs. The certifier's `RevokeCertificate` only deletes the
  serial from the certifier store, and that store's reader on this path, the
  shared orc8r identity interceptor
  (`orc8r/cloud/go/service/middleware/unary/identity_decorator.go`), resolves
  gateway identities only, so it is not a takedown for `sp_nop_bridge`.
  Reissuing the bridge cert does not stop a holder of the old key. Planned
  maintenance is therefore cooperative (see "Disabling") and incident
  containment is at the network layer (see "Revocation").

This runbook specifies the NOP-side E2 completeness delta rather than
restating the servicer implementation.

## E2 completeness delta

This is the contract for the NOP registration flow after BLO-5410. BLO-5410
owns mTLS caller verification and the orc8r-side idempotent RPC. NOP owns
local ordering, tenant selection, retry state, and reconciliation.

### MintMember identity and idempotency

NOP MUST derive the logical idempotency key from `(gateway_hwid, wallet)`,
using the canonical normalized form already used by the registration store.
The key MUST be stable across retries and MUST NOT include request time, a
random UUID, access token, or mutable display data. Persist it with the
registration attempt and send the same logical identity on every retry. A
repeated successful call returns the original `mb_uuid`; it MUST NOT create
another `individual_beacon` row.

The orc8r identity is fixed by the bridge contract: `st_uuid` is the seeded
`st_public` tenant identity, `subject_kind` is `individual_beacon`, and the
issuer is `nop.blockcast.net`. NOP must not accept issuer or subject from an
untrusted client or manufacture a second identity when a retry times out.

A `gateway_hwid` already bound to a live `individual_beacon` member MUST NOT be
minted under a second `wallet`. Because the idempotency key is
`(gateway_hwid, wallet)`, a wallet change is a *different* key, so the key alone
cannot catch this: NOP MUST check the hardware binding, not only the key, before
calling `MintMember`. A mismatch is a non-retryable identity error — the intent
transitions to `registration_failed` per "Local-first ordering and pending
state", recording the existing `mb_uuid` and the conflicting wallet in
`last_error`. NOP MUST NOT retry and MUST NOT mint.

Rebinding a gateway to a new wallet is a legitimate lifecycle event — hardware is
sold, re-keyed, or the owner moves — but it is not a side effect of registration,
for the same reason organization attachment is not (see "Explicit tenant-target
rule"): registration is driven by an untrusted client, so an implicit rebind lets
any wallet claim hardware already in service and redirect its earnings. Rebind
requires an authorized transfer operation that evidences the change and retires
the prior `mb_uuid` explicitly; until that operation exists it is an operator
action, not a registration outcome. Rejecting here does not strand sold hardware
— it routes it to that path instead of silently creating a second live member.

### Explicit tenant-target rule

The minted member is written under the orc8r `st_public` umbrella. It is not
written into a synthesized Privy tenant and it is not written into an
organization tenant selected by the browser, wallet, gateway payload, or
requester. `st_public` is an orc8r identity/compatibility sentinel, not a v2
NOP `tenants.id`, and MUST NOT be sent as `X-Tenant-Id` to NOP tenant APIs.

The authorization for this target is the authenticated `sp_nop_bridge`
principal and the `tenants_beacon` service policy: it may mint only the
`individual_beacon` member shape under `st_public`. A response with any
other `st_uuid`, tenant kind, or subject kind is a protocol error. NOP MUST
mark that attempt failed/quarantined and MUST NOT attach it to an org.
Organization onboarding and membership attachment require the separate
ASN-verified org-tenant flow and explicit membership/terms authorization;
they are not side effects of gateway registration.

### Local-first ordering and pending state

Registration MUST use this order:

1. In one local transaction, upsert the registration intent and its
   `(gateway_hwid, wallet)` idempotency key. The row starts in explicit
   `pending_orc8r` state; no local success state is written yet.
2. Call `MintMember` with the same derived identity and bridge mTLS
   credential.
3. In a second local transaction, validate the returned `mb_uuid`, bind it
   to the existing intent, and transition to `registered`.

If orc8r is unavailable, times out, or returns a retryable error, retain the
intent as `pending_orc8r` with `last_error`, `next_retry_at`, and an attempt
counter. Return a pending response. Never report success, create an unbound
local member, or silently discard the intent. Non-retryable identity,
tenant-target, or authorization errors transition to `registration_failed`
and require operator-visible remediation.

### Reconciliation sweep

Run a bounded, repeatable sweep at least once per deployment and on an
operator-triggered repair:

- Find due `pending_orc8r` intents and retry the exact same idempotency tuple.
- Find local `individual_beacon` rows without a valid `mb_uuid`/gateway
  binding and either complete them through `MintMember` or quarantine them;
  never guess a tenant.
- Group orc8r members by `(st_uuid, normalized gateway_hwid, wallet)` and
  surface duplicates. Keep the earliest authoritative `mb_uuid`, quarantine
  later rows, and require explicit repair before deletion or reassignment.
- Group orc8r members by `(st_uuid, normalized gateway_hwid)` alone and surface
  any hardware carrying more than one live member. This grouping is deliberately
  coarser than the idempotency key: the key includes `wallet`, so a
  same-hardware / different-wallet pair falls into two groups and the bullet
  above cannot see it. Treat the pair as a duplicate — keep the earliest
  authoritative `mb_uuid`, quarantine the later row, and require explicit repair
  before deletion or reassignment. Count it separately from a same-wallet
  duplicate: it means the rebind rejection in "MintMember identity and
  idempotency" did not hold.
- Emit counts for pending, orphaned, duplicate, repaired, and quarantined
  rows. Query failure is an unhealthy sweep, not a clean zero-count result.

The sweep must be safe to run concurrently with registration. It must use
the same unique constraint/idempotency path as the live call and must never
delete based only on a stale read.

### E2 verifying signal

The completeness suite MUST prove that concurrent retries with the same
`(gateway_hwid, wallet)` yield one member; a timeout leaves `pending_orc8r`;
a later retry converges to `registered`; a result under a non-`st_public`
tenant is rejected; a second registration of an already-bound `gateway_hwid`
under a different `wallet` is rejected as non-retryable, leaves the intent
`registration_failed`, and mints no second member; the `gateway_hwid`-only sweep
grouping surfaces such a pair when one is seeded directly; and the sweep reports
and quarantines an orphan/duplicate without silently reassigning it. Manual
verification must inspect persisted registration state and orchestrator logs for
the idempotency key.

### Dependency boundary

BLO-5410 owns the caller-verification plus MintMember/MintGateway servicer
contract; its shipped status is stated once, under "BLO-5410 shipped status"
above. BLO-5389 remains the cert/discovery/rotation track; this document does
not move those controls into registration. The gaps in the shipped BLO-5410
artifact listed there are a blocker to claiming E2 complete, not a reason for
NOP to add a second caller-verification implementation.

## Prerequisites

- Magma migration **`2026051500000001_typed_uuid_schema`** has run
  (creates the `system_principals` and `revocation_blocklist` tables +
  `sp_uuid_t` DOMAIN + `nop_bridge` kind in the CHECK enum). PR
  [magma#847](https://github.com/Blockcast/magma/pull/847).
- Magma migration **`2026051600000001_seed_st_public_tenant`** has run
  (creates the singleton `st_public` row in `tenant_identity`). This is
  S4 of BLO-5298 (this same parent ticket).
- You have `psql` access to the orc8r postgres pool with write
  permissions on `system_principals` and `revocation_blocklist` (the
  Revocation section writes the latter).

## One-time INSERT

Run **once per environment** (staging, canary, production). The
`sp_uuid` value below is the canonical caller-identity literal and MUST
be used unchanged by NOP code, certificate SANs, and every lifecycle
operation in this runbook. Do not substitute a per-environment UUID
unless every reference in this runbook and the deployed NOP configuration
is changed together.

### Suggested well-known value (acceptable for all environments)

```sql
INSERT INTO system_principals (
    sp_uuid,
    kind,
    scope,
    scope_target,
    display_name,
    approval_required
) VALUES (
    'sp_00000000-0000-4000-8000-000000000002',
    'nop_bridge',
    'global',
    NULL,
    'NOP bridge for BEACON',
    false
)
ON CONFLICT (sp_uuid) DO NOTHING;
```

The conflict clause only makes a matching seed retryable; it does not
prove that an existing row is the NOP bridge. Run this assertion in the
same database session immediately afterward. It raises an error and
aborts the bootstrap if the existing row has any different required
field, rather than allowing a colliding principal to look successfully
seeded:

```sql
DO $$
DECLARE
    actual_kind system_principals.kind%TYPE;
    actual_scope system_principals.scope%TYPE;
    actual_scope_target system_principals.scope_target%TYPE;
    actual_display_name system_principals.display_name%TYPE;
    actual_approval_required system_principals.approval_required%TYPE;
BEGIN
    SELECT kind, scope, scope_target, display_name, approval_required
      INTO STRICT actual_kind, actual_scope, actual_scope_target,
                actual_display_name, actual_approval_required
      FROM system_principals
     WHERE sp_uuid = 'sp_00000000-0000-4000-8000-000000000002';

    IF actual_kind IS DISTINCT FROM 'nop_bridge'
       OR actual_scope IS DISTINCT FROM 'global'
       OR actual_scope_target IS NOT NULL
       OR actual_approval_required IS DISTINCT FROM false THEN
        RAISE EXCEPTION
          'sp_uuid exists but is not the expected NOP bridge principal: kind=%, scope=%, scope_target=%, approval_required=%',
          actual_kind, actual_scope, actual_scope_target, actual_approval_required;
    END IF;

    -- display_name is a cosmetic label (editable from the Portal), not an
    -- identity attribute, so a rename is reported but does not abort.
    IF actual_display_name IS DISTINCT FROM 'NOP bridge for BEACON' THEN
        RAISE WARNING 'NOP bridge principal display_name is %, not the seeded label',
          actual_display_name;
    END IF;
END $$;
```

### Field rationale

| Field | Value | Why |
|---|---|---|
| `sp_uuid` | `sp_00000000-0000-4000-8000-000000000002` | Stable across environments. `...001` is reserved for the first `platform_admin` singleton if/when we mint one (the `sp_` and `st_` namespaces number independently — there's no symmetry-with-st_public constraint). Format is enforced by the `sp_uuid_t` DOMAIN. |
| `kind` | `nop_bridge` | Pinned in `system_principals.kind` CHECK enum by magma#847; mints alongside `platform_admin`, `sre`, `migration_job`, `extcdn_coordinator`, `break_glass`. |
| `scope` | `global` | `global` means the principal is not tenant-scoped. The caller policy then narrows it to the single seeded `st_public` identity, where it may mint only the `individual_beacon` member shape (see "Explicit tenant-target rule"). |
| `scope_target` | `NULL` | Required by the `system_principals_scope_target_shape` CHECK when `scope = 'global'`. |
| `display_name` | `NOP bridge for BEACON` | Human-readable label for audit logs / Portal. |
| `approval_required` | `false` | NOP-bridge cert issuance is one-time at NOP go-live; ongoing rotations don't require human approval. (Contrast: `break_glass` requires per-issuance approval; gated by the certifier-validator once BLO-5389 lands.) |

The `INSERT` plus assertion is idempotent and safe to re-run during a
re-deploy or after a partial failure, while failing closed on a conflicting
row with the wrong principal attributes (`kind`, `scope`, `scope_target`,
`approval_required`); the exception names the values it found. A renamed
`display_name` only raises a `WARNING`.

## Cert issuance

After the row exists, issue NOP's outbound mTLS cert via the existing
certifier path:

1. Use the standard mTLS-issuance flow (whichever scripted path your
   environment already uses for `extcdn_coordinator` or similar
   system-principal certs).
2. The cert MUST carry the `sp_uuid` above in a **SPIFFE URI SAN** of
   the form `spiffe://orc8r/system_principal/sp_00000000-0000-4000-8000-000000000002`
   so that `tenants_beacon`'s mTLS caller verify can resolve the cert
   back to the `system_principals` row. The exact SAN form is pinned
   by the Phase 0 cert-SAN spec — see
   [BLO-5368](https://paperclip/BLO/issues/BLO-5368) /
   [BLO-5369](https://paperclip/BLO/issues/BLO-5369). Putting the UUID
   in CN only will not work — the verifier reads the SAN.
3. **Manual approval** is required for this first issuance. The
   long-term automated path (per-issuance validator gating) lands in
   BLO-5389; until then, the operator runs the issuance with explicit
   approval in the same shell session.
4. Drop the resulting cert + private key into NOP's secret store at the
   path expected by the BLO-5413 outbound mTLS client (see
   BLO-5413 ticket for the env var / path contract).

## Rotation

Until BLO-5389 lands:

- Rotate the cert on the same approve-once cadence as other operator
  certs (typically 90 days; follow your environment's existing
  rotation playbook).
- The `system_principals` row stays put across rotations — only the
  cert behind it rotates.

After BLO-5389 lands:

- Rotation moves into the certifier-validator's gated path; this
  runbook gets superseded by the validator's contract.

## Disabling (planned maintenance)

> **Wave 1 caveat:** Nothing on the `MintMember` path reads `disabled_at`
> today (see "BLO-5410 shipped status"). Setting it does NOT pause
> onboarding: NOP keeps minting `individual_beacon` members. Until a
> `tenants_beacon` caller check reads this column, take NOP down for a
> maintenance window as follows. The private key may exist nowhere else, so
> **before removing anything, confirm NOP's secret store keeps the prior
> version** of the cert and key (the default path: no second copy of the key
> is made). Only if it does not, copy them to a secure location instead.
> Then remove them from NOP's secret store (the secret-store path identified
> in Cert issuance step 4, per BLO-5413) and restart NOP so its outbound mTLS
> client stops presenting them. This is cooperative: it stops a well-behaved
> NOP, not a holder of a copy of the key, which is acceptable for planned
> maintenance. To bring NOP back, restore the prior version (or the saved
> copy) and restart NOP. If you made a copy, **securely destroy it** once NOP
> is back: Wave 1 cannot invalidate an issued cert before its `notAfter` (see
> "Rotation"), so a stray copy stays a working credential until then. If the
> material is lost, the only other path is a fresh cert per the Cert issuance
> section, which needs **manual approval** (step 3) until BLO-5389 lands, so
> it is not a quick restore. Treat the rest of this section as
> "after-enforcement" guidance.

For graceful, reversible takedowns (planned maintenance, paused
onboarding window), prefer a soft-disable over revocation:

```sql
UPDATE system_principals
   SET disabled_at = now()
 WHERE sp_uuid = 'sp_00000000-0000-4000-8000-000000000002';
```

Once a `tenants_beacon` caller check reads `disabled_at` (the shipped
BLO-5410 servicer does not), it will refuse calls from any principal whose
`disabled_at IS NOT NULL`. To re-enable, set `disabled_at = NULL`. No cert
reissue needed.

## Revocation

> **Wave 1 caveat:** The fast-revocation propagation path described
> below depends on (a) a `tenants_beacon` caller check that reads
> `revocation_blocklist`, which the shipped
> [BLO-5410](https://paperclip/BLO/issues/BLO-5410) `MintMember` servicer
> does not have (see "BLO-5410 shipped status"), and (b) a Redis-backed
> reseed reader. [BLO-5412](https://paperclip/BLO/issues/BLO-5412) closed as
> a JWKS JWT verifier with TTL-only replay protection and no Redis store, so
> no reseed reader exists either. Until both land, a `revocation_blocklist`
> INSERT will NOT stop calls, and reissuing the bridge cert will NOT stop a
> holder of the old key either: Wave 1 cannot invalidate an issued cert
> before its `notAfter` (see "BLO-5410 shipped status"). **To contain NOP
> during an incident, cut its network path to orc8r**: stop NOP's outbound
> traffic to the orc8r endpoint, or block NOP's source at the orc8r edge.
> Then escalate to the orc8r platform owner (the BLO-5410 / BLO-5412 track).
> Treat the rest of this section as "after-enforcement" guidance.

To revoke NOP's bridge identity (e.g. during an incident):

1. (After enforcement lands.) Add a row to `revocation_blocklist`:

```sql
INSERT INTO revocation_blocklist (
    principal_uuid,
    reason,
    revoked_by_mb_uuid
) VALUES (
    'sp_00000000-0000-4000-8000-000000000002',
    'reason text here',
    NULL  -- or the mb_uuid of the operator triggering revocation
);
```

2. (After enforcement lands.) The fast-revocation channel (Redis-backed,
   reseeded from this table) will propagate within seconds;
   `tenants_beacon` mTLS caller verify will reject the cert on the
   next call.

3. To re-enable NOP, delete only its `revocation_blocklist` row:

```sql
DELETE FROM revocation_blocklist
 WHERE principal_uuid = 'sp_00000000-0000-4000-8000-000000000002';
```

   If the cert was rotated as part of the revocation, re-issue the new
   cert per the Cert issuance section.

## Verification

After running the INSERT, confirm:

```sql
SELECT sp_uuid, kind, scope, scope_target, display_name, approval_required,
       disabled_at
  FROM system_principals
 WHERE sp_uuid = 'sp_00000000-0000-4000-8000-000000000002';
```

Expected: exactly one row with `kind = 'nop_bridge'`, `scope = 'global'`,
`scope_target IS NULL`, and `approval_required = false`. These are the same
four attributes the assertion fails closed on. If the row is missing, or any
of the four differs, the bootstrap failed: do not issue or use a certificate
for that UUID.

Two other columns are things to reconcile, not failures:

- `display_name`: expected `'NOP bridge for BEACON'`. A different value is
  label drift, for example a rename in the Portal. The assertion only raises
  a `WARNING` for it. Reconcile the label; the certificate is still fine to
  issue.
- `disabled_at`: expected `NULL`. A non-NULL value means the principal was
  soft-disabled (see "Disabling (planned maintenance)") and was not re-enabled. Nothing reads it
  today, but once enforcement lands every call from this UUID will be
  refused. Set `disabled_at = NULL` if the principal should be live.

## Troubleshooting

The 2-3 failure modes you're most likely to hit:

- **`relation "system_principals" does not exist` (or DOMAIN error on
  INSERT).** The prereq migration `2026051500000001_typed_uuid_schema`
  hasn't run on this orc8r DB yet. Apply magma migrations first, then
  re-run the INSERT.

- **First `MintMember` call from NOP still fails after the row is
  seeded.** Two common causes:
  1. The cert's SPIFFE URI SAN doesn't match the expected form (see
     [BLO-5368](https://paperclip/BLO/issues/BLO-5368) /
     [BLO-5369](https://paperclip/BLO/issues/BLO-5369)). Re-issue with
     the SAN pinned to
     `spiffe://orc8r/system_principal/sp_00000000-0000-4000-8000-000000000002`.
  2. NOP's outbound mTLS client is pointing at the wrong CA bundle
     (verify the path/env var pinned by BLO-5413).

- **`MintMember` succeeds in dev but refuses in staging/prod.** Once
  `disabled_at` is enforced (it is not in the shipped BLO-5410 servicer;
  see "BLO-5410 shipped status"), check whether `disabled_at IS NOT NULL`
  on the singleton row, perhaps left over from a planned-maintenance
  window. Set `disabled_at = NULL` to re-enable. Today a refusal cannot come
  from `disabled_at`; check the cert SAN and CA bundle above instead.

## Related

- Parent: [BLO-5298](https://paperclip/BLO/issues/BLO-5298) — BEACON
  Phase 4 ordering doc.
- This ticket: [BLO-5400](https://paperclip/BLO/issues/BLO-5400) —
  seed migration + this runbook.
- Downstream: [BLO-5410](https://paperclip/BLO/issues/BLO-5410):
  `MintMember` servicer (does not yet read this row; see "BLO-5410 shipped
  status");
  [BLO-5413](https://paperclip/BLO/issues/BLO-5413) — NOP outbound
  mTLS client that presents the cert.
- Long-term automation:
  [BLO-5389](https://paperclip/BLO/issues/BLO-5389) — certifier
  validator (replaces the manual-approval step above).
