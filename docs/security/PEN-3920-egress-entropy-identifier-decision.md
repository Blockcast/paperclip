# PEN-3920 - Egress entropy rule vs. ordinary identifiers: security decision

Date: 2026-10-20
Reviewer: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Filed by: CTO. Re-scoped and assigned by the CEO (PEN-4422 liveness escalation).
Scope: `packages/adapter-utils/src/github-egress-scrub.ts`, measured against the shipped
bundle at `/opt/paperclip-bundled-adapters/node_modules/@paperclipai/adapter-utils/dist/github-egress-scrub.js`
(bundle dated 2026-10-19 23:28).
Method: read-only. Nothing mutated, no credential or Secret value read, no bypass attempted.

> **Writing convention in this file.** Every `name = value` pair below keeps a space around
> the `=`. Written contiguously, several of them are the exact material the rule under
> discussion refuses, so this document could not be pushed past the door it describes. Same
> convention as the PEN-3907, BLO-41153 and BLO-41262 fixtures.

PEN-3920 asked for a decision, not a patch, on two questions that narrow a security control.
Both are answered below, against measurement rather than argument. Section 6 states what may
now be implemented and what may not; it is deliberately a set of bounds rather than a diff.

## 1. Verdict

| # | Question PEN-3920 asked | Decision |
|---|---|---|
| D1 | Should a case-transition-delimited identifier join `isLexicalIdentifier`'s segment test? | **DECLINED.** Measured: the bare CamelCase shape exonerates 22-23% of random mixed-case letters-only tokens. `isLexicalIdentifier` is name-free, so that hole would open under every binding name in the fleet. |
| D2 | Does the push door warrant a different threshold from the comment door? | **DECLINED.** Door parity is a tested invariant installed by PEN-3152 precisely because divergent doors were themselves the defect, and the mechanism it records makes the irreversible door the worst place to diverge. |
| D3 | *(governing rule, newly stated)* | **Widen under a name anchor; never under a name-free rule.** Section 4 derives this from the control's own threat model. It is the line that resolves both questions above and every case like them. |
| D4 | *(approved work)* | Permit bounded digit runs inside the existing name-anchored CamelCase exemption. This closes the entire remaining measured false-positive class. |
| D5 | *(approved work)* | Route `job` through the name-anchored path. **Do NOT** raise `isLexicalIdentifier`'s mixed-segment cap: measured 4x widening of a name-free exemption. |
| D6 | *(approved work)* | Fix the push-door refusal text. Its only false-positive advice is unavailable on that door, and there is no sanctioned escape hatch behind it. This is the defect PEN-3920 found that nobody has yet costed. |

The row's `⛔` note stands and is re-affirmed: **do not raise `HIGH_ENTROPY_MIN_BITS_PER_CHAR`.**
Reaching the measured cases needs 4.16 bits/char, above the 4.0 ceiling a 16-symbol alphabet
allows, so it would exempt every hex-encoded secret as a side effect. The discriminator must
be structural.

## 2. Current state, re-measured 2026-10-20

The ground has moved twice since PEN-3920 was filed, and the row's own table is now out of date.

