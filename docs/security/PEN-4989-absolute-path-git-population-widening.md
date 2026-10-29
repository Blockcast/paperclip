# PEN-4989 — widening the absolute-path-`git` measurement past one pod

[`PEN-4986-absolute-path-git-runtime-measurement.md`](./PEN-4986-absolute-path-git-runtime-measurement.md)
took the measurement that §7.1 of
[`PEN-3183-git-egress-enforcement-boundary-decision.md`](./PEN-3183-git-egress-enforcement-boundary-decision.md)
makes its residual acceptance conditional on, and got **zero** — in **one pod**, on one image, for
one agent's workload. This document widens that population to **six windows across four agents and
five pods** (§1 is this record's own; §1.1 carries the Devops, UX Designer and Engineer rows; §1.2 is
the one that fired), and it exists because §7.2 trigger 4 has no detector and cannot have one: it has
only this measurement, and a measurement observes nothing between runs.

# ⛔⛔ RESULT: §7.2 TRIGGER 4 HAS FIRED. THE §7.1 RESIDUAL ACCEPTANCE ENDS HERE.

**The count is not zero.** The fifth window — an **Engineer** pod running the repository's own test
suite — observed **28 invocations that reached a real `git` binary without transiting the egress
wrapper**, none of them deliberate controls (PEN-4993, §1.2). Trigger 4 is written as a **count**
test, not a harm test, and the count is 28.

Per PEN-4989's own acceptance criterion, stated here explicitly rather than implied: **§7.1's
residual acceptance does not run to 2027-01-31. It is ended by this measurement, as of
2026-10-29.** This is raised to the **CTO** as the owner of the disposition, and is deliberately
**not** folded into PEN-4933's D1 broker rollout — the acceptance ending is a fact about today, not
a task to be absorbed into a future change.

The first five windows were zero. **That is not a reassurance, it is the finding**: five windows
across four agents saw nothing, and the sixth saw 26 in a 24-second burst, because it was the first
to run `pnpm test`. The measurement's blind spot is not between pods — it is between *workloads*.

⚠ **The 28 are individually harmless and the mechanism is not.** All 28 are non-publishing
(`rev-parse`, `maintenance run`) against throwaway scratch repos with no remote; nothing was
published and no credential was used. The finding is the **class**: 26 come from first-party test
code that constructs its own `PATH` (§1.2), and **any** test or tool that does so gets an unwrapped
`git` for free, on a pod where `/etc/gitconfig` supplies a live publish-capable credential helper
unconditionally.

⛔ **Separately, the zeros that preceded it are worth less than PEN-4986 stated** — §2.1. Three rows
found the calibration method overstates catch against the real binary. That weakens the bound §7.1
rested on; it is a second, independent reason the acceptance as written does not hold.

**But one claim PEN-4986 made is wrong, and §3 below retires it.** PEN-4986 argued that its image
census generalises fleet-wide "because the image is identical across the fleet". The fleet does not
run one image. That does not change either measurement's number; it changes what may be inferred
from them, and it changes the shape of the re-measurement trigger.

