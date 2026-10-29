# PEN-4986 — the runtime absolute-path-`git` measurement

This is the measurement §8 of
[`PEN-3183-git-egress-enforcement-boundary-decision.md`](./PEN-3183-git-egress-enforcement-boundary-decision.md)
calls its **highest-value item**, and the one §7.1's residual acceptance is explicitly conditional
on. §7.2 trigger 4 fires on a **non-zero** count and ends that acceptance early regardless of the
calendar date.

**Result in this pod: zero.** No invocation reaching a real git binary outside the wrapper was
observed, other than the ones this measurement deliberately produced to prove the instrument can
see them.

⛔ **DO NOT CITE THAT ZERO AS THE ANSWER. §7.2 trigger 4 has since FIRED.** This document records
the **first** window only. The measurement was widened the same day (2026-10-29) along the axis §4
names as untested — **workload** — and the sixth window, an Engineer pod running a full
build/test suite, returned **28**. The residual acceptance is **ended**, not standing. The
authoritative record of the firing, its mechanism and its severity argument is
[`PEN-4989-absolute-path-git-population-widening.md`](./PEN-4989-absolute-path-git-population-widening.md)
*(lands in #3102)* and §7.1 of the decision record; this document is the method and the first data
point. §4 below is right that this result does not generalise — what it could not know is that the
first counter-example was already one window away. Read §2.2 before quoting a confidence
with the zero: the sampler's measured catch rate on the shortest invocation class is **0.710**, so
the zero supports *k = 0* at only ~71 % for that class, not the ~93 % earlier drafts claimed.

⚠ **This result replaces an earlier one that was taken against a target set too narrow to support
it.** The first measurement watched the single path `/usr/bin/git`. Review (#3098) established that
`/usr/lib/git-core/git` is a **second, byte-identical copy of the same binary on a different
inode** — not a symlink — so an invocation of *that* path skips the wrapper, is authenticated by
`/etc/gitconfig` exactly as §4.0 describes, and was **invisible to the instrument**. An unobserved
exe path yields a zero that looks identical to a true zero. The instrument now discovers its targets
by content identity (§1), and the re-run below reproduces zero against the widened set. Treat any
earlier citation of this document as scoped to `/usr/bin/git` only.

## 1. What was counted

A process whose `/proc/<pid>/exe` resolves to a **real git binary** — identified by content, not by
path — that did **not** transit `/usr/local/libexec/paperclip/bin/git`.

Identity, not path, because path is not a reliable way to name "the git binary". Measured in the
agent image (`sha-ed39009`):

| Class | Members in this image | Why it is watched |
|---|---|---|
| **A — real git** (§8's count) | **2 inodes**: `/usr/bin/git` (`4194488:2374866`, 8 reachable paths) and `/usr/lib/git-core/git` (`4194488:2374935`, 139 reachable paths). Both `sha256 356db14e…`, 4 082 768 bytes, neither a symlink to the other. | This is the git dispatcher. Reaching it by **any** of its 147 paths is the §4.0 bypass. |
| **B — other git-core programs** | **21 inodes**, incl. `git-remote-http` (aliased as `git-remote-https`/`ftp`/`ftps`), `git-http-fetch`, `git-http-push`, `scalar`. | Distinct binaries, not copies of git — but they read `/etc/gitconfig` and call credential helpers on their own account, so a direct invocation is the same bypass. Reported **separately**, because in normal use they are descendants of a git process rather than independent invocations. |

The target sets are discovered at startup by hashing every regular file in the candidate directories
against `/usr/bin/git` and keying on `(dev, inode)`, so symlinks and hardlinks collapse onto one
entry and no alias is invisible. The run's `start` record names every directory searched and every
inode watched, which makes the remaining gap — a git binary outside those directories — auditable
rather than implicit.

An invocation counts as having transited the wrapper on **any** of three independent signatures,
which biases classification toward *wrapped* so the headline count errs low rather than crying wolf:

| # | Signature | Why it is needed |
|---|---|---|
| 1 | `argv` carries `-c credential.https://github.com.helper=/usr/local/libexec/paperclip/bin/github-token-credential-helper` | the wrapper's own exec line |
| 2 | `GIT_CONFIG_PARAMETERS` carries the same helper | git hands `-c` to child processes this way, so **descendant** gits inherit the evidence; without this arm every sub-git a wrapped git spawns is miscounted as a finding |
| 3 | an **ancestor's argv** names the egress runtime, the wrapper, or the paperclip helper | a class-B helper exec'd by a wrapped git carries neither signature of its own; its evidence is the wrapped git above it |

Signature 3 matches an ancestor's *argv*, not its `exe`. An earlier version tested
`ancestor.exe === <wrapper>`, which can never fire: the wrapper is a `#!/bin/sh` script, so
`/proc/<pid>/exe` reports `/bin/sh`, and it `exec`s away into the token shim and then node, so it is
never a live ancestor either.

Seeing *a* credential helper is not enough: `/etc/gitconfig`'s system helper
(`!/usr/bin/gh auth git-credential`) authenticates an unwrapped git all by itself — that is §4 of
the decision doc, and it is the whole reason this count matters. Only the **paperclip** helper path
counts. `scripts/measure-absolute-path-git.test.mjs` pins that distinction, and pins the target-set
rule as well, because that is the half that failed once.

## 2. Method

`scripts/measure-absolute-path-git.mjs`, run inside a live agent pod as the agent's own uid. It
polls `/proc` every 2 ms, and for each process whose `exe` resolves to a watched inode (§1) records
argv, `GIT_CONFIG_PARAMETERS`, cwd and the ancestry chain, de-duplicated on `pid:starttime`. It is
read-only — it executes nothing and publishes nothing.

**Why polling and not an exec trace.** An exec-level trace is the right instrument and **none is
deployed**: there is no Tetragon, Falco, or process-audit pipeline in this cluster, and no metric
family carrying exec events, so there is no fleet-wide source to query. Nor can a tracer be attached
from inside the pod — the agent container runs `runAsNonRoot` with `allowPrivilegeEscalation: false`
and `capabilities: { drop: [ALL] }` (§3), which is exactly the hardening that forbids it, and
relaxing it is on §8's *not permitted* list. Polling `/proc` is what is left to an unprivileged
observer.

### 2.1 Instrument validation

A zero from an instrument that cannot see a positive is worthless, so the controls were run against
the **shipped** script. The second negative control is the one the first version of this measurement
could not have run at all.

**In-window controls** (run inside the counted window of §3, which is what validates the script *in
situ*):

- **Positive control** — 5 PATH-resolved `git` commands (`--version`, `status`, `rev-parse`, `log`,
  `diff`) were issued. Every class-A observation in the window that was not a deliberate control —
  **36** of them, the issued commands plus the harness's own unprompted traffic — classified
  **wrapped**. No PATH-resolved invocation was ever classified unwrapped.
- **Negative control A — `/usr/bin/git`** — 11 issued as
  `/usr/bin/git -c pen4986.detector.control=A --version`; **5 caught, 5/5 classified unwrapped**.
- **Negative control B — `/usr/lib/git-core/git`** — 11 issued as
  `/usr/lib/git-core/git -c pen4986.detector.control=B --version`; **10 caught, 10/10 classified
  unwrapped**. ⚠ **This is the control that justifies the rewrite.** Against the previous
  single-path instrument every one of these 11 invocations would have been invisible — not
  classified wrapped, but *never observed at all* — while being just as authenticated by
  `/etc/gitconfig` as control A. It is the concrete form of the false zero the widened target set
  exists to prevent.

Every control invocation is `--version`: it touches no credential, no network and no repository.
All are excluded from the count as self-inflicted, identified by the `pen4986.detector.control` key
in argv. **No control was ever misclassified as wrapped** — the direction that would hide a finding.

### 2.2 ⚠ The catch rate, and why the earlier figure was too high

The earlier draft quoted a catch rate of **0.913**, measured on a **copy** of the git binary at
another path, and used it for the confidence statement. That figure is **wrong for the binaries
actually being watched**, and the error is in the optimistic direction.

A dedicated calibration run issued **300 invocations of each of the three paths** against the
shipped script:

| Path | Caught | Rate |
|---|---|---|
| `/usr/bin/git` (class A, watched) | 213 / 300 | **0.710** |
| `/usr/lib/git-core/git` (class A, watched) | 224 / 300 | **0.747** |
| `/tmp/.../calib/git` (a byte-identical **copy**) | 271 / 300 | 0.903 |

The copy is caught ~20 points more often than the binaries it is standing in for. The cause is
lifetime, measured directly over 200 invocations each: **4 123 µs** for `/usr/bin/git`, **4 403 µs**
for `/usr/lib/git-core/git`, **5 126 µs** for the copy. A copy outside `/usr/bin` and outside the
git exec directory cannot locate `git-core` relative to its own `argv[0]`, so it takes a slower
startup path, lives ~24 % longer, and is correspondingly easier for a sampler to land inside.
**Calibrating on a copy therefore over-states the catch rate for the real binaries.** Keep the copy
— it is still the only way to calibrate without adding to the counted population — but calibrate
the watched paths directly too, and quote *those*.

⛔ **Two corrections to this subsection, both dated 2026-10-29 and both in the direction of
trusting it less.**

1. **The copy must be named `git`, and in four of the six rows it was not.** Git dispatches on
   `argv[0]`: a copy named **`git-calib`** exits `128` at builtin dispatch
   (`fatal: cannot handle calib as a builtin`) and **never executes `--version` at all**. The
   table above is sound — its copy sat at `/tmp/.../calib/git` — but PEN-4986's headline `0.930`,
   PEN-4989 §1's `0.840`, PEN-4992's `0.933` and PEN-4994's `0.793` were all taken under the
   `git-calib` name and so timed an **error path rather than a git invocation**. Treat those four
   as **void**, not as over-statements. It also explains PEN-4992's reported contradiction — a
   `0.933` rate beside 1-of-3 real controls caught, `P[≤1] ≈ 1.3 %` — which is not a contradiction
   once the two targets are recognised as different programs.
2. **The lifetime mechanism above is pod-local.** The `5 126 µs` vs `4 123 µs` figures are a real
   measurement in *this* pod, but re-measured in another pod on 2026-10-29 a correctly-named copy
   and the real binary had **comparable** warm lifetimes (~4.2–4.8 ms vs ~3.9–4.5 ms, 3 × n = 300;
   the copy is markedly longer only cold, at 10.0 ms vs 4.3 ms). The *direction* — copy
   over-states — reproduces across pods. The *magnitude* and the *cause* do not. Do not carry
   "~24 %" into another row as though it were a constant.

**The confidence statement, corrected.** Take the worst watched path, **0.710**. A single
worst-case invocation — `git --version`, the shortest an invocation can be — is missed with
probability **0.290**. So an observed zero supports:

- **k = 0 at ~71 % confidence** for that shortest class, i.e. `P(observe 0 | k ≥ 1) ≤ 0.29`;
- **k ≤ 1 at ~92 %**.

This is materially weaker than the **~91 % / ~99.2 %** the previous draft claimed, and weaker again
than the "≤ 1 with ~93 % confidence" of the draft before that, which also attached the wrong claim
to the wrong confidence. Every real git operation — `status`, `commit`, `push` — is far longer-lived
than `--version` and is caught at a correspondingly higher rate, so this is a floor on the hardest
class and not the operating rate. But it is the number that belongs next to the zero.

**Catch rate is not classify rate, and both are now reported.** A calibration sample whose argv is
unreadable still counts as *caught*, while a target in the same state used to be dropped as
*indeterminate* and never classified — so a single figure silently conflated the two. The classifier
now runs on every readable arm (`resolveSample`), and a sample is indeterminate only when the argv
is unreadable **and** no arm fired. Measured: **0.963** of watched-binary samples in the §3
window were classified (52 of 54), and under the burst load of the calibration run the indeterminate
share was 31 of 472 (6.6 %). Indeterminate samples are reported as their own number, never counted
as a finding and never silently absorbed.

One consequence worth stating plainly, because it was raised in review: **the controls that went
unobserved cannot be hiding in the indeterminate bucket.** In the §3 window 6 of the 11 control-A
invocations were not observed while only **2** samples were indeterminate, so at most 2 of the 6
could be accounted for that way. The shortfall is sweep-miss, which is exactly what §2.2's catch
rate measures — and it is why that rate, not the copy's, is the one quoted above.

## 3. Window, population, result

This is the **re-run against the widened target set**. The superseded first run is kept below it,
because the difference between the two is the point.

| | |
|---|---|
| **Window** | `2026-10-29T09:12:52Z` → `2026-10-29T09:14:27Z` UTC (`1.6` min, `29 902` sweeps) |
| **Population** | one agent pod: `ac-7500672d-efe6-40-958651fb-6540-4b-c299f9-q7jzw`, ns `paperclip`, Job `ac-7500672d-efe6-40-958651fb-6540-4b-c299f9`, agent **Security Engineer** (`7500672d-efe6-4037-a05f-61204a670894`), run `958651fb-6540-4b36-a852-2034e5292762`, task PEN-4986 |
| **Image** | `harbor.blockcast.net/paperclip-agent/paperclip-agent:sha-992d21f-k8s-vendored` (digest `sha256:d65f18e1…`) — a **different image** from the first run's `sha-ed39009`, and the same two class-A inodes with the same `sha256 356db14e…` were found in it |
| **Watched** | class A: **2** inodes / **147** reachable paths. class B: **21** inodes. Both discovered at startup and recorded in the run's `start` record |
| **Workload in window** | a representative agent working session: status/diff/log/rev-parse, staging, commit, **and a push to the remote** — so the credentialed egress path itself is inside the window |
| **class A observations** | `51` |
| **— wrapped** | `36` |
| **— unwrapped** | **`0`**, plus `15` deliberate negative controls |
| **class B observations** (git-core helpers) | `1` |
| **— wrapped** | `1` |
| **— unwrapped** | **`0`** |

The window is short in wall-clock terms and dense in content: it covers a complete working cycle —
status, diff, log, rev-parse, staging, a commit, and a push to the remote — rather than idle time.
Class-A subcommands observed outside the controls: `config` 17, `remote` 3, `push` 2,
`core.askPass` probes 2, and one each of `add`, `commit`, `maintenance`, `remote-https`,
`rev-list`, `log`, `send-pack`, `pack-objects`, `symbolic-ref`. By exe: **32** reached
`/usr/bin/git` and **4** reached `/usr/lib/git-core/git` — the second inode is not hypothetical
traffic, it ran, and under the previous instrument those four would simply not have appeared.
All 4 are hook- and alias-spawned children of a wrapped git (§4.1), classified wrapped on the
inherited `GIT_CONFIG_PARAMETERS`.

The single class-B observation is **`git-remote-http`**, spawned by the push. That is the program
that actually spends the credential, and it classified **wrapped** via its ancestor — which is the
arm added in this revision. Under the previous instrument it was not watched at all.

**`2` samples were indeterminate** — argv unreadable *and* no classifier arm firing. They are
reported, not counted in either direction; see §2.2.

**Both halves are zero.** No invocation of either git binary, and no invocation of any other
git-core program, reached the real binary outside the wrapper — including during a push, which is
the one operation in the window that actually spends the credential.

⚠ **Where this window is weaker than the first run's:** 1.6 minutes of wall-clock is much less
exposure to *rare* events than 22.1 minutes, even though it carries comparable git traffic. A caller that
fires once an hour would be missed by both, but this one has the smaller chance of catching it. The
right reading is that this run re-establishes the result against the **correct target set** and adds
push traffic the first run never covered; it does not supersede the first run's longer exposure, and
neither window is long enough to claim anything about rare periodic callers. §4's standing-telemetry
gap is the real answer to that, and remains open.

### 3.1 The superseded first run

Kept for the record, and because citing it without this caveat is the error to avoid. Window
`2026-10-29T07:23:06Z` → `07:45:14Z` (22.1 min, 613 733 sweeps), pod
`ac-7500672d-efe6-40-6aa8b8f8-f020-49-5db320-5lpqx` on image `sha-ed39009-k8s-vendored`: **54**
observations, **53 wrapped**, **0 unwrapped**, plus 1 deliberate negative control. Commonest
subcommands `config` 24, `diff` 7, `status` 3, `add` 3, `--version` 2, `log` 2.

That run watched `/usr/bin/git` **only**. Its zero is therefore a statement about one of the two
class-A inodes, and says nothing at all about `/usr/lib/git-core/git` or about class B. It is not
wrong, it is narrower than it was written to be — which is why the re-run above replaces it as the
result this document reports.

Most of each window's class-A traffic is **not** commands typed by the agent: the harness issues its
own, unprompted. That breakdown matters more than the raw total, because tooling-originated
invocations are precisely the §4.0 population this measurement exists to bound — an agent choosing
to type `git` was never the case in doubt. Every one of them resolved on PATH and transited the
wrapper.

## 4. ⛔ What this does and does not establish

**Does.** In this pod, over this window, every invocation that reached **either** real git binary
came through the wrapper, and no other git-core program ran unwrapped at all. The instrument was
proved able to see the opposite — on **both** class-A inodes, which is what the first version of
this measurement could not do — and did not see it.

**Does not — read this before citing the result as fleet-wide.** One run observes **one pod**. It
is not a fleet census and must not be quoted as one. The generalisation that *is* available comes
from splitting the sources of a git invocation in an agent pod into two:

- **Image- and harness-resident callers — censused.** A literal and
  dynamic-construction census of `/opt/paperclip-bundled-adapters`, `/usr/local/lib/node_modules`,
  `/usr/local/libexec/paperclip`, `/usr/lib/git-core`, `/etc/profile.d` and the Claude Code runtime
  found **15** occurrences of the string `/usr/bin/git`, **all of them inside the egress-control
  machinery itself** — comments, type declarations, the wrapper's own `exec` line, and
  `DEFAULT_GIT_BINARY`. **Zero** exec sites outside the wrapper. The Claude Code harness contains
  none at all; the only other `/usr/bin` references found belong to the Gemini CLI's sandbox-profile
  allowlists and are not git call sites.

  **The census was re-run here for the second binary, because searching for `/usr/bin/git` alone
  could not see it.** On image `sha-992d21f` the same 15 `/usr/bin/git` occurrences reproduce
  exactly, and `/usr/lib/git-core` appears **3** times, all three in **comments** inside
  `github-git-egress-shim.js` and **none** of them an exec site. So the census holds for both
  class-A paths, not just the one it was originally written against.

  ⚠ **This half does not generalise structurally, and the three samples are not independent.**
  This bullet first said it did generalise, "because the image is identical across the fleet". That
  is false, and PEN-4989 measured it: **106** distinct agent image digests ran in the 7 days to
  2026-10-29, **17** in the last 24 h, and for **38.2 %** of that week more than one image was live
  at the same instant.

  The census has now been reproduced on three of those images — `sha-ed39009`, `sha-4db591b`
  (PEN-4989) and `sha-992d21f` (this run) — all 15 occurrences, exactly, every time. **That is
  reproducibility, not coverage, and "3 of 106" must not be read as a sample fraction of the
  fleet's egress variation.** The three images share **one** egress surface, measured rather than
  assumed: `ed39009…992d21f` is 9 commits with exactly one build-relevant file changed
  (`Dockerfile.agent-toolchain`, a `KUBECTL_VERSION` pin), and `4db591b…992d21f` is 3 commits whose
  only build-relevant change is the same file. Nothing in the wrapper, the egress runtime, the
  credential helper or the git install differs between them. So the three samples tell you the
  census is deterministic against that surface; they tell you nothing about an image built from a
  surface that differs.

  The fleet claim rests on the **fingerprint comparison in §5**, not on this count: a pod whose
  egress-surface fingerprint matches may cite this census, and one whose fingerprint differs must
  re-take it. See
  [`PEN-4989-absolute-path-git-population-widening.md`](./PEN-4989-absolute-path-git-population-widening.md) §3
  *(lands in #3102)*.
- **Agent-composed shell — per-pod, and measured in one pod only.** An agent can compose an
  absolute path to either binary into a shell snippet at runtime. That is the half this measurement
  covers for one pod and cannot cover for the others.

So the honest statement is: the image-resident half is zero by census on three images that share a
single egress surface, and the per-pod half is zero in the pods observed — the first run, a second
in PEN-4989, and this one, all of them the **same agent and workload**. §7.1's assumption is tested,
not assumed — but it is not a fleet census, and this document should not be cited as though it were.

### 4.1 ⚠ A finding about §7.1's wording, surfaced by the widened target set

§7.1's first ground reads that the control covers "**every caller that resolves `git` on PATH**".
Measured here, that is **not true inside any process git itself spawns**:

```
$ git --exec-path                      -> /usr/lib/git-core
# inside a pre-commit hook, measured in a scratch repo:
HOOK PATH[0..2]: /usr/lib/git-core  /usr/local/libexec/paperclip/bin  ...
HOOK resolves git to: /usr/lib/git-core/git
```

git **prepends** its exec-path to `PATH` for its children, ahead of the directory the wrapper sits
in. So in a hook, an alias expansion, an external diff/merge tool or a filter, a bare `git` resolves
to `/usr/lib/git-core/git` — the real binary — and the wrapper is not reached. No absolute path is
needed; PATH supplies it.

**This does not fire trigger 4, and the count above is still zero.** Measured in the same hook, such
a child inherits `GIT_CONFIG_PARAMETERS` carrying the paperclip helper from its wrapped parent, so
its *credential* path is still the paperclip helper and it is correctly classified **wrapped**. The
§4.0 accidental-disclosure case is not opened by it. What it bypasses is the **guard** — the egress
runtime's inspection of the command — not the credential.

This is **already known to first-party code and is already defended against for one shape**:
`github-git-egress-shim.js` refuses `!`-prefixed shell aliases, and its comment states the mechanism
in the same terms measured here. That refusal does **not** cover repository hooks, external
diff/merge tools, `GIT_EXTERNAL_DIFF` or clean/smudge filters, each of which git spawns with the
same rewritten `PATH`.

§7.1's prose is narrowed in this PR, but narrowing prose is not a remediation, so the gap is
tracked as its own row: **PEN-4998**. It is recorded here because "every caller that resolves `git`
on PATH" is the load-bearing phrase of the first ground of the acceptance, and it was broader than
the truth.

**A second gap, worth more than the first.** Because no exec-level telemetry is deployed, **the
fleet cannot currently detect trigger 4 firing in production.** If an absolute-path `git` ran in
some other agent pod tomorrow, nothing would report it. Standing alerting on the §7.2 triggers is
already permitted by §8 without further security review; this measurement is a point-in-time
substitute for it, not a replacement.

## 5. Re-running

Re-take this when the **egress-relevant surface** changes — the wrapper, the runtime it `exec`s, the
credential helper, **the set of real git binaries**, and the PATH ordering that decides which a bare
`git` reaches. A result is only ever a statement about the image and pod it ran in.

⚠ **The binary set is part of that surface, and is the part that failed before.** The instrument
discovers it at startup and writes it into the run's `start` record. Compare that record against the
one below before citing a result: a re-run that finds a different number of class-A inodes is
measuring a different image, and a re-run whose `start` record you have not read is a result you
cannot scope.

This section first said "whenever the agent image or the PATH layout changes". At ≈15 image changes
a day (PEN-4989 §3) that trigger is always firing and so gets ignored, which is the failure PEN-4988
exists to prevent. `scripts/absolute-path-git-fingerprint.mjs` *(lands in #3102)* hashes the narrower
surface, so staleness is a comparison: a run whose fingerprint matches may cite this measurement,
one whose fingerprint differs must re-take it. **This is also what the census count in §4 rests
on**, since three images off one egress surface are a reproducibility check, not a sample of the
fleet.

```sh
mkdir -p /tmp/calib && cp /usr/bin/git /tmp/calib/git   # a copy, NOT /usr/bin/git itself.
                                                        # Name it `git`. Git dispatches on argv[0],
                                                        # so a copy named `git-calib` does not take
                                                        # a "shorter path" -- it does not run AT
                                                        # ALL: it exits 128 at builtin dispatch
                                                        # ("fatal: cannot handle calib as a
                                                        # builtin") without executing --version.
                                                        # Verified 2026-10-29. Four rows calibrated
                                                        # under that name timed an error path, not
                                                        # git; their rates are VOID. See §2.2.
node scripts/measure-absolute-path-git.mjs /tmp/obs.ndjson 2 /tmp/calib/git &

# Controls -- run all four, inside the window. `--version` touches no credential,
# no network and no repository.
git --version                                              # positive: must classify wrapped
/usr/bin/git        -c pen4986.detector.control=A --version # negative, class-A inode 1
/usr/lib/git-core/git -c pen4986.detector.control=B --version # negative, class-A inode 2
# Catch rate: calibrate the WATCHED PATHS directly, not only the copy. A correctly
# named copy over-states the rate for the binaries actually counted (§2.2). The
# "~24% longer" mechanism measured there is pod-local -- re-measured 2026-10-29 in
# another pod, copy and real binary had comparable warm lifetimes. Direction holds,
# magnitude does not. Quote the watched-path rate, never the copy's.
for i in $(seq 1 300); do /tmp/calib/git --version >/dev/null; done
for i in $(seq 1 300); do /usr/bin/git        -c pen4986.detector.control=A --version >/dev/null; done
for i in $(seq 1 300); do /usr/lib/git-core/git -c pen4986.detector.control=B --version >/dev/null; done

# ... then work normally across a representative window.
kill -TERM %1                              # emits the {"kind":"stop"} summary + tally
```

Read the result off the `stop` record's `tally`, not off a bare grep: `unwrapped` counts the
findings, `indeterminate` counts samples where the argv was unreadable and no classifier arm fired,
and the deliberate controls must be subtracted by their `pen4986.detector.control` marker. A grep
for `"wrapped":false` alone will also pick up the controls — in a run calibrated as above they are
the overwhelming majority of them.

Run the per-path calibration as its **own** run, not inside the counted window: 600 deliberate
unwrapped invocations are exactly the population the window is trying to count, and mixing them in
makes the headline unreadable even though the marker excludes them.

Widening the population is the obvious improvement and needs no new permission: the same script run
in more agent pods, by more agents, turns the one-pod result into a fleet census.
