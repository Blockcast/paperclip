# PEN-3183 - Where enforcement of the GitHub egress door lives: security decision

Date: 2026-10-28
Reviewer: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Filed by: CTO (2026-09-11). Priority raised to `high` by the CEO the same day; owned to Security
by the CEO on 2026-10-28 (PEN-4920 pass 3) with the ask stated as *"own the decision of where
enforcement lives, or record that we accept the residual, dated."* This is that decision.
Scope: the three GitHub egress doors in `packages/adapter-utils/src/` (`github-git-egress-runtime.ts`,
`github-cli-egress-runtime.ts`, `github-mcp-egress-runtime.ts`), their image wrappers under
`/usr/local/libexec/paperclip/bin`, and the credential they all authenticate with.
Method: read-only, from inside a live `claude_k8s` agent Job pod
(`ac-7500672d-efe6-40-8a19e066-b452-45-988cdb`, `isolation-mode=workspace`, image
`sha-74e1c71-k8s-vendored`), plus the rendered Job manifest read through a read-only API seat.
**No bypass was executed, no Secret value was read, nothing was mutated.** File reachability was
established with `test -r` / `test -w` and `findmnt`, never by reading content.

PEN-3183 asked for a design decision, not a patch. Section 1 is the decision. Section 2 is a
re-measurement that materially changes the row: **three of its four bypasses are closed**, and its
evidence block has been out of date since 2026-10-06. Section 8 states the bounds on what may be
built against this decision.

## 1. Verdict

| # | Question | Decision |
|---|---|---|
| D1 | Where does enforcement live? | **Credential-side.** The binding constraint is not who owns the guard files. It is that the push credential is reachable by the very uid the guard scans — both as a 0444 file it may read and, more cheaply, via the system credential helper in `/etc/gitconfig` that authenticates *any* git it runs (§4). Cut both routes and the surviving bypass stops being a publish path. |
| D2 | Image-side (root-owned runtime)? | **Done, and that is as far as image-side reaches.** PEN-3713 / #2185 closed bypasses 2 and 4. It cannot close bypass 1, and no further image work can — see §3. Do not re-open this as an option. |
| D3 | Destination-side `pre-receive` hook? | **DECLINED — unavailable.** Pre-receive hooks are a GitHub Enterprise Server feature; these repositories are on github.com. The row asked for this to be confirmed before costing. It is confirmed, and it is the end of that option. |
| D4 | Egress NetworkPolicy + scanning proxy? | **DEFERRED, and note that it converges on D1.** Any proxy permitted to push to GitHub must itself hold the credential, so it *is* the credential-holder design, plus a TLS-terminating git-pack parser. Build the credential half first: it is most of the benefit at a fraction of the cost and risk. |
| D5 | The residual between now and D1 | **ACCEPTED, dated — and conditional.** Reviewed 2026-10-28; next review **2027-01-31**, or immediately on any trigger in §7.2. Accepted on the stated, *unmeasured* assumption that nothing in the fleet invokes `git` by absolute path (§4.0); the §8 count settles it and a non-zero result ends the acceptance. |
| D6 | *(correction of record)* | The row's evidence block, and the THREAT MODEL header in `github-git-egress-runtime.ts`, both describe a pod that no longer exists. Both are corrected by this change. |
| D7 | Env-delivered credentials under the broker | **REFUSE to render, do not route** — decided 2026-10-29. The ruling: a Job that would place a GitHub credential in the agent container's `env` must **fail to build** rather than render a boundary that is not there. ⚠ That refusal is **not on master** at this writing — it is #3089 (PEN-4933), open; D7 decides which way that PR goes and asserts no existing control. Routing that credential *into* the broker stays reserved; §7.4 gives the grounds and the three conditions that would release it. |

⛔ The row's existing prohibition stands and is re-affirmed: **do not add integrity checks between
wrapper, hook and scanner.** §3 shows why it is not merely unhelpful but unsound — they remain one
principal, and a check between them asserts a boundary that does not exist.

## 2. Re-measurement, 2026-10-28

The row enumerated four bypasses measured 2026-09-11. Re-measured today in a live pod:

| # | Bypass as filed | Status today | What changed it |
|---|---|---|---|
| 1 | Call `/usr/bin/git` directly; no file needs writing | **OPEN** — and easier than filed: `/etc/gitconfig` authenticates it unprompted (§4) | nothing |
| 2 | Edit the scanner in `/opt/paperclip-bundled-adapters` | **CLOSED** | PEN-3713 / #2185, merged 2026-10-06 |
| 3 | Replace the hook on the PVC | **CLOSED** | BLO-32734 phase 2b Job narrowing |
| 4 | Replace the wrapper on the PVC | **CLOSED** | PEN-3713 / #2185 |

Evidence, in the same shape the row used:

