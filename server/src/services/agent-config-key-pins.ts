/**
 * Agent `adapterConfig` key pins — the two pinned key sets and their
 * predicates, and NOTHING else.
 *
 * ⚠ THIS FILE IS A LEAF ON PURPOSE, AND THAT IS A SECURITY PROPERTY RATHER
 * THAN A TIDINESS ONE (PEN-6335). It must import nothing from this package.
 *
 * These sets have two enforcement points — the heartbeat's render-time overlay
 * merge, and the AGENT-authored write refusal on `PATCH /api/agents/:id`
 * (`routes/agents.ts`). They lived in `services/heartbeat.ts`, so
 * `routes/agents.ts` reached them through an import of that 2.2 MB module, and
 * any test file that did a TOTAL `vi.mock("../services/heartbeat.js")` replaced
 * them with `undefined` in that suite — leaving the route unable to compute its
 * refusal set.
 *
 * Measured once, first-party: `Blockcast/paperclip#3563`'s
 * `General tests (server 6/6)` went red at head `04b41b0e` with
 * `expected 500 to be 403` on the only two arms that reach the guard's success
 * path, because `__tests__/agent-permissions-routes.test.ts` carried exactly
 * such a mock. It was repaired per-file with `importActual` plus an explicit
 * named re-export list. That repair works and is kept; what it cannot do is
 * reach a test file that does not exist yet.
 *
 * ⛔ The direction that matters is the QUIET one. A dropped export fails LOUD
 * today only because `routes/agents.ts` calls these values directly, so
 * `undefined(...)` throws a 500 that reds a refusal arm and a must-pass arm
 * alike. A future consumer that reads a heartbeat export TOLERANTLY — `?.`, or
 * `?? fallback` — would instead see `undefined`, degrade silently to
 * not-guarding, and leave the suite green. A security control whose coverage an
 * unrelated file's module mock can switch off is one whose next regression
 * lands green.
 *
 * ⚠ ONE DEFINITION, NOT TWO. `AGENT_SCOPE_ONLY_CONFIG_KEYS`'s own maintenance
 * obligation below says it is exactly as complete as its last edit; two copies
 * would be exactly as complete as the LESS recently edited one (PEN-6259 §3).
 * Both enforcement points import from here. Do not re-export these from
 * `heartbeat.ts` for convenience — an importer reaching them through that
 * module is back inside the mock surface this file exists to leave.
 *
 * ⛔ THIS BUYS COVERAGE, NOT IMPORT COST, AND THAT IS NOT A SCOPING CHOICE —
 * IT IS UNACHIEVABLE HERE AT ANY SCOPING. The original proposal expected
 * sharing the definition to also stop `routes/agents.ts` paying for a 2.2 MB
 * import. It does not, and neither would additionally moving
 * `derivePaperclipPrReview` (the one symbol this file deliberately leaves
 * behind): `heartbeat.ts` has FOUR importers inside `routes/agents.ts`'s
 * transitive closure — `routes/agents.ts` itself, `services/index.ts` (which
 * `routes/agents.ts` also imports), `services/companies.ts` and
 * `services/routines.ts` — so cutting any one edge changes that closure by
 * ZERO files and ZERO bytes.
 *
 * Measured 2026-11-10 on this branch and on `master`, first-party, resolving
 * every relative import (`unresolved_relative: 0`): closure(`routes/agents.ts`)
 * = 324 files / 12.99 MB, and identical with the direct edge cut, and still
 * identical with `services/index.ts`'s edge cut as well. The 53-file / 3.3 MB
 * figure PEN-6335 recorded is a NODE-removal delta — what heartbeat's subtree
 * costs if NOTHING in the closure imports it — which needs all four importers
 * to drop it. Controls: a leaf entry reports 15 files / 0.34 MB, this file
 * reports 1 file, and a nonexistent entry reports 0, so the instrument is
 * neither constant nor mute.
 *
 * ⇒ do not claim an import saving for this change, and do not chase one by
 * moving `derivePaperclipPrReview` here. It belongs with the service.
 */

