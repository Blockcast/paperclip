/**
 * Write-time validation of `adapterConfig.model` against the target agent's own
 * adapter registry (PEN-4447).
 *
 * The defect this closes: `PATCH /agents/:id` accepted ANY string as
 * `adapterConfig.model` and returned 200. The id is not consumed until the
 * agent's next pod boot, so a plausible-but-wrong id bricks the lane hours
 * later, with nothing linking the dead lane to the successful-looking write.
 *
 * It is worse than a plain typo class, because which ids are valid depends on
 * which adapter the lane runs, and the two Claude adapters ship DIFFERENT
 * registries. The measured near-miss: `claude-haiku-4-5` is registered for
 * `claude_local` and absent from `claude_k8s` (whose cheap floor is
 * `claude-haiku-4-6`), so the id picked precisely because it looked like the
 * safest possible write is the one that would have killed a `claude_k8s` lane.
 *
 * Three deliberate limits:
 *
 *  - Enforcement is OPT-IN per adapter (`modelRegistryIsClosed`). Adapters that
 *    discover models from a live provider API or a CLI fall back to a static
 *    list when that lookup fails, so for them "absent from the registry" means
 *    "discovery is down" at least as often as it means "invalid". Refusing
 *    those writes would replace a late failure with an immediate wrong one.
 *  - Only a model id the write INTRODUCES is checked. An id already stored on
 *    the agent is tolerated, so an agent whose model has since left its
 *    adapter's registry can still take unrelated repairs instead of 422-ing on
 *    every write that touches `adapterConfig`. Same reasoning, and the same
 *    shape, as the `desiredSkills` guard in `routes/agents.ts`: validate what
 *    this write adds, never re-litigate what is already there. Re-pointing the
 *    agent at a different adapter IS an introduction — the pair changed, even
 *    if the string did not.
 *  - It validates the id against the registry, not against the provider. An id
 *    the adapter lists but the provider has retired still fails at exec. This
 *    closes the cross-adapter confusion, not every bad model id.
 */

const MAX_LISTED_MODEL_IDS = 40;

/**
 * Operator escape hatch. Set to a truthy value to accept unlisted model ids
 * fleet-wide.
 *
 * It exists because the failure mode of this guard is refusing a write that was
 * actually correct — a model the provider has shipped and the adapter has not
 * listed yet — and that needs an exit that is not "wait for a release".
 * `PAPERCLIP_ADAPTER_MODELS` is the narrower exit (declare the id for one
 * adapter type); reach for this one only when that is not enough.
 */
export const ALLOW_UNLISTED_ADAPTER_MODELS_ENV = "PAPERCLIP_ALLOW_UNLISTED_ADAPTER_MODELS";

export interface UnregisteredAdapterModel {
  adapterType: string;
  model: string;
  validModelIds: string[];
}

export function allowsUnlistedAdapterModels(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[ALLOW_UNLISTED_ADAPTER_MODELS_ENV];
  if (typeof raw !== "string") return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Pure core: decide whether `model` is admissible given an already-resolved
 * registry. Returns `null` when the write is allowed.
 *
 * Every fail-open arm is here rather than at the call site so that the reasons
 * for not enforcing are readable in one place:
 *  - no model set           → the adapter picks its own default
 *  - registry not declared closed → adapter has not opted in
 *  - registry empty         → nothing to validate against (unknown/unloaded
 *                             adapter type, or an adapter that lists nothing)
 */
export function findUnregisteredModel(input: {
  adapterType: string;
  model: unknown;
  registry: readonly { id: string }[];
  registryIsClosed: boolean;
  /** Already stored on this agent; an unchanged pair is not an introduction. */
  previous?: { adapterType?: string | null; model?: unknown } | null;
  /** Adapter verdict for an id no list can enumerate. Default: no. */
  acceptedByAdapter?: boolean;
  env?: NodeJS.ProcessEnv;
}): UnregisteredAdapterModel | null {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) return null;
  if (!input.registryIsClosed) return null;
  if (input.registry.length === 0) return null;
  if (!introducesModel({ adapterType: input.adapterType, model, previous: input.previous })) {
    return null;
  }
  if (allowsUnlistedAdapterModels(input.env ?? process.env)) return null;
  const validModelIds = input.registry.map((entry) => entry.id);
  if (validModelIds.includes(model)) return null;
  if (input.acceptedByAdapter === true) return null;
  return { adapterType: input.adapterType, model, validModelIds };
}

/**
 * Does this write introduce the (adapter, model) pair, or is it the one the
 * agent already had?
 *
 * Both halves matter. A patch that changes nothing about the model must not be
 * refused for it; and re-pointing an agent at a different adapter introduces
 * the pair even though the model string is untouched, which is the sideways
 * route to exactly the same dead lane.
 */
export function introducesModel(input: {
  adapterType: string;
  model: string;
  previous?: { adapterType?: string | null; model?: unknown } | null;
}): boolean {
  const previous = input.previous;
  if (!previous) return true;
  const previousModel = typeof previous.model === "string" ? previous.model.trim() : "";
  if (previousModel !== input.model) return true;
  const previousType = previous.adapterType ?? null;
  // A previous entry that does not name a type is a caller that could not
  // resolve one; treat the type as unchanged rather than inventing a mismatch.
  if (previousType === null) return false;
  return previousType !== input.adapterType;
}

/** Human-readable refusal naming the valid set, for the 4xx body. */
export function describeUnregisteredModel(finding: UnregisteredAdapterModel): string {
  const shown = finding.validModelIds.slice(0, MAX_LISTED_MODEL_IDS);
  const omitted = finding.validModelIds.length - shown.length;
  const suffix = omitted > 0 ? `, +${omitted} more` : "";
  return (
    `Unknown model "${finding.model}" for adapter "${finding.adapterType}". `
    + `Registries differ between adapters, so an id valid for another adapter can be invalid here. `
    + `Valid model ids: ${shown.join(", ")}${suffix}.`
  );
}

/**
 * Resolve the target adapter's registry for THIS config and check the model.
 *
 * The registry import is lazy so that callers which never set a model never
 * load the adapter registry (it pulls in every built-in adapter module).
 */
export async function findUnregisteredAdapterModel(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
  previous?: { adapterType?: string | null; adapterConfig?: Record<string, unknown> | null } | null,
): Promise<UnregisteredAdapterModel | null> {
  const model = typeof adapterConfig.model === "string" ? adapterConfig.model.trim() : "";
  if (!model || !adapterType) return null;
  if (allowsUnlistedAdapterModels()) return null;
  const previousPair = previous
    ? { adapterType: previous.adapterType ?? null, model: previous.adapterConfig?.model }
    : null;
  // Cheap checks first: this short-circuits before loading the adapter
  // registry, which for a discovering adapter can mean a network call.
  if (!introducesModel({ adapterType, model, previous: previousPair })) return null;
  const {
    adapterAcceptsModelForConfig,
    adapterModelRegistryIsClosed,
    listAdapterModelsForConfig,
  } = await import("./registry.js");
  if (!adapterModelRegistryIsClosed(adapterType)) return null;
  const registry = await listAdapterModelsForConfig(adapterType, adapterConfig);
  if (registry.some((entry) => entry.id === model)) return null;
  return findUnregisteredModel({
    adapterType,
    model,
    registry,
    registryIsClosed: true,
    previous: previousPair,
    acceptedByAdapter: await adapterAcceptsModelForConfig(adapterType, model, adapterConfig),
  });
}
