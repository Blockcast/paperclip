import {
  REDACTED_EVENT_VALUE,
  isPlainObject,
  maskWorkspaceRuntimeForRead,
  maskWorkspaceStrategyShellTextForRead,
  redactAgentConfigPayload,
  redactApprovalPayloadForDisplay,
  WITHHELD_AGENT_CONFIG_KEYS,
  withholdAgentConfigFromApprovalPayload,
} from "./redaction.js";
import { assignRecordKey, ownRecordValue } from "./record-keys.js";

/**
 * Containment helpers for anything that serializes an agent row.
 *
 * These live in a leaf module rather than inside the `agentRoutes` factory
 * because none of them touch factory state — they are pure functions of their
 * argument — and keeping them closure-private meant any surface outside
 * `routes/agents.ts` that embedded an agent row had no way to reach them.
 * `PATCH /agents/:agentId/budgets` in `routes/costs.ts` is the standing example:
 * it returns the full row and was accepted as board-gated *because* the fix
 * needed this extraction (PEN-3707 §5 / PEN-3726).
 */

// Sentinel substituted into adapter_config.env values by redactAgentSecrets()
// on the GET response. A naive UI/operator round-trip (read agent, edit, save)
// posts the sentinel back as the literal env value; without a guard it lands
// in the DB and breaks runs (BLO-5xxx: PATH=*** in opencode_k8s pods made
// runc fail to find sh and every Staff Engineer run died as StartError).
// Keep this in lockstep with the redactor.
export const REDACTED_ENV_SENTINEL = "***";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The one admission gate for anything agent-config-shaped on its way out.
 *
 * `redactAgentConfigPayload` — and `sanitizeValue` beneath it — sanitize only
 * `isPlainObject` values and return anything else *by reference*. A caller
 * that admits on a weaker "is it an object" test, or hands the value straight
 * in with no gate, therefore has a fail-open the redactor cannot see: it gets
 * the raw value back and serializes it.
 *
 * The obvious repair — swap the caller's predicate to `isPlainObject` — does
 * not work where the assignment sits inside the gate, as in
 * `redactAgentSecrets`: a failing gate just leaves the raw value on the
 * `{ ...agent }` spread, so the same bytes reach the wire by a different
 * route. Containment has to be *written back*, which is why this returns a
 * value rather than answering a question.
 *
 *   `undefined` — not object-like (`null`, `undefined`, a primitive). No
 *                 config to contain; each caller keeps its own absence
 *                 contract for these.
 *   `{}`        — an object this file cannot sanitize (array or foreign
 *                 prototype). Withheld rather than emitted uncontained.
 *   otherwise   — the redacted record.
 */
export function containAgentConfig(
  value: unknown,
  viewer: AgentWorkspaceCommandViewer = WITHHELD_AGENT_WORKSPACE_COMMAND_VIEWER,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!isPlainObject(value)) return {};
  const contained = redactAgentConfigPayload(value) ?? {};
  return maskAgentWorkspaceStrategyCommands(contained, viewer) as Record<string, unknown>;
}

/**
 * PEN-5225 — the entitlement for host-executed workspace command strings inside an agent config.
 *
 * Structurally `WorkspaceRuntimeViewer` (`routes/workspace-response.ts`), and callers pass that
 * value straight through. It is restated rather than imported because this module is a deliberate
 * leaf that imports only `./redaction.js` (PEN-3757): `services/agents.ts` depends on it, and a
 * service importing from the route layer inverts the layering and closes an import cycle. A
 * structural type costs nothing at the call site and keeps that property.
 *
 * `revealRuntimeConfig` is `workspace_runtime:read` and nothing else. Resolve it with
 * `resolveWorkspaceRuntimeViewer`; never re-derive it from a role or a permission key, which is the
 * substitution `routes/workspace-response.ts`'s header records as already falsified once.
 */
export interface AgentWorkspaceCommandViewer {
  revealRuntimeConfig: boolean;
}

/** Withholds by default: a caller that proves nothing gets the masked projection. */
export const WITHHELD_AGENT_WORKSPACE_COMMAND_VIEWER: AgentWorkspaceCommandViewer = {
  revealRuntimeConfig: false,
};