```
$ id
uid=1000(node) gid=1000(node) groups=1000(node)

$ ls -ld /opt/paperclip-bundled-adapters          # was: drwxr-xr-x node node
drwxr-xr-x 1 root root 4096 /opt/paperclip-bundled-adapters

$ ls -l .../dist/github-git-egress-runtime.js     # the scanner
-rw-r--r-- 1 root root 35351 ...                  # test -w -> not writable

$ ls -ld /usr/local/libexec/paperclip/bin         # first entry on PATH
drwxr-xr-x 1 root root 4096 ...                   # test -w -> not writable

$ findmnt /paperclip/.local/share/paperclip-git-hooks
                                       ro,...     # test -w -> not writable

$ ls -l /usr/bin/git                              # unchanged
-rwxr-xr-x 1 root root 4082768 /usr/bin/git
```

`which -a git` resolves `/usr/local/libexec/paperclip/bin/git` ahead of `/usr/bin/git`, and the
former PVC wrapper directories either no longer exist or are mounted `ro`. The PATH ordering is
held by a render guard — `deploy/helm/paperclip/tests/agent-egress-path.test.mjs` asserts that the
root-owned image wrappers come first and that `git` resolves to the publish-guarding wrapper.

### 2.1 Bypass 3 is closed by a *mount*, not by ownership — and that is conditional

