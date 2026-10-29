# PEN-4986 — the runtime absolute-path-`git` measurement

This is the measurement §8 of
[`PEN-3183-git-egress-enforcement-boundary-decision.md`](./PEN-3183-git-egress-enforcement-boundary-decision.md)
calls its **highest-value item**, and the one §7.1's residual acceptance is explicitly conditional
on. §7.2 trigger 4 fires on a **non-zero** count and ends that acceptance early regardless of the
calendar date.

**Result: zero.** No invocation reaching a real git binary outside the wrapper was observed, other
than the ones this measurement deliberately produced to prove the instrument can see them.
**Trigger 4 has not fired.** The acceptance stands, and §7.1's assumption is now tested rather than
merely stated — but read §4 before treating it as tested *fleet-wide*, because it is not, and the
part that remains untested is named there rather than buried.

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
the **shipped** script, inside the measurement window. The second negative control is the one the
first version of this measurement could not have run at all.

- **Positive control** — 5 PATH-resolved `git` commands (`--version`, `status`, `rev-parse`, `log`,
  `diff`) were issued inside the window. Every class-A observation in the window that was not a
  deliberate control — **46** of them, the issued commands plus the harness's own unprompted
  traffic — classified **wrapped**. No PATH-resolved invocation was ever classified unwrapped.
- **Negative control A — `/usr/bin/git`** — 11 issued as
  `/usr/bin/git -c pen4986.detector.control=A --version`; **7 of the 11 caught** (the rest fell
  between sweeps — see the catch rate below), **7/7 classified unwrapped**, with all three
  wrapped-signatures absent.
- **Negative control B — `/usr/lib/git-core/git`** — 11 issued as
  `/usr/lib/git-core/git -c pen4986.detector.control=B --version`; **10 of the 11 caught**,
  **10/10 classified unwrapped**. ⚠ **This is the control that justifies the rewrite.** Against the previous single-path instrument every one of these 11 invocations would
  have been invisible — not classified wrapped, but *never observed at all* — while being just as
  authenticated by `/etc/gitconfig` as control A. It is the concrete form of the false zero the
  widened target set exists to prevent.
- **Catch rate** — 300 invocations of a **copy** of the git binary at a different path
  (`cp /usr/bin/git /tmp/.../calib/git`; mean lifetime ≈ 4 ms, the shortest an invocation can be):
  **274 caught, 0.913**. A copy is used so that calibrating cannot contaminate the count, and its
  inode is excluded from the target set explicitly. Consistent with the 0.930 the first run
  measured the same way.

  ⚠ Name the copy `git`, not `git-calib`: git dispatches on `argv[0]`, so a copy under another
  name takes a shorter failure path and measures a catch rate that is not the one you want. That
  mistake was made and corrected while taking this measurement — it read 0.863 against the same
  binary.

- **Indeterminate samples.** A process caught inside `execve` reads back with an **empty**
  `/proc/<pid>/cmdline`: the kernel has swapped the `mm` but not yet written the new argv. Such a
  sample carries no evidence in either direction. The first version scored them **unwrapped**,
  which manufactures findings out of ordinary traffic — and since a non-zero count *is* trigger 4,
  an instrument that cries wolf is as useless as one that is blind. One immediate re-read clears
  most of the race; what survives is emitted as `kind: "indeterminate"`, never classified, never
  counted as a finding, and reported as its own number so the blind spot is visible rather than
  absorbed. Three occurred in this window.

All 17 caught unwrapped controls were classified correctly and **none** was misclassified
as wrapped, which is the direction that would hide a finding. Every control invocation is
`--version`: it touches no credential, no network and no repository, and all of them are excluded
from the count as self-inflicted, identified by the `pen4986.detector.control` key in argv.

