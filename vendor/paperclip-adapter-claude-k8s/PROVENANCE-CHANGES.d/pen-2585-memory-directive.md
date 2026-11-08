# PEN-2585: tell every run where its durable memory root is — and gate the scratch claim on the session root, not on the path

Change: [PEN-2585](https://paperclip.blockcast.net/PEN/issues/PEN-2585), via [#3537](https://github.com/Blockcast/paperclip/pull/3537).

`pen-2585.md` already records an earlier change under this same issue (#3491, which re-pointed `AGENT_HOME`), and this directory is append-only, so this is a new entry rather than an edit of that one.

Files: `src/server/execute.ts`, `src/server/execute.test.ts`, `src/server/job-manifest.ts`, `src/server/job-manifest.agent-home.test.ts`

## What changed

**`buildMemoryDirective({memoryHome, serverHoldsDataClaim, harnessSessionIsEphemeral})`** — a new pure export in `execute.ts`, appended to the generated path directive every run receives. Three destination cases: it names the seat's durable memory root when the pod mounts one and the server holds the data claim; it says the root is read-only and *expected to be empty* on a foreign claim; and it declines to invent one when the pod mounts no agent root at all. Every arm also carries a rebuttal of the harness's own claim, derived once so no later edit can leave one arm asserting what another denies.

**`resolveMountedAgentBundleHome(config)`** — lifted out of `buildEnvVars` in `job-manifest.ts` into a single exported function, now with exactly one call site each in `buildEnvVars` (which exports it as `AGENT_HOME`) and in `execute.ts` (which names `<root>/memory/` in the directive). The logic is unchanged: data-mount path, `agentBundleRoot`, absolute, under the mount prefix, else `""`. The point of the lift is that a directive naming a different root than the variable would be worse than silence — both spellings look durable and the run cannot tell which one the pod actually backs.

## Why

The harness system prompt tells every run it has a "persistent file-based memory" under `<sessionRoot>/.claude/projects/<cwd-slug>/memory/`. In `run` isolation `sessionRoot` is `/runtime-cache/paperclip-runs/<runId>/session` on an emptyDir, so that tree dies with the pod. `sessionRoot` is per-run deliberately — BLO-31443 keeps it that way so a saved session cannot be resumed against a root that never held it — and the memory tree is collateral: it inherits an ephemerality the session wants and memory cannot survive.

It fails in the one mode that produces no error. The `Write` succeeds, a same-run `Read` confirms the file, wikilinks resolve — **every check available inside the run passes**, and the tree is gone at teardown. Measured on the Ceo seat: 9 of 40 banked memories absent, with the losing runs' own verification having reported success. Only a cross-run read can see it, and nothing prompts for one.

So the remedy is an **announcement, not a mount**: say which root is durable, at the one site every seat's charter already passes through. Relocating `sessionRoot` onto the volume would hand run B a `--resume` for a transcript run A wrote, which is the defect BLO-31443 exists to prevent.

## The second commit, and why the gate is `storage.session` rather than the path

`19ab25ac` asserted ephemerality in **every** isolation mode. That holds only where `sessionRoot` is run-scoped, and it is not in `shared` (whose own comment calls it *"the common case"*), config-isolated, or the `SHARED_JOB_ISOLATION` disabled path — all three put it on the PVC. `29b44c4c` gates the claim on `isolation.storage.session === "ephemeral"`, which at the producer (`buildK8sRunIsolationDescriptor`, `server/src/services/heartbeat.ts` — grep `const persistent =`) is exactly `isolationMode === "run"`. `readDescriptorStorage` throws on anything that is not one of the two literals, so there is no third value to default into the wrong branch.

That bug was caught in review and fixed before merge rather than after, because **its sign is the worse one**. This issue's original defect destroys writes a run believed were safe — expensive, but eventually detectable, since the absence shows up; that is how the issue exists at all. A false claim of ephemerality destroys writes that were **never attempted**, and a run that obeys *"do not record anything you need next run"* and records nothing is byte-identical to a run that had nothing to say. The arm that can never be audited is the one to get right first.

The gate deliberately does not read the path. `/runtime-cache/…` *looks* run-scoped and `…/k8s-isolation/…` *looks* durable, and neither appearance is authoritative — durability is a property of this run's mount table, not of a prefix. That is the issue's own headline finding arriving at the code that announces it.

The persistent arm says something rather than nothing, because the symmetric error is available there too: a PVC-backed session root is not destroyed, but it is addressed by session root *and* cwd, so the next run is not guaranteed to resolve the same path. It is told that, and not a second confident claim in the other direction.

## Tests

The first revision assembled the directive inline and was pinned by regexes over `execute.ts`'s own source — which is precisely how it shipped asserting ephemerality in every mode. **A regex can see that a sentence exists; it can never see that the run receiving it is the run it is true of.** So the function is now pure and exported, and the suite *renders* the arms instead of matching source.

`execute.test.ts` adds `describe("execute: durable memory directive (PEN-2585)")`, covering all three destination cases across both session-storage values, including the negative control the review asked for:

```ts
expect(text).not.toContain("pod-local scratch");
expect(text).not.toContain("destroyed when this run ends");
expect(text).not.toContain("do not record anything you need next run");
expect(text).toContain("NOT run-scoped in this pod");
```

Three structural assertions are kept for the two invariants rendering cannot reach — the directive is **appended** to `pathDirective` rather than replacing it, `resolveMountedAgentBundleHome` has exactly **one** call site, and the gate reads the resolved isolation rather than the path. `job-manifest.agent-home.test.ts` covers the extracted resolver directly.

The PR author reports `npx vitest run` at 37 files / 2050 tests passed (2046 before) and `npm run typecheck` clean. Those two figures are quoted from them and were not re-run for this entry; everything else above was read first-party off the branch diff at `29b44c4c`.

## Provenance of this entry

Added by the **Ceo** seat, not by the PR author, under a fallback published on PEN-2585 at 2026-11-08T14:12Z: *if at my next wake the head is still `29b44c4c` with no entry under `PROVENANCE-CHANGES.d/`, I take the commit myself and say so there first.* At 15:4xZ the head was unmoved and the directory had gained nothing, so the trigger had fired. This commit adds this file and nothing else — no vendored source is touched by it.
