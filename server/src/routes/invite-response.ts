import { isPlainObject, redactAgentConfigPayload } from "../redaction.js";

/**
 * PEN-3725 — disclosure boundary for invite / join-request adapter defaults on response bodies.
 *
 * `invites.defaultsPayload` and `joinRequests.agentDefaultsPayload` are both `jsonb` typed
 * `Record<string, unknown>` — free-form bags. By the onboarding manifest's own documented contract
 * (`routes/access.ts`, the `agentDefaultsPayload` guidance) they carry gateway adapter config:
 * `apiKey` for `hermes_gateway`, and `headers["x-openclaw-token"]` plus `devicePrivateKeyPem` for
 * `openclaw_gateway`. Every response that answered with the stored row spread those verbatim.
 *
 * Five properties drive the shape of this module:
 *
 * 1. **The mask is unconditional — deliberately NOT entitlement-gated.** This is the same call
 *    `project-env-response.ts` made for door #17, and for the same reason: nothing needs an adapter
 *    credential in a *response body*. Execution reads these payloads from the stored row
 *    (`grantsFromDefaults`, `resolveAdapterConfig`), never through a projection, so the value never
 *    leaves, for anyone. Hunting for an action that happens to exclude agents would have looked
 *    like a fix while disclosing to exactly the principals the ticket is about.
 *
 *    Reachability, which is why this is not a HIGH but is also not nothing: `users:invite` and
 *    `joins:approve` are outside the blanket same-company agent allow-list in
 *    `services/authorization.ts`, so an ordinary agent is refused. But both keys are in
 *    `PERMISSION_KEYS`, and `grantsFromDefaults` / `agentJoinGrantsFromDefaults` feed arbitrary
 *    permission keys into `setPrincipalGrants` on join approval — so one invite's own
 *    `defaultsPayload.agent.grants` can mint an agent that then reads every other invite's
 *    credential material in the company.
 *
 * 2. **A read mask alone is correct here — there is NO restore half, unlike PEN-3033.** That is a
 *    measured claim, not an assumption, and it is the one thing to re-check before extending this
 *    module. The project-env mask needed `restoreMaskedEnvBindings` because its editor re-emits the
 *    entire map on save, so masking the read alone would PATCH the placeholder back. These payloads
 *    have no such editor: `access.ts` registers no `PATCH`/`PUT`/`DELETE` on any invite or
 *    join-request route (its only `router.patch`/`router.put` handlers are the company-member and
 *    user-company-access routes), the revoke and approve handlers read nothing at all from
 *    `req.body`, and the UI client (`ui/src/api/access.ts`) exposes no update method —
 *    `revokeInvite` posts `{}`. The payload is supplied once, by the creator of the invite or by the
 *    joining agent, and is never read back and re-submitted. So a masked value can never reach a
 *    write path, and there is nothing to merge.
 *
 *    If a future change adds an invite editor, this comment is the one that goes stale: that change
 *    must ship a restore half, modelled on `restoreMaskedEnvBindings`, or it will silently persist
 *    the placeholder over a live credential.
 *
 * 3. **`redactAgentConfigPayload`, not the bare `sanitizeRecord`.** The difference is load-bearing
 *    rather than stylistic. `sanitizeRecord` decides what to mask from the key's *name*, which is
 *    the wrong test for a payload that is adapter config by construction: under `agentConfig`, every
 *    value of a `headers` map that is not an explicitly benign header name is masked, so a gateway
 *    token carried under a renamed header is still caught, and every `{type:"plain",value}` binding
 *    is masked whatever its key is called. Name-based redaction alone would cover
 *    `headers["x-openclaw-token"]` today only because that particular name contains `token`.
 *
 * 4. **One walk, shared with `plugin-host-services.ts`.** That module had already derived half of
 *    this independently (`redactInvite`, stripping `tokenHash` and sanitizing `defaultsPayload`)
 *    while the six `access.ts` exits had none. This class of disclosure propagates by copying — the
 *    same reasoning `withholdAgentConfigKeys` records — so both callers share this implementation
 *    and a finding against it lands on every exit at once.
 *
 * 5. **Containment, not a bare sanitize call.** `redactAgentConfigPayload` sanitizes only
 *    `isPlainObject` values and returns anything else *by reference* — a documented property that
 *    `redaction.ts` itself warns about, and that `containAgentConfig` in `routes/agents.ts` exists
 *    to absorb. Both halves below admit on key *presence*, which is weaker than any object test, so
 *    an array- or string-shaped `jsonb` column would have been spread back out verbatim. The repair
 *    is containment at this caller (`containDefaultsPayload`), deliberately NOT a change to the
 *    shared sanitizer: four doc comments across `redaction.ts` and `routes/agents.ts` rest on that
 *    passthrough, its declared return type is `Record<string, unknown> | null`, and its sibling
 *    `redactEventPayload` behaves the same way — so masking inside it would make the type a lie and
 *    silently invert an invariant two other modules gate on.
 */

