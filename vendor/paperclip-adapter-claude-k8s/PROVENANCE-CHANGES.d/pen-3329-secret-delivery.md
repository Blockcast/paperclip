# [PEN-3329](https://paperclip.blockcast.net/PEN/issues/PEN-3329) — round two

## The path could never have crossed, so the content travels instead

Follows `pen-3329.md` in this directory, which recorded round one. A separate entry
rather than an edit of that one: entries are the per-change unit of record here and
`check-vendored-provenance-log.mjs` requires each vendored change to ADD one, which is
what keeps two concurrent PRs from conflicting on a single file.

**Files:** `src/server/shared-doc-overlay.ts`, `src/server/shared-doc-overlay.test.ts`, `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`, `src/server/execute.ts`

Round one shipped, deployed, and ran correctly — and delivered nothing. Measured
first-person from a live `isolation-mode: run` pod on 2026-10-29, agent image
`sha-ed39009-k8s-vendored` (the merge commit of round one), with
`paperclip-api` on `3ddaae37`:

```
[paperclip] shared doc docs/architecture-template.md is absent from the execution workspace; …
[paperclip] shared doc docs/definition-of-done.md    is absent from the execution workspace; …
   … all 14, one line each
```

So every part of the mechanism worked: the server declared the set, the adapter parsed it,
the step was spliced after `workspaceSetup`, the loop ran, and — as designed — it reported
each failure and stepped over it rather than failing the pod. The probe in the pod's own
cwd then read `0 entries`, `docs/definition-of-done.md ABSENT`, and
`find /paperclip -name definition-of-done.md` → nothing anywhere in the pod.

**The error was the mechanism, not the wiring.** The copy reads `$__pcdocs_src/$__pcdoc`
where `__pcdocs_src` is `overlay.sourceCwd` — the *server's* execution workspace,
`/paperclip/instances/default/projects/<company>/<project>/<repo>`. That path does not
exist inside a run-isolated pod. `/paperclip/instances/default` is an `emptyDir`
(`instance-overlay`, 16 MiB), and only named PVC subPaths are re-mounted over it:
`skills/`, `data/k8s-isolation/.../prompt-cache/<hash>`, `data/run-logs/...`, `work/`,
`wt/`. The projects tree is not among them, and
`/paperclip/.paperclip/instances/default/companies/<company>/` mounts only `agents/<agent>`,
so the company-root `docs/` is not reachable either.

That is not a mount list to correct. **Not mounting the server's execution workspace is
what `run` isolation IS**, so the first fix was asking the pod for something it must not
have — and the same invisibility explains the empty cwd: `workspaceSetup`'s repository test
also fails against an unreachable source, so it takes the `rm -rf` + `mkdir -p` branch and
no clone happens at all. A path cannot cross that boundary. Only content can.

So the bodies travel with the Job. The server reads each document where the files
demonstrably are and publishes them on `paperclipSharedDocs.contents`; the adapter stages
them as a per-Job Secret and projects them back to their repo-relative layout with
`secret.items`; the copy loop reads from that mount. This is the same channel `mcp.json`
already uses "regardless of size" (BLO-17980/BLO-17973), chosen for the property that
matters here: **delivery depends on the Job alone, not on which host paths the pod
happens to mount**, which is the exact dimension the path-based attempt was fragile on.
Lifecycle rides alongside the existing per-run Secrets — created before the Job, owner-ref
patched, and deleted on every completion, failure and retain path, including the
reattach-after-restart path, which recovers the Secret name off the live Job's volume list
because it has no build result to consult.

Four things worth recording, each pinned by a test:

* **The keys are positional (`doc-0`, `doc-1`, …), not derived from the path.** A Secret
  key may only contain `[-._a-zA-Z0-9]`, so a path has to be transformed — and the obvious
  transform, `/` → `__`, is *not injective* over the charset `isSafeSharedDocPath` admits:
  `docs/a/b.md` and `docs/a__b.md` are both legal and collide on one key, which would serve
  one document's body under the other's name. `items[].path` carries the real layout
  anyway. A test asserts those two paths stay distinct; restoring the encoding reddens it.