> ⚠ **Merge order: PR [#3098](https://github.com/Blockcast/paperclip/pull/3098) lands first.**
> Two things this document relies on exist only there and 404 on `master` until it lands:
> `PEN-4986-absolute-path-git-runtime-measurement.md` (linked above — this record's primary
> reference) and `scripts/measure-absolute-path-git.mjs` (the measurement itself, invoked by the
> §6 re-run procedure). Landing this record first would publish a security record whose primary
> link is dead and whose re-measurement procedure cannot be executed — which is the specific
> failure §4 is about: a staleness rule nobody can run is a rule nobody acts on.

## 1. Window, population, result

| | |
|---|---|
| **Window** | `2026-10-29T08:35:16.715Z` → `2026-10-29T08:43:11.876Z` UTC (`7.9` min, `220483` sweeps) |
| **Population** | one agent pod: `ac-7500672d-efe6-40-872601a6-55e4-43-40d491-bfzww`, ns `paperclip`, agent **Security Engineer** (`7500672d-efe6-4037-a05f-61204a670894`), run `872601a6-55e4-430c-8726-76d4c8f976ff`, task PEN-4989 |
| **Image** | `…/paperclip-agent:sha-4db591b-k8s-vendored` (`sha256:2ebb2948…30538a7`) — **a different image from PEN-4986's** `sha-ed39009-k8s-vendored` |
| **Surface fingerprint** | `d81423fe12c348c3e7ef7a004614385439f3d1998506850e47fcad640cf55568` (rule **v2**, §4) |
| **`/usr/bin/git` observations** | `233` |
| **— wrapped** | `231` |
| **— unwrapped** | **`0`**, plus 2 deliberate negative controls |

Subcommands observed: `--version` 194, *(empty argv)* 18, `config` 14, `show` 5, `checkout` 1,
`log` 1.

⚠ **Read that histogram before citing this window as "representative work" — it is not, and it is
weaker than PEN-4986's on exactly that axis.** 194 of the 233 are `--version`, because this run
invoked 210 of them as controls. The organic remainder is ~21 invocations over 7.9 minutes against
PEN-4986's 54 over 22.1. What this run adds is a **second image**, a **census reproduction** (§3), and
a **false-positive bound** (§2) — not a richer sample of agent behaviour. Both windows are short.

ℹ **The fingerprint above is a rule-v2 digest, and the measurement was taken under rule v1.**
The run recorded `a23454c47df4da615771bb9e5a5c958975587cb403884354812741ea70a144ee`; v2 additionally
hashes the *contents* of every `git` in the PATH layout, so every v1 digest is numerically different
from its v2 counterpart. The value above is not a re-derivation from the old one — it was recomputed
on the live surface, and the bridge is explicit: re-running the **v1** rule in the pod that produced
this edit — image `…/paperclip-agent:sha-1e99f06-k8s-vendored`
(`sha256:fd6337d3…10b2a31`), a **fourth** distinct image — reproduces `a23454c4…` exactly. (It is
"uncensused" only in the §3 sense of not appearing in this record's own image census; §1.1's two
workload rows were subsequently measured **on** it, which is why its digest now has three
independent confirmations rather than one.) That
establishes its egress surface as byte-identical to the measurement pod's, so its v2 digest is this
surface's v2 digest. Rule version is folded into the digest (`FINGERPRINT_VERSION`), so a v1 value
meeting a v2 value reads as a mismatch rather than as an unchanged surface.

### 1.1 The workload axis — three further agents, four further windows

PEN-4989 asked for the measurement in more than one agent pod *across agents whose workloads differ*,
because the population is (image × PATH layout × **workload**). Three agents took it in their own
runs, unprivileged and read-only, and reported on their own rows. **Devops and UX Designer were zero;
Engineer was zero on a git-dense window and NON-ZERO on a build/test one (§1.2).** The axis was the
right axis, and it took the sixth window to show it.

| Row | Agent | Image | Window | Sweeps | Obs. | Unexplained unwrapped | Copy calib. |
|---|---|---|---|---:|---:|---:|---:|
| PEN-4986 | Security Engineer | `sha-ed39009` | 22.1 min | — | 54 | **0** | `0.930` |
| PEN-4989 (§1) | Security Engineer | `sha-4db591b` | 7.9 min | 220,483 | 233 | **0** | `0.840` |
| **PEN-4992** | **Devops** | `sha-1e99f06` | 6.4 min | 167,814 | 24 | **0** | `0.933` |
| **PEN-4994** | **UX Designer** | `sha-1e99f06` | 4.8 min | 132,456 | 64 | **0** | `0.793` |
| **PEN-4993** A | **Engineer** (git-dense) | `sha-e74d17b` | ≈ 3 min | — | — | **0** | — |
| **⛔ PEN-4993** B | **Engineer** (build/test) | `sha-e74d17b` | 17.0 min | 435,047 | 2,447 | **⛔ 28** | `0.837` copy / `0.810` real |

⚠ **The `Obs.` column is not one quantity across rows and must not be summed.** PEN-4986's `54` is its
*organic* count; this record's `233` is the *total*, of which 210 were self-inflicted controls and only
≈ 21 organic (§1). The comparable organic figures are PEN-4986 `54`, this record ≈ `21`, PEN-4992 `24`,
PEN-4994 `64`, PEN-4993 B `2,447`. The column that **is** uniform, and the one this record turns on,
is *unexplained unwrapped*: **zero in the first five, ⛔ 28 in the sixth.**

**Six windows, four agents, five pods, four images — and ≈ 61 minutes of observation in total.**
⛔ **Trigger 4 fired in the last one (§1.2). The first five were zero.**

The three new agents are what makes this a workload axis rather than a repeat:

- **Devops** is the heaviest git/CI consumer in the company, and that is why it was the sample worth
  taking: `git init` / `fetch --depth 1` against two repos across three branches, `git show`,
  `rev-parse`, and ≈12 `gh` API calls — which drive the credential-helper path specifically. **All of
  it resolved through the PATH wrapper; nothing in that workload reached for an absolute path.**
- **UX Designer** exercised a frontend toolchain neither engineering pod had: a 131 MB clone,
  `pnpm install`, `tsc`, 1,759 vitest tests, a Vite build, and headless Chrome across 23 portal
  surfaces. Its 2 `git-core` observations were `git-remote-https` from its own clone, classified
  wrapped via the ancestry arm — class B behaving as designed, not a finding.

**The rows may be pooled, and that is measured rather than assumed.** Pooling is only legitimate
if the rows describe the same egress surface, so the surface digests were compared before summing:
PEN-4992, PEN-4994 and this record all report v1 fingerprint
`a23454c47df4da615771bb9e5a5c958975587cb403884354812741ea70a144ee`, with byte-identical hashes for
the wrapper (`deee13f6…`), the egress runtime (`f3b28390…`), the credential helper (`aed18024…`) and
the real binary (`356db14e…`), and `wrapperAhead: true` in every pod. §1.2's Engineer pod, on a
**fifth** image `sha-e74d17b`, independently reports the same **v2** digest `d81423fe…` as §1.
**Four different image tags, one byte-identical egress surface** — the same point §3 and §5 make from
the other direction, now with four data points instead of one. It is also the cleanest vindication
of §4: keyed on the image tag the staleness trigger would have fired here for nothing; keyed on the
surface it correctly says "same surface, the prior measurement may be cited".

⚠ **What this does not establish.** Four agents is not the fleet, and ≈ 61 minutes is not continuous
coverage — between runs nothing is observed, and that blind spot is unchanged. Three of the six
windows are under 7 minutes and ended when the work did. **These rows widen the population; they do
not narrow the accepted blind spot, and must not be cited as doing so.** ⛔ And note which direction
the one finding came from: **not** from more pods, but from one pod doing *different work*. A
population widened along the pod axis alone would have returned zero indefinitely.

⛔ **Read §2.1 before quoting any of these zeros.** The new rows also found that the calibration
method overstates catch against the real binary, which weakens every number in the table above —
including PEN-4986's and this record's.

### 1.2 ⛔ The firing — Engineer pod, build/test workload, 28 unwrapped

Measured by **Engineer** (PEN-4993) and reported there; carried here because PEN-4989 is outside that
agent's authorization boundary (`403 deny_missing_grant`), so the row could not be posted where it
was asked for. The analysis below is theirs; the disposition is this record's (**Disposition**, at the end).

| | |
|---|---|
| Pod / agent | `ac-b4fe9f95-65ef-47-bab67a18-23d8-41-4e3297-c259s` (node `k8s-paperclip-3`) / **Engineer** |
| Image | `sha-e74d17b-k8s-vendored` (`sha256:e690d3bf…077c9705`) — a **fifth** image |
| Surface fingerprint | `d81423fe…` (**v2**), `wrapperAhead: true` — **byte-identical to §1's** |
| Window | `2026-10-29T10:40:02.002Z` → `10:57:01.715Z` (17.0 min, 435,047 sweeps) |
| Observations | 2,447 — 2,400 wrapped, **48 unwrapped** |
| — marked negative controls | 18 |
| — measurer's own unmarked diagnostics, declared | 2 |
| **— ⛔ UNMARKED, NOT THE MEASURER'S** | **28** |
| indeterminate | 4 (`/usr/lib/git-core/git`, caught mid-`execve`) |

**The mechanism: first-party test code builds a wrapper-free `PATH` on purpose.** 26 of the 28 are a
24-second burst inside one test file, `test/secret-scan-budget.test.ts:611`, which spawns the CI
secret-scan script with a narrowed environment:

```ts
PATH: `${bin}:/usr/bin:/bin`,
```

`/usr/local/libexec/paperclip/bin` is absent from that `PATH` **by construction**, so every `git` the
spawned script runs reaches the real binary directly. The intent — isolate `gitleaks` so the
absent-binary case is genuinely absent — is reasonable and is commented in place. **The wrapper
bypass is an unremarked side effect of it.** That is the generalisation and the reason this is a
finding: **any test or tool that constructs its own `PATH` gets an unwrapped `git` for free.** It is
a class, not a file, and it is reached by every run of the test suite.

The remaining 2 are `/usr/lib/git-core/git maintenance run --auto --no-quiet --detach`, which is
**PEN-4998's class** — already triaged and excluded from the novel part of this finding.

**Why the `wrapped: false` verdict is sound.** A wrapped invocation necessarily presents three
signatures at once: `argv[0] == "/usr/bin/git"`, the two injected `-c credential.https://github.com.helper`
flags, and the node egress runtime in its ancestry. All 26 show a bare `git` as `argv[0]`, **no**
injected flags, and an ancestry of `bash < vitest < pnpm < zsh < claude` with no wrapper or runtime
anywhere — `viaArgv`, `viaEnv` and `viaAncestor` all false with `environReadable: true`. The
environment was readable and simply did not carry the marker. **The instrument also demonstrably saw
positives inline in this same window**: 23 marked controls, 18 observed, all 18 correctly flagged.
The 28 are not an artefact of a dead instrument.

⛔ **§4.0 verified live in that pod — the credential is there.**

```
$ git config --show-origin --get-all credential.https://github.com.helper
file:/etc/gitconfig    !/usr/bin/gh auth git-credential
```

An unwrapped `git` reaching github.com **is** authenticated by the system credential helper, with no
intent and no credential handling by the caller. These 26 ran with a live, publish-capable credential
path available and unscanned. It was **not** exercised — identifying a bypass is in scope, using one
is not.

### ⚠ The predicate matters, and this result is the first to make it load-bearing

"Absolute-path `git`" is a **poor literal test**, because the *wrapped* path is itself the one that
invokes `/usr/bin/git` absolutely. What actually discriminates is **transiting the wrapper**.

- By the instrument's definition — *reached a real `git` without transiting the wrapper* — the count
  is **28**.
- By a literal `argv[0] == "/usr/bin/git"` test it would be **0**.

§7.1's framing ("absolute-path invocations are rare-to-absent") and the instrument's definition are
**not the same predicate**. **28 is reported, because that is the predicate the acceptance is
actually conditional on** — an invocation that skips the scanner is the thing §7.1 is accepting the
risk of, whichever way it spells the path. **PEN-3183 §7.1 must state which predicate it means**; until it
does, the literal reading would let this exact finding be reported as a zero.

### Severity — argued both ways, disposed of at the end of this record

**Toward lower severity:** all 28 are non-publishing against remote-less scratch repos; nothing was
published and no credential was used. 26 come from one first-party test whose `PATH` narrowing is
deliberate and commented — a reviewed design choice, not agent-composed shell. The other 2 are
already-triaged PEN-4998.

**Toward taking it seriously:** the count the acceptance is conditional on is **not zero**, and
trigger 4 is a count test. §7.1's ground is that these invocations are *rare-to-absent* — in an
Engineer workload they are neither: **26 in 24 seconds from one ordinary `pnpm test`.** The
**accidental** disclosure case is what this control exists for, and this is precisely an accidental,
unremarked bypass — nobody writing that `PATH` line was thinking about egress. And it is a class
reached by every run of the suite, distinct from but adjacent to PEN-4979.

**Read:** the specific invocations are harmless; **the mechanism is the finding**; and §7.1's
assumption as written does not survive this workload.

### Wrapped by which signature

| Arm | Count |
|---|---|
| 1 — `argv` carries the paperclip `-c` helper | 219 |
| 2 — `GIT_CONFIG_PARAMETERS` carries it | 0 |
| 3 — an ancestor is the wrapper or the egress runtime | 231 |

Arm 3 covered every wrapped observation and arm 2 covered none, which is worth recording because it
is the opposite of what the arms' ordering suggests: in this window nothing spawned a descendant git
deep enough to need the environment arm. Arm 3 is doing the load-bearing work, including for the 18
observations caught mid-`exec` whose `argv` was not yet readable — see §2.

## 2. Instrument validation

All controls were run against the shipped script inside the window.

- **Positive control** — 10 PATH-resolved `git --version`: 9 observed, **9/9 wrapped**.
- **Negative control** — 3 × `/usr/bin/git -c pen4989.negativecontrol=marker --version`: **2
  observed, both correctly classified unwrapped**, with all three wrapped-signatures absent. Both
  are excluded from the count as self-inflicted. `--version` touches no credential, no network and
  no repository.
- **Catch rate** — 300 invocations of a **copy** of the git binary at a different path
  (`cp /usr/bin/git /tmp/pen4989/git-calib`): **252 caught, `0.840`**. A copy is used so that
  calibrating cannot contaminate the count. Lower than PEN-4986's `0.930`; this pod was busier.
  ⛔ **This number is a CEILING on catch against the real binary, not a floor — see §2.1.** It was
  described as a floor here until the two workload-axis rows measured the opposite direction.
- **False-positive control (new here)** — **200** PATH-resolved (wrapped) invocations produced 195
  observations and **0** misclassified as unwrapped.

That last control is new because this run tripped the failure it rules out. One observation came
back `wrapped: false` carrying an **empty `argv`** and `environReadable: false` — a process caught
between `exec` and the kernel publishing its `cmdline`/`environ`. Read carelessly that is a trigger-4
firing. It is not: its ancestry was `zsh` → `claude` with no wrapper in the chain, which is the
signature of one of this run's own three absolute-path negative controls, and the pid/starttime sit
one tick from the control that *was* fully captured.

The general question it raises — *can the same race make a genuinely wrapped invocation look
unwrapped?* — is the one that matters, because that direction manufactures false findings. The
answer measured here is **no**: arm 3 reads the ancestry, which `/proc` publishes before `cmdline`,
so the 18 mid-`exec` observations in this window were all still classified wrapped, and 195 wrapped
invocations produced zero false positives. The classifier's documented bias toward *wrapped* holds
under the race as well as under the evidence checks.

Taking `0.840` at face value, a single missed worst-case invocation would have probability `0.160`,
bounding the true count at ≤ 1 with ~84% confidence for that shortest class. ⛔ **Do not cite that
bound.** §2.1 shows `0.840` is measured on the wrong target and overstates catch against
`/usr/bin/git` itself; the defensible bound is the one derived there, and it is materially weaker.

## 2.1 ⛔ The calibration copy OVERSTATES catch against the real binary

Every row in this population calibrates the same way: 300 invocations of a **copy** of git at
another path. The copy exists so that calibrating cannot contaminate the count, and that reason is
still sound. **But the rate it yields does not transfer to `/usr/bin/git` itself, and it errs in the
direction that flatters the result.** This was found by the two workload-axis rows (§1.1), not by this
run, and it applies to PEN-4986's `0.930` and this record's `0.840` as much as to theirs.

Two independent measurements, by two agents, in the same direction:

- **Devops (PEN-4992)** calibrated `0.933` on the copy and then caught **1 of its 3** marked
  `/usr/bin/git` negative controls. At `p = 0.933` that is `P[≤ 1] ≈ 1.3%` — the two numbers do not
  reconcile.
- **UX Designer (PEN-4994)** calibrated `0.793` on the copy and reports `/usr/bin/git` itself
  calibrating **`0.710`** head-to-head.

Pooling the marked negative controls — the only measurements taken against the real binary — across
all three rows:

| Row | Copy calibration | Marked controls caught |
|---|---:|---:|
| PEN-4989 (this record, Security) | `0.840` | 2 of 3 |
| PEN-4992 (Devops) | `0.933` | 1 of 3 |
| PEN-4994 (UX Designer) | `0.793` | 2 of 3 |
| **Pooled** | **≈ `0.86` predicted** | **5 of 9 = `0.56` observed** |

The copy rates predict ≈ `7.7` of 9; `5` were caught. The plausible mechanism, and the one both rows
propose independently: a freshly written copy is cold, while `/usr/bin/git` is warm in page cache and
its `--version` is correspondingly shorter-lived, so a 2 ms sweep catches it nearer one-half than
nine-tenths.

**§1.2's Engineer row then ran the direct test this section asked for — and it narrows the gap
sharply.** Rather than inferring from negative controls, it calibrated `n = 300` against each target
head-to-head in one run:

| Target | Caught | Rate |
|---|---:|---:|
| copy named `git` | 251/300 | `0.837` |
| `/usr/bin/git` | 243/300 | `0.810` |
| `/usr/lib/git-core/git` | 243/300 | `0.810` |

**The direction holds — the copy does over-state — but by `0.027` here, not the ≈ `0.3` the negative
controls implied.** Treat the three-row inference above as what it is: an estimate from 9 samples,
which the 900-sample direct measurement supersedes on magnitude while confirming on sign. The honest
summary is that **the pods disagree on magnitude and agree on direction, and no pod's absolute rate
should be reused as a fleet figure.** Naming the copy `git` matters here: git dispatches on
`argv[0]`, so a copy named `git-calib` takes a shorter startup path and calibrates against the wrong
thing (§6).

**What this does and does not change.**

- It does **not** change any count, and it is **not** what fired trigger 4 — §1.2 is. The five zero
  rows still measured zero, and the instrument demonstrably sees positives: `5` of `9` absolute-path
  negative controls here, and in §1.2's window `18` of `23` inline, plus the 28 real ones.
- It **does** change what those five zeros are worth, and that is the number §7.1's residual
  acceptance leaned on. Even on the narrow `0.810`-vs-`0.837` direct measurement, an observed zero
  bounds the true count loosely for the shortest-lived class: a worst-case invocation is missed with
  probability ≈ `0.19`, so a small non-zero count per window was never excluded by a zero. The zeros
  are strong against anything repeated, long-running, or organic; they are **weak against a single
  short-lived invocation** — which is the shape trigger 4 exists to catch, and §1.2 is what catching
  it actually looked like.
- It is therefore reported here rather than resolved. **Resolving it means re-basing the instrument**
  (calibrate against `/usr/bin/git` directly with a marked harmless flag, alongside the copy, and
  compare head-to-head), and **re-basing one row without the others would make the population
  incomparable**. UX Designer deliberately kept the old spelling for that reason. If the population is
  re-based, re-base all rows together.

⚠ **This section weakens the evidence under §7.1's conditional acceptance; it is not what fired
trigger 4.** Trigger 4 fires on a non-zero count, and §1.2 is where that happened. Keep the two
separate: §1.2 ends the acceptance, while this section explains why even the zeros that preceded it
supported a looser claim than PEN-4986 made for them.

## 3. ⛔ The fleet-generalisation argument does not hold as PEN-4986 stated it

PEN-4986 §4 split git invocations into an image-resident half that "*does* generalise… because the
image is identical across the fleet", and an agent-composed half that does not. **The premise is
false.** Measured 2026-10-29 from `kube_pod_container_info{namespace="paperclip", container="claude"}`:

| Question | Measured |
|---|---|
| Distinct agent image **digests** running in the 7 days to 2026-10-29 | **106** |
| Distinct agent images in the preceding **24 h** | **17** (≈15/day) |
| Share of that week with **more than one** image live simultaneously | **38.2 %** |
| Distinct images live at the instant of this measurement | **3** (`sha-4db591b` ×13, `sha-3ddaae3` ×1, `sha-ed39009` ×1) |

Agent pods are per-run Jobs that pick up whatever image their agent is pinned to when they start, and
agents are bumped independently — so at any instant the fleet is a *mixture* of images, not one. The
pod that took PEN-4986's measurement and the pod that took this one were running different images
hours apart, and PEN-4986's own image was still serving another agent while this was written.

**What survives, and it is not nothing.** The census was re-run here, same method and same roots, on
this different image: **15** literal `/usr/bin/git` occurrences, **all of them inside the
egress-control machinery itself** — `DEFAULT_GIT_BINARY`, the wrapper's own `exec` line, comments and
type declarations in `github-git-egress-{runtime,shim}`, `github-publish-broker{,-client}`, and the
two adapters' `job-manifest`. **Zero exec sites outside the wrapper**, matching PEN-4986 exactly.

So the honest form of the argument is **empirical, not structural**:

> The image-resident half is zero by census in **2 of the 106 images** that ran this week, sampled
> ~1 h apart, with identical results. That is evidence the egress machinery is stable across
> rebuilds — it is **not** a proof that every image is identical, and the fleet demonstrably runs
> several at once.

Anyone citing either document fleet-wide must cite that sample size. The agent-composed half remains
per-pod and is now measured in **six** windows across **four agents** (§1.1).

⛔ **This paragraph predicted the finding, and the prediction held.** When this record was first
drafted it said the uncovered axis was **workload** — "the one most likely to vary, since what
differs between agents is precisely what they compose into a shell". That is exactly where the
non-zero count came from: five windows across four agents returned zero, and the sixth returned 28
the moment it ran the repository's own test suite (§1.2). **The axis was correctly identified before
it was sampled**, which is the strongest available argument that the remaining uncovered workloads
are worth sampling rather than assumed clean.

One correction to the original phrasing: the 26 were **not** agent-composed shell. They came from
**first-party test code** constructing its own `PATH`. The axis was right; the mechanism was not what
"what agents compose into a shell" led anyone to look for, which is why no amount of reviewing agent
behaviour would have found it.

## 4. The re-measurement trigger

PEN-4986 wrote the trigger as "re-take it whenever the agent image or the PATH layout changes". §3
shows why that cannot be followed literally: at ≈15 image changes a day, a hand-run measurement is
stale within hours of being taken, every time, and a trigger that is always firing is a trigger
nobody acts on — the failure PEN-4988 exists to prevent.

Almost none of those rebuilds touch git egress. The operable trigger is therefore the narrower one:
**re-take the measurement when the egress-relevant surface changes**, where that surface is the
wrapper, the runtime it `exec`s, the credential helper, the real binary, and the PATH ordering that
decides which of them a bare `git` reaches. `scripts/absolute-path-git-fingerprint.mjs` computes it,
so staleness is a comparison rather than a judgement:

```sh
node scripts/absolute-path-git-fingerprint.mjs --json
```

Rules:

- A later run whose fingerprint **equals** the one in §1 may cite this measurement.
- A later run whose fingerprint **differs** must re-take it; a prior result says nothing about it.
- Compare **like rule for like rule.** The digest carries its rule version (`version` in `--json`,
  `rule vN` in the human output). A digest produced by a different rule is a mismatch by
  construction and means "re-derive under the current rule", not "the surface changed".
- A run reporting `wrapperAhead: false` must not be treated as a stale-measurement question at all —
  the guard is not ahead of `/usr/bin`, which is a live control failure and goes to Security.

The fingerprint is **not a detector for trigger 4** and must not be cited as one. It cannot observe
an absolute-path invocation; it only says whether an earlier observation still applies. Trigger 4
remains undetectable fleet-wide for the reason §7.2 records — no exec-level telemetry is deployed,
and obtaining it from inside an agent pod needs the hardening §8 forbids relaxing.

## 5. What is still open

- **⛔ The acceptance is ended; the remediation is owned but not done.** §1.2 fired trigger 4. What
  this record does NOT do is fix the mechanism: `test/secret-scan-budget.test.ts:611` still narrows
  `PATH`, and **any other test or tool that constructs its own `PATH` still gets an unwrapped `git`**.
  Nobody has swept for the others. **That sweep is [PEN-5012](https://paperclip.blockcast.net/PEN/issues/PEN-5012)**,
  filed so the class has an owner rather than a sentence — which is the failure PEN-4988 exists to
  prevent and would have been repeated by recording it only here. The *acceptance* disposition
  remains the CTO's and is not decided by that row.
- **Workload, not pod count, was the axis that mattered — and it is still barely sampled.** Five pods
  and four agents found nothing until the one window that ran `pnpm test`. **≈ 61 minutes of
  observation in total**, and a single 24-second burst carried 26 of the 28. Widening needs no new
  platform capability, no `kubectl exec` and no tracer — only more agents running the script over
  **more kinds of work**. Sampling more pods doing the same work would have found nothing, forever.
- **⛔ The instrument's calibration is unresolved, and it is the most load-bearing open item here.**
  §2.1 measures the calibration copy as overstating catch against `/usr/bin/git` itself. Resolving it
  means re-basing every row together against a directly calibrated rate; nobody has. Until then the
  defensible bound is §2.1's looser one, and **§7.1 must not be written with a pooled figure that
  implies the tighter one.**
- **⛔ §7.1 still carries a one-pod ZERO, and it is now wrong in substance, not merely narrow.**
  It is rewritten once PEN-4986's PR has landed; until then **this document is the authoritative
  record and §7.1 must not be cited.** The rewrite must say that trigger 4 fired, must not state a
  pooled zero, and must carry §2.1's calibration bound and §1.2's predicate question with it.
- **The sample is 3 of 106 images** (4 counting the unmeasured `sha-1e99f06` surface reproduction). The census's stability across rebuilds is evidence, not a
  theorem — and counting images overstates it, because a different image is not automatically a
  different egress surface. That is measured, not assumed, and §1.1 turned it from one datum into
  three: `sha-4db591b`, `sha-1e99f06` (two independent pods) and the uncensused surface
  reproduction all yield the **same** v1 digest `a23454c4…`, with byte-identical component hashes.
  **Three distinct images, one egress surface.** That is a direct counter-example to treating image
  identity and surface identity as the same thing, and it is the direction that makes "3 of 106"
  read as *less* coverage than the surface evidence actually supports. A fleet claim therefore rests
  on the §4 fingerprint comparison rather than on the image count, which is the point of §4 and the
  reason the trigger is phrased against the surface rather than the image tag. **What remains
  uncovered is an image whose fingerprint DIFFERS: none has been observed — and none has been
  searched for, which is why this is an open item and not a result.**

## 6. Re-running

```sh
node scripts/absolute-path-git-fingerprint.mjs --json > fingerprint.json   # record FIRST
mkdir -p /tmp/calib && cp /usr/bin/git /tmp/calib/git   # copy, and NAME IT `git`: git dispatches
                                                        # on argv[0], so a differently-named copy
                                                        # takes a shorter startup path and
                                                        # calibrates against the wrong thing
node scripts/measure-absolute-path-git.mjs /tmp/obs.ndjson 2 /tmp/calib/git &  # lands in #3098
# positive, negative and calibration controls, then work normally across the window
kill -TERM %1                                      # emits the {"kind":"stop"} summary
grep -c '"wrapped":false' /tmp/obs.ndjson          # minus any deliberate negative control
```

⛔ **If you are re-basing the population (§2.1), calibrate against the real binary as well** — 300
× `/usr/bin/git -c <marker> --version` alongside the 300 against the copy — and report **both** rates.
Do not silently swap one for the other: a row calibrated differently from its neighbours is not
comparable to them, and §2.1's finding exists only because three rows used one method.

Record the fingerprint, the window, the pod, the image **and the agent whose workload ran** beside
the number. A measurement that does not name its population cannot be widened by the next one.

## Disposition — what this record asks for

Stated here because PEN-4989's acceptance criterion requires it to be said explicitly and on the
record, rather than left implicit in a count.

1. **§7.2 trigger 4 has fired** (§1.2, PEN-4993). The count is **28**, measured 2026-10-29.
2. **The §7.1 residual acceptance ends as of 2026-10-29.** It does **not** run to its 2027-01-31
   expiry. Nothing in this record re-grants it on narrower terms — that is the CTO's call, not this
   document's.
3. **Owner: the CTO.** Raised there directly, and deliberately **not** folded into PEN-4933's D1
   broker rollout. The broker retiring the residual *in future* is not the same event as the
   acceptance *failing now*, and merging the two would silently convert a fired trigger into a
   scheduled task.
4. **Open, named so they are not mistaken for handled:** the `PATH`-narrowing class has not been
   swept for other sites — owned by [PEN-5012](https://paperclip.blockcast.net/PEN/issues/PEN-5012),
   filed, not yet done. The predicate ambiguity in §7.1 ("absolute-path" vs "did not transit the
   wrapper") is unresolved and currently admits reporting this very finding as a zero; that one is
   **unowned**, because it is a question about what §7.1 means to claim and only the CTO's
   disposition can settle it. §2.1's calibration question is answered on sign but not on a fleet
   magnitude.
5. **Not in scope here, and not done:** no guard, wrapper, credential path or pod security context
   was touched. §8's "not permitted without returning here first" list binds this record as it binds
   every other measurement row.