// PEN-5017. The same hazard withAgentScopedEnvProvenance closes for `env`
// keys, one level up: TOP-LEVEL adapterConfig keys that gate a security
// boundary of the rendered pod rather than express a preference.
//
// `enableGitHubPublishBroker` is the first key where it has teeth. It decides
// whether the GitHub push credential is mounted into the agent container or
// into a sidecar at a different uid (PEN-4933 / PEN-3183 D1). It is read off
// the MERGED run config in buildJobManifest, and the merge below overlays
// `issue.assigneeAdapterOverrides.adapterConfig` last with no key allowlist —
// so without this filter, an issue assigned to the agent could carry
// `enableGitHubPublishBroker: false` and render the credential back into the
// agent's own container. An agent can file such an issue against itself, so
// the `assigneeAgentId === agent.id` gate on the overlay is not a mitigation.
//
// A boundary the constrained principal can decline per-run is not a boundary,
// it is a default — and this one would fail silently in the permissive
// direction, because an agent that opted out still publishes perfectly well
// and no metric distinguishes "brokered" from "opted out".
//
// ⚠ MAINTENANCE OBLIGATION. This is a list, so it is exactly as complete as
// its last edit. Add a key here when a top-level adapterConfig key starts
// deciding where a credential lands, what uid runs it, or whether a refusal
// fires — not when it merely changes cost, model or placement. The membership
// is pinned by a test, so adding or removing one is a deliberate act.
//
// Deliberately NOT a throw. Refusing to render would convert a finding that is
// not currently exploitable into a reachable denial of service: any actor able
// to assign an issue could park a guarded key on an issue assigned to another
// agent and brick every dispatch of it. §7.4's "fail closed and loud at
// render, or do not change it" is about silently STRIPPING a credential so
// that publishing fails at a boundary reporting success — the opposite
// direction. Ignoring the overlay renders the pod exactly as agent scope
// specifies and claims nothing false. The "loud" half is kept by logging the
// attempt at the call site (see agentScopeOnlyConfigKeyOverrides).
const AGENT_SCOPE_ONLY_CONFIG_KEYS = new Set([
  "enableGitHubPublishBroker",
  // PEN-4932 stage 4b. Decides WHICH VOLUME the Job mounts: the shared
  // `paperclip-data` claim, or `agent-workspace-<agentId>`. It qualifies on two
  // of the three tests above, and the second is the one that settles it.
  //
  // `what uid runs it` — the claim's identity selects the seeder SHAPE
  // (`selectSeedShape`, job-manifest.ts). On the server's own claim the pod
  // gets one uid-0 `seed-writable-dirs` container; on any other claim it gets
  // the PEN-4932 invariant-4 split, where uid 0 holds `CHOWN` over a single
  // inode and everything else runs at uid 1000 under `drop: ALL`. So declining
  // the key per-issue puts the broader-privileged shape back into the pod.
  //
  // `whether a refusal fires` — and here the DoS runs the OTHER way, which is
  // why this is pinned rather than merely documented. Turning the key ON for an
  // agent that does not run it moves that run onto a FRESH, EMPTY volume: no
  // checkout, no worktrees, no pnpm store, and any uncommitted work in
  // `wt/<companyId>` out of reach for the run. Anyone able to assign an issue
  // could do that to any agent, once per issue, and the run would complete
  // "successfully" having thrown away its workspace. It can also brick a
  // dispatch outright: `selectSeedShape` THROWS on a non-server claim while any
  // read-only subPath is declared.
  //
  // Agent scope is unaffected, which is where the rollout actually happens —
  // this pin stops a LOWER scope reaching the key, in either direction.
  "enablePerAgentWorkspaceVolume",
  // PEN-6247. Decides the Job pod's KUBERNETES IDENTITY.
  // `resolveServiceAccountName` (job-manifest.ts) takes this value verbatim —
  // no allowlist, no pattern — and `buildJobManifest` puts it on the pod spec,
  // so it answers `what uid runs it` in the strongest available sense: not a
  // uid inside the pod, but which principal the apiserver believes the pod is.
  //
  // What makes it belong in the UNCONDITIONAL set rather than the
  // broker-conditional one below: it decides the pod's identity on EVERY run,
  // brokered or not. Nothing about the hazard involves the broker.
  //
  // ⚠ THE CONTAINMENT IS A PROPERTY OF THE VALUE BEING OVERRIDDEN, which is
  // why this is pinned rather than documented. The adapter sets
  // `automountServiceAccountToken` NOWHERE, so the pod inherits it from the
  // ServiceAccount object this key NAMES. Agent SAs carry
  // `automountServiceAccountToken: false` (label
  // `security.paperclip.dev/rbac: unbound`) and measurably mount no
  // `kube-api-access-*` volume at all. Sibling SAs in the same namespace —
  // `paperclip-ci-deploy`, `paperclip-k8s-mcp-admin` — set no such field, so it
  // defaults to TRUE, and the first holds three ClusterRoleBindings. Naming one
  // of those does not merely relabel the pod; it mounts a cluster-RBAC token at
  // /var/run/secrets/kubernetes.io/serviceaccount/token. Overriding the value
  // discards the containment in the same stroke, and no second layer notices:
  // of the namespace's 47 ServiceAccounts exactly two are protected by a
  // `*-serviceaccount-use` ValidatingAdmissionPolicy, each keyed on one literal
  // SA name, and neither matches an agent-job pod.
  //
  // ⚠ CROSS-SEAT, unlike the `allow_self` route PEN-6188 closes, and this is
  // the half that sets the severity. Measured 2026-11-09 (PEN-6274): this seat
  // created an issue ASSIGNED TO ANOTHER AGENT carrying an arbitrary
  // `assigneeAdapterOverrides.adapterConfig` key, and it persisted. The
  // `assigneeAgentId === agent.id` gate on the overlay decides WHICH AGENT THE
  // OVERLAY APPLIES TO, never WHO MAY WRITE IT — so any actor able to file an
  // issue chooses the pod identity of the seat it is filed against. That is
  // why `AGENT_SCOPE_ONLY_CONFIG_KEYS` (taken against the issue overlay) is
  // load-bearing here independently of the route guard.
  //
  // ⚠ Blast radius is NOT nominal, unlike the keys above: an issue overlay can
  // no longer set `serviceAccountName` for ANY run, brokered or not. Measured
  // before landing — see the PR — zero live rows carry the key in an overlay,
  // so the capability being removed is unused. Agent and environment scope are
  // untouched, which is where a per-agent SA is actually configured.
  //
  // ⚠ This is the tourniquet, not the boundary. It constrains paperclip's own
  // write and merge paths and binds no other creator of pods in that namespace,
  // and it leaves the containment resting on a property of the named value. The
  // durable fix is an operator-controlled allowlist consulted by
  // `resolveServiceAccountName`, or a ValidatingAdmissionPolicy over
  // `app.kubernetes.io/component: agent-job` pods — PEN-6248.
  "serviceAccountName",
]);