/**
 * PEN-5225. Withhold every host-executed workspace command string reachable inside an agent config
 * from a reader that cannot clear `workspace_runtime:read`.
 *
 * ## The hole this closes
 *
 * `workspaceStrategy` is a key inside an agent's `adapter_config`. The WRITE side has always known
 * that — `collectAgentAdapterWorkspaceCommandPaths` (`routes/workspace-command-authz.ts`) addresses
 * it by exactly that path, and `assertNoAgentHostWorkspaceCommandMutation` refuses the mutation for
 * every agent actor, on itself included. The READ side did not: `redactAgentSecrets` masks
 * `adapterConfig.env` values and the MCP `Authorization` header and never touched
 * `workspaceStrategy`, so `provisionCommand` left `GET /api/agents/:id` in the clear for any peer
 * holding `agents:configure` or `agents:suggest-changes` (the two grants that clear
 * `agent_config:read` — `docs/security/agent-config-read-model.md`). Those are the same bytes:
 * `buildReusedExecutionWorkspaceConfigPatchFromIssueSettings` (`services/issues.ts`) copies
 * `workspaceStrategy.provisionCommand` straight onto `config.provisionCommand`, which is executed as
 * `bash -lc <string>`. Every other route carrying them withholds them, and no agent can hold
 * `workspace_runtime:read` at all (PEN-2852), so the agents route was a strictly WIDER door onto a
 * subset of what the narrower one refuses.
 *
 * ## Self-read is NOT exempt, and that is a decision, not an oversight
 *
 * PEN-5225 left open whether an agent reading its OWN `workspaceStrategy` commands should see them,
 * noting `GET /api/agents/me` discloses other fields to self. It should not, and this masks on the
 * entitlement alone with no self-ness branch. Three reasons, in order of weight:
 *
 *  1. The agent is not the executor. `provisionCommand` is run by the control plane
 *     (`services/environment-run-orchestrator.ts`), never by the agent, so no agent consumer needs
 *     the value — which is precisely the test that KEEPS `ExecutionWorkspace.cwd` disclosed in
 *     `routes/workspace-response.ts`. These two fail it.
 *  2. The read-to-edit round-trip that entitles human operators does not exist here. The write guard
 *     keys on `req.actor.type === "agent"`, not on peer-ness, so an agent cannot write these fields
 *     on its own row either; disclosing them to self would buy a read with no write it enables.
 *  3. Self-read reopens the same bytes one hop later. An agent that can read its own
 *     `provisionCommand` can post it into an issue thread, which is company-readable — the hazard
 *     PEN-5225's interim handling exists to route around.
 *
 * One predicate, not two, also means there is no self-ness test to get wrong: PEN-4775 is the
 * standing example of a self-exemption that was right on one route and wrong on its sibling.
 *
 * ## Keyed on reaching a shell, not on a field-name list
 *
 * The leaf classification is `maskWorkspaceStrategyShellTextForRead` (`./redaction.js`), shared with
 * `publicExecutionWorkspaceStrategy` — one list, two layers. Enumerating the two command names here
 * instead is what left `workspaceStrategy` out of `redactAgentSecrets` in the first place.
 *
 * The walk is recursive and keys on the `workspaceStrategy` key at ANY depth, rather than reading
 * `adapterConfig.workspaceStrategy` and stopping. That is not speculative width — the write side
 * already refuses the nested carrier by name: `assertNoAgentAdapterConfigMutation` is applied to
 * each model profile's config too, and `agent-permissions-routes.test.ts` pins the 403 on
 * `runtimeConfig.modelProfiles.cheap.adapterConfig.workspaceStrategy.provisionCommand`. So a
 * top-level-only read mask would have shipped with a carrier the project demonstrably treats as
 * privileged left open one key over, which is the one-of-twelve failure
 * `routes/workspace-response.ts` records. The read walk is deliberately WIDER than the write
 * enumeration (any depth, not `modelProfiles.cheap` specifically) because
 * `agentModelProfileConfigSchema.adapterConfig` is an open `z.record(z.string(), z.unknown())`
 * (`packages/shared/src/validators/agent.ts`) and a non-API writer — import, seed, direct SQL — is
 * not gated by the route guard at all. Wider fails closed; narrower fails the way this row was
 * filed about.
 *
 * A `workspaceStrategy` whose value is not a plain object — array, scalar, foreign prototype — is
 * masked WHOLE via `maskWorkspaceRuntimeForRead` rather than spread, matching
 * `publicIssueExecutionWorkspaceSettings`. Spreading a string would emit its characters.
 *
 * ## Withheld-is-not-absent
 *
 * Preserved at every level. Unrelated keys ride through untouched (this is a mask over an open
 * column, not a projection of a closed type, so deleting an unclassified sibling would be a data
 * loss, not a withholding); an absent command key stays absent; `null` stays `null`; anything else
 * becomes `REDACTED_EVENT_VALUE`. Reusing that sentinel rather than inventing one is also what makes
 * the write side already correct: `containsRedactedAdapterValue` / `restoreRedactedAdapterValue`
 * below substring-test for exactly it, so a client that reads a masked config, edits an unrelated
 * field and `PATCH`es the object back has the stored command restored instead of overwritten — the
 * BLO-5xxx failure mode, which needed no new guard here only because the sentinel is shared.
 *
 * No depth cap, deliberately. `sanitizeValue` already recurses this same value unbounded, so a cap
 * here would add a disclosure edge (a `workspaceStrategy` past the cap) without removing a stack
 * risk that the composed call does not already carry.
 */
export function maskAgentWorkspaceStrategyCommands(
  value: unknown,
  viewer: AgentWorkspaceCommandViewer = WITHHELD_AGENT_WORKSPACE_COMMAND_VIEWER,
): unknown {
  if (viewer.revealRuntimeConfig) return value;
  return maskAgentWorkspaceStrategyCommandsInner(value);
}

function maskAgentWorkspaceStrategyCommandsInner(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAgentWorkspaceStrategyCommandsInner);
  // A non-plain-object subtree (foreign prototype) is returned BY REFERENCE and therefore
  // unmasked. That is unreachable from every caller today because each one composes this walk
  // after `redactAgentConfigPayload` / `redactApprovalPayloadForDisplay`, and `sanitizeRecord`
  // emits only plain objects and arrays. It is called out because the failure is silent: a future
  // caller that hands a RAW column value straight in gets its `workspaceStrategy` back in the
  // clear with no error. Compose this after the sanitizer, or admit through `containAgentConfig`,
  // which withholds the unsanitizable shapes rather than passing them through.
  if (!isPlainObject(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // `assignRecordKey` for the same reason every other accumulator at this boundary uses it: a
    // bare `projected[key] = …` DROPS a key named `__proto__`, and `JSON.parse` makes that a real
    // own key on any jsonb column (PEN-4240). Dropping discloses less, but it breaks the
    // withheld-is-not-absent rule this walk exists to hold.
    assignRecordKey(
      projected,
      key,
      key === "workspaceStrategy"
        ? (isPlainObject(child)
            ? maskWorkspaceStrategyShellTextForRead(child)
            : maskWorkspaceRuntimeForRead(child))
        : maskAgentWorkspaceStrategyCommandsInner(child),
    );
  }
  return projected;
}