* **The failure asymmetry is deliberate.** In the pod a document must never be able to fail
  a bootstrap, so every error is still reported and stepped over and the step still ends
  `true`. On the server the Secret create *does* fail the run, because the Job references
  it with `optional: false` — if it is missing the pod cannot start and would sit at
  `CreateContainerConfigError` until the run timed out. Failing immediately with a named
  error (`k8s_shared_docs_secret_create_failed`) is strictly better than that.
* **Deploy skew is handled in both directions.** `contents` is optional: a newer adapter
  against an older server stages no Secret and keeps the path copy, which is still correct
  for any pod that *does* mount the workspace. Mounting an empty Secret with
  `optional: false` would wedge the pod, so "no bodies" must mean "no volume".
* **Budgeted on the server.** A Secret is capped at 1 MiB encoded, and `stringData` is
  base64-expanded 4/3, so the raw ceiling is nearer 768 KiB. Caps of 128 KiB per document
  and 512 KiB total sit under it; an over-budget or unreadable document is dropped from
  `contents` while staying in `paths`, so the pod names it undelivered instead of a short
  set shipping silently.

The verdict line changed with the mechanism — `is absent from the execution workspace` is
no longer true of what is being read, so it now reads `was not delivered to this pod`.

**The lesson this file exists to carry:** the first round was tested end-to-end against a
real `git clone --shared`, a real `/bin/sh` and a real repository, and it passed — because
every one of those tests supplied a source directory that existed. The untested premise
was the one that failed, and nothing in a green suite could have said so. The regression
test for this round therefore spells the production shape directly: a `sourceCwd` under a
path that was **never created**, asserted absent before the run, with a staged mount beside
it — plus a control that reproduces the defect by omitting `sourceDir`, so the fix cannot
quietly stop applying.


## Review response (Ally, head `2f6ff86ac`)

Three findings, all taken.

**The bodies no longer ride on the persisted run context.** `materializeExternalK8sSharedDocs`'
overlay is set on `context`, and `context` is written verbatim into
`heartbeat_runs.context_snapshot` at roughly fifteen call sites, so `contents` would have
turned a few-hundred-byte path list into a per-run copy of every company doc in the JSONB
column migrations 0079/0080 worked to keep under the detoast threshold. Nothing ever read
the bodies back out of a snapshot — they are transport only. `context` now carries
`sourceCwd` + `paths` via a new `omitSharedDocContents`, and the bodies are re-attached to
`adapterContext`, the same not-persisted seam `paperclipManagedMcp` already uses. Stripping
at each write site was the other option and was rejected: that is a list to keep in sync
with every future write, where keeping the field off `context` cannot drift.

**The strand analysis in `createOrAdoptRunSecret` was stale and is now correct.** Its
comment enumerated which Secrets can leave a key behind under merge-PATCH adoption and
concluded "only reachable for the env Secret — `prompt.txt` and `mcp.json` each carry a
single fixed key". The shared-docs Secret has a variable key set too (`doc-0`…`doc-N`), so
that enumeration stopped being true the moment this change landed. Corrected rather than
annotated. The residual is a retry whose doc set SHRANK leaving surplus high-index keys;
it is inert, by a different mechanism than the env Secret's: the Job projects through an
explicit `secret.items` list built in the same loop, from the same build result, as the
data — so it names exactly the current set's keys and a stranded `doc-N` is never mounted.
Note the adopt PATCH does refresh every key it sends, so an adopted Secret never serves a
stale body; only a no-longer-present key can survive.

Also in this round: a server-side regression test pins the persisted shape
(`heartbeat-shared-doc-contents-not-persisted.test.ts`). Mutation-checked per BLO-34263 —
an in-place `delete overlay.contents` and a `contents: undefined` spread each fail it, the
first because the adapter would then be handed a stripped overlay and deliver nothing
(round one's exact failure), the second because an own key set to undefined survives a
structured clone and reads as "delivered, empty".
