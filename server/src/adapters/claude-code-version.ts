/**
 * The admissible grammar of `adapterConfig.claudeCodeVersion`, as ONE
 * definition (PEN-6586).
 *
 * ⚠ THIS FILE IS A LEAF ON PURPOSE. It must import nothing, for the same
 * reason `services/agent-config-key-pins.ts` is one: the grammar has TWO
 * enforcement points in this package that sit on opposite sides of the
 * layering — the write-time refusal in `routes/agents.ts`, and the read-time
 * redaction exemption in `redaction.ts`, which itself imports only two
 * workspace packages and must stay that shallow. A leaf is the only shape both
 * can depend on without a cycle, and one definition is the only shape that
 * cannot drift between them.
 *
 * ## Why a grammar lives here at all
 *
 * `claudeCodeVersion` is consumed in exactly one place, and not until dispatch:
 * `resolveClaudeCodeVersion` (`vendor/paperclip-adapter-claude-k8s/src/server/
 * runtime-pin.ts`), called from that adapter's `job-manifest.ts` while building
 * the Job command. The value is INTERPOLATED INTO A SHELL COMMAND, so that
 * function throws on anything outside this grammar rather than quoting around
 * it. Throwing there is right. Throwing there *first* was not: the write
 * returned 200, and the throw landed at the next dispatch, which is the one
 * moment the seat that wrote it can no longer act.
 *
 * ## The grammar is a MIRROR, and the mirror is pinned
 *
 * `claude_k8s` is an external adapter — loaded from the bundled-adapters
 * directory at runtime, not a workspace dependency of `server/` — so this
 * package cannot import `resolveClaudeCodeVersion` and must restate its
 * grammar. A restatement is a second copy, and a second copy is exactly as
 * complete as the less recently edited one. `claude-code-version.test.ts`
 * therefore parses `EXACT_VERSION_RE` and the `"image"` sentinel OUT OF THE
 * VENDORED SOURCE and asserts they agree with the literals below, the same
 * technique `adapters/model-validation.test.ts` uses to keep its model ids
 * honest. If the adapter widens or narrows its grammar, that test reds.
 *
 * ⛔ Do not "simplify" this to a loose semver check. The admissible set is
 * decided by what is safe to interpolate into a shell command, not by what npm
 * would accept: a range (`^2.1.0`), a dist-tag (`latest`) and a `v` prefix are
 * all legal npm and all refused here.
 */

/** Config sentinel: run the CLI bundled in the container image, no bootstrap. */
export const CLAUDE_CODE_RUNTIME_FROM_IMAGE = "image";

/** The agent-config key this grammar governs. */
export const CLAUDE_CODE_VERSION_CONFIG_KEY = "claudeCodeVersion";

/**
 * Exact npm versions only. Mirrors `EXACT_VERSION_RE` in the vendored adapter's
 * `runtime-pin.ts`; pinned against that source by this module's test.
 */
export const CLAUDE_CODE_EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * True for every value `resolveClaudeCodeVersion` accepts, and nothing else.
 *
 * The three admissible shapes, matching that function arm for arm:
 *   - a non-string, or blank/whitespace  → the adapter's own default version
 *   - `"image"`                          → the image's bundled CLI
 *   - an exact `x.y.z[-prerelease]`      → that version
 *
 * A non-string is admissible because the adapter coerces it the same way
 * (`typeof raw === "string" ? raw.trim() : ""`), so `null` — which is what
 * clearing the field stores — must not be refused on write.
 */
export function isAdmissibleClaudeCodeVersion(raw: unknown): boolean {
  if (typeof raw !== "string") return true;
  const value = raw.trim();
  if (!value) return true;
  if (value === CLAUDE_CODE_RUNTIME_FROM_IMAGE) return true;
  return CLAUDE_CODE_EXACT_VERSION_RE.test(value);
}

/* ---------------------------------------------------------------------------
 * Write-time verdict.
 *
 * Shaped after `adapters/model-validation.ts`, which closes the same defect
 * class for `adapterConfig.model` (PEN-4447): a value accepted at 200 that is
 * not consumed until the next pod boot, so a plausible-but-wrong write kills
 * the lane hours later with nothing linking the dead lane to the write.
 * ------------------------------------------------------------------------- */

export interface InadmissibleClaudeCodeVersion {
  /** The offending value, as stored (trimmed for display only). */
  value: string;
}