/**
 * PEN-5225 round 3 — fail closed on an agent-config shape the command mask cannot walk into.
 *
 * {@link maskAgentWorkspaceStrategyCommands} finds `workspaceStrategy` by descending plain
 * objects and arrays. `approvalPayloadSchema` is a `.catchall(z.unknown())`, so
 * `POST /companies/:companyId/approvals` and the resubmit route persist whatever the filer sent:
 * an `adapterConfig` that arrives as a JSON-ENCODED STRING carries `provisionCommand` in bytes
 * that walk cannot reach, and hands them back unmasked.
 *
 * The reader this protects is the only one it can be: a caller that clears `agent_config:read`
 * and not `workspace_runtime:read`. A caller that clears neither is already covered at any shape,
 * because `withholdAgentConfigKeys` blanks the pair to `{}` by this same `.catchall` reasoning —
 * entitlement must not depend on shape. This closes the matching hole one gate down, where
 * entitlement is granted but the mask is shape-dependent.
 *
 * Blanked, never parsed. Reaching inside the string would make a filer-supplied encoding decide
 * an authorization outcome, and a failed parse would have to land here regardless.
 *
 * `null`/`undefined` stay readable for the reason `withholdAgentConfigKeys` gives: they carry no
 * commands and are the honest "no config was requested" the board queue renders. Arrays are
 * blanked even though the mask does descend them, because an element can itself be a string and
 * an array-valued config is a shape nothing writes server-side — fail closed rather than
 * enumerate which element types happen to be safe.
 */
export function maskUnwalkableAgentConfigForRead(payload: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(payload)) return payload;

  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const unwalkable =
        WITHHELD_AGENT_CONFIG_KEYS.has(key)
        && entry !== null
        && entry !== undefined
        && !isPlainObject(entry);
      // `assignRecordKey` for the reason every accumulator at this boundary uses it: a bare
      // `out[key] = …` drops a key named `__proto__`, which `JSON.parse` makes a real own key on
      // any jsonb column (PEN-4240), and dropping breaks withheld-is-not-absent.
      assignRecordKey(out, key, unwalkable ? REDACTED_EVENT_VALUE : walk(entry));
    }
    return out;
  }

  // Recursing unconditionally is what covers BOTH depths the card carries the pair at —
  // `payload.adapterConfig` and `payload.requestedConfigurationSnapshot.adapterConfig` — and any
  // third copy a later writer adds.
  return walk(payload) as Record<string, unknown>;
}

/**
 * PEN-5225 — the ONE read projection for an approval card payload.
 *
 * ## Why this is shared rather than restated
 *
 * A `hire_agent` card embeds the hire's `adapterConfig` / `runtimeConfig` twice (again under
 * `requestedConfigurationSnapshot`), and THREE read paths serialize it: `routes/approvals.ts`
 * (detail, company list, create echo, and every resolution response) and
 * `services/issue-approvals.ts#listApprovalsForIssue`. Both spelled the same three-step projection
 * out inline, and the second copy is exactly how this hole stayed open: PEN-5225 masked the
 * workspace commands at the agent-config admission gate, which closed `GET /api/agents/:id` and
 * left the approval card — the same bytes, one route over — disclosing them. That is the
 * two-exits-one-answer split PEN-4775 names. One function means the next finding against this
 * projection lands on every exit at once.
 *
 * ## Two independent gates, and the order they compose in
 *
 *  1. `redactApprovalPayloadForDisplay` — what is SECRET (credential values, env bindings).
 *     Unconditional; no entitlement turns it off.
 *  2. `includeAgentConfig` — the caller's `agent_config:read` verdict. Blanks the config pair to
 *     `{}` for a caller that cannot clear it (PEN-2777).
 *  3. `workspaceCommandViewer` — the caller's `workspace_runtime:read` verdict, masking the
 *     host-executed strings inside a config the caller IS entitled to read. Runs in two parts:
 *     `maskUnwalkableAgentConfigForRead` blanks a config whose SHAPE the mask cannot descend
 *     (a JSON-encoded string), then `maskAgentWorkspaceStrategyCommands` masks the commands
 *     inside the shapes it can. Splitting shape from content is what keeps the second half from
 *     having to parse filer-supplied bytes to reach an authorization outcome.
 *
 * Gates 2 and 3 are independent and a reader can clear either without the other: `agents:configure`
 * and `agents:suggest-changes` clear `agent_config:read`, while NO agent can hold
 * `workspace_runtime:read` at all (PEN-2852). A mock that answers one boolean for both cannot see
 * the bug this closes, which is why the regression tests resolve them separately.
 *
 * The mask runs LAST, over the already-withheld payload, so it covers a `workspaceStrategy`
 * carried anywhere in the card — not only inside the two keys gate 2 knows about. It is scoped to
 * `hire_agent` for the same reason gate 2 is: that is the type whose payload is agent-config-shaped.
 * Another type's payload is filer-authored prose and is left exactly as `redactEventPayload` made it.
 *
 * `workspaceCommandViewer` defaults to WITHHELD, matching every other viewer in this module: a read
 * path added later that does not resolve the verdict masks rather than discloses.
 */