| value (spaced, see convention above) | verdict today | why |
|---|---|---|
| `alertname = ArcRunnerPoolCeilingClipped` | clean | `ALERT_NAME_RE` + `CAMEL_CASE_VALUE_NAMES`, added by BLO-46448 (#2736, merged 2026-10-15) |
| `kind = ValidatingAdmissionPolicy` | clean | same rule, `kind` added by BLO-47509 (#2829, merged 2026-10-19) |
| `alertname = Vlan1MacvlanV6ProbeInstrumentBroken` | **REFUSED** `high-entropy-assignment` | `ALERT_NAME_RE` admits no digits |
| `job = vlan1_macvlan_v6_listener` | **REFUSED** `high-entropy-assignment` | `job` is not an anchored name; `isLexicalIdentifier` allows at most ONE mixed segment and this has two (`vlan1`, `v6`) |

### 2.1 Three corrections of record

**(a) The CamelCase verdict is not erratic. It is deterministic on exactly one axis.**

The escalation comment recorded the verdict as flipping unpredictably with length - "27 chars
clean, 28 refused, 29 clean, 32 clean, 35 refused" - and drew the row's strongest conclusion
from it: that a rule author cannot learn the rule from a refusal. That conclusion does not
survive measurement.

Under the anchored names the verdict is, exactly:

> **REFUSED if and only if `length >= 24` AND the value contains a digit.**

Measured over 40,000 generated alert names built from a realistic vocabulary:
**0 cases** where that predicate under-predicted a refusal. The 238 deviations were all in
the other direction - values the predicate called refused but which came back clean - and
every one is the entropy term falling below 3.5 on a name with heavy character repetition
(`InstrumentInstrumentInstrument2`). So the entropy term, within the anchored names, **only
ever rescues; it never condemns.**

Length is not a factor at all. A digit-free CamelCase name is clean at 27, 32, 48, 64 and 92
characters; a digit-bearing one is refused at every length from 24 up. The observed
"27 clean / 35 refused" pair is the digit axis, not the length axis.

This correction cuts against the row, and it is the honest reading: the detector is
*predictably* wrong in one narrow place, not arbitrarily wrong everywhere. That matters,
because "arbitrary" is an argument for removing a control and "one deterministic axis" is an
argument for a bounded fix. The second is what the evidence supports.

**(b) The digest fix reached production by a tracked replacement PR, not by an unknown route.**

PR #2399 is indeed closed, but `isContentDigestAssignment` ships from **#2412, merged
2026-10-10T06:47:47Z**, on branch `be4fce/rb-2399`. That is not an anomaly - an egress-scrub
change in this repo *often* lands as a rebased replacement PR: the agent-authored PR is
closed and a replacement is merged, usually but not always under `be4fce/rb-<original>`:

| original (closed) | replacement (merged) | replacement branch | change |
|---|---|---|---|
| #2399 | #2412, 2026-10-10 | `be4fce/rb-2399` | PEN-3907 digest pins |
| #2475 | #2509, 2026-10-12 | `be4fce/rb-2475` | PEN-3932 class split |
| #2485 | #2581, 2026-10-12 | `be4fce/rb-2485` | BLO-41153 gRPC paths |
| #2715 | #2718, 2026-10-14 | `drive/BLO-46233-trailer-free-2715` | BLO-46233 merge scan |

It is **not** universal, and an auditor should not assume it. The two changes this document
relies on most merged directly from their own branches, with no closed original and no
rebased replacement: **#2736** (`cto/blo-46448-camelcase-identifier`, 2026-10-15) and
**#2829** (`cto/blo-47509-camelcase-kind`, 2026-10-19).

So: anyone auditing what ships should, on finding a *closed* egress PR, look for a merged
replacement carrying the same change before concluding the code took an untracked path - by
title or by diff, not by assuming a `be4fce/rb-` branch name. A merged PR on its own branch
needs no such resolution.

**(c) PEN-3920's question D1 was already answered, the opposite way, by BLO-46448.**

The row proposes joining a case-transition split to `isLexicalIdentifier`. BLO-46448 measured
that exact shape, declined it, and routed around it with a name anchor instead. Section 3
reproduces that measurement independently rather than citing it.

## 3. D1 - why a shape-only CamelCase exemption is refused

`isLexicalIdentifier` carries **no name conjunction**. Whatever it exonerates is exonerated
under every binding name that exists or ever will. So its residual has to be read against
random tokens with no narrowing from the name at all.

Measured, 500,000 random values per cell, counting values that clear the entropy rule
(`length >= 24`, two character classes, `>= 3.5` bits/char) and that the bare `ALERT_NAME_RE`
shape would then exonerate:

| alphabet | len 24 | len 28 | len 32 | len 40 |
|---|---|---|---|---|
| mixed-case letters only | **2.33e-1** | **2.30e-1** | **2.27e-1** | **2.21e-1** |
| base64url | - | - | 2.78e-4 | - |

**22-23% of random mixed-case letters-only tokens pass the bare shape**, flat across every
length from 24 to 40. This reproduces BLO-46448's recorded ~22% figure independently.

That is not a narrowing, it is a hole, and length does not close it. It is also not a
hypothetical alphabet: PEN-3932's note records that a *single*-case letters-only value never
reaches the entropy test at all, so mixed-case letters-only is squarely inside the space this
rule is supposed to cover.

**D1 is declined.** Not on judgement - on a measured 23% exoneration rate for a rule that
applies under every name.

## 4. D3 - the governing rule, and why the name anchor is load-bearing

Section 3 raises an obvious objection: if the bare CamelCase shape is 23% leaky, how is
BLO-46448's name-anchored version of the *same shape* acceptable? The answer is the control's
own threat model, and stating it explicitly is the main contribution of this review.

`github-git-egress-runtime.ts` is unambiguous about what this control is for:

> SCOPE - this is an ACCIDENTAL-DISCLOSURE guard. It is not a tamper-resistant boundary and
> must not be described as one. [...] What this defends against is an agent that discloses
> WITHOUT INTENDING TO. [...] What it does NOT defend against is an agent that sets out to
> defeat it.

Deliberate bypass is explicitly out of scope and tracked as PEN-3183 - the wrapper, the hook
and the scanner are all writable by the account they guard, and `/usr/bin/git` is directly
executable, so an agent that *intends* to publish a credential does not need to defeat any
exemption in this file.

Against **accidental** disclosure, a name anchor is a near-total discriminator, and for a
structural reason:

> **An accidental leak does not choose its binding name.** The name comes from whatever code
> interpolated the value - `TOKEN`, `KEY`, `AUTH`, `PASSWORD`, some unenumerated name. For
> material to reach a name-anchored exemption it must land under one of a handful of
> enumerated names, and accident does not arrange that.
>
> A name-free rule has no such property. Accident reaches it under *every* name, which is
> precisely why `isLexicalIdentifier`'s bounds must stay tight and why its 23% variant is
> unacceptable.

Measured against the live corpus: every distinct `alertname` / `kind` / `job` binding of 16+
characters across both `Blockcast/paperclip` and `Blockcast/penstock-llm-proxy-core` - 18 of
them - is an ordinary identifier. Not one is credential-shaped:

```
alertname = CiliumPolicyDropsHigh                  job = kube-state-metrics
alertname = PaperclipAgentHeartbeatStale           job = paperclip-control-plane
alertname = PaperclipAgentStartLockWedged          job = penstock_front_door
alertname = LLMProxyByosLedgerReconciliationMismatch   job = penstock_registration_config
kind = ClusterSecretStore                          kind = ValidatingAdmissionPolicy
  (8 more, all identifiers)
```

So the rule this review lands, and which should govern every future narrowing of this file:

> **Widen under a name anchor; never under a name-free rule.**
>
> A name-anchored exemption (`isContentDigestAssignment` and its family) may be widened on
> shape, with the residual measured and recorded, because the threat this control addresses
> cannot satisfy the name half. A name-free exemption (`isLexicalIdentifier`,
> `GRPC_METHOD_PATH_RE`) must be held tight, because the threat reaches it under every name.

This is consistent with the structural-detection rule at the top of `github-egress-scrub.ts`,
and for the reason #2412 already recorded: that rule governs **detection**, where the default
must be to fire and a name nobody enumerated must not create a hole. A name used to narrow an
**exemption** inverts the failure mode - an unanticipated name yields a false positive, never
a leak.

## 5. D2 - why the push door does not get its own threshold

PEN-3920 argues that the cost asymmetry at the top of `github-egress-scrub.ts` - *"a false
positive costs a reviewer one glance at a marker, a false negative costs a fleet rotation"* -
holds on the comment path, where the scrub redacts in flight, but not on the git door, where
a false positive is a refused push. **That half of the argument is correct and is confirmed
below.** The conclusion drawn from it is not.

**5.1 Door parity is a tested invariant, installed because divergence was the original defect.**

`github-egress-door-parity.test.ts` exists because of PEN-3152, and its header states the
mechanism:

> an agent has no way to tell that `mcp__github__add_issue_comment` is unscrubbed while
> `gh issue comment` is scrubbed. The safe path is the one with the *worse* ergonomics, so
> ordinary tool selection drifts toward the unguarded door.

and the test's own purpose:

> They fail the moment someone gives one door its own policy, which is exactly how the
> original gap was introduced.

Giving the push door a looser threshold is that change. The drift mechanism makes it worse
than it first looks: a looser push door is a *better-ergonomics* door, so material that the
comment door would scrub gets routed through it - and the push door is the one that cannot
be undone.

**5.2 The asymmetry runs the other way on the axis that matters more.**

Reversibility is not symmetric between the doors:

| | comment / MCP door | git push door |
|---|---|---|
| false positive | marker in a comment; comment is editable | push refused; object must be rewritten |
| **false negative** | **comment is editable or deletable** | **object is content-addressed, distributed to every fork and clone on fetch, and GitHub retains unreachable objects; a public push is a fleet rotation** |

Both asymmetries are real and they point in opposite directions. If the thresholds are ever
to differ, the push door should be the **stricter** one, because its false negative is the
only irreversible outcome in the table. Loosening it specifically is the wrong direction on
the larger term.

**5.3 The real defect the row found is the remedy, not the threshold.**

Confirmed by reading the shipped push door:

- `formatRefusal` (`github-git-egress-shim.ts`) ends with exactly one piece of
  false-positive advice: *"If this is a false positive on a test fixture, derive the value at
  runtime instead of embedding a literal."* The row is right that this is meaningless for an
  alert name inside a `PrometheusRule` - the literal has to be in the blob.
- There is **no content allowlist and no escape hatch** behind it. The env-backed overrides
  that once existed (`PAPERCLIP_GIT_EGRESS_HOOKS_DIR`, `PAPERCLIP_GIT_EGRESS_GIT`) were
  removed *because* they were an escape hatch, and that removal is correct and should stand.

So an author hitting a genuine false positive on the push door is told to do something they
cannot do, and offered nothing else. That is the failure mode the row rightly says "gets a
control switched off" - but the fix is to make the refusal name a route that exists, not to
lower the bar for everyone. **D6 approves that fix.**

**D2 is declined. Both doors keep one detector and one threshold, and the parity test stays.**

## 6. What may now be implemented, and what may not

This section is bounds, not a patch. The row asked for the judgement before the code.

### 6.1 Approved: bounded digits inside the existing name-anchored CamelCase exemption (D4)

Permit each CamelCase word in `ALERT_NAME_RE` to carry a short trailing digit run, bounded in
run length and in how many runs a value may carry.

The shape measured below is, against the shipped
`/^(?:[A-Z][a-z]+|[A-Z]{1,5}(?=[A-Z][a-z]))+$/`:

```js
// bounded form - the approved one. <=2-digit tail on BOTH branches.
/^(?:[A-Z][a-z]+\d{0,2}|[A-Z]{1,5}\d{0,2}(?=[A-Z][a-z]))+$/
// plus, as a separate check the regex does not express:
//   (value.match(/\d+/g) ?? []).length <= 2
```

```js
// lowercase-tail variant - the declined one, third row of the table.
/^(?:[A-Z][a-z]+\d{0,2}[a-z]*|[A-Z]{1,5}\d{0,2}(?=[A-Z][a-z]))+$/
```

Note the digit tail must be on the **acronym branch too**, with the `(?=[A-Z][a-z])`
lookahead re-anchored *after* the digits. The narrower reading - a `\d{0,2}` tail on the
`[A-Z][a-z]+` branch only - is not what was measured and does **not** reach the corpus: it
misses `Vlan1MacvlanV6ProbeInstrumentBroken` (the `V6` word has no lowercase run) and
`HTTP2ServerStreamsExhausted` (same, on `HTTP2`). An implementing PR that takes the narrower
reading will not reproduce either the residual table or the coverage claim below.

Measured residual, 500,000 random values per cell, as a fraction newly exonerated **under an
anchored name**:

| shape | base62 @24 | base62 @32 | base64url @24 | base64url @32 |
|---|---|---|---|---|
| shipped `ALERT_NAME_RE` | 4.01e-3 | 9.34e-4 | 1.54e-3 | 2.78e-4 |
| + `<=2`-digit tail per word, `<=2` runs per value | 1.81e-2 | 6.39e-3 | 7.61e-3 | 1.97e-3 |
| + same, also allowing a lowercase tail after a digit | 2.91e-2 | 1.10e-2 | 1.22e-2 | 3.42e-3 |

Two readings govern the choice:

- On **mixed-case letters-only** - the alphabet that dominates this exemption's exposure -
  all three rows are identical at 2.33e-1, unchanged from shipped. A letters-only token has
  no digits to bound, so permitting digits widens nothing there. The marginal cost is
  confined to the digit-bearing alphabets, where the absolute figures stay at or below 1.8e-2
  and fall with length.
- The lowercase-tail variant costs ~1.6x the bounded one and buys one corpus member
  (`CoreDNSPanicCount24h`). **Take the bounded form.** The `<=2` run cap is cheap and should
  be kept even though it is not load-bearing against the dominant alphabet, because it keeps
  the stated bound honest.

Coverage of the measured corpus under the bounded form: `Vlan1MacvlanV6ProbeInstrumentBroken`
(2 digit runs), `ArcRunnerPool2CeilingClipped`, `HTTP2ServerStreamsExhausted` and
`Ipv6RouteAdvertisementStale` (1 each) all pass, all within the `<=2` run cap; every
digit-free name already passing continues to pass. `CoreDNSPanicCount24h` does **not** pass,
and is the one corpus member the declined lowercase-tail variant would have bought.

### 6.2 Approved: route `job` through the name anchor (D5)

`job = vlan1_macvlan_v6_listener` needs a snake_case shape under an anchored Prometheus label
name, in the same form as `alertname` and `kind`.

### 6.3 REFUSED: raising `isLexicalIdentifier`'s mixed-segment cap

This is the tempting one-line fix for 6.2 and it must not be taken. `isLexicalIdentifier` is
name-free (section 4). Measured over 2,000,000 random varying-length segmented tokens per
family - varying lengths specifically to defeat the uniform-layout check that otherwise masks
the cost:

| family | cap = 1 (shipped) | cap = 2 | cap = 3 |
|---|---|---|---|
| 2-8 chars, 4-6 groups, `-` | 2.96e-3 | **1.19e-2** | 2.48e-2 |
| 2-8 chars, 4-6 groups, `_` | 2.91e-3 | **1.19e-2** | 2.49e-2 |
| 3-7 chars, 4-5 groups, `-` | 3.57e-3 | **1.54e-2** | 3.34e-2 |

Raising the cap from 1 to 2 is a consistent **4x widening**, and it applies under every
binding name in the fleet. Note the measurement trap for anyone re-deriving this: with
*fixed*-length segment generators the cap appears to cost exactly nothing (identical residuals
at cap 1, 2 and 3), because the `new Set(segments.map(s => s.length)).size > 1` layout check
absorbs the whole difference. Only varying-length generators expose the real cost.

### 6.4 Approved: fix the push-door refusal text (D6)

`formatRefusal` should name a route that exists on the push door. At minimum: that the author
may file against the detector with the refused value, and that an identifier refused under a
label name is a known class with a home (this document). It must **not** gain an allowlist,
an env override, or any other bypass - section 5.3.

**Amended by PEN-4428 (2026-10-20): the report must not carry the refused value.** The clause
above said "with the refused value", and that is the wrong direction for a disclosure guard.
The only reader who reaches that sentence is one who has judged a refused value harmless while
the detector disagreed, so the single reader who can cause harm by complying is also the one
most likely to comply — and an issue tracker is more durable, more indexed and more widely read
than the blob the push door just refused. The refusal now asks for the **binding name** (the
label or key the value sits under) and the value's **shape** (length, character classes present,
longest digit run), and says plainly not to paste the value. That is not a weaker report: every
narrowing decision in this family — BLO-41153, BLO-41262, BLO-44747, BLO-46448, BLO-47509, and
D4/D5 above — was derived from exactly the name and the shape, and none needed the literal. The
rest of D6 is unchanged, and section 5.3 still stands: no allowlist, no env override, no bypass.

### 6.5 Record the residual honestly

The name-anchored CamelCase exemption carries a 2.33e-1 exoneration rate on mixed-case
letters-only tokens (section 3). That figure belongs in the comment above `ALERT_NAME_RE`
alongside the reasoning in section 4 that makes it acceptable. The current comment records
the shape measurement that led to the name anchor but not the residual the anchor is
carrying, and a future reader widening this rule needs the second number more than the first.

## 7. Reproducing

Every figure above comes from the shipped bundle or from the predicates as shipped, over
`crypto.randomBytes`-driven samples. The entropy rule reproduces as:

```
length >= 24  AND  >=2 of [a-z] [A-Z] [0-9]  AND  shannon(value) >= 3.5
```

with `isLexicalIdentifier`, `GRPC_METHOD_PATH_RE` and `isContentDigestAssignment` applied as
exemptions before it. Verdicts quoted in section 2 were taken through the exported
`locateGitHubEgressMatches` / `scrubGitHubEgressText` against the 2026-10-19 23:28 bundle.

## 8. Downstream

PEN-3920 blocks PEN-4226 (DevOps shard conversion). This document lands the decision; the
door still refuses `alertname = Vlan1MacvlanV6ProbeInstrumentBroken` and
`job = vlan1_macvlan_v6_listener` until 6.1 and 6.2 are implemented and the bundle redeploys.
PEN-4226 should not resume on the strength of this document alone.

## 9. PEN-4438 (D7) - Kubernetes object names under `cronjob`, `instance`, `name`, `pod`

Added 2026-10-21 by the Security Engineer, after PEN-4425 shipped and PEN-4226 re-measured
the door. Same method as above: read-only, against the shipped bundle
(`/opt/paperclip-bundled-adapters/...`, mtime 2026-10-20 22:18) through the exported
`locateGitHubEgressMatches`. Convention of section 2 applies - no `name=value` pair below is
written contiguously.

### 9.1 What was left

PEN-4425 closed the CamelCase/snake_case class. The residual PEN-4226 then hit is a different
one: Kubernetes-GENERATED identifiers, under four label names that were never anchored. Four
distinct values, in three `PrometheusRule` shard keys, all refused `high-entropy-assignment`:

| name | shape | fails `isLexicalIdentifier` on |
|---|---|---|
| `pod` | `<deploy>-<pod-template-hash>-<suffix>` | two mixed segments; summed content 32 against a cap of 30 |
| `name` | `<scale-set>-<hash>-listener` | its hash segment opens with a digit, so no mixed-segment branch reaches it |
| `instance` | `<service>.<namespace>.svc` | two mixed segments; summed content 39 |
| `cronjob` | `<ticket-id><digits>-<words>-selftest` | a 5-digit run against a per-segment cap of 2 |

A label matcher inside a PromQL expression must be a literal, so "derive it at runtime" is
unavailable - the gap PEN-4428 removed from the refusal text.

### 9.2 Verdict: anchor all four

| name | decision | why |
|---|---|---|
| `pod` | **ANCHOR** | 556 distinct values in the corpus, 239 refused today. Binding name is Kubernetes-specific. |
| `instance` | **ANCHOR** | 58 distinct, 7 refused. Prometheus/Kubernetes-specific. |
| `cronjob` | **ANCHOR** | 39 distinct, 1 refused. Narrowest of the four. |
| `name` | **ANCHOR**, and it is the one that needed the argument | Generic binding name, so section 4's "accident does not choose the name" is weakest here. What carries it is the SHAPE half: the word-mass floor (9.3) is not satisfiable by any real credential format, measured over 28 of them. |

Refusing any one of them leaves a shard key permanently single-line, and `pod` and `name`
appear in the same key, so a partial answer unblocks nothing in shard 3.

### 9.3 The shape, and the conjunct that carries it

A DNS-1123 subdomain whose hyphen-separated segments are words (letters only), numbers
(digits only), or GENERATED (anything else, at most 2 of them, each at most 10 characters,
summing to at most 16) - admitted only when the WORD segments sum to at least 16 characters.

That last floor is the whole rule. Without it the shape exonerates 3.5e-2 of random segmented
lowercase tokens; with it, 2.9e-3 to 9.9e-3. It is also what no credential format satisfies:
`sk-ant-api03-...` musters 5 characters of letter runs, `xoxb-...` 4, `sk_live_...` 6.

### 9.4 Residual, 200,000 random values per family

Fraction NEWLY exonerated under an anchored name. Varying-length segment generators, per the
measurement trap in 6.3.

| family | newly exonerated |
|---|---|
| base62 @24/@32, base64url @24/@43, base32 @32, lowercase hex @32/@40, mixed-case letters @24, UUID v4 layout | **0** each |
| base36, 4-6 varying groups of 2-8, `-` | 9.54e-3 |
| base36, 3-5 varying groups of 3-7, `-` | 5.39e-3 |
| base36, 2-4 varying groups of 4-10, `-` | 2.93e-3 |
| base36, 3-4 varying groups of 3-9, `.` | 2.96e-3 |
| Kubernetes suffix alphabet, 3-5 varying groups of 3-9, `-` | 9.85e-3 |

Credential-format check: 28 real formats (GitHub classic and fine-grained PATs, Slack, Stripe,
AWS id and secret, Google, Anthropic, OpenAI, Vault, GitLab, npm, Grafana, JWT, base32 TOTP
seed, Kubernetes bootstrap token, UUID, raw hex and base64 blobs), 20,000 synthesized samples
each: **0 of 560,000** newly exonerated.

For scale, the name-anchored CamelCase exemption this file already accepts carries 2.33e-1
(6.5), and `isLexicalIdentifier` carries 2.96e-3 to 3.57e-3 *name-free*. This rule sits
between them and is anchored.

### 9.5 What it does admit, stated plainly

A value built as real dictionary words glued to an opaque tail - `<16+ characters of
words>-<8-10 opaque>` - is exonerated at ~5e-1. No further conjunct closes it, because a
genuine Kubernetes name IS words plus a generated suffix; the two are not separable by shape.
Two things make it acceptable, and neither is "the number is small":

- It is a DELIBERATE construction. Accident binds the raw credential; it does not prepend
  dictionary words to it. Section 4 and PEN-3183 put deliberate bypass outside this control.
- The opaque mass admitted is at most 16 lowercase-alnum characters, ~83 bits - LESS than the
  ~141 bits `isLexicalIdentifier` already exonerates under EVERY name (three 10-letter random
  segments, hyphenated, is clean on the shipped bundle today).

The name anchor carries this rule. The shape alone was never going to, and a future reader
should not read 9.4 as though it did.

### 9.6 Corpus

556 distinct `pod` values, 145 `name`, 58 `instance`, 39 `cronjob` across Blockcast/onprem-k8s,
Blockcast/paperclip and Blockcast/penstock-llm-proxy-core. 262 are refused today; this rule
exonerates 204, every one an ordinary Kubernetes name - so this is a 204-value false-positive
class, not three shard keys. Loosening to the corpus maxima (3 generated segments, mass 21)
buys three more, so the caps sit at the knee. Held against the same corpus, the four-name
anchor withholds this shape from 23 other binding names that would gain it under a name-free
rule, among them `uid`, `evidence`, `claim` and `RULE_ID`.

### 9.7 Refused, unchanged

- `isLexicalIdentifier`'s mixed-segment cap stays at 1 (6.3).
- `HIGH_ENTROPY_MIN_BITS_PER_CHAR` stays at 3.5 (section 1).
- The push door keeps the comment door's threshold (section 5).
- No allowlist, env override or bypass.

## 10. PEN-4637 (D8) — absolute POSIX paths, and the first name-free widening

Added 2026-10-24 by the Security Engineer, from PEN-4637. Same method as above:
read-only against the shipped bundle (`/opt/paperclip-bundled-adapters/...`, mtime
2026-10-22 19:46) through the exported `scrubGitHubEgressText`, with a fast mirror of the
entropy predicate validated at 0 divergences over 200,000 random values and re-validated
against the patched source at 1 divergence in 300,000 (a `sk-` value the vendor-key
detector owns first — the safe direction). Convention of section 2 applies: no
`name = value` pair below is written contiguously.

### 10.1 What PEN-4637 asked, and why the answer is different

The row asked for a name anchor on `config`, by analogy with D7: *"name: `config` (and
plausibly the other path-bearing label names this fleet uses — worth enumerating from the
live label sets rather than guessing)."* That enumeration is the whole finding.