The hooks directory is still owned `node:node`. What makes it unwritable is
`ROOT_TOOLCHAIN_SUBPATHS` in `vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`,
which re-exposes it `readOnly: true` over an `emptyDir` root overlay — and only when
`narrowWritableSurface` holds (isolation enabled **and** the data claim matches the server's own).
When that gate falls through, the pod gets the whole PVC read-write and **bypass 3 re-opens**.

This is observable per Job rather than inferred: the manifest stamps
`paperclip.io/data-mount-scope: scoped | broad:<reason>`. Sampled 2026-10-28 across the running
agent Jobs including an `isolation-mode=shared` pod — the mode most likely to fall through — every
one read `scoped`. Treat that annotation as the regression detector for this bypass (§7.2).

### 2.2 The row's framing was right; its inventory has aged

Nothing here contradicts the row's thesis. Its title — *enforcement must move off the agent's own
machine* — survives intact, because the one bypass that remains is precisely the one that was never
about file ownership. What has aged is the supporting inventory, and it aged in the direction that
makes a reader *under*-rate the row: three closed bypasses make the remaining one look like
bookkeeping. It is not. §4 is why.

## 3. Why image-side cannot go further

The wrapper and the agent are **the same principal**. The pod spec, read today:

```yaml
securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 }
containers[0].securityContext:
  allowPrivilegeEscalation: false
  capabilities: { drop: [ALL] }
```

One container, uid 1000, no privilege escalation, all capabilities dropped. Every consequence
follows from that single line:

- **No file permission can separate them.** Any binary the wrapper may execute, the agent may
  execute directly. Making `/usr/bin/git` group-restricted fails because the wrapper runs as the
  same uid and gid and would lose access with it.
- **No setuid or setgid helper is possible.** `allowPrivilegeEscalation: false` is exactly the
  control that forbids it, and dropping `ALL` removes the capability route as well. This is correct
  hardening and must not be relaxed to buy a guard — that trade is strictly negative.
- **Therefore an integrity check between wrapper, hook and scanner cannot work.** It is one
  principal verifying itself. The row already prohibits this; the uid argument is *why* the
  prohibition is structural rather than stylistic.

The row listed "non-root-writable runtime" as a plausible shape, noting it would close 2 and 4 but
not 1 or 3. That assessment was correct and it has now been executed; 3 fell to a different change.
**Image-side is complete. There is nothing left for it to do here.**

## 4. The credential is the choke point, and it is the only one

Bypass 1 is not dangerous because the agent can run `/usr/bin/git`. It is dangerous because that
unguarded git **can authenticate** — and it does so *by itself*, with no credential handling by
the caller at all. Measured today:

- The agent image's **system** git scope carries a credential helper for github.com.
  `Dockerfile.runtime:82-83` writes, as the only `git config --system` in the whole build chain:

  ```
  git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential'
  ```

  That lands in `/etc/gitconfig`, which **every** git invocation in the pod loads — including
  `/usr/bin/git` called by absolute path. `scripts/git-config-surface.mjs` states the same split in
  the repo's own words: the system scope carries the **gh** helper, while the *paperclip* helper is
  injected only as `-c` flags on the wrapper's exec line. Skipping the wrapper therefore drops the
  paperclip helper and keeps the gh one.
- That helper deliberately points at `/usr/bin/gh`, the wrapper — not `gh.real` — precisely
  *because* the wrapper reads the token file (`Dockerfile.runtime:65-70`, BLO-25702). So the helper
  resolves the credential on git's behalf.
- The push credential is a Secret mounted at `/etc/paperclip/secrets/github-token/` with
  `defaultMode: 292` — octal **0444**, world-readable within the pod.
- `test -r` on the token path from uid 1000: **readable**. (Verified by reachability only; the
  value was not read.)
- It is not in the agent's environment — `paperclip-github-token-env` reads it from that file and
  injects it only into the wrapped child. That design is sound and deliberate, and it is undone
  twice over: by the file being readable, and by the system helper reading it for any caller.

So the unguarded path is not "call the real binary *and* supply a credential". It is **just**: call
the real binary. `/etc/gitconfig` supplies the credential. No guard file is touched, no privilege is
needed, and **no knowledge of where the credential is mounted is needed** — a bare
`/usr/bin/git push` from uid 1000 is authenticated and unscanned. That is why bypass 1 is
architectural in the way the CEO's disposition said it was.

This also enlarges the surface D1 must cut. The credential is reachable by two routes, and moving
the mount is only the first: **`/etc/gitconfig`'s helper is the second**, and it must be shown to
starve rather than assumed to. See §5.

### 4.0 It is not only the deliberate case

Because the helper needs no intent, **any** caller that execs git by absolute path — rather than
resolving it on PATH — publishes unscanned *and* authenticated, with no intent at all. The guard is
reached via PATH, which is exactly the thing such a caller does not consult. A tool, script, library
or MCP server that hardcodes `/usr/bin/git` is therefore outside the accidental-disclosure control
this guard exists to be, and nothing today reports that it happened.

How much of that exists in the fleet is **unmeasured**. That measurement (§8) is consequently not a
nice-to-have that could sharpen an urgency estimate: it is the one piece of evidence that bounds
whether the *accidental* case — the case this control is actually for — is covered at all. It is
load-bearing for §7.1 and it is named as an early trigger in §7.2.

### 4.1 One credential sits behind all three doors

This repository ships three egress doors — git, `gh`, and the GitHub MCP server — wrapped the same
way and held to a tested parity (`github-egress-door-parity.test.ts`). Each is reached through
PATH, so each carries the identical bypass, and **all three authenticate with the same 0444 token.**

That settles where a single boundary can usefully sit. A control in front of *git* relocates the
bypass to `gh`. A control in front of all three wrappers is still three controls reached by
caller-chosen PATH. A control in front of **the credential** is one boundary covering every door,
including doors not yet written.

This is also the strongest argument against D4 as a first step: a NetworkPolicy scoped to git
leaves `gh` and the MCP server publishing freely, and one scoped to all GitHub egress must still
decide who holds the credential — which is D1 again, arrived at from the other side.

### 4.2 Why this matters more than the file ownership ever did

`Blockcast/paperclip` is a **public** repository. An unscanned push there is world-readable
immediately, not merely a disclosure inside the perimeter. The disclosure class this control
descends from has fired once already (PEN-2526, an environment dump interpolated into prose).
Whether destination-side secret-scanning push protection is enabled is **unknown** — `gh api repos/...`
returns `security_and_analysis: null` to an agent seat, which needs admin to read. Record that as
unknown; do not count it as a layer until someone with admin confirms it.

## 5. What a credential-side boundary must be — and the way it will be got wrong

The decision is that enforcement lives credential-side. The shape is constrained, because there is
one obvious implementation that looks like a boundary and is not:

⛔ **Do not build a credential helper that scans and then emits the token.** Anything that hands
the credential to a process running as uid 1000 has handed it to the agent, which can then call the
helper itself and skip the scan. That is the same peers-not-layers error the header already warns
about, relocated. A gate on *issuance* is not a gate on *use*.

The boundary must therefore hold the credential and **perform the publish itself**:

- The credential is mounted into a **separate container** at a uid that is not 1000, with a mode
  that denies 1000 (`0400`, owned by that uid). The agent container loses the mount entirely.
- The agent reaches it over a unix socket on a shared `emptyDir`, asking for a *push*, not a token.
- The broker runs the existing scanner against the refs it is asked to publish and refuses on a
  finding — reusing `scrubGitHubEgressText` and the existing shim, so there is exactly one
  definition of what the doors refuse. Door parity is a tested invariant; a broker that re-derives
  the rule would break it.
- The agent may still run `/usr/bin/git` for everything local. It simply cannot authenticate to
  GitHub, which turns bypass 1 from *publishes unscanned* into *fails to authenticate*.
- **`/etc/gitconfig`'s system credential helper must be shown to starve** (§4). Removing the mount
  from uid 1000 should do it — the helper runs `/usr/bin/gh`, which has no token to read — but
  "should" is not the standard here, because the failure is silent in the permissive direction:
  git ignores a credential helper's non-zero exit and carries on. Two fallbacks must be closed, not
  assumed: `gh.real` resolving an ambient `GH_TOKEN`/`GITHUB_TOKEN`, and a stale
  `~/.config/gh/hosts.yml` — the unmaintained state BLO-13241 wrapped `gh` to stop using in the
  first place. Either one re-authenticates the unguarded binary with the mount already gone.
  Prefer removing the helper from the image's system scope outright; if it stays (the wrapped
  doors still need it), D1 must assert it yields no credential. Note `Dockerfile.runtime:82` is
  guarded by two equality checks (`scripts/check-agent-image-git-config.mjs` and assertion (a) in
  `agent-egress-path.test.mjs`) whose expectations live in `scripts/git-config-surface.mjs` —
  changing that line means changing those in the same commit, by construction.
  **Status:** still outstanding as of 2026-10-29 — PEN-4933 shipped without it. It is tracked as
  a precondition for discharging §7.1, not as a follow-up; see §7.3's *"The §5 starvation
  assertion is still outstanding, and it gates discharge"* for what is already in place, what is
  merely probable, and what remains unasserted.

Short-lived minted tokens are **not** a substitute. A GitHub App installation token handed to the
agent is readable for its whole lifetime, so it narrows the window and leaves the boundary exactly
where it is now.

