# PEN-4986 — the runtime absolute-path-`git` measurement

This is the measurement §8 of
[`PEN-3183-git-egress-enforcement-boundary-decision.md`](./PEN-3183-git-egress-enforcement-boundary-decision.md)
calls its **highest-value item**, and the one §7.1's residual acceptance is explicitly conditional
on. §7.2 trigger 4 fires on a **non-zero** count and ends that acceptance early regardless of the
calendar date.

**Result: zero.** No invocation reaching `/usr/bin/git` outside the wrapper was observed, other than
the one this measurement deliberately produced to prove the instrument can see one. **Trigger 4 has
not fired.** The acceptance stands, and §7.1's assumption is now tested rather than merely stated —
but read §4 before treating it as tested *fleet-wide*, because it is not, and the part that remains
untested is named there rather than buried.

## 1. What was counted

A process whose `/proc/<pid>/exe` resolves to `/usr/bin/git` — the real binary — that did **not**
transit `/usr/local/libexec/paperclip/bin/git`. That is §8's wording, taken literally.

An invocation counts as having transited the wrapper on **any** of three independent signatures,
which biases classification toward *wrapped* so the headline count errs low rather than crying wolf:

| # | Signature | Why it is needed |
|---|---|---|
| 1 | `argv` carries `-c credential.https://github.com.helper=/usr/local/libexec/paperclip/bin/github-token-credential-helper` | the wrapper's own exec line |
| 2 | `GIT_CONFIG_PARAMETERS` carries the same helper | git hands `-c` to child processes this way, so **descendant** gits inherit the evidence; without this arm every sub-git a wrapped git spawns is miscounted as a finding |
| 3 | an ancestor process is the wrapper or `github-git-egress-runtime.js` | catches anything the first two miss |

Seeing *a* credential helper is not enough: `/etc/gitconfig`'s system helper
(`!/usr/bin/gh auth git-credential`) authenticates an unwrapped git all by itself — that is §4 of
the decision doc, and it is the whole reason this count matters. Only the **paperclip** helper path
counts. `scripts/measure-absolute-path-git.test.mjs` pins that distinction.

## 2. Method

`scripts/measure-absolute-path-git.mjs`, run inside a live agent pod as the agent's own uid. It
polls `/proc` every 2 ms, and for each process whose `exe` is `/usr/bin/git` records argv,
`GIT_CONFIG_PARAMETERS`, cwd and the ancestry chain, de-duplicated on `pid:starttime`. It is
read-only — it executes nothing and publishes nothing.

**Why polling and not an exec trace.** An exec-level trace is the right instrument and **none is
deployed**: there is no Tetragon, Falco, or process-audit pipeline in this cluster, and no metric
family carrying exec events, so there is no fleet-wide source to query. Nor can a tracer be attached
from inside the pod — the agent container runs `runAsNonRoot` with `allowPrivilegeEscalation: false`
and `capabilities: { drop: [ALL] }` (§3), which is exactly the hardening that forbids it, and
relaxing it is on §8's *not permitted* list. Polling `/proc` is what is left to an unprivileged
observer.

### 2.1 Instrument validation

A zero from an instrument that cannot see a positive is worthless, so all three controls were run
against the **shipped** script, inside the measurement window:

- **Positive control** — 4 PATH-resolved `git` commands produced **7** `/usr/bin/git` observations
  (git forks sub-gits), classified **wrapped 7/7**.
- **Negative control** — one `/usr/bin/git -c pen4986.detector.control=1 --version`, classified
  **unwrapped**, with all three wrapped-signatures absent. This is the only unwrapped observation in
  the dataset and is excluded from the count as self-inflicted. `--version` touches no credential,
  no network and no repository.
- **Catch rate** — 300 invocations of a **copy** of the git binary at a different path
  (`cp /usr/bin/git /tmp/.../git-calib2`, mean lifetime 4.49 ms, the shortest an invocation can be):
  **279 caught, 0.930**. A copy is used so that calibrating cannot contaminate the count.

A second, shorter run of the same script after the window closed reproduced all three controls
exactly (3/3 wrapped, 1/1 unwrapped, and 100/100 on calibration under a lighter process load),
which is also the confirmation that the file as committed is the file that produced the result.

0.930 is a floor, not the operating rate: it is measured on `git --version`, and every real git
operation is longer-lived and correspondingly easier to catch. Taking it at face value anyway, a
single missed worst-case invocation has probability 0.070, so an observed zero bounds the true count
at **≤ 1 with ~93% confidence** for that shortest class, and tighter for anything realistic.