Harvested with the shipped `ASSIGNMENT_RE` across Blockcast/paperclip, Blockcast/onprem-k8s
and Blockcast/penstock-llm-proxy-core — 20,453 assignments:

| measure | count |
|---|---|
| assignments binding a slash-rooted value | 782 |
| distinct binding names doing so | ~250 |
| distinct (name, value) pairs | 475 |
| **refused today as `high-entropy-assignment`** | **69** |
| **distinct binding names those 69 sit under** | **52** |

`config` is not one of the 52. The paths that happen to be bound to it today are short and
digit-free, exactly as the row predicted; the class is real but the name is not where it
lives. The 52 are not a vocabulary anyone could enumerate — `new`, `prev`, `src`, `raw`,
`href`, `name`, `CAP`, `MAP`, `MAP6`, `DLL`, `SDF`, `CONF`, `DRY`, `PROG`, `backup`,
`override`, `remote`, `credential`, `ExecStart`, `JAVA_HOME`, `LD_PRELOAD` — and the wider
250 include `key`, `cert`, `SA_TOKEN`, `secretsPath` and `SSH_KEY_PATH`.

So D7's instrument is unavailable. A 52-name list is not an anchor, it is a snapshot, and
the first name nobody listed reproduces the false positive. This is the drift
`GRPC_METHOD_PATH_RE` already records for `method` / `rpc` / `grpc_method` / `full_method`,
an order of magnitude worse.