/**
 * Does this write INTRODUCE the value, or is it the one already stored?
 *
 * Introduce-only is not a courtesy here, it is what keeps the guard from
 * wedging the very agent it is meant to protect. The PATCH path validates the
 * EFFECTIVE config — stored shallow-merged with the request — so an agent that
 * already holds a malformed version carries it into every later write. Without
 * this test, the first bad value would refuse every subsequent `adapterConfig`
 * write, including the one repairing it, and including writes that never name
 * this key at all.
 *
 * ⛔ Note which direction that makes safe. Tolerating a stored bad value does
 * NOT leave it working: the agent is already undispatchable, by the throw this
 * guard exists to pre-empt. It leaves it REPAIRABLE.
 *
 * No adapter-type term, deliberately, and this is where it differs from
 * `introducesModel`. A model id is only meaningful against one adapter's
 * registry, so re-pointing the agent introduces the pair even when the string
 * is untouched. This grammar is adapter-independent and static — it is decided
 * by shell-interpolation safety, not by a registry that can narrow — so the
 * same string is admissible or not regardless of which adapter reads it.
 *
 * ## `previous` is a LIST of scopes, and that is load-bearing
 *
 * The config handed to the check is a MERGE — on the model-profile path it is
 * `{...agent top-level, ...adapter profile default, ...the profile's own}`. An
 * introduce test is only sound against the SAME scopes that fed the merge: ask
 * one layer whether it already held the value and the other layers' values all
 * read as new. Concretely, before this took a list (PEN-6586 review): an agent
 * storing a malformed top-level version was refused on a `runtimeConfig`
 * model-profile PATCH that never named this key, because the merge carried the
 * stored value forward while `previous` was the profile's config, which had
 * none. That is the exact wedge the paragraph above exists to prevent, reached
 * through a different write path.
 *
 * So: NOT introduced when the value equals the stored value in ANY supplied
 * scope. Equality with any one of them means the agent is already in that
 * state, and refusing repairs nothing — which is the whole introduce-only
 * rationale, applied per scope.
 *
 * ⛔ Do NOT widen `introducesModel` the same way. A model is profile-scoped:
 * the agent's top-level model is not what that profile dispatches with, so the
 * profile's own stored config is the only honest reference. The difference is
 * not stylistic — this key FALLS THROUGH from agent scope and `model` does not.
 */

/** One stored config the merged value could have fallen through from. */
export type ClaudeCodeVersionPreviousScope =
  | { adapterConfig?: Record<string, unknown> | null }
  | null
  | undefined;

function storedClaudeCodeVersion(scope: ClaudeCodeVersionPreviousScope): string | null {
  if (!scope) return null;
  const stored = scope.adapterConfig?.[CLAUDE_CODE_VERSION_CONFIG_KEY];
  return typeof stored === "string" ? stored.trim() : "";
}

export function introducesClaudeCodeVersion(input: {
  value: string;
  previous?: ClaudeCodeVersionPreviousScope | ClaudeCodeVersionPreviousScope[];
}): boolean {
  const scopes = Array.isArray(input.previous) ? input.previous : [input.previous];
  for (const scope of scopes) {
    if (storedClaudeCodeVersion(scope) === input.value) return false;
  }
  return true;
}

/**
 * The write-time check. Returns `null` when the write is allowed.
 *
 * Runs for EVERY adapter type rather than opting in per adapter, which is the
 * opposite of `findUnregisteredAdapterModel` and is deliberate. That guard is
 * opt-in because an adapter whose registry is DISCOVERED can report "absent"
 * when discovery is merely down, so refusing would replace a late failure with
 * an immediate wrong one. There is no discovery here: the grammar is three
 * static shapes, `claudeCodeVersion` has one meaning fleet-wide, and no other
 * adapter defines the key — so an adapter-name allowlist would buy nothing and
 * would silently stop guarding the day the key is read somewhere new.
 */
export function findInadmissibleClaudeCodeVersion(
  adapterConfig: Record<string, unknown>,
  previous?: ClaudeCodeVersionPreviousScope | ClaudeCodeVersionPreviousScope[],
): InadmissibleClaudeCodeVersion | null {
  const raw = adapterConfig[CLAUDE_CODE_VERSION_CONFIG_KEY];
  if (isAdmissibleClaudeCodeVersion(raw)) return null;
  const value = (raw as string).trim();
  if (!introducesClaudeCodeVersion({ value, previous })) return null;
  return { value };
}

/** Human-readable refusal naming the admissible shapes, for the 4xx body. */
export function describeInadmissibleClaudeCodeVersion(
  finding: InadmissibleClaudeCodeVersion,
): string {
  return (
    `Invalid adapterConfig.${CLAUDE_CODE_VERSION_CONFIG_KEY} ${JSON.stringify(finding.value)}. `
    + `It is interpolated into the agent Job's shell command, so it must be an exact version `
    + `such as "2.1.322", or "${CLAUDE_CODE_RUNTIME_FROM_IMAGE}" to use the container image's CLI, `
    + `or empty to take the adapter's default. Ranges ("^2.1.0"), dist-tags ("latest") and a "v" `
    + `prefix are refused. Left unrefused this write would return 200 and then throw while `
    + `building this agent's next Job manifest, which is after the point the agent can revert it.`
  );
}