export function projectApprovalPayloadForRead(
  type: unknown,
  rawPayload: Record<string, unknown>,
  options: {
    includeAgentConfig: boolean;
    workspaceCommandViewer?: AgentWorkspaceCommandViewer;
  },
): { payload: Record<string, unknown>; redactedFields: string[]; withheldFields: string[] } {
  const { payload, redactedFields } = redactApprovalPayloadForDisplay(type, rawPayload);
  const admitted = options.includeAgentConfig
    ? { payload, withheldFields: [] as string[] }
    : withholdAgentConfigFromApprovalPayload(type, payload);
  if (type !== "hire_agent") {
    return { payload: admitted.payload, redactedFields, withheldFields: admitted.withheldFields };
  }
  const viewer = options.workspaceCommandViewer ?? WITHHELD_AGENT_WORKSPACE_COMMAND_VIEWER;
  // Gate 3a, ahead of the walk: blank a config the walk cannot descend. No-op for a revealing
  // viewer, and a no-op after gate 2 as well, whose `{}` is a plain object.
  const walkable = viewer.revealRuntimeConfig
    ? admitted.payload
    : maskUnwalkableAgentConfigForRead(admitted.payload);
  return {
    payload: maskAgentWorkspaceStrategyCommands(walkable, viewer) as Record<string, unknown>,
    redactedFields,
    withheldFields: admitted.withheldFields,
  };
}

/**
 * The fail-closed disposition for an ALREADY-SANITIZED `metadata` value.
 *
 * `metadata` is NOT coerced to a record the way the two config columns are: an
 * array-valued `metadata` must survive as the element-wise-sanitized array
 * `sanitizeValue` produced, not be flattened to `{}` or `null`. But it must
 * still fail closed. `metadata` matches no tier and no special case in
 * `sanitizeRecord`, so it reaches `sanitizeValue`, which returns a non-plain
 * non-array object BY REFERENCE — a foreign-prototype `metadata` arrives
 * unsanitized and has to be withheld rather than emitted. Arrays and plain
 * objects have been sanitized and pass; a primitive carries no binding for
 * `sanitizeValue` to have missed and any string has already been through
 * `redactUriCredentialsInValue`; everything else is withheld.
 *
 * Note `isPlainObject` admits a null prototype, so `Object.create(null)` is
 * sanitized and passes here — the withheld shape is a prototype that is
 * neither `Object.prototype` nor `null`.
 */
export function keepSanitizedAgentMetadata(meta: unknown): unknown {
  if (meta === null || meta === undefined) return null;
  if (typeof meta !== "object") return meta;
  return isPlainObject(meta) || Array.isArray(meta) ? meta : null;
}

