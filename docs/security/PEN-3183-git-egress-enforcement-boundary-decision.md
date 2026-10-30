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
| D5 | The residual between now and D1 | ⛔ **ACCEPTANCE ENDED 2026-10-29 — it does NOT run to 2027-01-31.** It was accepted on 2026-10-28, dated and conditional, on the stated *unmeasured* assumption that nothing in the fleet invokes `git` by absolute path (§4.0), with the §8 count to settle it and a non-zero result to end it. **The count was taken on 2026-10-29 and is 28** (PEN-4986 → PEN-4989), so **§7.2 trigger 4 has fired** and the condition the acceptance was granted under has failed. The residual itself is unchanged and still describes the deployed fleet — what ended is the *acceptance of it*. Read §7.1 and §7.2 before relying on this row; disposition is the CTO's, tracked on PEN-4989. |
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

How much of that exists in the fleet was **unmeasured** when this decision was written. ⛔ **It has
since been measured: 28, on 2026-10-29** (§7.1) — so the *accidental* case is **not** covered. That
measurement (§8) was never a nice-to-have that could sharpen an urgency estimate: it is the one
piece of evidence that bounds whether the *accidental* case — the case this control is actually
for — is covered at all. It was load-bearing for §7.1 and named as an early trigger in §7.2, and
that trigger has **fired**: the §7.1 acceptance is **ended as of 2026-10-29**, not running to
2027-01-31.

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
  **Status: satisfied 2026-10-29** (#3097), having been outstanding when PEN-4933 first shipped.
  `scripts/gh-token-wrapper.test.mjs` now asserts that the helper yields no credential once the
  mount is gone, as a composed chain of four links each verified by mutation. Both fallbacks named
  just above are closed by it: each requires `gh.real` to **run**, and the assertion pins that it
  does not. This was a precondition for discharging §7.1 rather than a follow-up, and it is the
  second of that discharge's two conjuncts — the first, the rollout gate, is still off. See §7.3's
  *"The §5 starvation assertion is satisfied; the rollout gate still is not"* for the per-link
  breakdown and for the limit: these are composed unit assertions, not an in-pod end-to-end run.

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
  this reason, but that refusal does not cover hooks or external diff/merge tools. This bullet's
  wording is what had not kept up; the uncovered shapes are tracked as **PEN-4998**.
- Of the four enumerated bypasses, the three that required a deliberate write are closed. The
  survivor requires no write, no privilege, and — per §4 — **no knowledge of the credential
  either**; it requires only that something invoke git by absolute path. For the *deliberate*
  threat that is a low bar, but it is also the threat this control never claimed to cover and that
  PEN-3183 exists to close; accepting it is accepting the status quo ante, not a new exposure.
- The real uncertainty is therefore the **accidental** absolute-path caller (§4.0). The CEO asked
  for exactly that count on 2026-09-11. It was collected on 2026-10-29 (PEN-4986) and was
  **zero** in that pod; widening it the same day to a build/test workload returned **28**
  (PEN-4989, PEN-4993). ⛔ **This ground does not survive.** See below: the bullet is no longer
  an assumption, and it is no longer true as written.

**This acceptance is explicitly conditional on that count, and the count has now been taken.**
Measured 2026-10-29 (PEN-4986; method, controls and limits in
[`PEN-4986-absolute-path-git-runtime-measurement.md`](./PEN-4986-absolute-path-git-runtime-measurement.md)):
**zero** invocations reached a real git binary without transiting the wrapper — `51` class-A
observations, of which `36` wrapped and **0** unwrapped, plus `15` deliberate
unwrapped negative controls and `1` observation of another git-core program (`git-remote-http`,
spawned by the push), which was also wrapped — across a `1.6`-minute window of representative agent
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
classified correctly. Its catch rate on the shortest-lived invocation class — `git --version`,
measured **directly on each watched path** at n = 300 rather than on a copy — is **0.710** for
`/usr/bin/git` and **0.747** for `/usr/lib/git-core/git`. On that floor an observed zero supports
**k = 0 at ~71 %** and **k ≤ 1 at ~92 %** for that shortest class, and much tighter for any real
git operation, all of which are longer-lived. ⚠ Earlier drafts quoted ~0.93 here; that figure came
from a byte-identical *copy* of the binary, which over-stated the rate for the binaries actually
watched.

⛔ **The name of that copy decides whether the figure means anything, and four of the six rows got
it wrong.** Git dispatches on `argv[0]`, so a copy named **`git-calib`** — the name this
document's own earlier recipe gave, and the one PEN-4986, PEN-4989 §1, PEN-4992 and PEN-4994 all
used — **never runs at all**: it exits `128` at builtin dispatch (`fatal: cannot handle calib as a
builtin`) without ever executing `--version`. Verified 2026-10-29 on this image. Those four rows'
rates (`0.930`, `0.840`, `0.933`, `0.793`) therefore timed an **error path, not a git invocation**,
and are **void as catch rates** rather than merely optimistic. This also resolves an anomaly
PEN-4992 reported and could not explain: a `0.933` calibration alongside catching only 1 of 3 real
negative controls (`P[≤1] ≈ 1.3 %`). The two numbers never described the same thing.

Rows that named the copy `git` are unaffected and remain the usable ones: this document's §2.2
(`0.903` copy vs `0.710`/`0.747` watched) and PEN-4993 (`0.837` copy vs `0.810` watched). ⚠ §2.2's
*mechanism* for the residual gap — "lives ~24 % longer" — is a real measurement (5 126 µs vs
4 123 µs) but is **pod-local**: re-measured 2026-10-29 in a different pod, a correctly-named copy
and the real binary have comparable warm lifetimes (~4.2–4.8 ms vs ~3.9–4.5 ms, 3 × n = 300). The
over-statement direction reproduces; its magnitude and cause do not. Quote the **watched-path**
rate, never the copy's. Separately, an image- and harness-wide census found **no** exec site for either path
outside the egress-control machinery itself.

⛔ **§7.2 trigger 4 has FIRED, and this acceptance is ENDED as of 2026-10-29. It does not run to
2027-01-31.** The count is **28**, from a sixth measurement window in an **Engineer** pod running
the repository's own test suite (PEN-4993, folded into PEN-4989 and its record). The five earlier
windows, across four agents and four image tags, all returned zero; the sixth was the first to run
`pnpm test`. Widening along the *pod* axis alone would have returned zero indefinitely — §3 of the
PEN-4989 record named **workload** as the uncovered axis before it was sampled.

⚠ **The firing does not depend on the predicate question** raised on PEN-4989 and PEN-4993. Those
asked whether "absolute-path `git`" means a literal `argv[0] == "/usr/bin/git"` or the instrument's
"reached a real git without transiting the wrapper", and warned that the literal reading would
score this finding **zero**. Read against trigger 4's own words — *"any invocation **reaching**
`/usr/bin/git` that did not come through the wrapper"* — that ambiguity is **not load-bearing
here**: 26 of the 28 resolve a bare `git` through a narrowed `PATH` to `/usr/bin/git` itself, with
no wrapper anywhere in their ancestry. They reached `/usr/bin/git` and did not come through the
wrapper, so **trigger 4 fires on its own literal text**. (The remaining 2 reach
`/usr/lib/git-core/git` and are PEN-4998's separately-triaged class.) §7.1 should still be made to
say which predicate it means — but that is a clarification, not a precondition for acting on this.

**Mechanism — a class, not a site.** The 26 come from first-party test code that spawns a child
with `PATH` narrowed to `` `${bin}:/usr/bin:/bin` `` so that a stub binary is genuinely the only
candidate. The wrapper's directory is absent from that `PATH` **by construction**, so every `git`
the child runs reaches the real binary directly. The intent is reasonable and commented in place;
the wrapper bypass is an unremarked side effect of it. **Any test or tool that builds its own
`PATH` gets an unwrapped `git` for free.** ⚠ The known site is in
**`Blockcast/penstock-llm-proxy-core`** (`test/secret-scan-budget.test.ts`), **not** in this
repository — the class is cross-repo, and a paperclip-only sweep will report it clean. Tracked as
**PEN-5012**.

**Severity, stated both ways.** The 28 invocations are themselves harmless: `rev-parse` and
`maintenance` against throwaway scratch repos with no remote, so nothing was published and no
credential was used, and the 26 are one reviewed, commented design choice rather than
agent-composed shell. The **mechanism** is the finding. §4.0 was verified live in that pod —
`/etc/gitconfig` supplies `credential.https://github.com.helper` unconditionally — so an unwrapped
`git` reaching github.com *is* authenticated with no intent and no credential handling by the
caller, which is exactly the **accidental** case this control exists for; and the bypass is reached
by **every run of that test suite**. Trigger 4 is written as a count test, not a harm test.

What survives of the original measurement is narrower than it was written to be. The evidence
splits in two: the **image-resident** half, what the image and harness themselves run, is zero *by
census*; the **per-pod** half, what runs inside an agent's own workload, is zero in five windows
and **28 in the sixth**.

⚠ That first half does **not** generalise for the reason this paragraph originally gave. It claimed
the census carries fleet-wide "because the image is common to every agent pod", and the fleet does
not run one image: measured 2026-10-29 from `kube_pod_container_info` (PEN-4989), **106** distinct
agent image digests ran in the preceding 7 days, **17** in the last 24 h, and for **38.2 %** of that
week more than one image was live simultaneously — three at the moment of measurement. What supports
the census half is therefore *reproducibility*, not identity: it was re-run on a second image
(`sha-4db591b`) and on a third (`sha-992d21f`) and reproduced exactly each time — 15 occurrences,
all inside the egress machinery, zero exec sites outside the wrapper. ⚠ Those three images are
**not three independent samples**: measured, they span 9 commits with one build-relevant file
changed between them (a `KUBECTL_VERSION` pin), so they share a single egress surface. "3 of 106"
is a count, not a sample fraction of the fleet's variation. The fleet claim rests on the
egress-surface fingerprint comparison below, not on that count.

So the assumption is tested in six windows across four agents, five pods and four image tags, and
is not a fleet census — and it **failed** in the one window that ran a build/test workload. Re-take it when
the **egress-relevant surface** changes — the wrapper, the runtime it `exec`s, the credential helper,
**the set of real git binaries**, and the PATH ordering. "Whenever the agent image changes" is not an operable
trigger at ≈15 changes a day; `scripts/absolute-path-git-fingerprint.mjs` *(lands in #3102)* computes the narrower
surface hash so staleness is a comparison rather than a judgement.

One finding is worth more than the count itself: **no exec-level telemetry is deployed anywhere in
the cluster**, so nothing would currently report trigger 4 firing in another pod. Standing alerting
on the §7.2 triggers is already permitted by §8 without further security review, and is the cheapest
remaining improvement here.

⚠ **Status, 2026-10-29 (PEN-4933):** D1 is **built** and merged behind a default-off rollout gate;
see §7.3. The residual statement above still describes the deployed fleet — but it is **no longer
accepted on the grounds listed**, because trigger 4 has fired (above). ⛔ The firing is deliberately
**not** folded into D1's rollout: a broker retiring the residual *in future* is a different event
from the acceptance *failing now*, and merging the two would quietly convert a fired trigger into a
scheduled task. Disposition is the CTO's and is tracked on PEN-4989.

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

   ⛔ **FIRED 2026-10-29. Count = 28** (PEN-4993 → PEN-4989). This trigger is **spent**, not
   pending: §7.1 records the firing, the mechanism and the severity argument, and the acceptance is
   ended. Read item 5 below as superseded.
5. Otherwise: **2027-01-31.** ⛔ **Superseded** — trigger 4 fired on 2026-10-29, which ends the
   acceptance regardless of this date.

#### What watches each trigger (PEN-4988, 2026-10-29)

Until PEN-4988 **nothing watched any of these**, and the acceptance above was to run to
2027-01-31 unless one fired. **One since has** — trigger 4, below. A trigger that fires and is not
noticed is the same as a trigger that never fires — so the table below exists so a future reader can tell a *watched* condition from an
*unwatched* one without re-deriving it. Keep it accurate or delete it; a stale coverage claim is
worse than none.

| # | Watched? | By what | Owner of the page |
|---|---|---|---|
| 1 | **No** | Nothing. Not a pollable condition — see below. | — |
| 2 | **Yes** | `git-egress-residual-trigger-check.yml`, hourly | Security Engineer |
| 3 | **Partly** | Build/PR gates on *both* halves since PEN-4990. They BLOCK; they do not ALERT, and they are direction-blind. | — |
| 4 | **No** — and it has **FIRED** | Accepted blind spot: no exec telemetry exists. Found by measurement, not reported by a detector (PEN-4989). | — |

**Trigger 1 — not watched, and not watchable here.** A disclosure event is detected by whatever
detects disclosures (the PEN-2526 response path), not by polling this repo. It is listed as a
trigger because it ends the acceptance, not because this decision record can instrument it.

**Trigger 2 — watched.** `.github/workflows/git-egress-residual-trigger-check.yml` runs hourly on
`arc-paperclip-light` and pages Alertmanager as `GitEgressResidualTriggerFired`; a detector that
cannot read its source pages separately as `GitEgressResidualTriggerCheckUnreadable`, because
"nothing is watching" must never be reported as "clear". **The Security Engineer owns both pages**,
as owner of this record. A fired trigger ends the acceptance *early regardless of the calendar
date* and is raised to the CTO — it is not folded silently into the PEN-4933 rollout.

It reads the render-time server warn `claude_k8s.data_mount_broad_rw` out of Loki, **not** the
`paperclip.io/data-mount-scope` annotation §2.1 names. Both are written from the same
`broadDataMountReason` variable a few lines apart in `buildJobManifest`, so they are two renderings
of one computation rather than independent evidence, and the log is the one that is *observable*:
agent Jobs carry `ttlSecondsAfterFinished: 300`, so polling live Jobs samples and silently misses a
broad Job that starts and finishes between two polls; and the annotation is on the Job, not the Pod,
so reading it needs a `batch/jobs: list` grant that the only least-privilege credential this repo's
CI holds (`paperclip-ci-deploy`) does not have. The risk a log-based detector trades into — going
silent if the producer stops, where silence reads as clear — is covered in-repo rather than
trusted: the warn is pinned on all three gate legs by `job-manifest.test.ts` ("names the reason
whenever the broad rw mount is emitted"), so dropping it reds CI before it can blind the check. Do
not delete those tests as redundant with the annotation assertions beside them.

**Trigger 3 — partly covered, and the gap is specific.** Its `/etc/gitconfig` half has two
assertions: `deploy/helm/paperclip/tests/agent-egress-path.test.mjs` (assertion (a), the surface as
declared in this repo, on every PR) and `scripts/check-agent-image-git-config.mjs` (assertion (b),
the surface of the image as built, in `docker-agent.yml` before promotion). Three limits, none of
which a green run covers:

- **They block; they do not alert.** A red gate refuses the merge or the image promotion. Nobody is
  paged, and nothing watches for the *absence* of a run.
- **They are direction-blind**, and §7.2's direction rule above is precisely what they cannot
  apply. Both assert **exact equality** to a declared set — deliberately, since "an added `-c` flag
  is the attack, so a superset check cannot see it" — which means a change that *removes* a
  credential route reds them exactly like one that adds a route. A red is "the declared surface
  moved", not "a credential route widened". **A human must read the diff for direction**; the §7.4
  refusal is the worked example of a red that is *not* this trigger.
- Assertion (b) explicitly does not cover a retag or overwrite of an already-published image, or
  drift of an already-running pod (see its own header).

The **mount half** — "or mounts it into a new container" — **is asserted as of PEN-4990**
(merged 2026-10-29), which closed the gap this paragraph previously recorded as open:
`deploy/helm/paperclip/tests/github-credential-container-set.test.mjs` for the chart, and
`job-manifest.github-credential-container-set.test.ts` in **both** k8s adapters for the agent Job,
pin a map from container to the github.com credential routes it receives and compare it for exact
equality. The subsection below states what those assertions do and do not reach. They are merge
gates, so the first two limits above apply to them unchanged — they block rather than alert, and
exact equality makes them direction-blind.

Do **not** read `deploy/helm/paperclip/tests/secret-mounts-outside-data-volume.test.mjs` as this
assertion. It asserts *where* a secret volume may sit (BLO-40279: nothing credential-bearing nested
under the shared data volume) and stays green while the token is mounted into a brand-new container,
as long as that mount is outside `/paperclip` — a different property from *which* containers receive
the token.

⚠ **Trigger 4 has since FIRED, and this record is not the row that disposes of it.** On
2026-10-29 the measurement returned a non-zero count — **28** unwrapped absolute-path invocations in
an Engineer pod, 26 of them from a single test in another repository that narrows `PATH` and so
drops the guard directory by construction (measured on PEN-4993, widened on PEN-4989; the mechanism
is PEN-5012). Per the trigger list above that **ends the residual acceptance early, regardless of
the 2027-01-31 date**. The count and the disposition of the acceptance are owned by PEN-4989 and
raised to the CTO — recorded here so a reader of this table is not left to infer from "no detector"
that the condition has not occurred.

Everything below describes the **instrumentation**, which the firing does not change: there is still
no detector, which is precisely why the firing had to be found by a measurement rather than reported
by one.

**Trigger 4 — accepted blind spot, stated as such rather than left as an open gap.** It is the one
trigger with no instrument, and that is structural: **no exec-level telemetry is deployed anywhere
in this cluster** (no Tetragon, no Falco, no process-audit pipeline, and no Prometheus metric family
carrying exec events — measured during PEN-4986). Nor can one be obtained from inside an agent pod:
the container runs `runAsNonRoot` with `allowPrivilegeEscalation: false` and
`capabilities: { drop: [ALL] }`, which is exactly the hardening that forbids attaching a tracer —
and §8 forbids relaxing it. That hardening is correct; the blind spot is the price of it, and the
price is worth paying.

**The decision recorded here is that exec telemetry will not be deployed for this purpose.**
Deploying a cluster-wide tracer is a platform change far outside the scope of this decision record;
it is not refused on the merits, it is **not this record's to make** — the CTO owns that call, and
this paragraph is what a future reader should point at when asking for it to be revisited.

So trigger 4 fires **silently**: if an absolute-path `git` ran in another agent pod tomorrow,
nothing would report it. What stands in its place is a *measurement*, not a detector —
`scripts/measure-absolute-path-git.mjs`, re-runnable, from PEN-4986. ⚠ That script is **not on
master** at this writing — it is #3098 (PEN-4986), open — and neither is the §7.1 text this
paragraph cites. Both land in that PR or not at all; until they do, this paragraph states an
intent, not a control that exists. Read the difference plainly: a measurement observes the pods
it is run in, over the window it is run for, and says nothing about the rest of the fleet or
about the time between runs. PEN-4986 measured **three** pods on three images that share one
egress surface, and §7.1 records it as such — explicitly *not* as a fleet census. Widening that
population is per-pod work — the script runs unprivileged inside an agent's own run, so it needs
no new platform capability, only more agents running it — and re-taking it is required whenever the agent image or the PATH layout changes.
That re-measurement is tracked as **PEN-4989** rather than as a sentence here, for the reason
PEN-4988 exists at all: a condition recorded only in a document has no owner.

#### Trigger 3's mount half — what asserts it (PEN-4990, 2026-10-29)

Trigger 3 has two halves and until PEN-4990 only one was asserted anywhere.

| half | asserted by | kind |
|---|---|---|
| `/etc/gitconfig` system credential helper | `deploy/helm/paperclip/tests/agent-egress-path.test.mjs` (source, every PR) + `scripts/check-agent-image-git-config.mjs` (image, before promotion) | merge/promotion gate |
| **which containers receive the token Secret** | `deploy/helm/paperclip/tests/github-credential-container-set.test.mjs` (chart) + `job-manifest.github-credential-container-set.test.ts` in **both** k8s adapters (agent Job) | merge gate |

The second row is new. Before it, adding `paperclip-github-mcp-token` — or any
equivalent route — to a new container was caught only by human review, which is
precisely the change §7.2 names as ending the residual acceptance early.

`deploy/helm/paperclip/tests/secret-mounts-outside-data-volume.test.mjs` looks
like it covers this and does not. It asserts **where** a secret volume may sit
(BLO-40279: nothing credential-bearing nested under the shared data volume,
after a CephFS re-mount hid every secret mount for ~16h). Both of its assertions
stay green while the token is mounted into a brand-new container, as long as the
new mount is outside `/paperclip`. Do not read it as this row.

What the new assertions pin, in both surfaces: a map from container to the
github.com credential routes it receives, compared for **exact equality**. Four
properties are deliberate.

- **Two route kinds, reported separately.** The Secret volume mount, and the env
  route. The env route is split again, because `PAPERCLIP_GITHUB_TOKEN_FILE` is a
  POINTER rather than a credential — under the broker the agent keeps it with no
  mount behind it, by design (§7.3) — while `GH_TOKEN` / `GITHUB_TOKEN` /
  `GITHUB_PERSONAL_ACCESS_TOKEN` / `GH_SEAT_TOKEN_VALUE` carry a value and are
  what §7.4 keeps refused. A red therefore says which route moved.
- **The mount is matched two ways and includes ancestors.** By mount path
  (`/etc/paperclip/secrets/github-*token`) *and* by Secret name
  (`paperclip-github-*token`), because mounting the same Secret somewhere new
  defeats a path-only check and mounting a renamed Secret at the credential path
  defeats a name-only one; and a mount at any ancestor of a credential path
  counts as reaching it, since mounting `/etc/paperclip/secrets` hands over both
  tokens without naming either. A `projected` volume's sources count as the
  Secret they carry. The Secret-name match **fails closed**: the whole
  `paperclip-github-*` family counts as credential-bearing and the exceptions
  are enumerated, so a credential renamed out of the `*token` spelling is still
  seen. That matters most for the route below, which has no path to fall back
  on. The enumerated exceptions are exactly two — `paperclip-github-app-creds`
  and `paperclip-github-webhook-secret` — and both earn it twice over: each is
  a live `secretKeyRef` target in the StatefulSet, and each is held out of
  agent reach by a different control (below). That set is part of the declared
  surface; adding to it is a decision, not a cleanup. The rule an entry must
  pass is recorded in all three test headers: it must name a Secret that
  **actually exists**, and the reason must be that different control — not
  that the name looks administrative. A third entry, `paperclip-github-app-key`,
  was dropped on #3103 for failing exactly that test: no Secret by that name
  exists anywhere, so it excluded nothing today and pre-approved a hole
  tomorrow, and a mutation confirmed the detector went silent on a Secret of
  that name mounted into a container at a non-credential path. The one place
  the name does appear is `inherit-allowlist.test.ts`, as the example of a
  server-only Secret that must NOT reach an agent — the opposite of the reading
  the exclusion gave it.
- **A third route kind matches the referenced SECRET, not a name or a path**,
  and it is the one the first draft of these tests got wrong. A
  `env[].valueFrom.secretKeyRef` binds the token under **any** variable name, so
  a name list cannot see it; an `envFrom[].secretRef` injects every key of the
  Secret under names nothing observes. Both are live: `k8s-client.ts` captures
  the Deployment container's `valueFrom` entries and its allowlisted `envFrom`
  sources — filtered by env NAME only, never by which Secret they reference —
  and `job-manifest.ts` emits them into the agent container. Caught by review on
  #3103; recorded here because "we match the mount and the variable names" reads
  complete and is not. This route is also why the Secret-name match above has to
  fail closed: a `secretKeyRef` names no path, so the Secret name is the only
  signal there is.
- **Both broker arrangements are expected, not just today's.** §7.2 is explicit
  that the broker receiving a credential **is** trigger 3 — a declared, reviewed
  instance of it, not an exemption — so the agent-Job assertion carries a
  separate expectation for broker-off and broker-on. An assertion written against
  only the pre-broker shape would red the PEN-4933 rollout, which is the failure
  mode worth naming here.
- **The chart assertion renders the WHOLE chart**, not a list of templates, and
  finds pod specs structurally. "Mounts it into a new container" includes a new
  container in a new workload file, and a `--show-only` list covers only the
  templates its author remembered.

Three limits, none of which a green run covers.

- **They block; they do not alert.** A red refuses the merge. Nobody is paged,
  and nothing watches for the absence of a run. Same limit as the
  `/etc/gitconfig` half.
- **They are DIRECTION-BLIND**, and this is the trap §7.2's own direction rule
  sets. Exact equality means a change that *removes* a credential route from
  uid 1000 reds them exactly like one that adds a route — §7.4's refusal is the
  worked example of a red that is **not** this trigger. A red means "the declared
  credential-container map moved", never "a credential route widened"; **a human
  must read the diff for direction.** Each of the three files states this in its
  own header, so the next reader meets the warning at the failure rather than
  here. This is the same limitation the `/etc/gitconfig` assertions carry and it
  is accepted for the same reason: the gate's job is to stop a widening landing
  unnoticed, not to classify it.
- **The chart assertion sees the chart, not the cluster.** It renders
  `values.blockcast.yaml`; a mount added to a live workload by any path that is
  not this chart is outside it. Agent Jobs are covered by the adapter
  assertions instead, which read the manifest the builder actually emits.

One asymmetry between the two agent-Job builders is worth knowing, and is now
pinned by a test on each side rather than left to be rediscovered: `claude_k8s`
does **not** re-apply the env-name allowlist at build time, trusting the
capture-time filter in `k8s-client.ts`, while `opencode_k8s` re-applies it in
its `inheritedEnvValueFrom` loop and its `envFrom` filter. Neither is wrong —
capture is the control, and the build-time pass is defence in depth — but note
what that second pass is and is not: it filters env **names**, so a credential
bound under an allowed prefix (`ANTHROPIC_*`) passes it while still referencing
the token Secret. It is not a credential boundary and must not be cited as one.

Coverage is asserted in the **two** adapters that render agent Jobs —
`claude_k8s` and `opencode_k8s`, both registered in
`EXTERNAL_LIFECYCLE_ADAPTER_TYPES`. Asserting only the first would answer the
question for one of the two builders; the second has no broker and applies its
inheritance allowlist at build time rather than at capture time, so its
expectation differs and is written out rather than assumed to match.

The GitHub App private key (`paperclip-github-app-creds`) is **not** matched by
any of this, deliberately. It is a github.com credential, but a control-plane
one that never reaches an agent, and what keeps it there is a different control —
the server-only inheritance allowlist, backstopped by
`findServerOnlyEnvVarsInPodSpec`. Folding it in would merge two controls into one
assertion and make a red ambiguous.

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

1. **"the credential Secret" is not "the credential".** That paragraph is true
   of the mounted Secret and says nothing about a credential delivered as an
   **environment variable**, which is a separate, supported delivery route:
   `GH_SEAT_TOKEN_VALUE` exists exactly so a token can be bound to one agent
   without mounting it fleet-wide (BLO-18927), and
   `translateGithubSeatTokenForExecutionTarget` expands it into
   `GH_TOKEN`/`GITHUB_TOKEN` in the agent container's own environment. The
   first implementation moved the mount and left that route untouched, so for
   a seat-bound agent the boundary was **absent while every mount-based
   assertion passed** — `/etc/gitconfig`'s system helper answers a bare
   `/usr/bin/git push` out of those variables (§4.0), with no mount to read and
   no intent required. The Job builder now **refuses to render the broker**
   while any of `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` or
   `GH_SEAT_TOKEN_VALUE` would land on the agent container, in the same
   fail-closed shape as the broad-mount refusal. **So D1 covers the
   mounted-Secret delivery path only.** Routing the seat-token path through the
   broker would preserve the function, but it mounts a credential into a new
   container — §7.2 trigger 3 — and is a Security decision under §8 rather than
   a builder change. Until that decision is taken, enabling the broker for a
   seat-bound agent is a build failure, not a silent downgrade.

   ⚠ That refusal reads the container's `env` LIST only, and is stated here
   with its limit rather than as a clean close -- claiming more than was tested
   is what produced this defect in the first place. It cannot cover `envFrom`:
   a `secretRef` injects every key of the referenced Secret, and those keys
   live in the Secret rather than the PodSpec, so no manifest-time check can
   enumerate them. `isAgentInheritableEnvFromRef` filters those sources by
   NAME, not by key, so a GitHub credential placed in an inheritable `envFrom`
   source still reaches the agent container. **Carried forward as residual, not
   claimed closed**, on the same review date as the rest of §7.3.

2. **It is not yet enabled.** `enableGitHubPublishBroker` defaults to `false`,
   so the deployed fleet is unchanged and §7.1 still holds. The gate is a
   ROLLOUT gate, not the kill switch §6 refuses: with it off the fleet is
   exactly where this document found it, and the reason it exists is the one §6
   gives for deferring D4 — a change that can break every agent's ability to
   publish should soak rather than flip. **Switching it back off after
   enablement re-opens §7.1 and is a Security decision, not an incident one.**
   The acceptance is discharged when the gate is on **and item 5 below is
   satisfied**, not when this paragraph was written.
3. **The mode is not the mechanism.** §5 asks for `0400` owned by the broker's
   uid. That is not reachable through a Kubernetes Secret volume — the kubelet
   owns those files `root`, so `0400` denies the broker as readily as the
   agent, and `fsGroup` is pod-scoped and would hand the agent container a
   supplementary group instead. What makes the token unreadable at uid 1000 is
   that the mount is **not in the agent's mount namespace at all**; the mode is
   then doing no work. The uid split (broker at 1001) is kept as defence in
   depth against a future `shareProcessNamespace`, not as the boundary.
4. **A successor residual replaces the old one, and it is smaller but real.**
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

5. **The §5 starvation assertion is satisfied; the rollout gate still is not.**
   §5 requires that `/etc/gitconfig`'s system credential helper be *shown* to
   starve once the token leaves the agent container — explicitly not assumed,
   because git treats a credential helper's non-zero exit as "no credential"
   and carries on, so this fails silently in the permissive direction.

   ⚠ **Status (2026-10-29, #3097).** This item previously read *"is still
   outstanding, and it gates discharge"* and recorded that **no test asserted
   it**. Both statements are now false, and the survey behind the second was
   incomplete when written: it checked `github-publish-broker.test.ts`,
   `github-publish-broker-policy.test.ts`,
   `job-manifest.github-publish-broker.test.ts` and `agent-egress-path.test.mjs`,
   and missed `scripts/gh-token-wrapper.test.mjs`, which already pinned two of
   the four links. That suite now asserts the claim as a composed chain, every
   link verified **by mutation** — each was made to fail before being accepted
   as passing.

   | link | the claim | asserted by |
   |---|---|---|
   | A | `/etc/gitconfig` names `!/usr/bin/gh auth git-credential` | `gh-token-wrapper.test.mjs`, pre-existing (BLO-18484) |
   | B | `/usr/bin/gh` **is** this wrapper, not the upstream binary moved aside as `gh.real` | #3097 — **this was the hole.** Link A's helper string stays byte-identical if `/usr/bin/gh` is reverted to the real binary, which never reads the token file and never refuses |
   | C | the wrapper refuses, rather than falling through to ambient auth, when `PAPERCLIP_GITHUB_TOKEN_FILE` is set and the named file is absent | refusal pre-existing (BLO-37977); the **composed** form — driven with git's own `get` stdin request, asserting exit 64, empty stdout and specifically no `password=`/`username=` — is #3097 |
   | D | the brokered agent container still **sets** that variable while not mounting the Secret | `job-manifest.github-publish-broker.test.ts`; made load-bearing by a positive control in #3097 that pins that *unsetting* it really does re-authenticate |

   ⚠ **Correction (2026-10-29, PEN-4933).** This paragraph previously named
   `paperclip-github-token-env` as the binary that starves, and routed the
   answer through the broker's refusal of the `auth` verb. **Neither is on
   this path.** That wrapper installs to `/usr/local/libexec/paperclip/bin/`
   (`Dockerfile:674`) and is reached through `PATH` — which is precisely what
   bypass 4 sidesteps. The system helper is `!/usr/bin/gh auth git-credential`
   (`Dockerfile.runtime:83`), an **absolute** path, so `PATH` is not consulted
   and no egress wrapper is involved; and the broker is never asked, because
   nothing on this path speaks to it. Pointing an assertion at the documented
   mechanism would have pinned a file the chain does not execute, and stayed
   green while the real chain broke. Security traced this independently on
   master `8055be2a6`.

   The real mechanism, which is what the assertion confirms: `/usr/bin/gh` is
   a symlink to `scripts/gh-token-wrapper.sh` (`Dockerfile.runtime:53-55`), and
   the decisive conjunct is its `TOKEN_FILE_REQUIRED`, set to `yes` **iff
   `PAPERCLIP_GITHUB_TOKEN_FILE` is present in the environment** (`:404-406`,
   tested with `${VAR+x}`, so set-empty counts). `auth git-credential` is not
   in the exempt list that follows (`:412`), so with the variable set and the
   file absent the wrapper reaches `reject_token_file "is absent"` (`:525`) and
   exits non-zero. With the variable **unset** it falls through to
   `exec_real_gh` (`:528`) under whatever ambient auth exists.
   ⚠ That mechanism is now **asserted**, not merely probable — which was the
   whole of §5's objection to the paragraph above.

   **The failure mode to guard is quiet and looks like tidying up.** Links C
   and D resolve on that same single conjunct, so removing the mount *and* the
   now-dangling `PAPERCLIP_GITHUB_TOKEN_FILE` together — the variable points at
   a path that no longer exists, so deleting it reads as correct — silently
   flips the wrapper from *refuse* to *fall back to unwrapped auth*, with no
   error anywhere. C and D are therefore pinned as a **pair**, in two different
   suites: either half alone stays green while the pair is broken.

   **Both fallbacks are closed, and by the same assertion.** §5 named two that
   would each re-authenticate the unguarded binary with the mount already gone:
   `gh.real` resolving an ambient `GH_TOKEN`/`GITHUB_TOKEN`, and a stale
   `~/.config/gh/hosts.yml` (the unmaintained state BLO-13241 wrapped `gh` to
   stop using). Both require `gh.real` to **run**, and link C pins that it does
   not: the stub always writes to stdout, so the assertion that stdout is empty
   is what proves the real binary was never reached. The env-delivered half is
   additionally held off the agent container at render time by the refusal in
   *"the credential Secret is not the credential"* above — defence in depth, not
   the primary assertion.

   **What this discharges, and what it does not.** Item 2 has two conjuncts and
   this is the second of them. The first — `enableGitHubPublishBroker` on — is
   **unchanged and still false**, so on its own this discharges **nothing**.
   What has changed is that enabling the gate no longer closes §7.1's *mount*
   route while leaving its *helper* route unproven, which was the specific trap
   this item existed to prevent. The rollout precondition is met; the rollout
   has not happened.

   ⚠ Do **not** read this item as a statement about §7.1's overall standing.
   It speaks only to the assertion conjunct. Whether the acceptance is still
   in force — in particular whether a §7.2 trigger has since fired — is settled
   in §7.1 and §7.2 and nowhere else; the §8 absolute-path-`git` measurement
   that trigger 4 turns on was being taken and widened on this same date
   (PEN-4986 / PEN-4989), so a reader arriving here later should check those
   sections rather than infer their result from this one.

   ⚠ **State the limit rather than rounding up.** This is a *composed* assertion
   over four links, each pinned in a unit suite and each mutation-verified. It
   is **not** an end-to-end run of `/usr/bin/git push` from uid 1000 inside a
   live brokered pod. The composition is argued in the test file's header
   comment, not executed. Whether that meets the bar §7.4's release condition
   (a) sets is **Security's call, not this document's** — see the status note
   there; nothing is released either way, because (b) and (c) remain unmet.

### 7.4 Env-delivered credentials: the seat-token route stays refused, not routed (decided 2026-10-29)

⚠ **Status.** This section was written while the change it decides was still open, and said so.
It has since landed: #3089 (PEN-4933) merged, so `buildJobManifest` **does** now refuse to render
the broker when an agent-env GitHub credential would land on the agent container, and §7.3's
opening item, *the credential Secret is not the credential*, records it. Every "the refusal" below means
that refusal, which this section rules should stay. The decision itself is unchanged by the merge
— only this status note is. Note what the refusal is **not**: it is a manifest-render refusal, so
it binds the `env:`/`secretKeyRef` names a PodSpec carries, and **not** `envFrom.secretRef`, whose
keys live in the Secret rather than the manifest (§7.3's successor-residual item). Asserting a
boundary that is not there is the failure D7 exists to prevent, and it would be a poor way to
record D7.

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

4. **§5's bar — unmet for the credential already in the broker when this was decided; met
   later the same day.** As written this ground read *"is not yet met"*, and cited §7.3's
   item on the starvation assertion as recording the `/etc/gitconfig` assertion unmet and a
   **precondition for discharge**. #3097 satisfied that assertion; the item is retitled
   *"The §5 starvation assertion is satisfied; the rollout gate still is not"*.
   Adding a second, broader credential before the first one's starvation is *shown* rather than
   assumed would have been the §5 error at one remove — and that is no longer the objection.

   ⚠ **The decision is unchanged, and this ground is recorded rather than deleted.** Grounds 1–3
   are untouched by #3097 and each stands on its own; ground 1 in particular is the one that put
   this choice in Security's hands at all. A ground that has since been met is evidence about
   what the decision still rests on, which is exactly what a reader re-opening §7.4 needs and
   what deleting it would destroy. Re-deciding §7.4 on the strength of this is Security's call
   under §8, not a consequence of the merge.

**What would release this.** All three, together — any one alone is not enough:

- **(a)** §7.3's *"The §5 starvation assertion is satisfied; the rollout gate still is not"* —
  **partially met, and the remaining gap is Security's to judge.** That item is satisfied in its
  *composed* form (#3097): links A–D each pinned and each mutation-verified. It is **not** the
  literal thing this line asks for, which is a test that runs a bare `/usr/bin/git push` from uid
  1000 **inside a brokered pod**. Whether the composed assertion clears this bar is left open
  here deliberately, rather than marked met by the engineer who wrote those tests. Moot today
  either way: the three conditions are conjunctive and (b) and (c) are both unmet.
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

### 7.5 Issue-scope overrides of the D1 gate: pinned to agent provenance, not refused (decided 2026-10-29)

**The finding, raised by Devops as PEN-5017 while writing the D1 enablement plan.**
`enableGitHubPublishBroker` is read by `buildJobManifest` off the **merged** run config.
`mergeModelProfileAdapterConfig` overlays `issue.assigneeAdapterOverrides.adapterConfig` **last**
as a shallow spread, and `parseIssueAssigneeAdapterOverrides` accepts arbitrary keys. The only
provenance guard in that merge, `withAgentScopedEnvProvenance`, re-asserts three keys *inside*
`env` (BLO-18927); nothing re-asserted top-level keys. The overlay applies only to an issue
assigned to the agent, which is not a mitigation — an agent can file an issue against itself. So
the principal the boundary constrains could decline it per-run, and §6's "a flag able to disable a
refusal is a flag able to reopen the disclosure path" would have had a second, per-issue copy that
needs no operator at all.

**Not exploitable at this writing, and this section does not claim it was.** The gate is `false`
everywhere, so an override could only set it to the value it already held. This is **not** a §7.2
trigger-3 firing: no change put a credential anywhere new. It acquires teeth the moment D1 stage 1
sets the gate `true` at agent scope.

**Decision: pin the key to agent provenance, discard a lower-scope override, and log the attempt.
Do not refuse to render.** `AGENT_SCOPE_ONLY_CONFIG_KEYS` in `server/src/services/heartbeat.ts` is
the top-level sibling of the env-key guard: every listed key in the merged config holds exactly the
agent/base value, and one the base lacks is absent. Three grounds.

1. **Refusing to render would trade a latent confidentiality finding for a reachable availability
   one.** Any actor able to assign an issue could park the key on an issue assigned to *another*
   agent and fail every dispatch of it at manifest build. Discarding the overlay renders the pod
   exactly as agent scope specifies and strands nobody.
   ⚠ **That argument is about *this key*, and does not generalise to the merged config.** A sibling
   key already reaches a refusal: `workspaceVolumeClaim` feeds `narrowWritableSurface`, and a
   foreign claim makes `buildJobManifest` throw on the broad-data-mount check once the broker is
   on. That is fail-closed — no confidentiality loss — but it is the same per-issue denial of
   service, reached by a different key, and **it becomes reachable at D1 stage 1**. It is named
   here rather than fixed: it is an availability fault behind a gate that is off everywhere, and
   the stage-1 owner (PEN-5016) is the right place to decide whether it blocks enablement. Owned
   as **PEN-5027**, so the decision has a holder rather than only this paragraph.

2. **§7.4's "fail closed and loud at render, or do not change it" is not on point here, and was
   cited as if it were.** That sentence governs silently *stripping* a credential, so that publish
   fails at a boundary reporting success. Ignoring an issue override is the opposite direction:
   nothing is removed, nothing reports success falsely, and the pod is what the agent's own config
   asked for. The sentence is about a change that lies; this one declines an input.

3. **The silence was the real cost of discarding, and it is paid separately.** An agent that opted
   out would still publish perfectly well, and no metric distinguishes "brokered" from "opted out".
   The dispatch path therefore logs `agent_scope_only_config_key_override_refused` with the run,
   agent, issue and refused keys, for both the issue and model-profile routes. That is the "loud"
   half, without the denial of service.

**Stated weakness: this is a list, and a list is as complete as its last edit.** The `image`
finding above is that weakness firing on the first try — review caught a key the list did not, in
the same change that introduced the list. It is mitigated, not removed — the membership is pinned by a test so adding or removing a key is a deliberate act
with a diff on it, and the maintenance rule is written at the list ("a key belongs here when it
decides where a credential lands, what uid runs it, or whether a refusal fires"). An allowlist of
issue-settable keys would be structurally stronger and was considered; it was not taken because the
live set of keys issue overrides legitimately carry has not been measured, and guessing it would
break `modelProfile` and workspace selection, which this change deliberately leaves alone. Build
the allowlist when that measurement exists.

**A sibling key defeated the same boundary, and is closed here too (found by Ally reviewing the
fix, 2026-10-29).** Pinning the gate is not sufficient on its own. `image` is read off the *same*
merged config, and `buildJobManifest` hands it to the broker sidecar — which execs
`paperclip-github-token-env` and the broker runtime JS **out of that image** with the push
credential in its environment. So an issue override could leave `enableGitHubPublishBroker` pinned
exactly as intended and still choose the code that runs at uid 1001 holding the token. The gate
would have held and the boundary would not.

It is closed adapter-side rather than by a second list entry: the broker now renders from
`ctx.agent.adapterConfig` — the agent row *before* any merge, which is the one image value in that
function with agent provenance — while the agent container keeps the merged value. That asymmetry
is deliberate and is the point of D1: a brokered agent container holds no credential, so what it
runs is its own business; only the credential-holding container must run operator-chosen code.
Divergence between the two is allowed rather than refused, because a socket-protocol mismatch
fails loudly at publish time with no credential in it, whereas throwing would re-create the denial
of service this section declines above. Pinned by three cases in
`job-manifest.github-publish-broker.test.ts`, including a positive control that the broker still
*tracks* the agent image rather than being frozen to a constant.

**A third route, closed the same day: a privileged container standing *beside* the broker.**
Pinning the gate and the broker's image both answer "what code runs inside the boundary". Neither
answers "what else is in the pod". `enableDocker` renders the DinD sidecar as
`privileged: true, runAsUser: 0` in the **same pod** as the broker, and the agent container is
handed the resulting docker socket — so it can start further privileged containers with arbitrary
host mounts. A privileged root container defeats an in-pod uid boundary generally; it never needs
the credential volume mounted to read uid 1001's filesystem. Read off the merged config,
`enableDocker` was issue-settable, so the boundary was declinable by a third sibling key.

`enableDocker` and `dockerImage` are therefore pinned to agent scope **while the gate is on**, by
the same merge guard (`BROKERED_POD_COMPOSITION_CONFIG_KEYS`). `dockerImage` rides along because a
pinned `enableDocker` with an overridable image is a pin in name only. The pin is conditional for
the same reason the rest of this section is narrow: `enableDocker` stays freely overridable for
every agent not running the broker, which is the whole fleet today, so no current run changes. The
cost is stated and real — an issue override cannot request docker on a broker-enabled agent.

The membership rule is written at the list so this stays a rule rather than a list of remembered
incidents: **when the credential is brokered, what code runs in the pod and at what privilege is
agent scope's to decide.** `image` is deliberately not in that set — it is pinned at the point of
use instead, which is stronger and leaves the agent container's image alone.

✅ **The residual this section recorded is now closed, in the other direction: see §7.6
(decided 2026-10-29).** What stood here was "an operator who sets *both* `enableDocker` and
`enableGitHubPublishBroker` on the same agent still gets a privileged root container beside the
broker, and the uid-1001 boundary does not hold against it — recorded rather than refused, because
it is an operator decision about their own agent." §7.6 re-examined that with the question properly
scoped and **refuses the combination at render**. The reason the two sections differ is the reason
this one gave for not refusing: ground 1 above is an availability argument about a *third party*,
and at agent scope there is no third party. Read §7.6 before citing this paragraph; the shape of
the boundary moved.

⚠ **Scope of the claim, stated so it is not read wider than it is.** What is now agent-scope-only
is the **gate key**, the **broker's image**, and — while the gate is on — `enableDocker` /
`dockerImage`. The rendered broker boundary *as a whole* is not,
and this document should not be cited as saying so: `AGENT_SCOPE_ONLY_CONFIG_KEYS` is a list, the
`image` and `enableDocker` routes above were both found by review rather than by the list, and
the `workspaceVolumeClaim` route in ground 1 is open. Four keys are closed; the class is not.
§7.6 closes the *privilege* class structurally rather than by a fifth key — which is the
answer to this paragraph's complaint, for that one class only.

**The audit half.** `enableGitHubPublishBroker` is now in the adapter's `getConfigSchema()`, so the
state of a credential boundary is legible to a reviewer looking at the agent rather than only to
whoever reads the database. That field is a **view** — the pin above is the enforcement, and both
the field's hint and its provenance entry say so, because describing a UI toggle as the boundary
would be the §8 overclaim.

**Scope.** Nothing here changes the gate's default, the broker, the wrapper, the hook, the scanner
or the credential path, and nothing here approaches §8's forbidden list.

### 7.6 A privileged container beside the broker: refused at render (decided 2026-10-29)

**Owner: Security (§8 reserves the shape of this boundary). Raised as PEN-5026, out of §7.5.**

**The finding.** D1's property is that the push credential lives in a container at uid 1001 that
the agent cannot read into. That property is about the **pod**, not about the broker container.
`buildDindSidecar` renders the DinD sidecar `privileged: true, runAsUser: 0, runAsNonRoot: false`
in the same pod as the broker. It mounts no credential volume and does not need one: privileged
means `setns` into another container's mount namespace, and it means mounting the node's own
filesystem, where the kubelet has already written the Secret. The agent is then handed that
sidecar's docker socket (`--group=1000`, mode 0660 root:1000), so it can start further privileged
containers with arbitrary host mounts. §7.5 pinned `enableDocker`/`dockerImage` to agent scope,
which closes the route where a *lower* scope turns this on; it does not reach an operator who sets
both keys on the same agent.

**Why this was worth re-opening rather than leaving as §7.5's residual.** Not because it was live
— `enableGitHubPublishBroker` is `false` everywhere, so no pod has a broker for a sidecar to sit
beside. Because of what it does to the **measurement**. PEN-5016 stage 1 soaks D1 to find out
whether the boundary holds. For a docker-enabled agent it does not hold, and the soak would read
green regardless, because publishing works identically either way. Nothing — no metric, no log
line, no failed dispatch — distinguished "brokered and isolated" from "brokered with privileged
root beside it". A soak containing such an agent is evidence of nothing, and nobody reading its
result could tell.

**Decision: refuse the combination at render.** With the broker on, `buildJobManifest` throws if
any container other than the broker holds privilege. Four grounds.

1. **§7.5's reason for not refusing is scope-dependent, and does not survive the move to agent
   scope.** Ground 1 there is an availability argument about a **third party**: anyone able to
   assign an issue could park the key on an issue assigned to *another* agent and fail every
   dispatch of it, denying service to a principal who did nothing. At agent scope there is no
   third party. The only principal who can set `enableDocker` on a brokered agent is the operator
   who also set `enableGitHubPublishBroker`, and the failure is immediate, attributed, and fixed
   by the same hand that caused it. §7.5's own ground 1 therefore argues *for* refusal here.

2. **It is the third member of a set this builder already has.** A broad data mount throws. An
   env-delivered credential throws. Both say the same thing: the pod would REPORT a boundary that
   is not there, the config is operator-fixable, so refuse and name the leg that failed. A
   privileged container beside the broker was the one member of that set still rendered silently.
   Note the env-credential refusal is itself **agent-scope-only** — the seat-token binding is
   pinned by `withAgentScopedEnvProvenance` — so "this builder does not refuse an operator's own
   decision" is not a rule it follows. It refuses exactly this kind of decision, twice already.

3. **Refusing makes the state unrepresentable, which is strictly better than detecting it.** The
   row asked for the outcome to be *detectable*. An accept-and-exclude answer (option (c)) needs a
   check that enumerates docker-enabled agents at soak time and keeps being run, and it leaves the
   broken combination legal between runs of that check. Refusing at render puts the enforcement in
   the one place that sees every pod, at the only moment anyone can still act, and leaves nothing
   to detect: every brokered pod that exists holds the boundary, so a green soak means something.

4. **Dropping the sidecar instead of refusing would be §7.4's error.** Silently removing docker
   would leave the agent's toolchain failing at a boundary that reported success. The operator
   asked for two things that cannot both be true; say so.

**The check is a property, not a key.** §7.5 states its own weakness — "this is a list, and a list
is as complete as its last edit" — and records it firing twice, `image` and then `enableDocker`,
both found by review rather than by the list. A third list entry would inherit it. So
`findPrivilegedContainersBesideBroker` reads the **assembled** pod spec and asks whether anything
beside the broker is privileged, escalation-capable, or holds a capability that crosses a
container. A sidecar added later is covered without anyone remembering to add it.

⚠ **The discriminator is privilege, not uid, and tightening it to `runAsUser === 0` would brick the
broker.** PEN-4932's `seed-writable-dirs` init container is uid 0 by necessity — it creates the
`subPath` targets a narrow mount needs, and `narrowWritableSurface` is itself a precondition of the
broker — so uid 0 and the broker *co-occur*, in exactly the configurations the broker is legal in.
It is also not a risk: unprivileged, `allowPrivilegeEscalation: false`, every capability dropped
but CHOWN and DAC_OVERRIDE (neither crosses a container), and, being a classic init container ahead
of both sidecars, exited before the broker process exists. Pinned by a test for that reason.
`allowPrivilegeEscalation` is tripped when **unset** as well as when true, because Kubernetes
defaults it to true — reading absent as false would make the backstop inert on exactly the
container nobody thought about.

**The release condition, named so this does not quietly delete a capability.** Option (b) —
rootless DinD, or a non-Docker builder — would make the combination renderable with the boundary
intact, and is strictly better if it works. It is not taken today because it is **unmeasured**, and
because making it work in this pod needs precisely what §8 reserves: `allowPrivilegeEscalation`,
dropped capabilities, or an unconfined seccomp/AppArmor profile. So: refuse now, and treat an
unprivileged container runtime as the thing that releases the refusal. The error message says so,
in the same shape §7.4 uses for the seat token. **Do not weaken the refusal instead.**

**The cost, measured rather than asserted.** Zero agents today. All 11 agents in the one company
readable from this seat carry neither `enableDocker` nor `enableGitHubPublishBroker` in their
`adapterConfig`. That measurement is *complete* rather than a sample, and §7.5's pin is what makes
it so: `withAgentScopedConfigProvenance` restores both keys from `baseConfig`, so when the broker is
on, agent `adapterConfig` is the only place either key can come from — no project scope, no model
profile, no issue override. The standing cost is narrower than it looks: `enableDocker` is
unaffected for every agent not running the broker, which is the whole fleet.

**What this does NOT claim.** It does not make the pod unprivileged — a docker-enabled agent with
no broker still gets the privileged sidecar, unchanged, and that is the status quo this decision
deliberately leaves alone. It does not address `hostPID`, `hostIPC` or `shareProcessNamespace`,
none of which this builder sets. And it is scoped to the `claude_k8s` adapter: `opencode_k8s`
renders the same privileged sidecar but has no broker, so there is no uid boundary there to defeat.

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
  ⛔ **Taken 2026-10-29 (PEN-4986, widened PEN-4993 → PEN-4989): the count is 28, NOT zero — so
  the non-zero branch above is the one that applies.** §7.2 trigger 4 has **fired** and the §7.1
  acceptance is **ended as of 2026-10-29**. The first five windows returned zero; the sixth, an
  Engineer pod running the repository's own test suite, returned 28. Widening along the *pod*
  axis alone would have returned zero indefinitely — **workload** was the uncovered axis. The
  mechanism is a **class, not a site**: any test or tool that builds its own narrowed `PATH` gets
  an unwrapped `git` for free, and the known site is cross-repo
  (`Blockcast/penstock-llm-proxy-core`), so a paperclip-only sweep reports it clean. Tracked as
  **PEN-5012**. See §7.1 and
  [`PEN-4986-absolute-path-git-runtime-measurement.md`](./PEN-4986-absolute-path-git-runtime-measurement.md),
  whose own headline records the *first* window and says so — do not cite that document's "zero"
  as the answer. The tool is `scripts/measure-absolute-path-git.mjs`; re-take it on any agent-image
  or PATH change. ⚠ Re-taking it is still permitted here and is still only an observation — but
  note that the measurement has already discharged its purpose, so a further re-take neither
  revives the acceptance nor is required to end it.

Not permitted without returning here first:

- Any integrity check between wrapper, hook and scanner (§3).
- Any relaxation of `allowPrivilegeEscalation`, dropped capabilities, or `runAsNonRoot` (§3).
- Any credential helper that emits the token to the agent container (§5).
- Any broker that implements its own notion of what a push may contain (§5, door parity).
- Routing an **env-delivered** credential (`GH_SEAT_TOKEN_VALUE`, and the `GH_TOKEN` /
  `GITHUB_TOKEN` / `GITHUB_PERSONAL_ACCESS_TOKEN` it expands into) through the broker rather
  than refusing to render the Job — decided 2026-10-29 in §7.4, which lists the three
  conditions that would release it.
- Weakening, narrowing or removing §7.6's refusal of a privileged container beside the broker —
  including narrowing it from a property check back to a key check, or reading an unset
  `allowPrivilegeEscalation` as `false`. The way to make `enableDocker` and the broker coexist is
  an unprivileged container runtime, which is §7.6's named release condition and lands squarely in
  the `allowPrivilegeEscalation` / dropped-capabilities bullet above.
- Describing this control as tamper-resistant anywhere in the codebase until D1 ships. The header
  in `github-git-egress-runtime.ts` is the canonical statement of its limits and is updated by this
  change; keep it true.
