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

This table is PEN-3920's own verdicts and is not the whole decision set. Later rows decided
under the same governing rule are appended as numbered sections, each heading carrying its
letter: D7 in section 9, D8 in section 10, D9 in section 11, D10 in section 12, D11 in section 13, D12 in section 14.

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

**PEN-5828: the cap=1 column is a FAMILY AVERAGE, and the bracket quoted from it
elsewhere excluded one of its own rows.** This document and
`github-egress-scrub.ts` both quoted `isLexicalIdentifier` as carrying *"2.96e-3
to 3.57e-3"*; the `_` row above measures **2.91e-3**, below that lower bound. The
bracket is **2.91e-3 to 3.57e-3** and is corrected everywhere it appears.

Per shape, with the group count pinned instead of drawn per trial, and against
the population denominator — the draws the detector would otherwise redact,
which are the only ones this exemption can save:

| family | groups | population | per-population | per-trial |
|---|---|---|---|---|
| 2-8 chars, `-` | 4 | 0.450 | 5.29e-3 | 2.38e-3 |
| 2-8 chars, `-` | 5 | 0.885 | 3.56e-3 | 3.15e-3 |
| 2-8 chars, `-` | 6 | 0.991 | 1.84e-3 | 1.82e-3 |
| 2-8 chars, `_` | 4 | 0.452 | 6.11e-3 | 2.76e-3 |
| 2-8 chars, `_` | 5 | 0.883 | 4.42e-3 | 3.90e-3 |
| 2-8 chars, `_` | 6 | 0.991 | 2.03e-3 | 2.01e-3 |
| **3-7 chars, `-`** | **4** | **0.429** | **6.21e-3** | 2.66e-3 |
| 3-7 chars, `-` | 5 | 0.958 | 4.05e-3 | 3.88e-3 |

100,000 trials per shape against the shipped module at `master`, 2026-11-11;
baseline is this predicate neutered in a copy of the module, so *newly
exonerated* means exonerated **by this rule** and not by something else. The
re-measured mixtures are 2.45e-3 / 2.89e-3 / 3.27e-3 against the published
2.96e-3 / 2.91e-3 / 3.57e-3, so **the published figures reproduce** — what was
missing is the shape they average over.

**Worst shape 6.21e-3, 95% CI [5.46e-3, 6.95e-3]** (266 of 42,870 in-population
draws), at 3-7 characters and four groups. ⚠ **The denominator is load-bearing
whenever this figure is quoted "for scale" against another rule**: the hot bin
runs a population of 0.43, so the same cell reads 3.90e-3 per trial. A
comparison that takes one rule's per-population worst shape against another's
per-trial worst shape inherits a factor of ~1.6 that nothing in either number
discloses.

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

**PEN-5828 — three clauses every rule in this family is now measured against.** The
generator that prompted them is one instance; the reporting convention is the defect worth
fixing, because every future rule in the family inherits it.

**(a) REPORT THE WORST REACHABLE SHAPE, NOT THE FAMILY AVERAGE.** A generator that varies a
structural parameter — group count, segment count, length — inside the trial loop reports an
average over a mixture whose bins are usually *not* equally reachable, and the dilution is
the number of dead bins. Measured across this family: `isGitRefName` 3.00x, 
`isKubernetesObjectName` 2.06x, `isLexicalIdentifier` 1.19x per trial. Pin the parameter and
report per shape; print the family average beside it if it helps comparison with older
figures, but the worst shape is the figure the decision rests on.

**(b) CARRY A POPULATION DENOMINATOR, AND PRINT TWO KINDS OF ZERO DIFFERENTLY.** `admitted /
trials` divides by draws the shipped detector never redacted, which cannot become `after &&
!before` at all. The honest denominator is the draws it *did* redact. And a population
denominator only half-fixes the report unless the two zeros render apart:

| | meaning | print |
|---|---|---|
| population-side | the detector never fired; the rate is 0/0 and **undefined** | `n/a` |
| admission-side | the detector fired and the conjunct refused every draw | `0` |

A report that prints `0` for both cannot distinguish *"we never looked"* from *"we looked and
it held"* — the first is the absence of evidence, the second is evidence. Both are live in
`isGitRefName`'s own grid: at ~6-character runs, three components is `n/a` (below
`HIGH_ENTROPY_MIN_LENGTH`) and five is a measured `0` (`GIT_REF_MAX_COMPONENTS` doing its
job). `scripts/residual-report.test.mjs` pins this; a mutation that collapses the bins back
to an average fails it.

**(c) EVERY PUBLISHED RESIDUAL GENERATOR IS REPRODUCIBLE FROM THE REPOSITORY ALONE, AND A
BORROWED ALPHABET OR PARAMETER NAMES ITS SOURCE IN THE COMMENT.** 9.4's *"Kubernetes suffix
alphabet"* row was the instance that forced this: the alphabet appeared nowhere in the tree,
so the one figure a reader was most likely to check was the one they could not. It is
`bcdfghjklmnpqrstvwxz2456789`, from `k8s.io/apimachinery/pkg/util/rand`, and it is now
recorded beside the figure.

⚠ **And name the rule you measured, not the name you anchored on.** A re-measurement is
sound only if the anchor reaches exactly one exemption. `pod` reaches two —
`isKubernetesObjectName` and, since PEN-5921, `isGeneratedPodName` — so anchoring there
reports their union (1.43e-2) rather than either (9.68e-3 under `instance`). The populations
are identical both ways, so nothing in the output says which you got.

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

**The Kubernetes suffix alphabet is `bcdfghjklmnpqrstvwxz2456789`** — 20 consonants and 7
digits, vowels and ambiguous glyphs removed — from `k8s.io/apimachinery/pkg/util/rand`,
which is what the apiserver draws a generated name suffix from. Recorded per 6.5(c): it
appears nowhere in this repository, so this was the one published row a reader could not
reproduce from the tree.

**PEN-5828: per shape.** Every row above is a family average over 3/4/5 groups, whose bins
are not equally reachable — the low bin is starved by the same `HIGH_ENTROPY_MIN_LENGTH`
floor that starves D10's.

| groups | population | per-trial | per-population |
|---|---|---|---|
| 3 | 0.161 | 9.93e-4 | 6.19e-3 |
| 4 | 0.793 | 8.13e-3 | 1.03e-2 |
| **5** | **0.988** | **1.99e-2** | **2.02e-2** |

150,000 trials per shape against the shipped module at `master`, 2026-11-11, anchored on
`instance`. **Worst shape 1.99e-2, 95% CI [1.92e-2, 2.06e-2]** (2988 of 150,000); 2.02e-2
[1.94e-2, 2.09e-2] per population. **Dilution 2.06x.** The mixture itself re-measures at
9.68e-3 against the 9.85e-3 published, so that figure is sound — it is the shape it averages
over that was missing. Independently measured at 2.00e-2 [1.94e-2, 2.06e-2] by a second seat
on 2026-11-07 against a different tree.

⚠ **Anchor on `instance`, not `pod`, when re-deriving this.** Since PEN-5921, `pod`
additionally reaches `isGeneratedPodName`, so a sweep anchored there reports the union of two
rules — 1.43e-2 against this rule's 9.68e-3, with identical populations either way, so
nothing in the output says which you measured. 6.5(c).