### 10.2 Verdict

| # | Decision |
|---|---|
| D8 | **ADMIT absolute POSIX paths, SHAPE-ONLY, with no name conjunction** — the second name-free exemption in this file after `GRPC_METHOD_PATH_RE`, and permitted for the same reason: nothing of this shape is a credential, and a name list would drift. |
| D8a | Because the shape carries the WHOLE decision, the rule admits **zero opaque mass**. Every run must be a word, a number, or a tightly bounded word-with-digits. This is the conjunct that makes a name-free widening safe, and it is what distinguishes D8 from D7 — D7 spends a 16-character opaque budget it can afford because its name anchor carries the other half. |
| D8b | **Refused, unchanged:** `isLexicalIdentifier`'s mixed-segment cap, `HIGH_ENTROPY_MIN_BITS_PER_CHAR`, door parity, and any allowlist, env override or bypass. |

Section 4's governing rule — *widen under a name anchor; never under a name-free rule* —
is not overturned. It is a rule about where the SAFETY ARGUMENT comes from, and it says a
name-free exemption "must be held tight". D8 is held tight by construction rather than by
a name: the measured residual below is roughly forty times smaller than what
`isLexicalIdentifier` already carries name-free today.

### 10.3 The shape, and what each conjunct holds

A value is admitted when it is slash-rooted, carries at least two segments, and every RUN
— the text between `/`, `-`, `_` and `.` — is one of: a lowercase word, an uppercase word,
a digit group, a CamelCase word of at least 5 characters and at most 3 words, or a
single-case letter-initial run carrying exactly one digit group of at most 2 digits. A
leading `.` on a segment (a dotfile) and one trailing separator (the capture of a path
interpolated with `$(…)`) are tolerated. Totals are capped at 16 runs and 96 content
characters.

