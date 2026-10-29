# PEN-4989 — widening the absolute-path-`git` measurement past one pod

[`PEN-4986-absolute-path-git-runtime-measurement.md`](./PEN-4986-absolute-path-git-runtime-measurement.md)
took the measurement that §7.1 of
[`PEN-3183-git-egress-enforcement-boundary-decision.md`](./PEN-3183-git-egress-enforcement-boundary-decision.md)
makes its residual acceptance conditional on, and got **zero** — in **one pod**, on one image, for
one agent's workload. This document is the second point in that population, and it exists because
§7.2 trigger 4 has no detector and cannot have one: it has only this measurement, and a measurement
observes nothing between runs.

**Result: still zero.** No invocation reached `/usr/bin/git` outside the wrapper, other than the
ones this run deliberately produced. **Trigger 4 has not fired.**

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
(`sha256:fd6337d3…10b2a31`), a **fourth** distinct image — reproduces `a23454c4…` exactly. That
establishes its egress surface as byte-identical to the measurement pod's, so its v2 digest is this
surface's v2 digest. Rule version is folded into the digest (`FINGERPRINT_VERSION`), so a v1 value
meeting a v2 value reads as a mismatch rather than as an unchanged surface.

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
  calibrating cannot contaminate the count. Lower than PEN-4986's `0.930`; this pod was busier, and
  the figure is a floor measured on the shortest-lived invocation class, not an operating rate.
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

Taking `0.840` at face value, a single missed worst-case invocation has probability `0.160`, so an
observed zero bounds the true count at **≤ 1 with ~84% confidence** for that shortest class, and
tighter for anything realistic. That is a weaker bound than PEN-4986's and is stated rather than
rounded away.

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
per-pod and is now measured in **two** pods — both of them the **same agent and the same workload**
(Security Engineer). The population axis the two runs do *not* yet cover is **workload**, which is the
one most likely to vary, since what differs between agents is precisely what they compose into a
shell.

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

- **Workload is uncovered.** Two pods, one agent, one workload. Widening needs the script run by
  agents whose work differs; it needs no new platform capability, no `kubectl exec` and no tracer —
  only more agents running it in their own runs.
- **§7.1 still carries a one-pod figure.** It is updated to a two-pod, two-image figure only when
  PEN-4986's PR has landed; until then this document is the wider record.
- **The sample is 2 of 106 images.** The census's stability across rebuilds is evidence, not a
  theorem — and counting images overstates it, because a different image is not automatically a
  different egress surface. That is measured, not assumed: `sha-1e99f06` (`sha256:fd6337d3…`), a
  **fourth** image that was **not** censused, reproduces this record's v1 surface digest **exactly**
  despite differing from the `sha-4db591b` the measurement ran on. One datum, not a survey — but it
  is a direct counter-example to treating image identity and surface identity as the same thing, and
  it is the direction that makes "2 of 106" read as more coverage than it is. A fleet claim therefore
  rests on the §4 fingerprint comparison rather than on the image count, which is the point of §4 and
  the reason the trigger is phrased against the surface rather than the image tag. **What remains
  uncovered is an image whose fingerprint DIFFERS: none has been observed — and none has been
  searched for, which is why this is an open item and not a result.**

## 6. Re-running

```sh
node scripts/absolute-path-git-fingerprint.mjs --json > fingerprint.json   # record FIRST
cp /usr/bin/git /tmp/git-calib                    # calibration copy; NOT /usr/bin/git itself
node scripts/measure-absolute-path-git.mjs /tmp/obs.ndjson 2 /tmp/git-calib &  # lands in #3098
# positive, negative and calibration controls, then work normally across the window
kill -TERM %1                                      # emits the {"kind":"stop"} summary
grep -c '"wrapped":false' /tmp/obs.ndjson          # minus any deliberate negative control
```

Record the fingerprint, the window, the pod, the image **and the agent whose workload ran** beside
the number. A measurement that does not name its population cannot be widened by the next one.