/**
 * Sanitize a raw stored `metadata` on its way out of a spread-based redactor.
 *
 * `metadata` is the same admission problem `containAgentConfig` solves for the
 * two config columns, minus the ability to coerce the result. It is a
 * caller-writable open bag — `jsonb`, validated only as
 * `z.record(z.string(), z.unknown())` on create/patch — and unlike
 * `adapterConfig` it takes no secret-sentinel pass on write. Its intended
 * contents are markers (`paperclipBuiltInAgent`, `paperclipManagedResource`,
 * `pluginManagedAgent`) that callers read, so it cannot simply be dropped.
 *
 * Sanitize it under the key `metadata`, which is the key the config-revision
 * snapshot already sanitizes it under: `sanitizeRecord` resolves its
 * `env` / `headers` / args / key-tier special cases from the key NAME, so
 * wrapping under any other key would silently apply a different rule to the
 * identical column on two paths that must agree.
 *
 * `containAgentConfig` is deliberately NOT reused here: it answers for a config
 * *record* and returns `{}` for an array, which would flatten an array-valued
 * `metadata` instead of keeping the element-wise-sanitized array.
 *
 * Coverage is the sanitizer's, not this function's: `{type:"plain",value}`
 * bindings, `env` maps, Tier-1 key names at any depth, URI-embedded
 * credentials and JWT-shaped strings are masked — the last two at *any* key,
 * so the Tier-0 fallthrough is not shape-blind.
 *
 * What survives is narrower than "a bare string", and sharper: a *non-JWT,
 * non-URI* credential under an innocuous key, at any depth. Measured, not
 * inferred (PEN-5253): `{note: "sk-ant-…"}`, `{note: "AKIA…"}` and a whole
 * PEM private-key block all egress verbatim, while `{token: …}`,
 * `{secret: …}`, a JWT and a `user:pass@` URI do not.
 *
 * That residual is ACCEPTED AND UNENFORCED — a decision, not a pending fix.
 * `agents.metadata` is contractually non-secret-bearing: nothing stops a
 * caller storing a credential under an innocuous key, and nothing will.
 * Decided for the sanitizer's admission generally, so it covers all three
 * columns `sanitizeRecord` serves. `adapterConfig` / `runtimeConfig` are not
 * differently covered here; they differ only in that their *designed*
 * credential channels — `env`, `headers`, `{type:"plain"}` bindings — are
 * masked structurally, whereas `metadata` has no designed credential channel
 * at all.
 *
 * Two measured reasons, so neither is re-litigated here:
 *
 *  - A value-shape test cannot be both safe and complete at a Tier-0 key.
 *    `looksLikeCredentialValue` (`redaction.ts`) is exactly that instrument
 *    and already runs — but only behind a Tier-1/2 *key* match, which is why
 *    `{secret: "sk-ant-…"}` is masked and `{note: …}` is not. Run *as-is* at
 *    every key, its length backstop (`MIN_OPAQUE_TOKEN_LENGTH`, 20,
 *    minus the readable-slug exemption) blanks the ordinary long opaque
 *    identifiers this column and its two siblings legitimately hold: UUIDs,
 *    40-hex git SHAs and image references all classify as credential-shaped.
 *    "As-is" is load-bearing, and the honest cost is smaller than that list:
 *    `redaction.ts` ALREADY has `HEX_IDENTIFIER_RE` / `UUID_RE` exemptions and
 *    applies them inside `hasOpaqueUrlPathSegment` but not in the bare-value
 *    branch, so a Tier-0 pass that simply reused them would stop blanking the
 *    UUID and the SHA. What survives that cheap refinement — image references
 *    and other long non-hex, non-UUID identifiers — is the durable cost.
 *    Smaller, not zero. Narrowed instead to high-confidence prefixes the pass
 *    stops over-redacting but misses every *prefixless* secret — AWS secret
 *    access keys, passphrases, hex HMAC keys, base64 blobs. Same dial,
 *    opposite ends: the test is sound only where the KEY already says
 *    "secret", and the residual is by construction where it does not.
 *  - A write-side pass that *masked* would collide with the shared restore
 *    path. All three columns share {@link restoreRedactedAdapterValue} /
 *    {@link containsRedactedAdapterValue}, by two entry points rather than
 *    one: `metadata` and `runtimeConfig` via
 *    {@link restoreRedactedAgentMetadata} (of which
 *    {@link restoreRedactedAgentRuntimeConfig} is a direct alias), and
 *    `adapterConfig` via {@link stripRedactedEnvBindingsFromAdapterConfig}.
 *    `containsRedactedAdapterValue` SUBSTRING-tests for the sentinel — so a
 *    persisted mask makes that key permanently unwritable: stored `***`
 *    restores from a prior that is itself `***`, with no escape hatch for a
 *    false positive. Masking is therefore out, and *vaulting* (PEN-3726 tick
 *    4's named instrument) needs a secret-store binding this column does not
 *    have.
 *
 * An earlier revision of this docblock said closing the residual "needs a
 * write-side key allowlist, not a read-side redactor". Both halves were
 * wrong, in opposite directions: a key allowlist was already rejected
 * (PEN-3726 tick 4 — `pluginManagedAgent` needs arbitrary keys), and a
 * read-side value-shape pass *can* see this case. It is not that no control
 * could reach it; it is that every control that reaches it costs more than
 * the hazard, which has no confirmed instance.
 *
 * The first revision of *this* decision then got the over-redaction example
 * wrong in a third way, worth recording because it ran in the direction that
 * flatters the decision: it claimed the detector run at every key would blank
 * "the live `paperclipBuiltInAgent` marker", confusing the 21-character *key*
 * with the *value* `looksLikeCredentialValue` actually tests. The real marker
 * values (`cto`, `security-engineer`, …) are short readable slugs and survive
 * untouched. The over-redaction cost is real but sits elsewhere — on the long
 * opaque identifiers named above — so that is what the tests now pin. The
 * "as-is" qualifier on that cost was then added on review (#3292), for the
 * same reason: stated without it, the cost overstates in the same
 * decision-flattering direction a second time.
 * `__tests__/agent-secret-redaction.test.ts` pins both sides of this
 * boundary, so a future shape pass fails a test rather than silently
 * widening the column.
 */
export function containAgentMetadata(value: unknown): unknown {
  // `?? {}` is a type narrowing, not a live branch: the argument is always a
  // freshly built plain object, so `redactAgentConfigPayload` never returns null.
  return keepSanitizedAgentMetadata((redactAgentConfigPayload({ metadata: value }) ?? {}).metadata);
}

/**
 * Strip credential material out of an agent row before it goes on the wire.
 *
 * `adapterConfig` holds live secrets — `{type:"plain",value}` env bindings and
 * literal `Bearer …` values in `mcpServers.*.headers`. This used to be applied
 * only on the read paths, so a budget-only `PATCH /api/agents/:id` handed the
 * caller the agent's entire credential set, and it landed verbatim in agent
 * transcripts and run logs, which are read far more widely than the secret
 * store (BLO-18969).
 *
 * `secret_ref` / `user_secret_ref` bindings are pointers, not plaintext, so
 * they survive — minus any resolved `value`, which the schema has no field
 * for and which only ever means a secret leaked in.
 *
 * Redaction is structural, not key-name based: `redactAgentConfigPayload`
 * masks every plain binding and every `env` value at any depth, so a nested
 * `runtimeConfig.modelProfiles.*.adapterConfig.env` entry is covered too.
 *
 * Every response that serializes an agent MUST go through here,
 * `redactForRestrictedAgentView`, or `redactAgentConfiguration`. Adding an
 * agent-serializing route without one of them reopens this hole.
 *
 * PEN-5225 added the `viewer` parameter, which gates the host-executed
 * workspace command strings described on
 * {@link maskAgentWorkspaceStrategyCommands}. It DEFAULTS TO WITHHELD, and that
 * polarity is the point: a new call site that forgets it masks those strings
 * rather than disclosing them, so the omission is survivable in the direction
 * this file's history keeps failing in. Pass a resolved
 * `resolveWorkspaceRuntimeViewer` result only where an entitled human has to
 * keep reading the value — the agent-config read and round-trip routes.
 */