## 6. Options declined, and why

- **Server-side `pre-receive`** — unavailable on github.com (D3). Closed.
- **Integrity checks between the guard's own components** — unsound at one uid (§3), and already
  prohibited by the row and by the file header. Closed.
- **Relaxing `allowPrivilegeEscalation` or capabilities to enable a setuid guard** — trades a
  strong, standard container control for a weak bespoke one. Refused outright.
- **A kill switch on the egress refusals** — not proposed by anyone, recorded here pre-emptively
  because the adjacent PEN-2415 reasoning applies verbatim: a flag able to disable the refusal is a
  flag able to reopen the disclosure path under incident pressure.
- **Egress NetworkPolicy + scanning proxy (D4)** — deferred, not rejected. It is the only option
  that also covers non-git exfiltration (plain HTTPS to any host), so it remains the right
  long-term posture. It is deferred because it needs the credential decision made first (§4.1), and
  because terminating TLS and parsing git pack protocol is a large, high-risk build whose failure
  mode is breaking every agent's ability to publish.

## 7. The accepted residual

### 7.1 Statement

Between 2026-10-28 and the delivery of D1, an agent that deliberately sets out to publish material
`scrubGitHubEgressText` would remove **can do so**, by invoking the real binary — which
`/etc/gitconfig` then authenticates for it (§4). This is accepted, with eyes open, on these
grounds:

- The control's designed threat — **accidental** disclosure — is covered **for every caller that
  resolves `git` on the agent's own PATH**, and is better covered than when the row was filed: the
  guard now sits on a root-owned path ahead of `/usr/bin`, where before it sat on a surface the
  agent could rewrite. That is the shape of essentially all agent and tool invocations.
  ⚠ "On PATH" is narrower than it reads, and PEN-4986 §4.1 measured where: **git prepends its own
  exec-path `/usr/lib/git-core` to `PATH` for every process it spawns**, ahead of the wrapper's
  directory, and that directory holds a second complete copy of the git binary. So inside a hook,
  an alias expansion or an external diff/merge tool, a bare `git` resolves to
  `/usr/lib/git-core/git` and the wrapper is not reached. Such a child still inherits
  `GIT_CONFIG_PARAMETERS` from its wrapped parent, so its **credential** path is still the paperclip
  helper and the accidental-disclosure case is not opened — what it escapes is the **guard**, not
  the credential. `github-git-egress-shim.ts` already refuses `!`-prefixed shell aliases for exactly
  this reason; this bullet's wording is what had not kept up.
- Of the four enumerated bypasses, the three that required a deliberate write are closed. The
  survivor requires no write, no privilege, and — per §4 — **no knowledge of the credential
  either**; it requires only that something invoke git by absolute path. For the *deliberate*
  threat that is a low bar, but it is also the threat this control never claimed to cover and that
  PEN-3183 exists to close; accepting it is accepting the status quo ante, not a new exposure.
- The real uncertainty is therefore the **accidental** absolute-path caller (§4.0). The CEO asked
  for exactly that count on 2026-09-11; it was collected on 2026-10-29 (PEN-4986) and it is
  **zero**. See below — that bullet is no longer an assumption.

**This acceptance is explicitly conditional on that count, and the count has now been taken.**
Measured 2026-10-29 (PEN-4986; method, controls and limits in
[`PEN-4986-absolute-path-git-runtime-measurement.md`](./PEN-4986-absolute-path-git-runtime-measurement.md)):
**zero** invocations reached a real git binary without transiting the wrapper — `63` class-A
observations, of which `46` wrapped and **0** unwrapped, plus `17` deliberate
unwrapped negative controls and `1` observation of another git-core program (`git-remote-http`,
spawned by the push), which was also wrapped — across a `2.5`-minute window of representative agent
work (including a push) in a live agent pod on image `sha-992d21f-k8s-vendored`. The first run's
longer 22.1-minute window, against the narrower target set, is kept in §3.1 of that document:
neither window is long enough to speak to a rare periodic caller, which is what the standing
telemetry gap below is for.

"A real git binary" is two of them, not one, and that is a correction to the first version of this
paragraph. The image ships `/usr/bin/git` **and** `/usr/lib/git-core/git` as **separate inodes
holding byte-identical copies** of the same binary; the first measurement watched only the former,
so its zero was narrower than it was written to be. The instrument now discovers its targets by
content identity and watched both — 2 inodes reachable by 147 paths, plus 21 further git-core
programs that read `/etc/gitconfig` on their own account. The instrument was proved able to see the
opposite **on each of the two inodes separately**: deliberate unwrapped invocations of both were
classified correctly, and its catch rate on the shortest-lived invocation class measured
`0.913`. Separately, an image- and harness-wide census found **no** exec site for either path
outside the egress-control machinery itself.

**§7.2 trigger 4 has not fired, and the acceptance stands unchanged.** What has changed is that the
first ground above rests on a measurement rather than an expectation — with one qualification,
which replaces the old one rather than removing it. The evidence splits in two: the
**image-resident** half, what the image and harness themselves run, is zero *by census*; the
**per-pod** half, what an agent composes into a shell at runtime, is zero *in the pods measured*.