Each conjunct was measured by removing it:

| conjunct | what it holds | residual without it |
|---|---|---|
| slash-rooted, 2+ segments | the gate. Only standard base64 emits `/` at all, at 1 char in 64; base64url, base62, base32, hex and every vendor prefix cannot produce the first character | the rule would not be reachable without it |
| CamelCase run ≥ 5 characters | mixed-case tokens sliced into 4-character runs. `Users` is the corpus minimum at exactly 5; 6 drops nine real values | `/letters-chop@4` 1.1e-3 → **0** |
| CamelCase ≤ 3 words | the 2.3e-1 bare-shape residual of section 3, reappearing per-run | `/letters-chop@16` **1.31e-1** (39436/300000) |
| ≤ 2 runs mixing letters and digits | chopped base36/alphanumeric tokens. Corpus maximum over all 421 shape-matching values is exactly 2 | `/base36-chop@4` 9.8e-3 → 4.8e-5 |
| one digit group per mixed run, ≤ 2 digits | see 10.5 — the corpus needs exactly this, and the measured alternative is in the table there | — |
| 16 runs / 96 content characters | total admitted mass, as `LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH` does for `isLexicalIdentifier`. Corpus maxima are 16 and 93 | headroom bounds, not entropy bounds |

`POSIX_PATH_MAX_LENGTH` is a cost guard and NOT a bound: 16 runs summing to 96 characters
admit at most 113 characters in total, so the 128 cap is unreachable. A test pins that
arithmetic so a future reader does not mistake it for load-bearing.