export function redactAgentSecrets<
  T extends { adapterConfig?: unknown; runtimeConfig?: unknown; metadata?: unknown },
>(agent: T, viewer: AgentWorkspaceCommandViewer = WITHHELD_AGENT_WORKSPACE_COMMAND_VIEWER): T {
  const result = { ...agent };
  // `containAgentConfig`, not the local `asRecord`: `asRecord` admits any
  // non-array object, and for a foreign-prototype config the redactor handed
  // the argument straight back, so `result.adapterConfig` was assigned the
  // raw record. See the helper for why swapping the predicate alone would
  // have moved the leak rather than closed it.
  const rawConfig = agent.adapterConfig;
  const containedConfig = containAgentConfig(rawConfig, viewer);
  if (containedConfig) {
    const env = isPlainObject(rawConfig) ? asRecord(rawConfig.env) : null;
    if (env) {
      // The top-level env keeps the shorter `***` sentinel the UI and
      // `stripRedactedEnvBindingsFromAdapterConfig` have always round-tripped.
      // `assignRecordKey` (PEN-4240). A stored key named `__proto__` cannot reach
      // here through the API today -- `ENV_KEY_RE` refuses the name on write
      // (PEN-3257), once `stripRedactedEnvBindingsFromAdapterConfig` below stops
      // dropping it before the validator runs. Guarded anyway: a non-API writer
      // (import, seed, direct SQL) is not gated by that refusal, and a read path
      // that silently loses a key name is the defect PEN-2370 ask-1 forbids.
      const redactedEnv: Record<string, string> = {};
      for (const key of Object.keys(env)) {
        assignRecordKey(redactedEnv, key, REDACTED_ENV_SENTINEL);
      }
      result.adapterConfig = { ...containedConfig, env: redactedEnv } as T["adapterConfig"];
    } else {
      result.adapterConfig = containedConfig as T["adapterConfig"];
    }
  }
  const containedRuntime = containAgentConfig(agent.runtimeConfig, viewer);
  if (containedRuntime) {
    result.runtimeConfig = containedRuntime as T["runtimeConfig"];
  }
  // `metadata` is an open bag with no write-side secret pass (PEN-3726). The
  // three projections that enumerate their output already decline to emit it
  // as stored; this spread and `redactForRestrictedAgentView` did not, which
  // left the same column sanitized on one path and inert on the two common
  // read paths. Guarded on presence so a caller whose `T` carries no
  // `metadata` does not acquire one.
  if ("metadata" in agent) {
    result.metadata = containAgentMetadata(agent.metadata) as T["metadata"];
  }
  return result;
}

/* ---------------------------------------------------------------------------
 * Write side: undo this module's own masking on the way back in.
 *
 * These live beside the redactors above rather than in `routes/agents.ts`
 * because the mask and its inverse have to agree, and the inverse now has a
 * caller that is not a route. `activatePendingApproval`
 * (`services/agents.ts`) replays the board-approval snapshot over the agent
 * row, and that snapshot is masked — so the service layer needs the restore.
 * Reaching into `routes/agents.ts` from a service inverts the layering and
 * would close an import cycle (`routes/agents.ts` imports `services/agents.js`
 * already); this module imports only `./redaction.js`, so both sides can
 * depend on it (PEN-3757).
 * ------------------------------------------------------------------------- */

export function isRedactedEnvBinding(binding: unknown): boolean {
  if (typeof binding === "string") return binding === REDACTED_ENV_SENTINEL;
  if (binding && typeof binding === "object") {
    const b = binding as { type?: unknown; value?: unknown };
    return b.type === "plain" && b.value === REDACTED_ENV_SENTINEL;
  }
  return false;
}

const OMIT_REDACTED_ADAPTER_VALUE = Symbol("omit-redacted-adapter-value");

export function containsRedactedAdapterValue(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REDACTED_EVENT_VALUE);
  if (Array.isArray(value)) return value.some(containsRedactedAdapterValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsRedactedAdapterValue);
}

/**
 * The shared sentinel-restore walk. Prefer {@link restoreRedactedAgentMetadata},
 * {@link restoreRedactedAgentRuntimeConfig} or
 * {@link stripRedactedEnvBindingsFromAdapterConfig} where one fits — they pair
 * this with the `containsRedactedAdapterValue` short-circuit that keeps an
 * unmasked payload byte-identical. It stays exported for tests and for a future
 * column that needs the walk without that pairing.
 *
 * A masked scalar with an `undefined` prior has nothing to restore from, and
 * reports that as `undefined` rather than as the private
 * `OMIT_REDACTED_ADAPTER_VALUE` symbol: the walk below uses that symbol to tell
 * "drop this key" apart from "the stored value is `undefined`", but it is an
 * internal token and must not cross this boundary. Nested occurrences are
 * consumed by the object/array walk, so only the top-level one could ever
 * escape, and the wrapper here maps it. Every call site in this repo passes a
 * record for `existing`, so the case does not arise today — this keeps the
 * hazard unreachable by construction rather than by that fact, since the
 * failure mode is silent (a `Symbol` serialized into a config column) and this
 * is a leaf module's public surface (PEN-3759).
 */
