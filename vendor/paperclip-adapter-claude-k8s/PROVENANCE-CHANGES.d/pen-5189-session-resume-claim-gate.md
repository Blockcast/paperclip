# PEN-5189 — gate the session-resume predicate on the data claim (PEN-4932 invariant 7)

Changes to `src/server/job-manifest.ts` and `src/server/job-manifest.per-agent-claim.test.ts`.

`resolveResumableClaudeSessionId` decided whether to resume a Claude session by stat-ing the
transcript. The `existsSync` runs in the **server** process; the path it stats is a **pod**
address — the call site passes `${isolation.sessionRoot}/.claude`, and `isolation.sessionRoot` is
rooted at `resolveDataMountPath(config)`, the pod's mount. The transcript is written by
claude-code in the pod. Those are the same bytes only while the two mounts are the same *volume*,
which is exactly `serverHoldsJobDataClaim`. Nothing gated it on that.

Pod-written, server-read — the same direction as invariant 5, a different artifact, covered by
neither it nor invariants 1/6.

## The failure is a false POSITIVE, which is what makes it dangerous

The opt-in migrates nothing, so an opted-in agent's existing transcripts stay at the
byte-identical path on the **server's** volume (measured 2026-11-01 on one agent: 72 files,
105 MB), and `encodeClaudeCwd(workingDir)` does not change across the swap — the cwd is derived
from the project path, not the claim. So after an opt-in the server keeps answering "resume" for a
transcript the pod cannot open.

That one boolean suppresses **four** separate things, every one justified in source by "it is
already in the session" — the premise that is false the moment the pod cannot read the transcript:
the `--resume` target, the bootstrap prompt, the whole main prompt template
(`shouldUseResumeDeltaPrompt` collapses it to the wake delta alone), and
`--append-system-prompt-file`. The pod gets a delta-only prompt, no bootstrap, no instructions,
and a `--resume` pointing at nothing.

It compounds invariant 6 (PEN-5183), which empties the instructions *directory*; this withheld the
instructions *file* as well, so a resumed wake of an opted-in agent had neither.

**It would have scored a PASS.** The Job still succeeds and still emits complete parseable stdout,
so PEN-5120's done-when 1 — "a complete, parseable stdout for the run" — is satisfied by a run
that had no prompt, no bootstrap and no instructions. That is why this is closed before the
operator flip rather than after.

## ⛔ Not fixed by an address translation

The obvious-looking fix is a `toServerAddress`-style prefix swap, mirroring what `serverRootDir`
does for the prompt bundle (`prompt-cache.ts`). That is sound **there** because one volume is
reachable from both processes at two roots. Here the pod's volume is not reachable from the server
at *any* path — the problem is a different **volume**, not a different root — so a translation
would turn a wrong answer into a confidently wrong one. Same reasoning as PEN-4932 §2's refusal of
a shared read-only tooling claim and PEN-5120's refusal of `run-logs` as a server `subPath`.

Refusing to resume costs an opted-in agent its session continuity, which is strictly better than
silently withholding all four. Moving the existence check into the pod is the eventual shape, and
the four suppressions have to move with it or be re-derived there.

## The derivation is MOVED, not copied

`resolveAgentWorkspaceClaimName` / `resolveDataClaimName` / `serverHoldsJobDataClaim` are hoisted
above the prompt block, because the predicate now needs the answer ~200 lines before the volume
block that used to compute it. A second copy would be free to drift from the one the mount
actually uses — and this predicate deciding "resume" off a different claim than the Pod mounts is
precisely the class of bug invariant 7 *is*.

## Inert today, asserted by a negative control

Every agent currently resolves `dataClaimName` to the server's own PVC, so the new branch is not
taken fleet-wide and resume behaviour is unchanged. That is a test, not a claim: the control and
the opted-in case are the **same fixture with the same transcript on disk**, differing only in the
claim. The opted-in case additionally asserts the file the predicate stats is still present — so
the test states something about the *volume* rather than about a missing file, which is the whole
distinction an `existsSync` cannot make. Four tests: the control resumes; the opted-in run does
not; all four suppressed things are delivered (including that the wake delta is still there — the
fix adds the template back, it does not swap one for the other); and the bootstrap survives.