// PEN-5017, added in review. Keys pinned to agent scope ONLY WHEN the broker
// is on at agent scope, because that is exactly when they stop expressing a
// preference and start deciding whether the broker's uid boundary means
// anything.
//
// `enableDocker` renders the DinD sidecar, and that sidecar is
// `privileged: true, runAsUser: 0` in the SAME POD as the broker. A privileged
// root container defeats an in-pod uid boundary generally — it does not need
// the credential volume mounted to reach uid 1001's filesystem — and the agent
// container is handed the resulting docker socket, so it can start further
// privileged containers with arbitrary host mounts. Pinning the broker's image
// (see `brokerImage` in job-manifest.ts) stops an override choosing the code
// *inside* the boundary; this stops one standing a privileged container up
// *beside* it. `dockerImage` rides along because a pinned `enableDocker` with
// an overridable image is a pin in name only.
//
// ⚠ This closes the LOWER-SCOPE route only — an operator who sets both
// `enableDocker` and `enableGitHubPublishBroker` at agent scope is not reached
// by a provenance pin at all. That residual is no longer open: §7.6 of the
// PEN-3183 decision record (PEN-5026) REFUSES the combination at render, in
// the adapter, by reading the assembled pod spec
// (`findPrivilegedContainersBesideBroker`) rather than by naming a key here.
// So the two halves are: this list stops a lower scope turning it on, and the
// builder refuses it whatever scope turned it on.
//
// The membership rule, so this stays a rule and not a list of incidents: WHEN
// THE CREDENTIAL IS BROKERED, WHAT CODE RUNS IN THE POD, AT WHAT PRIVILEGE,
// AND OFF WHICH VOLUME IS AGENT SCOPE'S TO DECIDE.
//
// `image` is still deliberately NOT in THIS set — the OVERLAY set — and that
// half stands: the adapter resolves the broker's image from the agent row
// alone, allows the agent CONTAINER to diverge on purpose, and ignores rather
// than throws, so pinning it here would buy nothing and could brick a dispatch.
//
// ⛔ But the REASON this comment gave for leaving it out is superseded, and is
// re-quoted one marked line per line so a grep arrival meets the correction
// rather than the claim (PEN-6259, 2026-11-09):
//   SUPERSEDED 2026-11-09: "it is pinned adapter-side for the broker container"
//   SUPERSEDED 2026-11-09: "alone, which is strictly stronger and leaves the"
//   SUPERSEDED 2026-11-09: "agent container's image freely overridable."
// Adapter-side pinning is strictly stronger only against a LOWER scope. It
// pins the broker to `ctx.agent.adapterConfig.image` — the agent ROW — and
// PEN-6188 measured that row to be self-writable by the subject agent through
// `allow_self`. So the point of use pins the broker to a value the constrained
// principal can choose, which is the one direction that pin cannot cover.
//
// The remedy is the WRITE side, not this one: `agentActorUnwritableConfigKeys`
// below refuses an agent-authored write of `image` on the agent row, while this
// set keeps deciding only which scope wins at render. Two questions, two sets.
//
// Add a key here when it answers the question above and cannot be pinned at
// the point of use. Add it to the write-side set instead when the question it
// answers is WHO MAY SET IT, not WHICH SCOPE WINS.
//
// PEN-5027 adds the third clause and `workspaceVolumeClaim` under it.
// `buildJobManifest` narrows the shared data volume to read-only and re-mounts
// a few trees rw by `subPath` only when the Job's claim IS this server's own
// (`narrowWritableSurface`: `dataClaimName === selfPod.pvcClaimName`). The
// broker's pre-push hook lives on that volume, so under the broad fallback
// uid 1000 could rewrite the code the credential holder runs — which is why
// the adapter REFUSES to render a brokered pod on a broad mount
// (job-manifest.ts, the `enableGitHubPublishBroker && !narrowWritableSurface`
// throw). An issue-scope `workspaceVolumeClaim` naming any other claim is
// therefore not a preference: on a brokered agent it fails that agent's
// dispatch at manifest build, and anyone able to assign it an issue can do it.
// That is the same per-issue denial of service AGENT_SCOPE_ONLY_CONFIG_KEYS
// declines to create above, reached by a different key — discarding the
// overlay closes it the same way, and for the same reason.
//
// ⚠ An ENVIRONMENT-supplied claim must still win, and does: the environment
// overlay is applied DOWNSTREAM of this merge, by `mergeEnvironmentConfig` in
// the adapter's own execute.ts, over the config this function returns. That
// ordering is what makes the discard safe here and is a property of the SITE,
// not of this list — moving this guard adapter-side would have to re-establish
// it explicitly (PEN-5027 constraint 1).
//
// ⚠ Not pinned when the broker is OFF, where a foreign claim merely forgoes
// the subPath narrowing with a `claude_k8s.data_mount_broad_rw` warn and no
// throw. Whether an issue should be able to choose the data volume at all is a
// wider question about the override surface; it is deliberately not answered
// here.
//
// ⚠ The cost, stated: an issue override cannot request docker, or choose the
// data volume, on a broker-enabled agent. That is a real capability loss. It
// is accepted because it is narrow — both stay freely overridable for every
// agent not running the broker, which is the whole fleet today.
//
// The two keys differ in what agent scope buys back, and §7.6 is why. For
// `workspaceVolumeClaim` the loss is close to nominal: an agent that needs a
// particular data volume for brokered work can have it set at agent scope, and
// in any case the only value that renders a brokered pod at all is the
// server's own claim — which is what the agent already resolves to without the
// override. For `enableDocker` agent scope buys back NOTHING: §7.6 refuses the
// brokered + privileged combination at render regardless of which scope asked
// for it. Discarding the overlay there turns a refusal into a working pod
// without docker, which is the kinder failure, not a way to obtain docker.
const BROKERED_POD_COMPOSITION_CONFIG_KEYS = new Set([
  "enableDocker",
  "dockerImage",
  "workspaceVolumeClaim",
]);