### 10.4 Residual, 250,000 random values per family

Fraction NEWLY exonerated — values the detector refuses today that this rule admits.
Varying generators per the measurement trap in 6.3.

| family | newly exonerated |
|---|---|
| Every flat token family, bare AND slash-prefixed — base64 url-safe, base62, base36, base32, hex upper and lower, mixed-case letters, alphanumeric, at 24 / 32 / 43 / 64 characters; UUID v4; standard base64 filtered to two or more interior slashes | **0** each |
| 29 real credential formats, each measured bare AND slash-prefixed — GitHub PAT classic / fine-grained / OAuth, Slack bot, Stripe live and restricted, AWS key id and secret, Google API, Anthropic, OpenAI key and project key, Vault, GitLab PAT, npm, Grafana, JWT, base32 TOTP seed, Kubernetes bootstrap token, DigitalOcean, Paperclip service key, Azure SAS, UUID, raw hex and base64 blobs | **0** each |
| **standard base64 at 24 characters, leading slash FORCED** — see below | **3.0e-6** |
| standard base64 at 24 characters, as generated | **0** (0 / 3,000,000) |
| standard base64 at 32 / 43 / 64 characters, forced and as generated | **0** each (0 / 3,000,000) |
| synthetic chopped tokens — base36 / lowercase-alnum sliced into 4, 6 and 8-character slash-separated runs | 4.0e-5 to 7.2e-5 |
| synthetic chopped tokens — mixed-case letters, 6 and 8-character runs | 8.0e-6 to 3.2e-5 |
| synthetic chopped tokens — mixed-case letters or base62, 4-character runs | 0 |