Credential-format check: 28 real formats (GitHub classic and fine-grained PATs, Slack, Stripe,
AWS id and secret, Google, Anthropic, OpenAI, Vault, GitLab, npm, Grafana, JWT, base32 TOTP
seed, Kubernetes bootstrap token, UUID, raw hex and base64 blobs), 20,000 synthesized samples
each: **0 of 560,000** newly exonerated.

For scale, the name-anchored CamelCase exemption this file already accepts carries 2.33e-1
(6.5), and `isLexicalIdentifier` carries 2.91e-3 to 3.57e-3 *name-free*. This rule sits
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

For scale: `isLexicalIdentifier` carries 2.91e-3 to 3.57e-3 **name-free** today, and the
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

## 11. PEN-6152 (D9) — a descriptive snake_case label value under `error_code`

Filed by Devops (run `5acd1ebe`, 2026-11-08) out of PEN-6095, by following the refusal text's
own instruction: binding name and value shape reported, value not pasted. Measured and
decided by the Security Engineer the same day, run `d44a56c7`. Source read first-hand at
`packages/adapter-utils/src/github-egress-scrub.ts`; every figure below was computed in the
deciding run against the build being changed, not quoted from an earlier one.

> The spacing convention at the top of this file applies here too. Several pairs below are
> the exact material the SHIPPED rule refuses, so written contiguously this section would
> make the document unpushable until D9 deploys.

### 11.1 What PEN-6152 asked

A `git push` to `Blockcast/onprem-k8s` was refused on a PromQL label matcher in a runbook:
`error_code` `=` the Paperclip error code for a Kubernetes concurrency-guard timeout. The row
asked for a decision on whether `isLexicalIdentifier`'s `longSegments > 1` conjunct should be
relaxed — specifically whether it should be keyed on *equal-length* segments, which is what
the generated-fixed-layout-key rationale describes — or whether label-matcher context should
exonerate.

The filing is accurate on every measured fact and on the single failing conjunct. One
attribution in it is off by one clause and is worth correcting, because it is the clause the
proposed remedy was derived from: the fixed-layout rationale (`xxxxxx-xxxxxx-xxxxxx-xxxxxx`,
equal-length segments) belongs to the **uniform-length check at the end of
`isLexicalIdentifier`**, not to `longSegments`. `LEXICAL_LONG_SEGMENT_LENGTH`'s own comment
states the real rationale, and it is an entropy bound: *"two random 16-letter words joined by
a hyphen (~150 bits) passed."*

### 11.2 Verdict

| # | | |
|---|---|---|
| D9a | Relax `longSegments > 1` in `isLexicalIdentifier` | **REFUSED on measurement.** See 11.3. |
| D9b | Key that conjunct on equal-length segments instead | **REFUSED on measurement.** It blocks one column of six. See 11.3. |
| D9c | Exonerate the shape under the `error_code` NAME anchor | **APPROVED**, residual measured and recorded below. |

D9c is D3 applied unchanged: widen under a name anchor, never under a name-free rule.

### 11.3 Why the name-free relaxation is refused, measured

`longSegments > 1` is the only conjunct standing between the refused value and exoneration.
Relaxing it to `> 2` was built from the source under change and measured through the whole
door, 20,000 random values per shape, under a bare three-letter binding name:

| shape, two segments joined by one separator | shipped | `longSegments > 2` | equal-length keying |
|---|---|---|---|
| mixed-case letters, 11+13 | 0 / 20000 | **20000 / 20000** | **20000 / 20000** |
| mixed-case letters, 12+14 | 0 / 20000 | **20000 / 20000** | **20000 / 20000** |
| mixed-case letters, 14+16 | 0 / 20000 | **20000 / 20000** | **20000 / 20000** |
| mixed-case letters, 16+14 | 0 / 20000 | **20000 / 20000** | **20000 / 20000** |
| mixed-case letters, 15+15 | 0 / 20000 | **20000 / 20000** | 0 / 20000 |
| base62, 11+13 | 0 / 20000 | 281 / 20000 | 281 / 20000 |
| base62, 14+16 | 0 / 20000 | 104 / 20000 | 104 / 20000 |

A 24-to-30-character random mixed-case token carries about 137 bits. Both variants exonerate
it outright, under **every** binding name in the fleet — the 22-23%-leaky CamelCase shape D1
already declined, at 100%. Keying on equal length does not rescue the idea: it blocks the
uniform column and nothing else, because two random words of *different* lengths are the
common case, not the exception.

Two observations that are not obvious from reading the clause, and that a future reader
narrowing this file will need:

- **`longSegments` is load-bearing only above `HIGH_ENTROPY_MIN_LENGTH`.** A two-word value
  shorter than 24 characters never reaches the entropy test at all, which is why the 11+11
  row is exonerated in all three columns and is not evidence about any of them.
- **`longSegments` no longer bounds exonerated entropy; `LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH`
  does.** The 150-bit example in its comment predates that cap. What the conjunct still does,
  and the measurement above is the proof, is bound the SHAPE: it refuses the two-opaque-word
  layout at the lengths that reach the test. Do not read the comment's rationale as retired —
  read it as superseded in its mechanism and intact in its effect.
- **A digit-free snake_case value is not refused by this rule, or by any rule here.** It draws
  one character class and returns at `classIndex`, well before `isLexicalIdentifier`. The
  refused class is specifically snake_case **carrying a digit**, which in this fleet means the
  subsystem prefix (`k8s`, `orc8r`, `ipv6`) that error codes are built from.

### 11.4 The shape D9c admits, and what each conjunct holds

Under the exact name `error_code` only, a value is exonerated when it is the union of:

- whatever `JOB_NAME_RE` already admits — written as a literal disjunct, so non-regression
  against the `job` shape is a property of the code and needs no corpus; or
- lowercase snake_case, at least two segments, **every** segment either plain
  (`LEXICAL_SEGMENT_RE`) or one of the bounded mixed forms (`MIXED_LEXICAL_SEGMENT_RE`),
  no segment over `LEXICAL_SEGMENT_MAX_LENGTH`, and the whole value no longer than
  `ERROR_CODE_MAX_CONTENT_LENGTH` (48).

That second arm is `isLexicalIdentifier`'s own segment grammar with **one** of its two
AGGREGATE caps lifted — `longSegments > 1`, the conjunct PEN-6152 exists to get past.
`LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH` is **not** lifted; it is re-imposed as
`ERROR_CODE_MAX_CONTENT_LENGTH`, sized to this population (11.4a). D3 is precisely the
finding that a name anchor is what pays for relaxing an entropy bound — it does not pay for
removing one outright. The per-segment cap is a SHAPE bound and is **kept**, so a single
opaque run cannot hide between underscores.

The surrounding `digitRunCount(value) <= ALERT_NAME_MAX_DIGIT_RUNS` gate is load-bearing here
and must not be moved: every **mixed** segment carries at least one digit run, so that cap is
what bounds how many **mixed** segments a value may hold. At most two.

### 11.4a The aggregate cap, and the measurement that required it

⛔ **An earlier revision of this section said D9c lifted BOTH aggregate caps, and described the
digit-run gate as what bounds the arm. That is corrected above, and the correction is the
substance of this subsection, not an editorial tidy.** The digit-run gate bounds only the
*mixed* segments, because only a mixed segment must carry a digit run. It says nothing about
*plain* segments — so one digit-bearing prefix could tow an unbounded number of 16-letter
plain segments.