/**
 * Is the publish broker on at AGENT scope?
 *
 * ⚠ Mirrors the adapter's own read exactly: `buildJobManifest` uses
 * `asBoolean(config.enableGitHubPublishBroker, false)`, and `asBoolean` is
 * strict — `typeof value === "boolean" ? value : fallback` — so a string
 * `"true"` is `false` there and must be `false` here. If the two drift, this
 * returns `false` for a pod the adapter does broker and the composition keys
 * silently stop being pinned, which is the permissive direction.
 *
 * Read off `baseConfig`, not the merged config: the answer must not depend on
 * an overlay. `enableGitHubPublishBroker` is itself pinned, so the two agree
 * by construction — reading the base makes that independent of the order the
 * keys happen to be visited in.
 */
function brokerEnabledAtAgentScope(baseConfig: Record<string, unknown>): boolean {
  return baseConfig.enableGitHubPublishBroker === true;
}

/**
 * The pinned key set for this run: the unconditional keys, plus the
 * brokered-pod composition keys when the broker is on.
 *
 * Exported for `routes/agents.ts`, which refuses an AGENT-authored write of
 * these same keys on `PATCH /api/agents/:id` (PEN-6188). The two enforcement
 * points share one definition on purpose: this list's own maintenance
 * obligation above says it is exactly as complete as its last edit, and two
 * copies of it would be exactly as complete as the *less* recently edited one.
 */