export function restoreRedactedAdapterValue(incoming: unknown, existing: unknown): unknown {
  const restored = restoreRedactedAdapterValueInner(incoming, existing);
  return restored === OMIT_REDACTED_ADAPTER_VALUE ? undefined : restored;
}

function restoreRedactedAdapterValueInner(incoming: unknown, existing: unknown): unknown {
  // PEN-2747: the URI-credential rule masks only the credential *component* of
  // a URL, so the round-tripped value is `https://user:***REDACTED***@host/mcp`
  // — a string that merely CONTAINS the sentinel rather than equalling it. An
  // equality test misses it and persists a broken upstream URL, which is the
  // BLO-5xxx failure mode described above (a sentinel written back into live
  // config killed every run) with a different shape. Substring-test instead:
  // no legitimate configured value contains this sentinel.
  if (typeof incoming === "string" && incoming.includes(REDACTED_EVENT_VALUE)) {
    return existing === undefined ? OMIT_REDACTED_ADAPTER_VALUE : existing;
  }
  if (
    incoming
    && typeof incoming === "object"
    && !Array.isArray(incoming)
    && (incoming as { type?: unknown; value?: unknown }).type === "plain"
    && (incoming as { type?: unknown; value?: unknown }).value === REDACTED_EVENT_VALUE
  ) {
    return existing === undefined ? OMIT_REDACTED_ADAPTER_VALUE : existing;
  }
  if (Array.isArray(incoming)) {
    const existingArray = Array.isArray(existing) ? existing : [];
    return incoming.flatMap((value, index) => {
      const restored = restoreRedactedAdapterValueInner(value, existingArray[index]);
      return restored === OMIT_REDACTED_ADAPTER_VALUE ? [] : [restored];
    });
  }
  if (!incoming || typeof incoming !== "object") return incoming;

  const existingRecord =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  // WRITE-SIDE POLICY (PEN-4244): a `__proto__` key that survives this walk is deliberately
  // PERSISTED into stored agent `adapterConfig`, not refused. That is the opposite of
  // `normalizeEnvConfig`'s 422 (PEN-3257), on purpose; the measurements and the reasoning live
  // next to `mergeRecord` in `services/plugin-config-masking.ts`, and the decision is pinned by
  // `__tests__/write-side-proto-policy.test.ts`.
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    // OWN-property read, not `existingRecord[key]` (PEN-4240). This is the READ half of the
    // same `__proto__` hazard `assignRecordKey` fixes, and it needs its own remedy: once an
    // incoming `__proto__` key SURVIVES into this walk, a bare lookup resolves it up the chain
    // to `Object.prototype` -- which is not `undefined`, so the two sentinel branches above read
    // it as "something was stored" and restore a withheld value to `Object.prototype`,
    // persisting as `{}`. Fixing the write side is not a substitute for this guard.
    const restoredValue = restoreRedactedAdapterValueInner(value, ownRecordValue(existingRecord, key));
    if (restoredValue !== OMIT_REDACTED_ADAPTER_VALUE) assignRecordKey(restored, key, restoredValue);
  }
  return restored;
}

// The legacy name is retained for call-site compatibility; this now restores
// both env sentinels and recursively redacted adapter values on API round-trips.
export function stripRedactedEnvBindingsFromAdapterConfig(
  incomingAdapterConfig: Record<string, unknown>,
  existingAdapterConfig: Record<string, unknown> | null,
): Record<string, unknown> {
  const restoredAdapterConfig = containsRedactedAdapterValue(incomingAdapterConfig)
    ? (restoreRedactedAdapterValue(
        incomingAdapterConfig,
        existingAdapterConfig ?? {},
      ) as Record<string, unknown>)
    : incomingAdapterConfig;
  const incomingEnv = restoredAdapterConfig.env;
  if (!incomingEnv || typeof incomingEnv !== "object" || Array.isArray(incomingEnv)) {
    return restoredAdapterConfig;
  }
  const existingEnv =
    existingAdapterConfig
    && typeof existingAdapterConfig.env === "object"
    && existingAdapterConfig.env !== null
    && !Array.isArray(existingAdapterConfig.env)
      ? (existingAdapterConfig.env as Record<string, unknown>)
      : {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incomingEnv as Record<string, unknown>)) {
    if (isRedactedEnvBinding(value)) {
      // UI round-trip: the GET response masks env values to the sentinel,
      // and a naive save sends them back. Preserve the prior binding if we
      // have one; drop the key entirely otherwise.
      if (Object.prototype.hasOwnProperty.call(existingEnv, key)) {
        assignRecordKey(cleaned, key, existingEnv[key]);
      }
    } else {
      assignRecordKey(cleaned, key, value);
    }
  }
  return { ...restoredAdapterConfig, env: cleaned };
}