Measured through `scrubGitHubEgressText` end to end, 200 values per width — `k8s_` followed by
N random 16-letter lowercase segments:

| N segments | length | ~bits | refused under `error_code` | under a bare name | under `job` |
|---|---|---|---|---|---|
| 1 | 20 | 75 | 0/200 | 0/200 | — |
| 2 | 37 | 150 | 0/200 | 189/200 | 188/200 |
| 3 | 54 | 226 | 0/200 | 200/200 | 200/200 |
| 4–8 | 71–139 | 301–602 | **0/200** | **200/200** | **200/200** |

The N=1 row is the internal control: at 20 characters it is below `HIGH_ENTROPY_MIN_LENGTH`
and never reaches the entropy test, so it is refused nowhere and is evidence about nothing.
From N=3 the shape is refused everywhere **except** under the anchor D9c added.

Two further notes on attribution, both measured the same way:

- The `k8s_`-prefixed shape is admitted by the **segment-grammar arm only** — `k8s` fails
  `JOB_NAME_RE` (its `[a-z]+\d{0,2}` form cannot match a letter after a digit), and the same
  values are refused 188–200/200 under `job`. So this class is one D9c introduced, and the cap
  belongs on that arm.
- A `JOB_NAME_RE`-shaped value with a digit tail (`abc12_` + N plain 16-letter segments) is
  exonerated at every width under **both** `job` and `error_code`, and refused 199–200/200
  under a bare name. That is **pre-existing** behaviour of the `job` anchor, which D9c unions
  in deliberately; the cap is placed *after* the `JOB_NAME_RE` disjunct so that non-regression
  against the `job` shape stays a property of the code. Widening that arm's bound is not in
  PEN-6152's scope — it is the `job` anchor's, adjacent to PEN-5828.

⭐ The generator worth carrying: **11.5's residual is measured over a population that cannot
contain this shape.** A random `[a-z0-9_]` token carries many digit runs, so the digit-run gate
refuses it before this rule is ever consulted; pure-lowercase-letter tokens are drawn from that
alphabet with negligible probability. The residual table is therefore sound for what it
measures and must not be read as an upper bound on what the anchor admits.

⚠ `ERROR_CODE_MAX_CONTENT_LENGTH` is 48, sized to the live population — 153 distinct error
codes in this repo: p50 21, p90 30, p99 36, longest 38
(`routine_execution_duplicate_suppressed`), most segments 6. It clears the longest by ten
characters, about one more word. Chosen on the failure **directions** rather than headroom
alone: a code that outgrows the cap is REFUSED, which is loud, arrives at the author at push
time and is fixed by widening a number here; an uncapped exoneration is SILENT and nothing
ever reports it.


### 11.5 Residual, 200,000 random `[a-z0-9_]` values per length

One token set, generated once and replayed against every arm, so the columns are paired rather
than three independent samples:

| | 24 chars | 32 chars | 40 chars |
|---|---|---|---|
| `error_code`, shipped | 882 | 14 | 1 |
| `error_code`, **D9c** | **1033** | **32** | **1** |
| `job`, either build | 956 | 28 | 1 |
| a bare name, either build | 882 | 14 | 1 |

D9c costs 1.08x / 1.14x / 1.0x against the `job` anchor on the same tokens — the band BLO-51639
already accepted for `module` (~1.1x). The bare-name column is unchanged **to the count**,
which is the whole point of the anchor: the disjunct is gated on the literal name.

A tail-widened regex form of the same idea — `[a-z]+\d{0,2}[a-z]*` per segment, the obvious
way to write it — was built and measured first and is **declined**: 2425 / 306 / 45 on the same
tokens, 2.7x / 21x / 45x the shipped residual. The segment-grammar form is not a stylistic
preference over it; it is two orders of magnitude cheaper at 40 characters.

### 11.6 Population, and what the live corpus cannot tell you

- **140** distinct error codes are emitted in `Blockcast/paperclip`. Exactly **one** is refused
  under `error_code` on the shipped build; **zero** after D9c.
- **5,410** distinct `NAME` `=` `VALUE` pairs across `Blockcast/paperclip` (`4962a9c`) and
  `Blockcast/onprem-k8s` (`0dfcd82`); **348** refused, of which **0** are lowercase snake_case.
  D9c frees **0** of them and newly refuses **0**.

That second line is the honest limit of the corpus and is recorded rather than buried: a value
whose push was REFUSED is by construction absent from the repository, so the live corpus is
structurally blind to this entire class and a clean sweep over it is evidence of nothing. The
evidence for D9c is the error-code population and the paired residual, not the corpus.

### 11.7 For the next author who hits this door

The refusal text already names the route and is unchanged by D9: identifiers are exonerated
**under the label name that binds them**. If a label matcher you cannot derive at runtime is
refused, the answer is a name-anchored exemption on a measured false positive — not a
relaxation of `isLexicalIdentifier`, which is reached under every name and is where the
measurement above says the cost is.

`error_code` is anchored. `errorCode`, `reason` and `code` are deliberately **not**, because no
false positive has been measured under them; `reason` values in the current corpus are short
enough that `isLexicalIdentifier` exonerates them already. Exact names, one at a time, each on
a measured case — the reasoning `UUID_VALUE_NAMES` records for why the obvious generalisation
is the change to decline applies here word for word.

### 11.8 Reproducing

Build the variant from the source under change in the same step as the measurement — a tagged
copy of an earlier build gives a fluent and wrong answer — and pair the arms on one token set.
Every number in 11.3 and 11.5 came from `scrubGitHubEgressText` end to end, never from calling
an internal predicate directly, and the generators were checked against a known refusal and a
known exoneration before any count was believed: a value bound to a name shorter than three
characters is not captured by `ASSIGNMENT_RE` at all, and an unchecked harness reports that
silence as a clean result for every shape.

## 12. PEN-5734 (D10) — `--force-with-lease=<ref>:<oid>`, and the door that rewrote instead of refusing

Date: 2026-11-06
Reviewer: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Filed by: CTO, measured first-hand against `Blockcast/penstock-llm-proxy-core#3055`.

> The `=` spacing convention at the top of this file applies here too, and in this section it
> is doubly load-bearing: until D10 deploys, the shipped scrubber redacts the very command
> this section is about, so a contiguous `--force-with-lease=<ref>:<oid>` anywhere below
> would make this document unpushable through the door it describes.

PEN-5734 is two findings. The second is a routine name anchor of the kind §9 and §10 record.
The first is not, and it is the one that matters.

### 12.1 Finding 1 — the `gh` door rewrote an artifact and reported success

Every prior row in this family is about a door **refusing**: PEN-3920, PEN-4637, PEN-5406 and
PEN-3907 all describe a push or a write that failed closed. A refusal is a usability gap in a
working control — you are told, nothing lands, you fix it.

This was not that. `gh pr edit --body-file` **succeeded, exited 0, and printed nothing on
stdout or stderr**, while the text GitHub then served back had the author's content replaced
in place by a redaction marker. Nothing in the tool result, the exit code, or the output
distinguished it from a clean write. The author found out by reading the artifact back.