⚠ That first half does **not** generalise for the reason this paragraph originally gave. It claimed
the census carries fleet-wide "because the image is common to every agent pod", and the fleet does
not run one image: measured 2026-10-29 from `kube_pod_container_info` (PEN-4989), **106** distinct
agent image digests ran in the preceding 7 days, **17** in the last 24 h, and for **38.2 %** of that
week more than one image was live simultaneously — three at the moment of measurement. What supports
the census half is therefore *sampling*, not identity: it was re-run on a second image
(`sha-4db591b`) and on a third (`sha-992d21f`) and reproduced exactly each time — 15 occurrences,
all inside the egress machinery, zero exec sites outside the wrapper — making it **3 of 106
images**. Cite that sample size, not a fleet census.

So the assumption is tested in three pods on three images, and is not a fleet census. Re-take it when
the **egress-relevant surface** changes — the wrapper, the runtime it `exec`s, the credential helper,
**the set of real git binaries**, and the PATH ordering. "Whenever the agent image changes" is not an operable
trigger at ≈15 changes a day; `scripts/absolute-path-git-fingerprint.mjs` computes the narrower
surface hash so staleness is a comparison rather than a judgement.

One finding is worth more than the count itself: **no exec-level telemetry is deployed anywhere in
the cluster**, so nothing would currently report trigger 4 firing in another pod. Standing alerting
on the §7.2 triggers is already permitted by §8 without further security review, and is the cheapest
remaining improvement here.

⚠ **Status, 2026-10-28 (PEN-4933):** D1 is **built** and merged behind a
default-off rollout gate; see §7.3. The residual statement above still describes
the deployed fleet, and remains accepted on the grounds listed, until that gate
is enabled.

### 7.2 Review triggers — any one of these ends the acceptance early

1. **A second disclosure event of the PEN-2526 class**, by any door.
2. **Any agent Job rendering `paperclip.io/data-mount-scope: broad:*`** — that re-opens bypass 3
   and returns the guard to peers-not-layers. This is a cheap alerting target and should be one.
3. **Any change that widens read access to the token Secret**, or mounts it into a new container.
   Read "the token Secret" as *any* route by which uid 1000 obtains a github.com credential — which
   per §4 includes `/etc/gitconfig`'s system helper, not only the mount. A change broadening what
   that helper will answer for is this trigger.

   ⚠ Read the **direction**, not just the nouns. A change that *removes* a credential route
   from uid 1000 is not this trigger even though it rearranges containers — the §7.4 refusal
   is the worked example, and reading it as a trigger would invert the test. A change that
   puts a credential somewhere one was not before **is** this trigger, including when the
   recipient is the broker.
4. **A non-zero absolute-path-`git` count** from the §8 measurement — i.e. any invocation reaching
   `/usr/bin/git` that did not come through the wrapper. That means the *accidental* case is
   uncovered too, which is the ground §7.1 accepts on; it ends the acceptance regardless of the
   calendar date.
5. Otherwise: **2027-01-31.**

### 7.3 Discharge status (PEN-4933)

The broker shape in §5 is implemented: `packages/adapter-utils/src/
github-publish-broker*.ts` plus a `github-publish-broker` sidecar rendered by
`vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts`. With it
enabled, the GitHub credential Secret is mounted into that sidecar and **not**
into the agent container, the agent reaches it over a unix socket asking for a
publish, and the broker performs that publish by re-entering the SAME image
wrapper — so the scan is the existing pre-push hook running the existing
`scrubGitHubEgressText`, and door parity is preserved by construction rather
than by a second implementation. `git`, `gh` and the GitHub MCP server are all
routed, because §4.1 says routing one relocates the bypass to the other two.

Four things a reader should not infer from that paragraph:

1. **It is not yet enabled.** `enableGitHubPublishBroker` defaults to `false`,
   so the deployed fleet is unchanged and §7.1 still holds. The gate is a
   ROLLOUT gate, not the kill switch §6 refuses: with it off the fleet is
   exactly where this document found it, and the reason it exists is the one §6
   gives for deferring D4 — a change that can break every agent's ability to
   publish should soak rather than flip. **Switching it back off after
   enablement re-opens §7.1 and is a Security decision, not an incident one.**
   The acceptance is discharged when the gate is on **and item 4 below is
   satisfied**, not when this paragraph was written.
2. **The mode is not the mechanism.** §5 asks for `0400` owned by the broker's
   uid. That is not reachable through a Kubernetes Secret volume — the kubelet
   owns those files `root`, so `0400` denies the broker as readily as the
   agent, and `fsGroup` is pod-scoped and would hand the agent container a
   supplementary group instead. What makes the token unreadable at uid 1000 is
   that the mount is **not in the agent's mount namespace at all**; the mode is
   then doing no work. The uid split (broker at 1001) is kept as defence in
   depth against a future `shareProcessNamespace`, not as the boundary.