/**
 * Undo this module's own `metadata` masking on an API round-trip.
 *
 * Containing `metadata` on the read paths (PEN-3726) gave it the same
 * read-modify-write hazard `adapterConfig` has carried since BLO-5xxx, where a
 * sentinel written back into live config killed every run: `GET` now masks
 * credential-shaped values to `REDACTED_EVENT_VALUE`, `updateAgentSchema`
 * accepts `metadata`, and `svc.update` persists whatever arrives. So a client
 * that reads an agent, edits an unrelated field and `PATCH`es the object back
 * overwrites the stored value with the placeholder. `adapterConfig` is guarded
 * against exactly this by `stripRedactedEnvBindingsFromAdapterConfig`;
 * `metadata` had no analogue.
 *
 * This composes the *same* `containsRedactedAdapterValue` /
 * `restoreRedactedAdapterValue` pair rather than restating the sentinel rule.
 * Both columns are masked by the one redactor, so a parallel implementation
 * could drift from it — and a rule that drifts on the write side is how a
 * column ends up sanitized on one path and inert on another, which is the
 * defect PEN-3726 exists to close. In particular the PEN-2747 case (a URI
 * whose credential *component* alone is masked, so the value contains the
 * sentinel rather than equalling it) is handled because that helper
 * substring-tests; an equality test written fresh here would miss it.
 *
 * Absent prior value: `restoreRedactedAdapterValue` drops the key rather than
 * inventing one, so a masked key with nothing stored to restore is omitted
 * instead of persisting the placeholder. On a create there is no prior value at
 * all, so passing `null` there scrubs the whole payload on the same rule.
 *
 * Ceiling, inherited from that helper: arrays are matched to their prior values
 * **positionally** (`existingArray[index]`). A client that reorders or inserts
 * into an array holding a masked element restores the wrong stored element, and
 * elements past the end of the prior array are dropped — stored
 * `[secretA, secretB]` sent back as `[newItem, ***, ***]` yields
 * `[newItem, secretB]`. Index-matching is about all a restore can do for an
 * anonymous array, but it is worth knowing here specifically: unlike
 * `adapterConfig.env`, `metadata` supports array values as a first-class shape
 * (`keepSanitizedAgentMetadata` preserves them rather than flattening), so this
 * is reachable on this column in a way it is not on the one it was written for.
 *
 * That ceiling is scoped to the client `PATCH` round-trip, where the array the
 * caller sends back is whatever the caller chose to send. It is **not** reachable
 * on the hire-approval replay (`services/agents.ts`), because there the
 * "incoming" side is a `redactEventPayload` snapshot of the stored row, and every
 * array branch in that redactor is length-preserving: `sanitizeValue` and
 * `sanitizeSecretMatchedValue` both `.map()`, and `sanitizeCommandArgs` returns
 * the flag verbatim and masks the following element in place. Snapshot and row
 * therefore stay index-aligned by construction on that path. Keep the two apart
 * when reading this: only a caller-supplied array can misalign (PEN-3759).
 */
export function restoreRedactedAgentMetadata(incoming: unknown, existing: unknown): unknown {
  if (!containsRedactedAdapterValue(incoming)) return incoming;
  return restoreRedactedAdapterValue(incoming, existing ?? {});
}

/**
 * The same restore for `runtimeConfig`, the third column replayed on the
 * hire-approval path (PEN-3847).
 *
 * Two callers, reached from opposite directions, which is why this lives here
 * rather than in either of them:
 *
 *  - `restoreRedactedRuntimeConfigValues` (`routes/agents.ts`) — the client
 *    `PATCH` round-trip, which pairs it with the `modelProfiles.*.adapterConfig`
 *    restore that only the route can do.
 *  - `activatePendingApproval` (`services/agents.ts`) — the approval replay.
 *
 * The replay caller is the new one. Its verbatim branch was documented as
 * unreachable because the only *producer* of the stored payload
 * (`POST .../agent-hires`) sets `requestedConfigurationSnapshot`
 * unconditionally, so `mergeApprovedRuntimeConfig` — which starts from the
 * stored row and `continue`s on `jsonEqual` keys — always ran. There is a
 * second producer: `PUT /approvals/:id/resubmit` **replaces** the stored payload
 * wholesale (`services/approvals.ts`) and re-binds `agentId` from the card
 * (`routes/approvals.ts`), so a requester that GETs its own
 * `revision_requested` card through the redacted read path, edits a field and
 * PUTs it back — ordinary read-modify-write — stores `REDACTED_EVENT_VALUE`
 * wherever `redactAgentConfigPayload` masked, and can omit the snapshot
 * entirely. `runtimeConfig` carries `heartbeat.maxConcurrentRuns` and the
 * external-lifecycle settings, so a sentinel where a structured value belongs
 * is a live-agent availability fault, not only a hygiene one.
 *
 * Deliberately **is** {@link restoreRedactedAgentMetadata} rather than a copy of
 * it: all three columns are masked by the one redactor, and a rule restated per
 * column is how a column ends up guarded on one path and inert on another. An
 * identical body re-typed here would be exactly that restatement — the aliasing
 * makes divergence structurally impossible instead of conventionally
 * discouraged, while keeping the per-column name and this docblock as the thing
 * a caller reads. The PEN-2747 substring case and the drop-rather-than-invent
 * behaviour on an absent prior are inherited from
 * {@link restoreRedactedAdapterValue}; so is the positional array ceiling
 * documented on {@link restoreRedactedAgentMetadata} — and that inheritance is
 * now by identity, not by assertion.
 */
export const restoreRedactedAgentRuntimeConfig = restoreRedactedAgentMetadata;