An agent that trusts its own success publishes a corrupted instruction and reports the step
done. That is strictly worse than refusal, and worse specifically on a **write** path, where
the corrupted text becomes the artifact other agents and humans then execute.

The cause was a one-line omission with a wide blast radius: `scrubGitHubCliInvocation` already
returned `redacted` and `classes`, and `prepareGitHubCliInvocation` **discarded both**. The
same runtime's refusal path (BLO-33171 content fields) builds a detailed, line-attributed
message; the rewrite path built nothing. The MCP door, by contrast, has notified since
PEN-3152 (`paperclip-github-mcp-egress: redacted outbound frame (<classes>)`). So this was
also a **door-parity defect on reporting** — the `gh` door was the only one of the three that
could alter an outbound payload without saying so.

#### Decision: ANNOUNCE, do not refuse. The defect was the silence, not the rewrite.

The three doors now divide deliberately, and the asymmetry has to be argued rather than
assumed:

| door | disposition | why |
|---|---|---|
| `git` push (PEN-3156) | **refuse** | carries bytes that get committed |
| `gh`/MCP repository-content fields (BLO-33171) | **refuse** | same — a rewrite survives into the repository and reads on review as an intentional change (#1542 landed with 9 `sk-` fixtures eaten) |
| `gh`/MCP **prose** (PEN-2527) | **rewrite, and announce** | removing the material and publishing the rest IS the containment PEN-2527 was built to perform |

Refusing prose instead was considered and declined. It would mean an agent that accidentally
pastes a token cannot post its review at all, and the body is then retyped by hand around a
control nobody can see — trading a silent corruption for a silent workaround.

**The exit code stays the child's**, and this is the part worth stating explicitly because
PEN-5734's acceptance criterion offered a non-zero exit as an alternative. It is the wrong
one here. The notice is emitted *before* `gh` is spawned, so the author sees it whether the
call then succeeds or fails; but failing the invocation *after* a successful publish would be
a lie in the other direction — the artifact exists, and a caller that retries on non-zero
posts it twice. A refusal must prevent the write, not annotate it.

The notice names the field, the originating file, the classes, and the **1-based line within
the value**, reusing `locateGitHubEgressMatches` and the exact format the refusal path
already emits, so the two cannot drift and the fleet's existing parsing keeps working. The
excerpt is the **scrubbed** line: echoing the raw match would send the material into agent
stderr and from there into run logs — PEN-2526's shape, reached from inside the control built
to prevent it. `prepareGitHubCliInvocation` additionally returns the `rewrites` array, so an
embedding caller can act on it without parsing stderr.

Brokered deployments are covered without further work: the broker forwards child stderr over
its socket and the client writes it to `process.stderr`, and the broker re-enters this same
runtime, which is what keeps door parity true (PEN-4933).

### 12.2 Finding 2 — the anchor, and why this value needed one

[PEN-4869](https://paperclip.blockcast.net/PEN/issues/PEN-4869) made the `git` egress wrapper
**refuse a bare `--force-with-lease`** and accept only the pinned `<ref>:<expected-oid>` form,
because a bare lease reads its expected OID from `refs/remotes/origin/<branch>` and any
intervening `git fetch` makes it pass vacuously. So two shipped controls disagreed about one
string: the git door **required** it, and the egress scrub **redacted** it.

The consequence is sharper than an ordinary false positive. The mandated form could not be
**written down** through any `gh` surface — PR body, PR comment, issue text. Documenting the
correct command corrupted it into a non-command, and PEN-5055 (remediation texts that still
print the *bare* form) could not be fixed, because the replacement text was unpublishable.
"Derive it at runtime" — this file's standing advice on a false positive — is unavailable by
construction: the whole point of a pinned lease is that the expected OID is a literal written
down ahead of time.

**Mechanically**, `ASSIGNMENT_RE` captures a name from `[A-Za-z0-9_]`, so the `-` terminates
it and the captured name is bare `lease`; `:` is outside the value alphabet, so the captured
value is the **ref half alone**. The ref was redacted and the `:<oid>` left dangling.

#### The anchor is the literal flag, not the captured name

Exonerating the captured name `lease` would also reach `lease=`, `--lease=` and `my_lease=`,
none of which any control mandates. `isForceWithLeaseBinding` therefore re-reads the bytes
immediately before the match and requires `--force-with-` there. A test pins `--lease`,
`--force-lease`, `--with-lease` and `-force-with-lease` as still refused, so the
generalisation cannot land silently — the same discipline §9's `UUID_VALUE_NAMES` note
demands ("⛔ Do NOT generalise this to a `/Id$/` pattern").

#### Two halves, two independent bounds — never the composite as a whole

This is §10's BLO-45350 / BLO-45605 lesson applied *before* the fact. There, two runs of a
composite were bounded and the third exonerated an arbitrary token in the gap. Here the value
is a git ref and a git object name joined by `:`, and each half is bounded on its own:

- **ref half** — `isGitRefName`, which spends **zero opaque budget**: every run between `/`,
  `-`, `_` and `.` must be a word, a number, or a bounded word-with-digits (`isPosixPathRun`,
  reused from §10). Plus a letters-only **word mass** floor and a component cap; see 12.3.
- **expectation half** — `LEASE_EXPECTED_OID_RE`, lowercase hex of 7 to 64 characters: git's
  own minimum unambiguous abbreviation through a sha256 OID.

An opaque left half is still refused by the entropy test it falls through to; an opaque right
half is now refused by a rule that did not previously exist.

#### The right half was a hole, and closing it is a tightening

Stated plainly because it inverts the usual direction of these sections. Because `:` ends
`ASSIGNMENT_RE`'s capture, **everything after the colon was never offered to any detector**.
Measured on the shipped scrubber: a lease naming a 32-character base64url token as its
expectation published that token **byte-exact**, while redacting the harmless public branch
name beside it. This binding scrubbed the public half and passed the opaque one.

D10 closes that. Across the residual harness's 164 families at 200,000 trials each the change
**newly refuses** 7,073,445 values — essentially all of them in the expectation slot — and
newly admits **none** there: every expectation-slot family measures 0 newly admitted.

### 12.3 Residual, measured

`scripts/measure-force-with-lease-residual.mjs`, 200,000 trials per family. "Newly admitted"
is the fraction the shipped detector refuses that the patched one passes — the number §6.5
requires. The shipped detector is reconstructed by denying the anchor its name
(`--force-with-leaseX=`), which exercises every other detector identically and cannot drift
from a vendored copy.

> **A baseline trap, recorded because the first version of this harness fell into it** — it is
> PEN-4425's measurement trap in different clothes. The ref held constant while the
> *expectation* half was under test was a realistic branch, which is precisely a value the
> shipped detector redacts. Every expectation family therefore measured a baseline already
> failing for an unrelated reason, and the **ref** exemption alone moved the composite from
> refused to passed — reporting `1.00e+0` "newly admitted" for families where the expectation
> rule had not fired at all. The constant is now `main`: four characters, below
> `ASSIGNMENT_RE`'s three-character name floor and its 16-character value floor, so it is
> clean under both detectors and contributes to neither verdict.

Every flat token family — base64url, base62, base36, base32, hex upper and lower, mixed-case
letters, alphanumeric, at 24 / 32 / 43 / 64 characters — and the UUID v4 layout measure **0**,
in the ref slot, the expectation slot, and both at once. So do 24 real credential formats,
each measured bare and under a branch-like `release/` prefix, with one exception noted below.
The families that are not zero are the only construction that can reach a word-only rule — a
random token chopped into short runs:

The knee analysis below was taken at 20,000 trials per family (enough to rank the
configurations); the shipped row was then re-measured at the full 200,000.

| conjunct state | worst newly-admitted family | rate | real branches published |
|---|---|---|---|
| no word-mass floor, 6 components | `lower-alnum` chopped by `/` into ~4-char runs | 8.50e-3 | 518 of 847 |
| floor 10, 4 components | `base36` chopped by `-` into ~6-char runs | 7.25e-3 | 518 of 847 |
| **floor 14, 4 components (shipped)** | `letters-mixed` chopped by `/` into ~6-char runs | **2.33e-3** | **511 of 847** |
| floor 16, 4 components | `letters-mixed` chopped by `/` into ~6-char runs | 2.30e-3 | 502 of 847 |

The knee is at 14: a 3x reduction for seven real branches out of 518, and 16 buys nothing
further on residual while costing nine more.

### 12.3a Per shape, and the alphabet the grid was blind to (PEN-5828)

Every figure in 12.3 is a **family average**, and the generator drew its component count at
random inside the trial loop. The bins are not equally reachable, and they are unreachable
for two **different** reasons, one at each end — so neither correction in 6.5 is sufficient
alone. At `letters-mixed` chopped by `/` into ~6-character runs:

| components | population | per-trial | mechanism |
|---|---|---|---|
| 3 | **0.000** | `n/a` | 17-23 characters, below `HIGH_ENTROPY_MIN_LENGTH`; the detector never fires, so word mass is never consulted |
| **4** | 0.988 | **6.88e-3** | the hot shape |
| 5 | 1.000 | **0** | refused by `GIT_REF_MAX_COMPONENTS` — a measured zero, a conjunct doing its job |

Two of three bins contribute exactly zero, so the published 2.33e-3 is the hot bin divided by
three: **dilution 3.000x, exact rather than approximate.**

**Worst shape 6.88e-3, 95% CI [6.65e-3, 7.11e-3]** — pooled 3439 of 500,000 trials over five
independent runs across three seats (671 / 681 / 709 / 716 / 662 per 100,000; widest pairwise
gap 1.46σ, so all five agree). 6.96e-3 against the population denominator; the population
correction moves this cell by 1.2% because it already runs at 0.988, which is why **binning,
not the denominator, is the whole 3x here**. Nothing newly **refused** anywhere: 0 across
every cell of the grid.

**The `-` arm is population-bounded by a constant outside `isGitRefName`**, which is why its
dead bins are at the opposite end. `-` is not a ref component separator, so the component cap
never fires on it; instead `isOpaqueSecretValue` bails on `isLexicalIdentifier`, which splits
on `[-._]` and exonerates any value whose segments sum to at most
`LEXICAL_IDENTIFIER_MAX_CONTENT_LENGTH` (30). So a `-`-joined draw is in population iff its
summed run length exceeds 30, and a `/`-joined one iff its total length reaches 24 — closed
form, and it predicts the measured populations to three decimals. ⚠ The emptiness is **not**
uniform across the arm: six of nine `-` bins are dead for `letters-mixed`, but only three of
nine for the lowercase alphabets, whose digits stop their segments being plain. A blanket
"the `-` arm is population-bounded" note in the driver would be false for two thirds of those
cells, so the report prints it per bin instead.

**And the grid was blind to its own hot region.** Two of its three chopped alphabets were
byte-identical — `base36` and `lower-alnum` were both lowercase+digits — so it sampled two
letter densities, not three: 72% and 100%. The residual peaks **between** them, because the
hot alphabet is the one with enough digits to escape `isLexicalIdentifier`'s exoneration (and
so stay in population) and enough letters to clear the word-mass floor:

| alphabet | letters | worst family | worst shape |
|---|---|---|---|
| `base36` `a-z0-9` | 72% | 1.67e-3 | 5.00e-3 |
| `upper-alnum` `A-Z0-9` | 72% | 1.78e-3 | 5.35e-3 |
| `letters-mixed` `a-zA-Z` | 100% | 2.31e-3 | 6.93e-3 |
| **`base32` `A-Z234567`** | **81%** | **1.66e-2** | **4.40e-2** |

40,000 trials per shape. `upper-alnum` tracking `base36` is the control: it is the same letter
density in the other case, and it lands in the same place, so the driver is **density, not
case**. Replacing the duplicate slot with base32 therefore does not merely de-duplicate the
grid — it moves the worst shape by **6.3x**.

⚠ **This is reachable by a real credential, and still only by deliberate construction.** An
RFC 4648 base32 TOTP seed — the alphabet is exactly `A-Z2-7` — measures **0 of 50,000** in its
native flat form, and **4.33e-2** when sliced across `/` into four runs, matching the
synthetic cell (4.30e-2) to within noise. So the threat-model verdict in 12.4 is unchanged: a
flat credential of any alphabet is refused, and reaching 4.4e-2 means setting out to, which
section 4 and PEN-3183 put outside this control. What changes is the **number**, and the
comparison built on it.

**The knee, per shape.** Re-measured with the component count pinned, 20,000 trials per shape,
worst over the whole grid:

| `GIT_REF_MIN_WORD_MASS` | three published alphabets: family / shape | with `base32`: family / shape |
|---|---|---|
| 10 | 6.83e-3 / 2.05e-2 | 3.95e-2 / 1.13e-1 |
| **14 (shipped)** | **2.20e-3 / 6.60e-3** | **1.66e-2 / 4.40e-2** |
| 16 | 1.87e-3 / 5.60e-3 | 1.29e-2 / 3.81e-2 |
| 18 | — | 7.28e-3 / 2.13e-2 |
| 20 | — | 3.43e-3 / 8.05e-3 |

**THE CONSTANT IS UNCHANGED.** On the three published alphabets the knee analysis holds and
is *stronger* per shape than the family figures implied — 14 buys a 3.1x reduction over 10
(2.05e-2 → 6.60e-3) rather than ~2.7x, and 16 still buys only 1.18x more. The 12.3 statement
that a floor of 10 "carries 7.25e-3" is a family average whose worst shape is **2.05e-2**, so
the rejected option sat at the Kubernetes rule's *own* worst shape (2.02e-2) rather than
safely inside a diluted 9.85e-3. **Dilution flattered the rejected alternative as well as the
choice.**

⛔ **What is NOT decided here.** With `base32` in the grid the residual no longer flattens at
16: 14→16 buys 1.15x, 16→18 buys 1.79x, 18→20 buys 2.64x. So the knee argument that selected
14 does not obviously survive the wider grid, and a floor of 18 would return the worst shape
to roughly the Kubernetes precedent. **This row changes no constant and takes no position on
that**, for one concrete reason: the other half of the trade is the corpus cost — 14 publishes
511 real branches of 847 and 16 publishes 502 — and **the corpus cost at 18 and 20 is
unmeasured.** A residual table alone cannot settle a floor. Tracked as the follow-up to
PEN-5828.

### 12.3b The comparison, like-for-like

12.3's closing "for scale" sentence is withdrawn above. Worst shape against worst shape, on
the **population** denominator, which is the one 6.5(b) makes the honest default:

| rule | worst shape, per population | anchor |
|---|---|---|
| `isLexicalIdentifier` | 6.21e-3 [5.46e-3, 6.95e-3] | none — name-free |
| **`isGitRefName` (D10)**, three published alphabets | **6.96e-3** | one literal flag |
| `isKubernetesObjectName` | 2.02e-2 [1.94e-2, 2.09e-2] | eight common label names |
| `isGitRefName` (D10), with `base32` | 4.49e-2 | one literal flag |

On the three published alphabets, D10 is **within measurement error of
`isLexicalIdentifier`** and **~2.9x below** the name-anchored Kubernetes rule — 65% headroom,
not the ~30% a diluted 9.85e-3 implies. With `base32` it is ~2.2x **above** the Kubernetes
rule, which is the open question in 12.3a.

⛔ **No ordering against `isLexicalIdentifier` may be written in either direction, and no
ratio.** This is not a sample-size limit that more trials would lift. The two operands sit on
very different population fractions — 0.99 here against 0.43 there — so **the comparison
inverts with the denominator**: 1.12x on the population denominator, 1.76x per trial. An
ordering becomes available only once both operands are restated on one denominator at one
evidential standard; absent that the stronger claim is not available at any price, and
"within measurement error" is the whole claim. ⚠ Do **not** rest it on "the confidence
intervals overlap" either: that is true today and is not robust, because pooling the
`isLexicalIdentifier` operand and correcting the instrument push the overlap in opposite
directions. The Kubernetes half **is** ordering-safe — no plausible correction closes a 2.9x
gap — so exactly one of the two comparisons may be stated as an ordering, which is a
different "exactly one" from 12.3's *"one comparison breaks, not both"*.

At the full 200,000 trials the shipped configuration measures **2.33e-3** worst, over 164
families. The chopped-token families span 7.5e-5 to 2.33e-3; a `release/`-prefixed Kubernetes
bootstrap token sits at 1.80e-3; every flat token family, every other real credential format,
and every expectation-slot family measure 0.

> ⛔ **The "for scale" sentence that closed this paragraph is WITHDRAWN (PEN-5828)**, re-quoted
> one marked line per line so a `grep` arrival meets the retraction rather than the claim:
>
> WITHDRAWN 2026-11-11: "For scale, `isLexicalIdentifier` carries 2.96e-3 to 3.57e-3"
> WITHDRAWN 2026-11-11: "**name-free** today and §9's Kubernetes rule up to 9.85e-3 under an"
> WITHDRAWN 2026-11-11: "anchor of eight common label names; D10's 2.33e-3 sits below both,"
> WITHDRAWN 2026-11-11: "under an anchor of one literal flag."
>
> It compares a family average against two family averages, and all three are diluted
> mixtures. The like-for-like replacement is in 12.3a below.

**The corpus.** 1192 distinct branch names from `Blockcast/paperclip`'s history. **847 of them
are refused inside a lease by the shipped detector** — 71% — which is the scale of the false
positive this row reports; D10 publishes 511. The component cap sits exactly on the corpus
maximum (263 one-component, 914 two, 3 three, 12 four) with no headroom, and it is a real
bound rather than hygiene: `/` is the separator the chopped-token families use, and capping it
is what takes `lower-alnum chopped by '/'` out of the top of the table.

**The word-mass floor is the conjunct that holds the rule**, exactly as
`K8S_NAME_MIN_WORD_MASS` holds §9's. It is also the only conjunct here that keeps real
credential **formats** out, because none musters fourteen characters of letter runs:
`sk-ant-api03-…` has 5, `xoxb-…` 4, `sk_live_…` 6, and a Kubernetes bootstrap token's
`<6>.<16>` has none unless both halves happen to draw no digit — which is exactly the 1.80e-3
row above, and the honest reading of it is that a bootstrap token whose two halves are
*all letters*, written with a branch-like prefix, is admitted at that rate.

### 12.4 What it admits, stated plainly

A **deliberately constructed** value — a secret chopped into short case-homogeneous
word-shaped runs and spelled as a branch name — is admitted, up to the word mass
`POSIX_PATH_MAX_CONTENT_LENGTH` allows. No encoder emits that; producing it means setting out
to, which §4 and PEN-3183 put outside this control's threat model.

On the expectation half the residual is the one `GIT_OBJECT_NAME_VALUE_NAMES` already states
and accepts (§ PEN-5406), reached under one more binding name: a legacy GitHub personal access
token is exactly 40 lowercase hex with no prefix, and `VENDOR_KEY_RE` does not see one. What
makes it acceptable is the **name half alone** — nothing but a git object name is plausibly
written after `--force-with-lease=<ref>:` — and it must never be widened into a shape-only
rule.

### 12.5 Downstream

- **PEN-5055** can now proceed. Its remediation texts print the *bare* `--force-with-lease`
  that the PEN-4869 guard refuses; the pinned replacement is publishable once D10 deploys, and
  was not before.
- The **variable workaround** in `penstock-llm-proxy-core#3055`'s body keeps working and needs
  no edit. It is worth recording that it is more fragile than it looks: it survives because
  the variable is named `BR`, two characters, below `ASSIGNMENT_RE`'s three-character name
  floor. `BRANCH=<the same string>` is redacted, before D10 and after it. The row's conclusion
  — that the binding name discriminates — is right; that particular evidence had a second
  cause. A test pins both halves so the distinction cannot be lost.
## 13. PEN-6163 (D11) — an alert name asserted by a lockstep guard test

Measured 2026-11-08 against the shipped detector
(`github-egress-scrub.js`, `sha256:8af54ecc6d3a71961507526d6546fdf84474b0f819f624dd0f4ac560f5288841`).
Filed from a refused push of `Blockcast/onprem-k8s#8395`.

### 13.1 The false positive

`ALERT_NAME_RE` exonerates an UpperCamelCase alert name, but only under
`CAMEL_CASE_VALUE_NAMES`, which was `{alertname, kind}`. Under any other binding name the
identical value is `high-entropy-assignment`. Same value, both rows:

| line | verdict |
|---|---|
| `alertname="<AlertName>"` | exempt |
| `kind="<AlertName>"` | exempt |
| the assertion kwarg `want_in_output`, bound to the same `<AlertName>` | **refused** |

The `onprem-k8s` lockstep guard tests assert that a guard script prints a given alert name,
so the alert name is a literal the test has to spell out. `scripts/check-arc-manifests.sh`
makes a lockstep test close to mandatory for a new alert, so the family grows with the
alert set. Three such test files exist today.

### 13.2 Verdict: anchor the one exact name

`want_in_output` joins `CAMEL_CASE_VALUE_NAMES`. The shape anchor (`ALERT_NAME_RE`, and the
D4 digit-run bound) is unchanged. This is the same trade BLO-47509 made for `kind` and
PEN-5406 made for `companyId`: one exact name, on a measured false positive.

### 13.3 ⚠️ Where this differs from the two precedents, stated rather than smoothed over

`alertname` and `kind` are **typed** bindings — the name itself constrains what the value may
legitimately be, so name and shape agree and §4's name anchor is doing real work on its own.
`want_in_output` is **untyped**: it means only *"whatever this test expects to find in some
output"*, and puts no constraint of its own on the value. So under this name the **shape**
anchor carries the whole trade.

That is acceptable because the shape anchor is the half that was measured, and it is
unchanged — but it should not be recorded as parity with the two precedents, and a future
name that is *both* untyped *and* shape-free must be refused on these grounds.

§4 still holds and was re-read before this was taken: an accidental leak does not choose its
binding name. For material to reach this exemption it must land under one enumerated name
**and** take the UpperCamelCase shape; accident arranges neither.

### 13.4 Residual, 200,000 random values per cell

Measured through the shipped rule at 24 / 32 / 40 characters:

| alphabet | 24 | 32 | 40 |
|---|---|---|---|
| letters-only, mixed case | 2.28e-1 | 2.22e-1 | 2.14e-1 |
| base62 | 1.80e-2 | 6.37e-3 | 2.14e-3 |
| base64url | 7.32e-3 | 1.92e-3 | 5.05e-4 |
| lowercase hex | 0 | 0 | 0 (0 of 600k) |

The base62 column reproduces the `1.81e-2` D4 already records, which is the cross-check that
this is the same measurement rather than a new one; the letters-only column reproduces §3's
23%. The letters-only row is the adversarial worst case and is the honest number to quote
*against* this exemption — it is also the alphabet in which no key, token or digest is
issued. The alphabets an accidental paste actually arrives in are the lower three, and hex —
the shape of every digest and most generated secrets here — is exonerated at zero.

### 13.5 ⛔ Refused: a `want_*` prefix or a `*_SELECTOR` suffix

This is the `/Id$/` cleanup declined for `UUID_VALUE_NAMES`, in the same shape. A pattern
would exonerate `want_token`, `want_secret`, `want_password`, `API_KEY_SELECTOR` and
`CREDENTIAL_SELECTOR`, where an UpperCamelCase value may genuinely be the credential. Exact
names, one at a time, each on a measured false positive. A test pins those six as still
refused so the generalisation cannot land silently; a mutation control confirms all six red
under exactly that widening, and that the five shape pins stay green.

### 13.6 Blast radius, and what this does *not* settle

At `onprem-k8s` `fa88a4f` the three lockstep test files carry **81** `want_in_output=` lines
and **0** of them are refused by the shipped door — the longest value asserted today is
snake_case and exempt by a different route. (Positive control: planting the refused line into
the same corpus yields exactly 1 refusal, so the zero is a real zero.) The hazard is therefore
**prospective**, not an outstanding breakage: the cost of *not* taking D11 is a refused push the
next time a guard test asserts an UpperCamelCase alert name, not an ongoing tax.

⛔ **D11 does not discharge PEN-6162's precondition.** PEN-6162 (the unspaced-`=` gap) would, if
its spaced arm ever landed, newly refuse a measured 325 lines in `Blockcast/paperclip`, whose
largest classes are 72 lowerCamelCase metadata-key constants and 41 `this.name = "SomeError"`
assignments. `ALERT_NAME_RE` reaches **neither** — they fail the *shape* half, not just the
name half — so widening `CAMEL_CASE_VALUE_NAMES` cannot cover them. Those remain separate
exemption decisions, each needing its own measurement, and they still gate any spaced arm.
## 14. PEN-6187 (D12) — a gbrain source id under `source`, and a namespace literal as the second anchor

Added 2026-11-08 by the DevOps Engineer, on a refusal hit while shipping PEN-6149
(`Blockcast/onprem-k8s#8443`). Same method as sections 9 and 10: read-only against the
shipped bundle (`/opt/paperclip-bundled-adapters/...`) through the exported
`scrubGitHubEgressText` / `locateGitHubEgressMatches`, patched copy of the same bundle for
the delta. Convention of section 2 applies — no `name = value` pair below is written
contiguously, and per PEN-4428 no refused value is pasted at all.

| # | Decision |
|---|---|
| D12 | **ANCHOR `source` to a gbrain source-id shape**, whose load-bearing conjunct is a LITERAL NAMESPACE SEGMENT rather than word mass. One name, one measured false positive. |
| D12a | **DECLINED: exonerate identifiers inside a Prometheus label matcher `{key="value"}`**, which is what the row proposed. It is name-FREE, so section 4 refuses it — and it is the widest possible rule in this file, not a narrow one. |
| D12b | **DECLINED: adding `source` to `K8S_OBJECT_NAME_VALUE_NAMES`.** Measured: it fixes nothing. The value is refused under `pod` and `name` today. |
| D12c | **Refused, unchanged:** `K8S_NAME_MIN_WORD_MASS` (PEN-5921), `isLexicalIdentifier`'s caps, `HIGH_ENTROPY_MIN_BITS_PER_CHAR`, door parity, and any allowlist, env override or bypass. |

### 14.1 What was refused

One value, under one binding name: a gbrain source id in a `source = …` label matcher
inside a `- series:` key of a promtool unit-test fixture
(`monitoring/gbrain-code-index-freshness/prometheus-rule_test.yml`). A promtool fixture has
to spell the label value out, so "derive it at runtime" is unavailable — the gap PEN-4428
removed from the refusal text, reported through the route that text now names.

The shape, stated as the refusal asks for it: 32 characters; lowercase letters, digits and
hyphens; longest digit run 6; laid out as a `gstack` namespace segment, a strategy word, a
four-letter repo slug, and two trailing hex runs of 8 and 6.

Scored against the shipped predicates, it fails on exactly one conjunct:

| conjunct | value | bound |
|---|---|---|
| DNS-1123 subdomain, length, label count | ok | — |
| generated segments | 2 | `K8S_NAME_MAX_GENERATED_SEGMENTS` = 2 |
| longest generated segment | 8 | `K8S_NAME_MAX_GENERATED_LENGTH` = 10 |
| generated mass | 14 | `K8S_NAME_MAX_GENERATED_MASS` = 16 |
| **word mass** | **14** | **`K8S_NAME_MIN_WORD_MASS` = 16** |

Two characters, on the one conjunct section 9.3 calls "the whole rule".

### 14.2 Why the two obvious fixes are both wrong

**D12b — anchoring `source` to the existing Kubernetes shape fixes nothing, and this was
measured rather than reasoned.** The value is refused *today* under `pod` and under `name`,
which are already anchored. A patch that only extends `K8S_OBJECT_NAME_VALUE_NAMES` would
ship, pass review, redeploy, and leave the fixture exactly as unpushable as before. This is
worth recording because it is the change a reader of section 9 reaches for first.

**Lowering the word-mass floor is the other knob, and PEN-5921 already refused it** — it is
name-free in effect, reaching all eight anchored names, and costs a 5.8x residual on
precisely the hyphenated alphabets real API keys take. Nothing here re-opens it.

So the price has to be paid in a conjunct the general rule does not have.

### 14.3 D12a — why the row's own suggestion is declined

PEN-6187 proposed exonerating identifiers that appear inside a Prometheus label matcher,
and described that as "more narrowly and probably better" than anchoring the name. It is
neither. The author of that suggestion is the author of this section, so it is recorded
plainly rather than dropped.

A label matcher is a SYNTACTIC CONTEXT, not a name. `{token="…"}`, `{password="…"}` and
`{api_key="…"}` are all label matchers. The proposed rule therefore exonerates every
binding name that exists or ever will, inside a context an agent writes routinely and can
type at will — which is section 4's name-free case at its weakest, with no shape conjunct
at all to carry it. It would be the widest exemption in this file by a wide margin, and the
fact that it *reads* narrow — "only inside a matcher" — is exactly what makes it dangerous
to leave unanswered in the row.

The half of the suggestion that is correct is the observation it rests on: a matcher
literal cannot be derived at runtime. That is true, it is why this class keeps recurring,
and section 9.1 and PEN-4428 already record it. It is an argument for anchoring the names
this class binds, one measured false positive at a time. It is not an argument for keying
on the context.

### 14.4 The shape, and the conjunct that carries it

Every structural conjunct the general Kubernetes rule applies — DNS-1123 subdomain within
`K8S_NAME_MAX_LENGTH` and `K8S_NAME_MAX_LABELS`, at most `K8S_NAME_MAX_GENERATED_SEGMENTS`
generated segments, each at most `K8S_NAME_MAX_GENERATED_LENGTH`, summing to at most
`K8S_NAME_MAX_GENERATED_MASS` — with the word-mass floor of 16 replaced by three conjuncts
of its own:

- the FIRST segment is the literal namespace `gstack`;
- the SECOND segment is a bare lowercase word (the sync strategy);
- every generated segment is lowercase hex;
- word mass reaches 10 — the namespace (6) plus a four-letter strategy word.

**The namespace literal is the whole rule, and it is a STRONGER anchor than a name.**
Section 4 accepts a name anchor because an accidental leak does not choose its binding
name: the name comes from whatever code interpolated the value. Here that argument runs
twice. For material to reach this exemption it must land under the name `source` AND wear a
seven-character literal prefix as its own first hyphen-separated segment. Accident arranges
neither, and it certainly does not arrange both.

The hex conjunct is free on the live corpus — 3 of 3 legacy ids conform — and it is what
keeps a base36 or base62 payload from riding in behind the namespace. Same trade, and the
same "free on the corpus" justification, as `K8S_GENERATED_SEGMENT_RE` in section 9.

**The opaque-mass ceiling is NOT raised.** Worst case is still
`K8S_NAME_MAX_GENERATED_MASS` characters, now over 16 symbols rather than 36: ~64 bits,
BELOW the ~83 the general rule admits at word mass 16 (9.5), below the ~71 PEN-5921's pod
layout admits, and far below the ~141 `isLexicalIdentifier` exonerates under EVERY name in
the fleet. What D12 lowers is the word-mass PRICE, from 16 to 10, for one namespace, under
one binding name.

### 14.5 Residual

Fraction NEWLY exonerated under the anchored name `source`, shipped bundle vs. patched
bundle, through the WHOLE pipeline. Varying-length segment generators per the measurement
trap in 6.3.

| family | n | newly exonerated |
|---|---|---|
| base62 @24, base62 @32, base64url @24, base64url @43, base32 @32, lowercase hex @32, lowercase hex @40, mixed-case letters @24, UUID v4 layout | 200,000 each | **0** each |
| base36, 4-6 varying groups of 2-8, `-` | 200,000 | **0** |
| base36, 3-5 varying groups of 3-7, `-` | 200,000 | **0** |
| base36, 2-4 varying groups of 4-10, `-` | 200,000 | **0** |
| base36, 3-4 varying groups of 3-9, `.` | 200,000 | **0** |
| Kubernetes suffix alphabet, 3-5 varying groups of 3-9, `-` | 200,000 | **0** |

Credential-format check, same method as 9.4: 28 real formats (GitHub classic / fine-grained
/ App installation, Slack, Stripe, AWS id and secret, Google, Anthropic, OpenAI, Vault,
GitLab, npm, Grafana, JWT, base32 TOTP seed, Kubernetes bootstrap token, UUID, raw hex and
base64 and base36 blobs, legacy 40-hex PAT, Paperclip service key, docker registry auth,
litellm master key, Harbor robot secret, a database password), 20,000 synthesized samples
each: **0 of 560,000** newly exonerated.

**3,560,000 samples, 0 newly exonerated**, for the structural reason stated in 11.4: no
random token wears the namespace segment.

⚠️ Two honest notes on that table, because a wall of zeros is the reading most likely to be
taken at face value.

**(a) The zeros are not a clean sweep unless the instrument can report a non-zero, so the
known positive was measured in the SAME invocation**: the live 36-source gbrain corpus,
under `source`, goes from **3 refused** on the shipped bundle to **0 refused** on the
patched one. Those three are the entire false-positive class; the other 33 ids are
single-character-class (`<slug>-cluster`) values that never reached the entropy test at all
and are NOT freed by this rule — pinned by a test so a later widening cannot claim credit
for them.

**(b) One row of the table is degenerate and is kept rather than quietly dropped.** The
"lowercase words" family refuses 0 of 200,000 on the SHIPPED bundle too — a single-character-class
value never reaches the entropy rule — so its zero in the delta column measures nothing. It is
listed so the next reader does not re-derive it as evidence.

### 14.6 Every cap is a cap, measured

Each bound was measured with its segments FORCED to be generated — at least one letter and
at least one digit each — because a uniformly-random base36 run is all-letters about 4% of
the time, which reclassifies the segment as a word and brings the value back inside the caps.
Without that forcing the sampler produces apparent leakage of 10-12% through conjuncts that
are in fact exact. This is the same family of measurement trap 6.3 records for fixed-length
segment generators, reached from the other direction.

Newly exonerated, 20,000 samples each, under `source`: an 11-character run **0**; a generated
mass of 18 **0**; a third generated segment **0**; a non-hex (base36) payload **0**; a missing
namespace segment **0**; a second segment that is not a word **0**; word mass 8 **0**; and the
whole shape bound to `pod` **0** or to `token` **0**.

### 14.7 What it admits, stated plainly

A value DELIBERATELY built as `gstack-<word>-<10 hex>-<6 hex>` is exonerated BY
CONSTRUCTION — 20,000 of 20,000 measured. The namespace literal buys nothing against an
author who chooses to type it.

That is the price, and it is accepted on the same ground as 9.5 and PEN-5921: this file
guards ACCIDENTAL disclosure (section 4, PEN-3183), deliberate bypass is out of scope and
needs no exemption in this file at all, and the opaque mass admitted is strictly below what
two already-shipped rules admit — one of them name-free, under every binding name.

### 14.8 Corpus and scope

36 registered gbrain sources, read live. 3 refused today, all three the pre-`-cluster`
legacy layout; 0 after D12. No other binding name is touched: `source_id` and
`paperclip_dedupe_domain` — which carries the same value in the same fixture — stay refused
until one of them is measured too, and tests pin that, in the manner the `networkID` note
asks for. The `gstack` namespace is not admitted under any other name.

### 14.9 Downstream

PEN-6149's fixture currently uses a synthetic id and does not need changing; what that test
case pins is the shape, not the row. Once this lands and the bundle redeploys, the fixture
*may* go back to the legacy id, which is marginally more faithful. It is optional, and it
should not be done on the strength of this document alone — section 8's rule applies: the
door still refuses until the shipped bundle carries the change.