## 3. Window, population, result

| | |
|---|---|
| **Window** | `2026-10-29T07:23:06Z` → `2026-10-29T07:45:14Z` UTC (`22.1` min, `613733` sweeps) |
| **Population** | one agent pod: `ac-7500672d-efe6-40-6aa8b8f8-f020-49-5db320-5lpqx`, ns `paperclip`, Job `ac-7500672d-efe6-40-6aa8b8f8-f020-49-5db320`, agent **Security Engineer** (`7500672d-efe6-4037-a05f-61204a670894`), run `6aa8b8f8-f020-49d9-9065-12e0a0d0d94a`, task PEN-4986 |
| **Image** | `harbor.blockcast.net/paperclip-agent/paperclip-agent:sha-ed39009-k8s-vendored` |
| **Workload in window** | a representative agent working session: repo clone, branch, status/diff/log/rev-parse, staging and commit, plus whatever the harness and MCP servers ran unprompted |
| **`/usr/bin/git` observations** | `54` |
| **— wrapped** | `53` |
| **— unwrapped** | **`0`**, plus 1 deliberate negative control |

Most of the window's `/usr/bin/git` traffic was **not** commands typed by the agent: the harness
issues its own, unprompted. Commonest subcommands observed: `config` 24, `diff` 7, `status` 3,
`add` 3, `--version` 2, `log` 2. That breakdown matters more than the raw total, because
tooling-originated invocations are precisely the §4.0 population this measurement exists to bound
— an agent choosing to type `git` was never the case in doubt. Every one of them resolved on PATH
and transited the wrapper.

## 4. ⛔ What this does and does not establish

**Does.** In this pod, over this window, every invocation that reached `/usr/bin/git` came through
the wrapper. The instrument was proved able to see the opposite and did not see it.

**Does not — read this before citing the result as fleet-wide.** One run observes **one pod**. It
is not a fleet census and must not be quoted as one. The generalisation that *is* available comes
from splitting the sources of a git invocation in an agent pod into two:

- **Image- and harness-resident callers — common to every agent pod, and censused.** A literal and
  dynamic-construction census of `/opt/paperclip-bundled-adapters`, `/usr/local/lib/node_modules`,
  `/usr/local/libexec/paperclip`, `/usr/lib/git-core`, `/etc/profile.d` and the Claude Code runtime
  found **15** occurrences of the string `/usr/bin/git`, **all of them inside the egress-control
  machinery itself** — comments, type declarations, the wrapper's own `exec` line, and
  `DEFAULT_GIT_BINARY`. **Zero** exec sites outside the wrapper. The Claude Code harness contains
  none at all; the only other `/usr/bin` references found belong to the Gemini CLI's sandbox-profile
  allowlists and are not git call sites. Because the image is identical across the fleet, this half
  *does* generalise.
- **Agent-composed shell — per-pod, and measured in one pod only.** An agent can compose
  `/usr/bin/git` into a shell snippet at runtime. That is the half this measurement covers for one
  pod and cannot cover for the others.

So the honest statement is: the fleet-constant half is zero by census, and the fleet-variable half
is zero in the one pod observed. §7.1's assumption is tested, not assumed — but it is not yet a
fleet census, and this document should not be cited as though it were.

**A second gap, worth more than the first.** Because no exec-level telemetry is deployed, **the
fleet cannot currently detect trigger 4 firing in production.** If an absolute-path `git` ran in
some other agent pod tomorrow, nothing would report it. Standing alerting on the §7.2 triggers is
already permitted by §8 without further security review; this measurement is a point-in-time
substitute for it, not a replacement.

## 5. Re-running

Re-take this whenever the agent image or the PATH layout changes — a result is only ever a statement
about the image and pod it ran in.

```sh
cp /usr/bin/git /tmp/git-calib            # calibration copy; NOT /usr/bin/git itself
node scripts/measure-absolute-path-git.mjs /tmp/obs.ndjson 2 /tmp/git-calib &
# run the controls, then work normally across a representative window
kill -TERM %1                              # emits the {"kind":"stop"} summary
grep -c '"wrapped":false' /tmp/obs.ndjson  # minus any deliberate negative control
```

Widening the population is the obvious improvement and needs no new permission: the same script run
in more agent pods, by more agents, turns the one-pod result into a fleet census.
