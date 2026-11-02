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
  credential:         present (390 bytes)
  mount-generation:   ..2026_11_02_21_23_49.3562890036
  token-sha256:       bf65aa6d
  github-reachable:   yes (unauthenticated /rate_limit -> 200, x-ratelimit-limit 60)
  authenticated:      /installation/repositories -> 200, x-ratelimit-limit 9500
  verdict:            OK — valid GitHub App installation token
```

The pairing is the point: an unauthenticated `200` beside an authenticated
`401` separates *this credential is dead* from *GitHub is slow or down*. Do
not hand-roll the probe — `$GH_TOKEN` is empty in your shell (the wrapper
exports it into `gh` only), so curl-ing with it returns `401` whatever the
credential's health, and an empty Bearer returns the same `401` as a revoked
token.

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
a non-GitHub value. Length and separator count carry no diagnostic signal;
only `token-sha256` and `mount-generation` do.

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

PEN-5239 named three candidates. Two are closed:

- ~~the 390-byte two-part value is not a GitHub token~~ — falsified in §3.
- ~~the App installation was suspended or revoked~~ — a suspended installation
  cannot mint a working token, and tokens minted roughly two hours after the
  last measured `401` performed authenticated pushes and an API write. If the
  installation was ever suspended it was restored inside that window with
  nothing recorded.
- **the minter emitted an invalid credential for one mount generation** — what
  remains, and what the evidence fits. Generation
  `..2026_11_02_01_52_54` (`token-sha256 cfc3d245`) was refused continuously
  from `01:56:57Z` to `02:01:21Z`; a later generation carried a working
  credential with a different sha.

> Bound: the `401` was measured in **one** pod. The fleet-wide blast radius
> asserted in PEN-5239 was inferred from the mount being fleet-wide, never
> observed in a second pod. Treat fleet-wide as likely, not measured.

## 5. Recovery, and how an in-flight run should park

**The credential self-heals on the next kubelet rotation of the projected
Secret.** On 2026-11-02 the refusal window closed without intervention inside
about two hours. So the default action is to *park on the rotation*, not to
retry and not to escalate immediately.

- Re-run `gh paperclip-auth-check` rather than retrying the failed `gh`
  command. A retry against a bad generation is indistinguishable at the call
  site from a pending CI gate — the same observability conflation as
  PEN-2502's `relay_failed`/`credential_quarantined`.
- Park the issue with the mount generation in the park reason, so the waking
  run can tell *the same bad credential* from *a new one*.
- Escalate only if the verdict is still `rejected` across **two distinct**
  mount generations. One bad generation is self-correcting; two is a minter
  fault.

> **Capture forensics while it is live.** The mount retains exactly **one**
> generation directory — the next rotation destroys the evidence. If the
> verdict is `rejected`, record `mount-generation` and `token-sha256` into the
> issue *before* parking. Neither is recoverable afterwards.

## 6. What this runbook deliberately does not do

It does not widen any credential's scope, move it to a more privileged seat,
or touch the PEN-4933 publish-broker design. If the broker lands, this failure
mode moves behind it rather than disappearing, and §1's oracle is still the
thing that makes it legible.