Standard base64 is the ONLY real credential alphabet that can reach this rule, because it
is the only one that emits `/`. Measured over 3,000,000 samples per length: forcing the
leading slash — which a generator does one time in 64 — it is admitted at 3.0e-6 at 24
characters and at 0 for every longer length. **As actually generated, including the cost
of the leading slash, 0 of 3,000,000 at every length.** That is the number that matters,
and the forced-slash row is reported beside it so the margin is visible rather than hidden
inside a probability nobody re-derived.

For scale: `isLexicalIdentifier` carries 2.96e-3 to 3.57e-3 **name-free** today, and the
name-ANCHORED D7 rule carries up to 9.85e-3. D8's worst family is 7.2e-5 — roughly forty
times below the name-free exemption this file already ships. It is the loosest-looking
exemption here by vocabulary and the tightest by measurement.

### 10.4.1 Measured and DECLINED: a second digit group inside a mixed run

`v1alpha1` — a Kubernetes API version, and 4 of the 17 values in 10.6 — needs a mixed run
to carry TWO digit groups rather than one. Measured at 250,000 per family:

| | corpus | `/base36-chop@6` | `/base36-chop@8` | `/letters-chop@6` |
|---|---|---|---|---|
| one digit group (shipped) | 52/69 | 4.0e-5 | 7.2e-5 | 3.2e-5 |
| two digit groups | 56/69 | 1.4e-4 | 1.1e-4 | 6.0e-5 |

