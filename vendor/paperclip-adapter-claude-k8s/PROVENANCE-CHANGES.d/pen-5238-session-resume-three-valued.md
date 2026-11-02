# PEN-5238 — `sessionResume` on the foreign-claim warn reports a refusal that did not happen

Changes to `src/server/job-manifest.ts` and `src/server/job-manifest.per-agent-claim.test.ts`.

`claude_k8s.data_claim_foreign` publishes `sessionResume`, added by PEN-5234 to close PEN-5189's
recorded residual — that the invariant-7 resume refusal had no observable except the absence of a
flag in the Job spec. The field was written two-valued:

```ts
sessionResume: claudeResumeSessionId ? "resumed" : "refused_foreign_claim",
```

over a fact that is three-valued. A run that requested **no session at all** — a cold wake — took
the `refused_foreign_claim` arm, reporting a refusal that never occurred because nothing was ever
requested. The comment directly above the line states the opposite contract in terms ("so that if
that gate is ever changed this line reports *what happened* instead of what used to"), so the
source already carried the standard it did not meet.

This is the failure mode the warn exists to remove, turned on itself. An operator reading
`refused_foreign_claim` goes looking for the session the run lost; on a cold wake there is nothing
to find, and the time is spent before that becomes clear. A diagnostic that is confidently wrong
is worse than one that is absent — the same class of silent-wrongness the PEN-4932 invariant
series exists to eliminate.

## The arms

`resolveResumableClaudeSessionId` returns `""` for "nothing requested", for "the claim is foreign",
and for its model-mismatch and transcript-existence checks alike, so the cases cannot be
distinguished from its *result*. They are distinguished by the **request** instead:

- **`resumed`** — unreachable on this line today, and emitted anyway. This block is
  `narrowWritableSurface && !serverCanPreCreate`, and `serverCanPreCreate` is
  `narrowWritableSurface && serverHoldsDataClaim`, so reaching it means the claim is foreign and
  the resolver has already returned `""`. Kept so the field reports what happened rather than a
  constant, and so it goes wrong loudly if the PEN-5189 gate is ever moved into the pod.
- **`refused_foreign_claim`** — a session *was* requested and the claim gate is what took it. That
  `return ""` sits above both the model-mismatch and the transcript-existence checks, so on this
  line no other cause can be the one that refused.
- **`none_requested`** — nothing was asked for, so nothing was refused. A cold wake, not a loss.

The predicate reads `runtimeSessionId.trim()`, mirroring the resolver's own admission:
`asString` does not trim while `resolveResumableClaudeSessionId` does, so an untrimmed check would
report a refusal for a whitespace-only session id that the resolver treats as absent — the same
confidently-wrong diagnostic one layer down.

## Scope of the behaviour change

The value's meaning narrows: `refused_foreign_claim` now means "a resume was requested and
refused" rather than "no resume happened". Nothing consumes it. Verified 2026-11-02 across the
emitting repo and the alerting repo — the only occurrences of the literal anywhere are the
emitting line, the PEN-4932 plan document and the PEN-5234 provenance entry; `execute.ts`
references the *event* only in a comment; neither
`Blockcast/onprem-k8s` `paperclip/paperclip-runtime-alerts-prometheusrule.yaml` nor
`monitoring/prometheus-rules-2-configmap.yaml` (the two lockstep files Prometheus actually loads,
5087 and 8517 lines, 70 and 73 `Paperclip*` alerts between them) mentions the field or the event,
and no series in Prometheus carries a `sessionResume` label. The field is a structured log field
on a warn that cannot fire in production today in any case, since every agent still resolves
`dataClaimName` to the server's own PVC.

## Tests

Five cases in `job-manifest.per-agent-claim.test.ts`, all on a real resumable transcript written
to disk so that `refused_foreign_claim` is attributable to the claim rather than to a missing
file: the `none_requested` arm, the `refused_foreign_claim` arm, the whitespace-only request, the
unreachability of `resumed`, and a control confirming the warn is silent on the server's own claim
where the same fixture genuinely resumes. Mutation-checked — reverting to the original two-valued
expression fails 2, dropping the `.trim()` fails 1, swapping the two non-resumed arms fails 3.
