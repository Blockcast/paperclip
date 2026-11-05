# `401 Bad credentials` from an agent pod

The fleet GitHub App installation token mounts at
`/etc/paperclip/secrets/github-token/token` (path in
`PAPERCLIP_GITHUB_TOKEN_FILE`). When GitHub refuses it, every agent path that
reaches GitHub dies at once: `gh pr view`, `gh api`, `gh run rerun`,
`git push`, PR comments, commit statuses.

This runbook exists so the next occurrence is not re-derived by hand. It
records what the oracle is, which two leads are already falsified, and how an
in-flight run should park.

Source incident: PEN-5239 (2026-11-02). Detector: PEN-5241, merged as
[#3256](https://github.com/Blockcast/paperclip/pull/3256).

## 1. Run the oracle first

```
gh paperclip-auth-check
```

It prints the credential source, byte length, **mount generation**, a
truncated `token-sha256`, an unauthenticated reachability probe, and the
authenticated verdict. It reads no credential value into your output.

```
  source:             PAPERCLIP_GITHUB_TOKEN_FILE=/etc/paperclip/secrets/github-token/token
  credential:         present (390 bytes)
  mount-generation:   ..2026_11_02_21_37_06.2080447267
  mount-written:      2026-11-02 21:37:06
  token-sha256:       bf65aa6d
  github-reachable:   yes (unauthenticated /rate_limit -> 200, x-ratelimit-limit 60)
  authenticated:      /installation/repositories -> 200, x-ratelimit-limit 9500, remaining 4730, reset 2026-11-03T04:53:38Z (1793681618)
  credential-channel: gh / curl / git (all re-read the mount per invocation)
  mcp-channel:        covered — the MCP server reaches GitHub through the loopback token proxy, which re-reads this same mount on every request, so the verdict below governs `mcp__github__*` too (PEN-5641)
  verdict:            OK — valid GitHub App installation token (rate limit 9500/hr)
```

The pairing is the point: an unauthenticated `200` beside an authenticated
`401` separates *this credential is dead* from *GitHub is slow or down*. Do
not hand-roll the probe — `$GH_TOKEN` is empty in your shell (the wrapper
exports it into `gh` only), so curl-ing with it returns `401` whatever the
credential's health, and an empty Bearer returns the same `401` as a revoked
token.

### 1a. A `403` is not a `401` — read the rate-limit plane (PEN-5355)

That pairing is silent on the state this installation actually reaches most
often. Under an exhausted shared budget the authenticated call to
`/installation/repositories` returns **`403`, not `401`**, so §1's oracle says
nothing and the two failures look identical at the call site: same command,
same red, same "GitHub refused me". The rate-limit headers are what separate
them. (This is a different `403` from §2's: there, a `403` on `/user` is the
healthy per-endpoint refusal. Here it is `/installation/repositories`, which a
healthy, unthrottled token answers `200`.)

| state | authenticated code | `x-ratelimit-limit` | `x-ratelimit-remaining` | verdict / exit | correct action |
|---|---|---|---|---|---|
| healthy | 200 | 9500 | > 0 | `OK` / 0 | proceed |
| **budget exhausted** | **403** | **9500** | **0** | `RATE_LIMITED` / 6 | **wait for the reset; GraphQL still works** |
| permission refusal | 403 | 9500 | > 0 | `UNEXPECTED` / 5 | genuine authorization fault — escalate |
| credential dead | 401 | absent / 60 | — | `REJECTED` / 1 | park; §2 onward |

`limit: 9500` is itself positive evidence the credential **authenticated** —
the unauthenticated plane is 60. A `403` quoting `9500` is a healthy token
being throttled, not a permission loss. The exhaustion is tracked and owned
(PEN-3776 measured installation `138085375` hitting zero ~94 min/24h across 8
exporters; PEN-3852 is the App split, PEN-5087 the draw reduction). Do not
file it as a credential incident.

**GraphQL has an independent budget, so GitHub is not unreachable.** Measured
2026-11-03T03:5xZ, at the moment core read `0/9500`, `graphql` read **9401
remaining**. Anything expressible as a GraphQL query still works for the whole
exhaustion window — worth saying out loud, because the reflex on a 403 storm
is to conclude the API is gone and park the run. `gh api graphql` and
`gh pr view`-style reads that go through GraphQL are the way through.

### 1b. One `REJECTED` must not stand your work down — and must not gate escalation on the generation (PEN-5641)

`REJECTED` is the correct **instantaneous** verdict, and it is also what a
transient window looks like from inside the pod. Standing a run down on the
single sample spends a wake and escalates a condition that may already have
cleared. So a first `REJECTED` buys a re-check, not an escalation.

**But the window does not self-heal, and it is not seconds long.** It ends only
when the rotator next succeeds. The one measured on 2026-11-05 ran
**~7½–11 minutes at the Secret**, plus up to ~60 s of kubelet mount
propagation — the rotator lost five consecutive cycles to Cilium
sandbox-create failures (`putEndpointIdTooManyRequests`) and the published
credential **aged out against its ~60 m TTL**. Nothing bad was ever published;
the mounted credential simply **expired**. Had the Cilium fault continued past
cycle six, the window would have continued with it (PEN-5637, PEN-5155).

| bound | basis | value |
|---|---|---|
| lower | last successful mint 03:23:18Z → expiry 04:23:18Z → recovery publish 04:30:50Z | **7m32s** |
| upper | mint at job start 03:20:00Z → expiry 04:20:00Z → recovery publish 04:30:50Z | **10m50s** |
| floor, no TTL assumption | first observed `REJECTED` 04:24:52Z → recovery publish 04:30:50Z | **5m58s** |

> ⚠️ Two figures that have circulated for this window are both wrong.
> **93 seconds** was the gap between two *readings* that happened to straddle
> the recovery — a sampling interval, not a duration. **~76 minutes** was
> `github-cli-probe`'s *dead window*, the interval in which the **detector**
> could not look; the probe's dead window strictly contains the credential's,
> and transposing one onto the other is the same error as reading a red
> detector as a found fault.

The check prints the procedure under a `rotation-vs-outage:` heading whenever
it returns `REJECTED`:

1. `OK` → proceed.
2. First `REJECTED` → note `mount-generation` and `token-sha256`, do other work
   for a few minutes, re-run. Do not escalate yet; do not stand the row down.
3. Re-check now `OK` → the window closed; proceed, escalate nothing.
4. Re-check **still `REJECTED`** → **escalate.** The generation says *which*
   fault to report, never *whether* to report one:
   - generation **unchanged** → the rotator is stalled and the credential aged
     out on the mount (PEN-5637, PEN-5239, PEN-5240 — every instance measured
     in this fleet so far).
   - generation **advanced** → a freshly published credential is being refused.
     This has **not** been observed here; PEN-5637 retracted exactly that
     diagnosis. Report it as new rather than filing it under the stall.

**Escalation is gated on the second `REJECTED`, never on the generation.** An
earlier draft of this section made "generation unchanged" a *necessary*
condition for escalating, which fails open in the quadrant it does not name:
advanced-and-still-`REJECTED` matched no case and so read as "do not escalate".
The generation cannot carry that weight in any case — it is **also stamped when
your own pod first mounted the secret**, so it moves without the rotator having
run. Measured on PEN-5641: generation `..2026_11_05_04_30_17` carried the same
`token-sha256` another pod had already been given at `04:26Z`. That stamp was a
mount sync, not a publish.

### 1c. Which channels the verdict governs (PEN-5641)

`gh`, `curl` and `git` re-read the token file on **every** invocation, so they
pick up each rotation. `github-mcp-server` does not: it is an upstream Go
binary that reads `GITHUB_PERSONAL_ACCESS_TOKEN` once at startup and then runs
for the whole session. Before PEN-5641 that produced the worst possible
pairing — this oracle printing `OK` while every `mcp__github__*` tool returned
`401 Bad credentials`, measured at 2026-11-05T04:49Z on URLs `curl` was
answering `200`.

The fix points the MCP server at a loopback proxy that re-reads the same mount
per request, so both channels now share one credential. **Read the
`mcp-channel:` line to know which situation you are in:**

- `covered` → the verdict governs `mcp__github__*` as well.
- `NOT COVERED` → the verdict governs the file-reading path **only**. After a
  rotation, `mcp__github__*` returning `401 Bad credentials` while `gh`/`curl`
  are green is **expected and is not a credential fault**. Use `gh`/`curl`/`git`;
  the MCP GitHub tools recover when their server restarts.

The proxy can be turned off without an image rollback by setting
`PAPERCLIP_GITHUB_MCP_TOKEN_PROXY=0`, which restores the pre-PEN-5641
behaviour; `mcp-channel:` then reports `NOT COVERED`, truthfully.

## 2. Healthy vs dead — read the right endpoint

| probe | healthy installation token | dead credential |
|---|---|---|
| `GET /installation/repositories` | **200** | 401 |
| `GET /user` | **403** | 401 |

A healthy installation token authenticates and is then refused *per endpoint*
— `403` on `/user` is the correct, healthy signature (PEN-3193 baseline), not
a symptom. `401` on `/installation/repositories` means the credential is not
recognised at all. Grading health off `/user` alone inverts the reading.

## 3. Two leads that are already closed — do not re-chase them

**The 390-byte two-part token shape is normal.** PEN-5239 §6 offered the
length as a lead: a conventional `ghs_` token is ~40 bytes with no separator,
and the mounted value was 390 bytes, masked `ghs_9999999_aaaa….aaaa…`. That
lead is **falsified**. A token measured healthy on 2026-11-02T21:2xZ —
`/installation/repositories` 200 at 9500 req/hr — has the *identical* shape:
390 bytes, `ghs_<7 digits>_…`, two `.` separators. The minter is not emitting
a non-GitHub value. Length and separator count carry no diagnostic signal.
`token-sha256` is the only field that identifies the credential —
`mount-generation` does not, for the reason given in §5.

**Comment silence is not an outage instrument.** Across
2026-11-01T22:00Z → 2026-11-02T09:32:51Z there were zero `allyblockcast[bot]`
issue comments on `Blockcast/paperclip`, which reads like an 11.5-hour
blackout. It was not: authenticated git pushes landed on a branch at
`04:00:23Z`, `04:17:06Z`, `04:31:52Z` and `05:46:26Z`, and
[#3256](https://github.com/Blockcast/paperclip/pull/3256) was opened through
the API at `04:00:38Z` — all inside the apparent gap. Comment volume measures
what agents had to say, not whether the credential worked. Bound an outage
with the auth check or with push/PR timestamps, never with comment density.

## 4. Root cause, as far as it is established

PEN-5239 named three candidates. **One is closed; the other two are not
separated by the evidence.**

- ~~the 390-byte two-part value is not a GitHub token~~ — **falsified** in §3,
  against a measured-healthy control.

- **the App installation was suspended or revoked** — *still open: not
  distinguished by the available evidence.* It is tempting to close this,
  because a suspended installation cannot mint a working token and tokens
  minted roughly two hours after the last measured `401` performed
  authenticated pushes and an API write. That argument does not hold: a
  suspension **lifted** anywhere inside the `02:01:21Z` → `04:00:23Z` gap
  produces exactly the same timeline as a bad minted value. Nor does the sha
  changing in a later generation separate them — the minter rotates regardless
  of *why* the previous value was refused. Nobody held an installation-level
  read open across the window.

  **Discriminate it next time:** with an App JWT,
  `GET /app/installations/{installation_id}` returns `suspended_at`. Capture it
  *while the `401` is live*. Afterwards the two hypotheses are observationally
  identical.

- **the minter emitted one invalid credential** — the best fit for what was
  observed, but **not established** against the candidate above.
  `token-sha256 cfc3d245` (seen at mount generation `..2026_11_02_01_52_54`)
  was refused continuously from `01:56:57Z` to `02:01:21Z`; a later mount
  carried a working credential under a *different* sha.

> Bound: the `401` was measured in **one** pod. The fleet-wide blast radius
> asserted in PEN-5239 was inferred from the mount being fleet-wide, never
> observed in a second pod. Treat fleet-wide as likely, not measured.

## 5. Recovery, and how an in-flight run should park

**The refusal window closed on its own.** On 2026-11-02 the `401` was gone
within about two hours. No intervention is recorded — but nobody was watching
the minter, so that is *unrecorded*, not *established*. The default action is
still to park and re-check rather than retry or escalate immediately.

- Re-run `gh paperclip-auth-check` rather than retrying the failed `gh`
  command. A retry against a bad credential is indistinguishable at the call
  site from a pending CI gate — the same observability conflation as
  PEN-2502's `relay_failed`/`credential_quarantined`.

- **Key the park on `token-sha256`, never on `mount-generation`.** Record both,
  but only the sha identifies the credential. `mount-generation` is the
  kubelet's projection timestamp *for this pod*, reset whenever a pod starts —
  so an unchanged credential shows a **new** generation to every run, and every
  agent run is a fresh Job pod. Measured 2026-11-02 across three pods:
  generations `..21_23_49`, `..21_34_52` and `..21_37_06`, all carrying
  `token-sha256 bf65aa6d`. Generation is per-pod forensics only.

- **Escalate when either condition holds:**
  - the verdict is `rejected` under **two distinct `token-sha256` values** —
    the minter rotated and still emitted a bad credential; or
  - the **same** rejected sha persists past **90 minutes**. Installation tokens
    live at most an hour, so a sha that has not moved in 90 minutes means the
    minter has stopped rotating. That failure never produces a second sha, so
    without this bound the first condition waits forever.

  A single bad sha replaced inside that bound is self-correcting. Note the rule
  the first condition replaces — "two distinct mount generations" — would have
  escalated on the **second run every time**, because the generation always
  differs between pods.

- **Park as `todo` with an explicit re-check time, or arm a monitor. Do not use
  `blocked`.** `blocked` with no `blockedBy` edge strands the row — nothing
  resolves it and no wake fires. Do not add a `blockedBy` edge to fix that
  either: an unresolved blocker *suppresses* the monitor wake, so the two
  mechanisms cancel.

> **Capture forensics while it is live.** The mount retains exactly **one**
> generation directory — the next rotation destroys the evidence. If the
> verdict is `rejected`, record `mount-generation` and `token-sha256` into the
> issue *before* parking. Neither is recoverable afterwards.

## 6. What this runbook deliberately does not do

It does not widen any credential's scope, move it to a more privileged seat,
or touch the PEN-4933 publish-broker design. If the broker lands, this failure
mode moves behind it rather than disappearing, and §1's oracle is still the
thing that makes it legible.