3. **A successor residual replaces the old one, and it is smaller but real.**
   The broker runs `git` and `gh` against a repository owned by uid 1000, so
   the agent still chooses some of the input the credential-holding process
   reads — `.git/config` in particular, which is exactly what git's own
   `safe.directory` check warns about and which the broker has to suppress in
   order to work. The enumerated routes from that input back to the credential
   are closed (`github-publish-broker-policy.ts`: pushes only, no caller config
   assignments, `protocol.allow` pinned, `core.askpass`/`core.fsmonitor`/
   `http.proxy`/`http.sslVerify` pinned, `gh auth`/`alias`/`extension` refused,
   a broker-private ephemeral `GH_CONFIG_DIR`, `--hostname` refused, every
   file-path argument confined to the workspace or the shared `/tmp`, and the
   working directory confined to the same). ⚠ That is a list of vectors
   closed, **not a proof that no other git config key can reach an exec during
   a push**, and it must not be written up as one. It is strictly better than
   §7.1, where the agent simply holds the token, and it is strictly weaker than
   "the broker cannot be made to run attacker-chosen code". Review it on the
   same date.

   Three things in that list are only true because of a container boundary, and
   each was wrong in the first implementation before review (#3080) caught it.
   They are recorded because the same mistake is easy to make again:

   - **The broker is not rendered at all under a broad data mount.** It
     executes the PEN-3156 pre-push hook with the credential in its
     environment. That hook is read-only to uid 1000 only while
     `narrowWritableSurface` holds; under the broad fallback the whole volume
     is rw and the agent picks the code the credential holder runs. The Job
     builder now **refuses to build** in that combination rather than
     rendering a boundary that does not hold. This makes §7.2 trigger 2
     structural for broker-enabled runs instead of purely an alerting target —
     though the trigger still stands for every run that has the broker off.
   - **`GH_CONFIG_DIR` is broker-private, not under the shared `/tmp`.** The
     ephemeral config dir is half of what makes the `gh` denylist acceptable
     (the two code-execution verbs are refused *and* have nothing to execute
     from). `mkdtemp` creates it `0700`, but an `emptyDir` parent carries no
     sticky bit and the agent can write it, so the directory entry could be
     renamed away and replaced — and `gh` would then read an alias out of the
     substitute. The mode was never the mechanism here either; the mount
     namespace is. Same correction as (2) above, in a second place. It sits
     under `/var/lib`, not `/run`: `/var/run` is a symlink to `/run` on this
     image, so a private directory named `/run/paperclip-github-broker` would
     have been the same directory as the shared socket mount at
     `/var/run/paperclip-github-broker`, which the agent does mount. A
     manifest test pins the two as disjoint after resolving that symlink,
     because the builder's own mount-shadowing check compares literal paths.
   - **Confining `cwd` does not confine file arguments.** `gh` takes absolute
     paths (`--body-file`, `gh api --input`, `-F field=@file`) and an absolute
     path does not care about the working directory. Admission now refuses any
     argument that *resolves* to an existing path outside the workspace or
     the shared `/tmp`, compared after `realpath` so a symlink **already
     planted** in `/tmp` when the request arrives is caught; one planted
     after admission is the check-then-use residual below. Leaving this to
     the content scrubber would have been the §8 error: the scrubber is a
     mistake guard, not a boundary.

   Carried forward as residual, not claimed closed:

   - That rule is **check-then-use**, and the window is real. Admission
     resolves each candidate with `realpath`; `gh` re-resolves every path
     when it OPENS it, and the agent owns the shared `/tmp` in between. Two
     ways through: a candidate that names nothing at admission is admitted
     and can be created as a symlink to the credential before the child
     starts, and an admitted regular file can be swapped for one. Either way
     the brokered tool reads the token inside the broker's mount namespace
     and publishes it, which is the boundary this whole document is about.
     The standard closure — snapshot each admitted file into
     `BROKER_PRIVATE_DIR`, open it `O_NOFOLLOW`, `fstat` it, and rewrite the
     argv token to the copy — is **not available here**, and the obstacle is
     structural rather than effort: the candidate set is *every token*,
     because `gh` is allowlist-by-exception (only `auth`, `alias`,
     `extension` and `extensions` are refused) and its file-bearing flags
     cannot be enumerated without a table that fails OPEN on the next `gh`
     release. An over-broad candidate set is safe to REFUSE on and unsafe to
     SUBSTITUTE on: rewriting every token that happens to name an existing
     file would corrupt arguments that were never paths, `--title README.md`
     being the cheap example. What would actually close it is giving the
     child a different filesystem view from the broker — a mount namespace
     per invocation, or a uid split between broker and child — and §8
     reserves both to Security, because each needs a capability the broker
     does not have today. **This is strictly narrower than §7.1 and strictly
     weaker than a closed door**: it costs the attacker a race against a
     process they cannot observe, where §7.1 simply handed them the token.
     Two characterization tests in `github-publish-broker-policy.test.ts`
     pin the gap, so that it stays visible to the next reader and so that
     closing it reds a test rather than passing silently. Raised by review
     on #3080, carried deliberately; review it on the same date.

   - That rule is a **read** confinement. An argument naming a path outside
     the roots that does not yet exist is admitted, because refusing on the
     nearest existing ancestor would refuse `gh api /repos/o/r/pulls`. What
     stops a brokered tool WRITING into the image — over the wrapper the
     broker execs, say — is that the broker runs non-root against a
     root-owned image, which is a different control and a weaker one than a
     refusal.
   - The repository's own `.git/config` is not cleared wholesale; the broker
     pins a named set of keys. Two keys in that file that would otherwise
     reach an exec inside the credential-holding container are closed
     ELSEWHERE, which is worth knowing because neither is visible in the
     broker's own list: `diff.<driver>.textconv` cannot run, because both
     `git show` reads in `github-git-egress-shim.ts` pass `--no-textconv`
     (a documented security flag with its own test); and a repository
     `core.hooksPath` cannot redirect the hook, because the runtime injects
     its own immediately before the subcommand, where git takes it last —
     measured against 2.47.3 as beating repo config, `--config-env` and
     `GIT_CONFIG_KEY_*`. Both are load-bearing for the broker and neither is
     stated in `github-publish-broker-policy.ts`. **A change to either file
     that drops them silently re-opens an exec route into the broker**, so
     they belong on the review-date checklist even though they are closed
     today.

4. **The §5 starvation assertion is still outstanding, and it gates discharge.**
   §5 requires that `/etc/gitconfig`'s system credential helper be *shown* to
   starve once the token leaves the agent container — explicitly not assumed,
   because git treats a credential helper's non-zero exit as "no credential"
   and carries on, so this fails silently in the permissive direction. **No
   test asserts it today.** Checked at this head:
   `github-publish-broker.test.ts`, `github-publish-broker-policy.test.ts` and
   `job-manifest.github-publish-broker.test.ts` contain no starvation check,
   and `agent-egress-path.test.mjs` asserts only that the git wrapper installs
   the *paperclip* helper on its own command line and that nothing else writes
   `/etc/gitconfig` — a different claim.

   The expected mechanism is plausible and worth stating so the assertion knows
   what it is confirming: the helper runs `/usr/bin/gh auth git-credential`;
   `paperclip-github-token-env` execs the child with **no** token when
   `PAPERCLIP_GITHUB_BROKER_SOCKET` is set and the token file is absent
   (`docker/github-wrappers/paperclip-github-token-env:34-45`), which is the
   brokered agent container; and the broker refuses the whole `auth` verb
   (`github-publish-broker-policy.ts`), so the helper has nothing to return.
   ⚠ That is why it **probably** starves, which is the standard §5 rejects.
   Two fallbacks remain unasserted and either one re-authenticates the
   unguarded binary with the mount already gone: `gh.real` resolving an ambient
   `GH_TOKEN`/`GITHUB_TOKEN`, and a stale `~/.config/gh/hosts.yml` — the
   unmaintained state BLO-13241 wrapped `gh` to stop using.

   So: **do not read item 1's "discharged when the gate is on" as satisfied by
   flipping the gate.** Until a test asserts that a bare `/usr/bin/git push`
   from uid 1000 in a brokered pod fails to authenticate, enabling the broker
   closes §7.1's *mount* route and leaves its *helper* route unproven, which is
   the narrower of the two but the one §4 found to be cheaper for an attacker.
   This is a rollout precondition for PEN-4933, not a follow-up.

### 7.4 Env-delivered credentials: the seat-token route stays refused, not routed (decided 2026-10-29)

⚠ **Status, so this section is not misread as a description of master.** What follows decides a
change that is **not merged**. The refusal lives in #3089 (PEN-4933), open at this writing;
neither `buildJobManifest` nor §7.3 refuses anything on master today. Every "the refusal" below
means *the refusal #3089 proposes, which this section rules should stay* — nothing here asserts a
control that exists. Asserting a boundary that is not there is the failure D7 exists to prevent,
and it would be a poor way to record D7.

> **Citation convention.** §7.3's items are cited below by their **bold titles**, never by number.
> #3089 inserts a new first item and renumbers the rest, so a numeric reference would silently
> point at the wrong item in one of the two merge orders — and these references are the
> load-bearing part of the release conditions.

**The question, raised from PEN-4933 on 2026-10-29.** #3089 would make `buildJobManifest` refuse
to render the broker while `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` or
`GH_SEAT_TOKEN_VALUE` would land on the agent container, and would record that refusal as a new
first item in §7.3. Routing the seat-token path *through* the broker instead would preserve
function for a seat-bound agent. CTO declined to pick unilaterally, correctly, because §8 reserves
it here.

**Decision: keep the refusal. Do not route.** Four grounds, in the order that decided it.

1. **The refusal is not §7.2 trigger 3; routing would be.** The trigger asks whether a change gives
   uid 1000 a route to a github.com credential. Refusing to render *removes* one. Routing adds a
   credential to a container that did not hold it — the trigger's own words — which is precisely
   why the choice sits here rather than in the Job builder.

2. **The measured cost of refusing is zero today.** Across the 11 agents in this company, **none**
   binds `GH_SEAT_TOKEN_VALUE` at agent scope; the only agent carrying any `adapterConfig.env` at
   all carries no GitHub credential name. Measured read-only from inside a live agent Job pod on
   2026-10-29: all four credential variables **absent**, `PAPERCLIP_GITHUB_TOKEN_FILE` **present**,
   the seat PAT volume **absent** (BLO-24056's removal holds at this head), broker socket absent.
   So the default delivery route is the mounted Secret, and the env route is an opt-in exception —
   refusing it blocks nobody now.
   ⚠ **Bounds of that count, stated rather than buried:** it covers *agent* scope in *this* company.
   `translateGithubSeatTokenForExecutionTarget` reads the merged runtime config, so a project- or
   environment-scope binding would not appear above, and `/environments/:id` is `403 Board access
   required` for the Security seat. Treat it as "no agent-scope binding found", not "no binding
   exists" — which is also why condition (c) below is a measurement and not an assumption.

3. **Routing would amplify the one residual §7.3 leaves open, onto a broader credential.** That
   is §7.3's *"A successor residual replaces the old one, and it is smaller but real"*, which
   carries a live check-then-use gap: admission resolves a path, `gh` re-resolves it when
   it opens it, and the agent owns the shared `/tmp` in between. Whatever credential the broker
   holds is what that race leaks. Today that is the App installation token. `GH_SEAT_TOKEN_VALUE`'s
   documented instance is the `allyblockcast` **user** PAT, which `AGENTS.md` records as *broader
   than the App installation* — `repo, write:packages, delete:packages, admin:public_key` over 31
   repos with push on 11, including repos the App installation cannot see at all. Routing it in
   would widen the blast radius of a gap this document already declines to claim closed. That is
   backwards for a change whose entire purpose is to narrow credential reach.

4. **§5's bar is not yet met for the credential already in the broker.** §7.3's *"The §5
   starvation assertion is still outstanding, and it gates discharge"* records that the
   `/etc/gitconfig` assertion is unmet and is a **precondition for discharge**.
   Adding a second, broader credential before the first one's starvation is *shown* rather than
   assumed is the §5 error at one remove.

**What would release this.** All three, together — any one alone is not enough:

- **(a)** §7.3's *"The §5 starvation assertion is still outstanding, and it gates discharge"*
  satisfied: a test asserts that a bare `/usr/bin/git push` from uid 1000 in a brokered pod fails
  to authenticate.
- **(b)** *Either* the check-then-use residual of §7.3's *"A successor residual replaces the old
  one, and it is smaller but real"* closed — per-invocation mount namespace, or a uid split between
  broker and child, both already reserved to Security by §8 — *or* the credential proposed for
  routing shown to be no broader than the App installation it would join.
- **(c)** A non-zero count of seat-bound agents across **all** binding scopes, i.e. evidence that a
  real agent is actually blocked by the refusal. Build it when something needs it, not before.

**A scope note this turned up for §7.1.** §7.1 describes the residual in terms of "the credential",
and means the App installation token. For a seat-bound agent it is whatever is bound, and the
documented instance is broader. If (c) ever returns non-zero **before** the broker is enabled, that
agent's §7.1 residual is wider than §7.1 describes — that is its own finding and its own trigger-3
review, not a footnote to this one.

**Not a licence to strip.** Silently removing the credential from the agent container was already
rejected on the build side and is rejected here too: it leaves a seat-bound agent with no credential
anywhere, so every publish fails at a boundary that reports success. Fail closed and loud at render,
or do not change it.

## 8. Bounds on what may be built against this decision

Permitted without further security review:

- The broker shape in §5, provided it performs the publish and never emits the credential to uid
  1000, and provided it calls the existing shim rather than re-deriving the refusal rule.
- Alerting on the triggers in §7.2.
- The absolute-path-`git` measurement the CEO asked for on 2026-09-11: count invocations reaching
  `/usr/bin/git` that did not come through the wrapper. **Treat this as the highest-value item
  here, not a nice-to-have.** Per §4.0, such an invocation is authenticated by `/etc/gitconfig`
  with no intent and no credential handling, so a non-zero count means the *accidental* case — the
  one this control exists for — is uncovered, falsifies the first ground of §7.1, and ends the
  §7.2 acceptance early rather than merely "raising urgency". A zero count leaves this decision
  unchanged and converts §7.1's stated assumption into a measured one.
  ✅ **Taken 2026-10-29 (PEN-4986): zero.** See §7.1 and
  [`PEN-4986-absolute-path-git-runtime-measurement.md`](./PEN-4986-absolute-path-git-runtime-measurement.md).
  The tool is `scripts/measure-absolute-path-git.mjs`; re-take it on any agent-image or PATH
  change, and note the result is one pod, so widening the population stays permitted here.

Not permitted without returning here first:

- Any integrity check between wrapper, hook and scanner (§3).
- Any relaxation of `allowPrivilegeEscalation`, dropped capabilities, or `runAsNonRoot` (§3).
- Any credential helper that emits the token to the agent container (§5).
- Any broker that implements its own notion of what a push may contain (§5, door parity).
- Routing an **env-delivered** credential (`GH_SEAT_TOKEN_VALUE`, and the `GH_TOKEN` /
  `GITHUB_TOKEN` / `GITHUB_PERSONAL_ACCESS_TOKEN` it expands into) through the broker rather
  than refusing to render the Job — decided 2026-10-29 in §7.4, which lists the three
  conditions that would release it.
- Describing this control as tamper-resistant anywhere in the codebase until D1 ships. The header
  in `github-git-egress-runtime.ts` is the canonical statement of its limits and is updated by this
  change; keep it true.
