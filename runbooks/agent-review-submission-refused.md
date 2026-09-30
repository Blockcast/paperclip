# Agent review submission refused (`paperclip-github-egress`)

An agent tried to post a GitHub pull-request review and the `gh` egress wrapper
refused it. The review **was not posted** — the GitHub CLI was never started —
and the agent's command exited **65**.

**Trigger.** A run log or agent stderr carrying:

```
paperclip-github-egress: refusing to submit PR review: <detail> [<reason>]
```

This is a deliberate fail-closed refusal, not a crash. It is emitted by
`packages/adapter-utils/src/github-review-attestation.ts`, called from the
Helm-seeded `gh` wrapper (`deploy/helm/paperclip/templates/statefulset.yaml`)
before the real CLI runs.

## Why the guard exists

A review body computed against one pull request can be submitted to a
different one. GitHub stamps a review's `commit_id` from the **target** PR at
submission time, so `commit_id` reads the target's real head and every
consumer checking `state == "APPROVED" && commit_id == head` is satisfied. The
body's `Reviewed head:` marker is the only field that travels with the review
text, so it is the only one able to disagree.

That happened once, measured: `Blockcast/mediamtx#33` received an **APPROVED**
review (`5146990033`) whose body reviewed `pim-multicast-gateway#2864`. It
fails **open** — in a repo where an Ally approval gates merge it admits
entirely unreviewed code under a green signal.

## Triage by reason

The bracketed `reason` is stable and tells you what to do.

### `unreachable-attestation`

The body attests a SHA that does not exist in the target repository, or its
existence could not be confirmed. Two very different causes — check which:

```bash
# Does the attested SHA exist anywhere else in the org?
gh api "repos/<owner>/<repo>/commits/<sha>" --jq .sha    # 422/404 = absent here
gh search commits --hash <sha> --owner <org>             # slow to index; not authoritative
```

- **Cross-repository contamination** — the SHA is the head of a PR in a
  *different* repo. This is the BLO-32844 defect. The refusal is correct and
  valuable: capture the target repo, PR number, attested SHA and the run id,
  then attach them to BLO-32844 (AC #1, the transport, is still open). Have the
  agent re-review the intended PR.
- **The commit was rewritten** — a force-push removed the attested head
  between composing and submitting. Benign, and the refusal is still correct:
  the review describes code that is no longer there. Re-review at the live
  head.
- **GitHub was unreachable** — the message reads `could not confirm` rather
  than `does not exist`. Transient; re-run the agent. If it persists, check
  GitHub status and the pod's token before anything else.

### `malformed-attestation`

The `Reviewed head:` token is not 40 hex characters. Refused locally with no
API call.

This is corrupt marker emission by the reviewer, not staleness. Measured on
`Blockcast/review-gate-action#7` (reviews `5013561307`, `5013569224`): a
42-character marker, the real SHA with two characters spliced in, both bodies
byte-identical 1m45s apart. Note the failure direction is the **opposite** of
the case above — a malformed marker can never equal any head, so the
attestation is permanently unsatisfiable and the PR could never pass the gate.
Refusing at emission is what keeps that out of the repo. Re-run the agent;
report a recurring pattern against BLO-32844.

### `ambiguous-attestation`

Several `Reviewed head:` lines outside fenced blocks. Consumers require exactly
one and treat several as none, so the review would attest nothing. Usually the
agent quoted a prior review without fencing it. Re-run; fenced quotes are
ignored by design.

### `unresolved-target`

Neither the argv nor the checkout named a target repository, so the attestation
could not be checked against anything. Have the agent pass `--repo <owner>/<name>`
explicitly.

### `unreadable-body`

The `--body-file` path could not be read. Almost always a workspace problem
(wrong cwd, cleaned temp dir), not a review problem.

### `unparsable-request-body`

Only reachable via `gh api .../pulls/{n}/reviews --input <file>`, where the file
is the whole JSON request payload rather than raw Markdown. It means the file is
not a JSON object, or its `body` member exists but is not a string, so the
review text cannot be located and its attestation cannot be checked.

A payload with **no** `body` member at all is fine and is allowed —
`{"event":"APPROVE"}` is a valid review that carries no comment and therefore
attests nothing. Have the agent emit a well-formed payload, or use
`--body-file` with Markdown.

## Do not

- **Do not disable or bypass the guard to get a review posted.** There is no
  env escape hatch on purpose. The asymmetry is the whole point: a refused
  review is recoverable by re-running, whereas an admitted false approval is
  merge-visible immediately and only a human dismissal removes it.
- **Do not hand-post the refused review body under a human seat.** You would be
  re-creating the exact defect — an attestation that does not describe the PR it
  is attached to — with a human identity attached to it.
- **Do not read a refusal as the reviewer being broken.** Every refusal so far
  has been the guard working. Diagnose the reason first.

## Verifying an already-posted review

To check reviews that predate the guard, the marker must name a commit that
exists in *that* repo:

```bash
R=<owner>/<repo>; N=<pr>
gh api "repos/$R/pulls/$N/reviews" --paginate \
  --jq '.[]|select(.user.login=="allyblockcast[bot]")|.body' \
  | grep -oE 'Reviewed head: [0-9a-f]{40}' | awk '{print $3}' | while read -r m; do
      gh api "repos/$R/commits/$m" --jq .sha >/dev/null 2>&1 \
        && echo "$m exists in $R" || echo "$m ABSENT from $R  <-- contamination"
    done
```

A prior-head marker that still resolves is normal staleness, not contamination.
The distinguishing signal is a SHA absent from the repository entirely.

## Sources

- [BLO-32844](https://paperclip.blockcast.net/BLO/issues/BLO-32844) — the
  cross-repository APPROVED review, this guard, and the still-open question of
  how the body reached the wrong PR.
- [BLO-32512](https://paperclip.blockcast.net/BLO/issues/BLO-32512) — the
  attestation grammar is intentionally duplicated between `adapter-utils`
  (ships to agent pods, must not import `server/`) and
  `server/src/services/ally-review-detection.ts`. Detection there is
  deliberately *looser* and validation *stricter* than the consumer's, which is
  what catches a malformed marker the consumer reads as simply absent.
- [BLO-31730](https://paperclip.blockcast.net/BLO/issues/BLO-31730) — earlier
  attestation-parsing defect, for contrast: a backticked marker made a real
  review invisible.