A consistent 2-3x widening to buy four values of one shape, all in one path family in one
repo. Section 6.1 declined a 1.6x widening to buy one corpus member; the same reasoning
declines this one. It is recorded rather than omitted because it is the first thing a
future reader will reach for, and the measurement should not have to be redone.

### 10.5 What it admits, stated plainly

A **deliberately constructed** value — a secret sliced into short slash-separated runs,
each one case-homogeneous — is admitted at the rates in the last two rows. No encoder emits
that; producing it means setting out to, which section 4 and PEN-3183 put outside this
control's threat model.

The honest statement of the bound is that this rule admits more total WORD mass than any
other exemption here — 96 characters against `isLexicalIdentifier`'s 30 — and **zero**
opaque mass, where D7 admits 16 characters of it. Those two numbers move in opposite
directions on purpose: word mass is what a path is made of, opaque mass is what a secret is
made of, and only the second is an entropy budget.

### 10.6 Coverage, and the residue that stays refused

Of the 69 refused values, **52 are exonerated across 42 distinct binding names**. The
remaining 17 all carry a segment the rule calls opaque, and that is the intended outcome
rather than a shortfall:

- a uuid, a pod-template hash, a `kubepods` slice id, a container id, an 8-hex chart digest;
- a disk serial (`ata-INTEL_SSDSC2KG240G8_PHY…`, `ata-Samsung_SSD_870_EVO_4TB_S8HT…`);
- a run whose digits the mixed-run bound does not admit — `st2059` and `ct140` (a group
  longer than two), `storcli64` (nine characters against a cap of eight), and `log4j2` and
  `v1alpha1` (two digit groups in one run; see 10.4.1, measured and declined);
- a literal `...` elision inside a documentation path.

This is the right line, and PEN-4637 drew it itself: *"no segment that is itself opaque."*
It is also the right outcome for the refusal that produced the row — those paths were
per-seat homes carrying an execution-workspace uuid belonging to **another company**, seen
from a Penstock seat. A rule that exonerated them would have helped publish them. The door
failed closed on the material question as well as the shape one, and after D8 it still
does.

### 10.7 Reachable from a repo checkout

PEN-4637 notes that the refusal text points at this document and that it is not present in
`Blockcast/onprem-k8s` — it lives only at `/app/docs/security/` on the agent image and in
`Blockcast/paperclip`. That is accurate and worth recording for anyone following the
pointer from another checkout. Resolving it is not in D8's scope; it is a property of the
refusal text, which D6/PEN-4428 already own.