**What the catch rate licenses, stated precisely.** 0.913 is a floor, not the operating rate:
it is measured on `git --version`, and every real git operation is longer-lived and correspondingly
easier to catch. Taking it at face value anyway, a single worst-case invocation is missed with
probability 0.087, so for that shortest class an observed zero supports **k = 0 at ~91%
confidence** — i.e. `P(observe 0 | k ≥ 1) ≤ 0.087`. The weaker claim **k ≤ 1** holds at
**~99.2%**. (An earlier draft of this section wrote "bounds the true count at ≤ 1 with ~93%
confidence", which attached the wrong claim to the wrong confidence.)

## 3. Window, population, result

This is the **re-run against the widened target set**. The superseded first run is kept below it,
because the difference between the two is the point.

| | |
|---|---|
| **Window** | `2026-10-29T09:04:14Z` → `2026-10-29T09:06:42Z` UTC (`2.5` min, `62 033` sweeps) |
| **Population** | one agent pod: `ac-7500672d-efe6-40-958651fb-6540-4b-c299f9-q7jzw`, ns `paperclip`, Job `ac-7500672d-efe6-40-958651fb-6540-4b-c299f9`, agent **Security Engineer** (`7500672d-efe6-4037-a05f-61204a670894`), run `958651fb-6540-4b36-a852-2034e5292762`, task PEN-4986 |
| **Image** | `harbor.blockcast.net/paperclip-agent/paperclip-agent:sha-992d21f-k8s-vendored` (digest `sha256:d65f18e1…`) — a **different image** from the first run's `sha-ed39009`, and the same two class-A inodes with the same `sha256 356db14e…` were found in it |
| **Watched** | class A: **2** inodes / **147** reachable paths. class B: **21** inodes. Both discovered at startup and recorded in the run's `start` record |
| **Workload in window** | a representative agent working session: status/diff/log/rev-parse, staging, commit, **and a push to the remote** — so the credentialed egress path itself is inside the window |
| **class A observations** | `63` |
| **— wrapped** | `46` |
| **— unwrapped** | **`0`**, plus `17` deliberate negative controls |
| **class B observations** (git-core helpers) | `1` |
| **— wrapped** | `1` |
| **— unwrapped** | **`0`** |

The window is short in wall-clock terms and dense in content: it covers a complete working cycle —
status, diff, log, rev-parse, staging, a commit, and a push to the remote — rather than idle time.
Class-A subcommands observed outside the controls: `config` 20, `core.fsmonitor` probes 8, `log` 3,
`push` 2, `remote` 2, and one each of `diff`, `add`, `rev-parse`, `commit`, `rev-list`,
`send-pack`, `pack-objects`, `symbolic-ref`, `core.askPass` probe. By exe: **43** reached
`/usr/bin/git` and **3** reached `/usr/lib/git-core/git` — the second inode is not hypothetical
traffic, it ran, and under the previous instrument those three would simply not have appeared.
All 3 are hook- and alias-spawned children of a wrapped git (§4.1), classified wrapped on the
inherited `GIT_CONFIG_PARAMETERS`.

The single class-B observation is **`git-remote-http`**, spawned by the push. That is the program
that actually spends the credential, and it classified **wrapped** via its ancestor — which is the
arm added in this revision. Under the previous instrument it was not watched at all.

**`3` samples were indeterminate** — caught inside `execve` with an unreadable `/proc/<pid>/cmdline`.
They are reported, not counted in either direction; see §2.1.

**Both halves are zero.** No invocation of either git binary, and no invocation of any other
git-core program, reached the real binary outside the wrapper — including during a push, which is
the one operation in the window that actually spends the credential.

⚠ **Where this window is weaker than the first run's:** 2.5 minutes of wall-clock is much less
exposure to *rare* events than 22.1 minutes, even though it carries more git traffic. A caller that
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

  ⚠ **This half does not generalise structurally.** This bullet first said it did, "because the
  image is identical across the fleet". That is false, and PEN-4989 measured it: **106** distinct
  agent image digests ran in the 7 days to 2026-10-29, **17** in the last 24 h, and for **38.2 %**
  of that week more than one image was live at the same instant. What carries the census is
  *sampling* — PEN-4989 re-ran it on a second image and reproduced all 15 occurrences exactly, and
  this run reproduced them on a **third** (`sha-992d21f`), so it stands at **3 of 106 images**.
  Strong evidence the egress machinery is stable across rebuilds; not a fleet census, and it must
  not be cited as one. See
  [`PEN-4989-absolute-path-git-population-widening.md`](./PEN-4989-absolute-path-git-population-widening.md) §3.
- **Agent-composed shell — per-pod, and measured in one pod only.** An agent can compose an
  absolute path to either binary into a shell snippet at runtime. That is the half this measurement
  covers for one pod and cannot cover for the others.

So the honest statement is: the image-resident half is zero by census in 3 of the 106 images that
ran that week, and the per-pod half is zero in the pods observed — the first run, a second in
PEN-4989, and this one, all of them the **same agent and workload**. §7.1's assumption is tested,
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

This is **already known to first-party code and is already defended against** for the one shape that
escapes: `github-git-egress-shim.js` refuses `!`-prefixed shell aliases, and its comment states the
mechanism in the same terms measured here. What has not kept up is §7.1's prose. The wording is
narrowed in this PR; it is recorded here because "every caller that resolves `git` on PATH" is the
load-bearing phrase of the first ground of the acceptance, and it was broader than the truth.

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
exists to prevent. `scripts/absolute-path-git-fingerprint.mjs` hashes the narrower surface, so
staleness is a comparison: a run whose fingerprint matches may cite this measurement, one whose
fingerprint differs must re-take it.

```sh
mkdir -p /tmp/calib && cp /usr/bin/git /tmp/calib/git   # a copy, NOT /usr/bin/git itself.
                                                        # Name it `git`: git dispatches on argv[0],
                                                        # so a copy named `git-calib` runs a
                                                        # different, shorter path and mismeasures
                                                        # the catch rate.
node scripts/measure-absolute-path-git.mjs /tmp/obs.ndjson 2 /tmp/calib/git &

# Controls -- run all four, inside the window. `--version` touches no credential,
# no network and no repository.
git --version                                              # positive: must classify wrapped
/usr/bin/git        -c pen4986.detector.control=A --version # negative, class-A inode 1
/usr/lib/git-core/git -c pen4986.detector.control=B --version # negative, class-A inode 2
for i in $(seq 1 300); do /tmp/calib/git --version >/dev/null; done   # catch rate

# ... then work normally across a representative window.
kill -TERM %1                              # emits the {"kind":"stop"} summary + tally
```

Read the result off the `stop` record's `tally`, not off a bare grep: `unwrapped` counts the
findings, `indeterminate` counts samples caught inside `execve` whose argv could not be read, and
the deliberate controls must be subtracted by their `pen4986.detector.control` marker. A grep for
`"wrapped":false` alone will also pick up the controls.

Widening the population is the obvious improvement and needs no new permission: the same script run
in more agent pods, by more agents, turns the one-pod result into a fleet census.