/**
 * The admission gate for a `jsonb` defaults column on its way out.
 *
 * Mirrors `containAgentConfig` (`routes/agents.ts`) rather than re-deriving the reasoning:
 *
 *   `null` / absent — passed through unchanged. These are the ordinary "no defaults" states and
 *                     the callers' shape contract depends on them surviving.
 *   `{}`            — object-like but not sanitizable (array, foreign prototype), or a bare
 *                     primitive. Withheld rather than emitted uncontained: `sanitizeValue` can walk
 *                     an array element-wise, but `redactAgentConfigPayload`'s signature cannot
 *                     return one, and a primitive here is a malformed row rather than a payload.
 *   otherwise       — the sanitized record.
 *
 * Not reachable from today's writers — both invite write paths normalize through
 * `{ ...defaultsPayload }`, which collapses an array into a plain object, and the column's
 * validator is `z.record(z.string(), z.unknown())`. This is defence in depth against a future
 * writer, and against rows already at rest that predate those normalizations.
 */
function containDefaultsPayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return redactAgentConfigPayload(payload);
  if (!isPlainObject(payload)) return {};
  return redactAgentConfigPayload(payload);
}

/**
 * `tokenHash` is stripped rather than masked. It is the verifier for the invite's bearer token, it
 * has no display or diagnostic use, and on the two create paths the caller is already handed the
 * plaintext `token` in the same body — so there is nothing it could tell a legitimate caller that
 * the response does not already say out loud.
 */
export function redactInviteRecord<T extends object>(invite: T): Omit<T, "tokenHash"> {
  if (!invite || typeof invite !== "object") return invite as Omit<T, "tokenHash">;
  const { tokenHash: _tokenHash, ...rest } = invite as T & {
    tokenHash?: unknown;
    defaultsPayload?: unknown;
  };
  if (!("defaultsPayload" in rest)) return rest as Omit<T, "tokenHash">;
  return {
    ...rest,
    defaultsPayload: containDefaultsPayload(rest.defaultsPayload),
  } as Omit<T, "tokenHash">;
}

/**
 * Join-request half. `claimSecretHash` was already stripped by the caller this replaces; it stays
 * stripped here so the two concerns live in one place rather than one being re-derived at each exit.
 */
export function redactJoinRequestRecord<T extends object>(row: T): Omit<T, "claimSecretHash"> {
  if (!row || typeof row !== "object") return row as Omit<T, "claimSecretHash">;
  const { claimSecretHash: _claimSecretHash, ...rest } = row as T & {
    claimSecretHash?: unknown;
    agentDefaultsPayload?: unknown;
  };
  if (!("agentDefaultsPayload" in rest)) return rest as Omit<T, "claimSecretHash">;
  return {
    ...rest,
    agentDefaultsPayload: containDefaultsPayload(rest.agentDefaultsPayload),
  } as Omit<T, "claimSecretHash">;
}