export function agentScopeOnlyConfigKeysFor(baseConfig: Record<string, unknown>): ReadonlySet<string> {
  if (!brokerEnabledAtAgentScope(baseConfig)) return AGENT_SCOPE_ONLY_CONFIG_KEYS;
  return new Set([...AGENT_SCOPE_ONLY_CONFIG_KEYS, ...BROKERED_POD_COMPOSITION_CONFIG_KEYS]);
}

// PEN-6259. Keys an AGENT ACTOR may not write on an agent row, over and above
// the overlay-pinned set — today just `image`.
//
// UNCONDITIONAL, deliberately, where the composition keys above are
// broker-conditional. The conditional form has a write-ordering hole that the
// overlay form does not: the refusal set is computed against the config AS
// STORED, so with the broker off (the whole fleet today) `image` would not be
// in the set, an agent could set it freely, and an OPERATOR flipping
// `enableGitHubPublishBroker` later — exactly what the D1 rollout does —
// would promote that already-stored agent-chosen value into `brokerImage`.
// The pin would be evaluated at a moment when it does not yet apply, against a
// value that is still there when it does.
//
// ⚠ That is NOT a defect in the existing conditional. Computing against the
// stored config is sound for the composition keys because
// `enableGitHubPublishBroker` is itself unconditionally pinned, so the AGENT
// cannot move the conditional's own input. An OPERATOR can, and may — this set
// is what makes that safe.
const AGENT_ACTOR_UNWRITABLE_EXTRA_CONFIG_KEYS = new Set([
  // Becomes the broker container's image (`brokerImage`, job-manifest.ts),
  // which execs the publish hook with the GitHub push credential in its
  // environment at uid 1001. No image allowlist exists at any layer, so a
  // self-written `image` on a brokered agent is a choice of what code holds
  // the credential.
  "image",
]);

/**
 * The key set an AGENT-authenticated write of an agent row may not change:
 * `agentScopeOnlyConfigKeysFor` plus the write-side-only keys above.
 *
 * Defined in terms of that function rather than beside it, so there is still
 * ONE list to maintain — the anti-drift property the overlay set's own comment
 * argues for ("two copies would be exactly as complete as the less recently
 * edited one") is preserved, not forked.
 *
 * The two sides answer different questions and `image` is the first key where
 * the answers differ:
 *   - OVERLAY (`agentScopeOnlyConfigKeysFor`): which SCOPE wins at render?
 *   - WRITE  (this): may this PRINCIPAL set the agent row at all?
 * The write side is strictly stronger than the overlay side, always — so this
 * is a superset by construction and must never be the smaller of the two.
 *
 * ⚠ Scope, stated because it is a decision and not an oversight: this is for
 * the TOP-LEVEL agent `adapterConfig` only. A model-profile `adapterConfig`
 * does not feed `brokerImage` — the adapter reads the broker's image off the
 * agent row verbatim — so refusing `image` there would cost a capability and
 * close no hazard. `routes/agents.ts` passes `configScope` to say which it has.
 */
export function agentActorUnwritableConfigKeys(
  baseConfig: Record<string, unknown>,
): ReadonlySet<string> {
  return new Set([
    ...agentScopeOnlyConfigKeysFor(baseConfig),
    ...AGENT_ACTOR_UNWRITABLE_EXTRA_CONFIG_KEYS,
  ]);
}

/**
 * Keys an overlay supplied that the merge will NOT honour. Exported so the
 * dispatch path can log the attempt: the guard below is silent by design, and
 * a security boundary that quietly discards input is one an operator cannot
 * tell from one that was never tested.
 *
 * Takes `baseConfig` because the pinned set is run-dependent (see
 * BROKERED_POD_COMPOSITION_CONFIG_KEYS) — the caller must report what was
 * actually refused for THIS run, not what would be refused for some run.
 */
export function agentScopeOnlyConfigKeyOverrides(
  overlayConfig: Record<string, unknown> | null | undefined,
  baseConfig: Record<string, unknown>,
): string[] {
  if (!overlayConfig) return [];
  const pinned = agentScopeOnlyConfigKeysFor(baseConfig);
  return Object.keys(overlayConfig).filter((key) => pinned.has(key));
}
