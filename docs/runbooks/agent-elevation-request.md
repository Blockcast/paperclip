# Agent-requested admin elevation (BLO-30652 chain)

Status: authoritative for how a Paperclip agent obtains a write to a protected
Secret, and how operators grant a time-boxed elevation. Source of truth for the
k8s side is `Blockcast/onprem-k8s` `security/bc-elevation/source-of-truth.md`
(revised 2026-08-31, BLO-30652). **No Paperclip code participates in this
chain** — there is no `ElevationGrant` reference anywhere in `server/src`.

> **Read this first.** The elevation chain is live and works — **for human OIDC
> identities only.** A Paperclip agent **cannot** obtain an elevation grant for
> its own ServiceAccount, and no amount of approval will make one work. This is
> a structural property of the controller, verified from source, not a
> misconfiguration. See [Why an agent cannot elevate its own
> ServiceAccount](#why-an-agent-cannot-elevate-its-own-serviceaccount) before
> filing any request. If you are an agent that needs a protected-Secret write,
> go straight to [What an agent should do
> instead](#what-an-agent-should-do-instead).

## The chain

1. **magma tenants `ApprovalsService`** (`approvals` table) is the only source
   of truth. `RecordAdminElevationApproval(subject_ref, reason)` writes one row
   with `approval_kind='admin_elevation'`, `subject_kind='oidc_user'`. The
   approver identity is the caller's mTLS `mb_<uuid>` cert, never the request
   body. A subject is **active** only when two rows with distinct
   `approver_mb_uuid` are unconsumed and unexpired.
2. **bc-elevation-controller** (`replicas: 1`, `--enable-reconcile`, image
   `v0.4.0`) polls magma over mTLS and mints an `ElevationGrant` CR
   (`spec.subjectUserId`, `elevatedGroups`, `reason`, `requestedBy`,
   `approvedBy`, `approvalIds`, `grantedAt`, `expiresAt`). It deletes or
   shortens the grant when quorum drops.
3. **ConfigMap `bc-elevation/bc-active-elevations`**: the controller writes
   `data.subjects`, a comma-separated list of Kubernetes usernames.
   **The list is built from each grant's `SubjectEmail`, prefixed with
   `ELEVATION_USERNAME_PREFIX` (`"oidc:"` in this cluster).** It is *not* built
   from `spec.subjectUserId`. Grants whose `SubjectEmail` is empty are skipped
   entirely.
4. **ValidatingAdmissionPolicy `bc-protected-secret-write`** reads that
   ConfigMap as a parameter and admits a protected-Secret write only when
   `variables.elevatedSubjects != '' && request.userInfo.username in
   variables.elevatedSubjects.split(',')`.

Expiry is deliberately **not** checked in the policy — VAP CEL has no clock.
Presence in `subjects` *is* the liveness signal; the controller removes the
subject when the grant lapses. If the controller dies, the list freezes
(staleness alert: BLO-30654).

## Why an agent cannot elevate its own ServiceAccount

A Kubernetes ServiceAccount's `request.userInfo.username` is literally
`system:serviceaccount:<namespace>:<sa-name>`, minted by the apiserver's
ServiceAccount authenticator. It carries **no** `oidc:` prefix — that prefix
comes from the OIDC authenticator's `claimMappings.username.prefix`, which
applies only to Dex/Entra human logins.

The controller applies the prefix unconditionally:

```go
// internal/reconcile/reconcile.go:170-184
// subjectsFor maps grants to the Kubernetes usernames admission will compare
// against. Grants with no SubjectEmail are skipped: SubjectUserID is a magma
// subject_ref, not a k8s identity, and guessing a mapping from it would be a
// silent authorization bug in the dangerous direction.
func (r *Reconciler) subjectsFor(grants map[string]ElevationGrant) []string {
	out := make([]string, 0, len(grants))
	for _, g := range grants {
		if g.SubjectEmail == "" {
			continue
		}
		out = append(out, r.UsernamePrefix+g.SubjectEmail)
	}
	sort.Strings(out)
	return dedupe(out)
}
```

So for any subject the controller can publish, the string that lands in
`subjects` is `"oidc:" + SubjectEmail`. There are only two ways an agent's SA
username could appear, and neither is available:

- Set `SubjectEmail` to `system:serviceaccount:paperclip:<sa>`. The published
  entry becomes `oidc:system:serviceaccount:paperclip:<sa>`, which can never
  equal the SA's actual username. **No match.**
- Set `ELEVATION_USERNAME_PREFIX` to `""`. That would break every human grant
  in the cluster simultaneously, because human usernames genuinely carry the
  `oidc:` prefix.

This is intended behaviour, not a bug to route around. The controller's own
comment states the reason: mapping a magma `subject_ref` to a k8s identity by
guesswork "would be a silent authorization bug in the dangerous direction."

**The failure mode is silent, which is why this section exists.** The
deployment manifest warns: *"A wrong prefix does not error — it silently
matches nobody, which looks exactly like 'no one is elevated'."* An agent that
requested elevation for its SA would spend two human approvals, receive a
grant, and still get `403` on the write — indistinguishable from "quorum not
active yet." Do not enter that loop.

## What an agent should do instead

The `bc-protected-secret-write` policy states the supported automated path in
its own denial message:

> "For an automated writer, add an exact-scoped clause to this policy — the
> pattern it already uses five times — via a PR to onprem-k8s. For a one-off
> human write, obtain an elevation grant (two distinct approvers …)."

So:

1. **Check whether you already have access.** Some Paperclip subjects are
   already permitted by the policy. `system:serviceaccount:paperclip:paperclip`
   is in the broad allowlist; `paperclip-ci-deploy`, `figma-designer-bot`,
   `webflow-designer-bot`, and `github-app-token-rotator` have exact-scoped
   clauses. Confirm which SA will actually perform the write before asking for
   anything — an elevation request for an already-permitted subject is pure
   waste.
2. **For a recurring automated write:** open a PR to `Blockcast/onprem-k8s`
   adding an exact-scoped disjunct to `bc-protected-secret-write` — pin the
   SA username, the namespace, the operation set, the object name, and the
   Secret type. Follow the five existing clauses. Scope it as narrowly as the
   write genuinely needs; a bare username entry authorizes writing *any*
   protected Secret in *every* covered namespace.
3. **For a genuine one-off:** ask a human operator to perform the write under
   their own elevation grant, using the request template below. The human is
   the subject; you are the requester. Post the outcome on the issue.

Never widen your own RBAC, and never propose making grants readable to agents,
to work around any of this.

## Agent procedure: ask, do not poll

1. Post a `request_board_approval` whose body is the template below, filled in.
   Include `idempotencyKey` at the top level (sibling of `type` and `payload`),
   derived from the ask — e.g. `elevation:BLO-<n>` — so a retried or resumed run
   replays the original card instead of stacking a duplicate on a queue humans
   drain by hand. Check `paperclipListApprovals` with `view=summary` first.
2. Add the approval as a first-class blocker and keep the issue `in_progress`.
   **Do not poll for the grant.** Both Paperclip MCP ServiceAccounts, and the
   read-only MCP tier, are forbidden from listing `elevationgrants.bcast.id` by
   design.
3. When the operator reports the write is done, verify the observable effect
   (the thing the Secret feeds), not the grant.
4. Comment the result and the UTC timestamp on the originating issue.

### The card must carry a branch and a default, or it will not clear

This ask is the shape the board measures as *least* likely to be approved: the
action after the decision is performed by a **human**, who has to leave
Paperclip to run `break_glass_cli` and then `kubectl`. Standing CEO policy is
that every board card must carry an explicit branch satisfiable entirely inside
Paperclip, and must state what happens on silence. A branchless card is worse
than no card — it is a work item with no owner.

So, before you file:

- **Prefer step 2 of the previous section.** The exact-scoped VAP clause is a PR
  you open yourself. It needs no card at all, and it is the path the policy's own
  denial message names. Only fall through to elevation for a genuine one-off.
- **File once the precondition already holds.** A card is judged against the
  state at decision time, not execution time — same-day cards are read in
  minutes — so "approve this after X lands" is refused as premature. Never write
  a self-rejecting branch ("if X has not happened, reject this"): the refusal
  carries no information and burns the `idempotencyKey`.
- **One ask per card.** Do not bundle the elevation with an unrelated in-channel
  decision. The card is refused as a unit, so the decidable half dies with the
  branchless half.
- **Add both clauses to the payload**, adapted:

  > *Branch:* if you judge the exact-scoped VAP clause sufficient instead, say
  > so and I will open that PR and close this request — no elevation needed.
  >
  > *Default on silence:* absent a reply by `<ISO date>`, I record the write as
  > not performed, leave BLO-`<n>` in `todo` with a `re-check not before` note,
  > and take no further action on this card.

- **Read the outcome carefully.** On `approved`/`rejected` an empty
  `decisionNote` is a known platform defect, not a signal — look for the
  reasoning in `paperclipListApprovalComments` and on the issue. Only on
  `revision_requested` does the note persist.

## Request template

Copy verbatim, replace every `<...>`. **The subject must be a human operator's
OIDC identity — the email they log into Dex/Entra with — not a ServiceAccount.**

```text
Elevation request (admin_elevation, <=1h)

Subject (human OIDC identity): <operator-email@blockcast.net>
  -> lands in bc-active-elevations as "oidc:<operator-email@blockcast.net>"
Target: <namespace>/<secret-name> (<one-line what changes>)
Issue: BLO-<n>
Reason: <one sentence; this text is stored in magma and audited>
Window needed: <minutes, max 60>

Approvers (two distinct operators, each with their own mb_<uuid> cert,
neither of them the subject):

  break_glass_cli grant --kind admin_elevation \
    --subject <operator-email@blockcast.net> \
    --reason "BLO-<n>: <same reason>" \
    --addr tenants.controller.magma.local:9079 \
    --cert-file <your operator mb_<uuid> cert> \
    --key-file <your operator key> \
    --ca-file <ca bundle>

  Second call prints `active_distinct_approvers: 2` and `active: true`.
  Same-approver repeat returns AlreadyExists; that is expected and does not
  count toward quorum.

The named operator performs the write, then posts the result here.
```

## Approver procedure

1. Confirm the subject and target match the issue. Refuse if the reason is
   generic, or if the subject is a ServiceAccount (see above — such a grant
   cannot take effect and the resulting `403` will be misread as "not yet").
2. First approver runs the `grant` command from the request. Expected output
   starts `✓ approval granted` with `active_distinct_approvers: 1` and
   `active: false`.
3. Second approver runs the same command with **their own** `mb_<uuid>` cert.
   Expected `active_distinct_approvers: 2`, `active: true`.
4. Optional check:
   `break_glass_cli list --kind admin_elevation --subject <subject> --addr ... --cert-file ... --key-file ... --ca-file ...`
   shows two active rows with distinct `approver_mb_uuid`.
5. Confirm the subject now appears in the ConfigMap, prefixed:
   `kubectl -n bc-elevation get configmap bc-active-elevations -o jsonpath='{.data.subjects}'`
6. Perform the write, then resolve the `request_board_approval` with the grant
   timestamps and the write result.

## Expiry

`ElevationGrant.spec.expiresAt` is the minimum `expires_at` among the two quorum
rows. The **controller** enforces the ≤1h maximum at admission; the CRD schema
itself does not cap the duration (its only validations are distinct approvers,
no self-approval, and `expiresAt > grantedAt`). Both approvals must be active at
the same time, so coordinate the two `grant` calls closely. When either row
expires or is consumed, the controller removes the subject from
`bc-active-elevations` on its next reconcile and the policy denies again.

There is no renewal path. A new window is a new request.

`status.phase` is **observational only** — a grant showing `Expired` there
remains live until `spec.expiresAt`. Revoke by deleting the object or shortening
`spec.expiresAt`; never rely on `phase`.

## Observability limitation

Agents cannot observe grant state, and this is correct privilege separation.
Listing `elevationgrants.bcast.id` is forbidden to the Paperclip MCP
ServiceAccounts; the read-only MCP tier additionally redacts container `args` on
the controller Deployment, so even its configuration is not agent-visible. An
agent learns nothing about a grant except through the approval thread.

Treat a denied write as "not authorized", go back to the approval thread, and
**never widen RBAC to make grants visible to agents.**

## Superseded recommendation

The 2026-09-04 gap analysis recommended "Edit 2: a TokenReview read-extension"
in Paperclip — having the TokenReview webhook read `ElevationGrant` objects and
add a group to the caller. **That recommendation is withdrawn.** It was
superseded on 2026-08-31 (BLO-30652) for two structural reasons:

1. The apiserver authenticates with `--authentication-config` JWT
   authenticators only. A token webhook never sees Dex JWTs, so it cannot
   annotate the identity the policy sees.
2. Enforcement moved to the authorization plane. The VAP reads
   `bc-active-elevations` `subjects`; it does not consult groups minted by any
   webhook. `spec.elevatedGroups` is vestigial — nothing reads it.

Nothing in `server/src` needs an `ElevationGrant` reference. Do not reopen that
work item.

**Caveat for the next reader:** several live artifacts still describe the
superseded design, and reading them alone will lead you back to the wrong
answer. The `elevationgrants.bcast.id` CRD schema descriptions still say
`elevatedGroups` are "injected verbatim by the webhook", that `subjectUserId` is
what "the webhook matches", and that "the read path (webhook) keys off
`now < spec.expiresAt`". `source-of-truth.md:115` likewise still calls
`spec.subjectUserId` the key "matching the TokenReview identity key used by the
webhook". The live enforcement path is the ConfigMap + VAP described above.
Correcting those descriptions is tracked in the issue linked from the
Verification log.

## Tracked elsewhere (not part of this runbook)

- `Blockcast/onprem-k8s#3060`: kyverno `bc-elevation-image-policy` to
  ImageValidatingPolicy (open).
- `bc-elevation-token-refresher` is `suspend: true`.
- Audit-sink cutover: the magma producer must emit request, first-approval, and
  second-approval events before the sink is authoritative.
- `Blockcast/onprem-k8s#3074` is a review-gate `actions: read` permissions fix.
  It is unrelated to this chain; do not cite it as the elevation bridge.

## Verification log

Every fact above, with the command or file that proves it. Cluster reads are
from the read-only Paperclip MCP tier; repository reads are pinned to the paths
shown.

### 1. Source of truth is magma `ApprovalsService`, two distinct human approvers

`Blockcast/magma` `orc8r/cloud/go/services/tenants/protos/approvals.proto:71-77`:

```proto
message RecordAdminElevationApprovalRequest {
  // subject_ref is the OIDC user subject being approved for a
  // time-boxed admin elevation grant. It is stored with
  // subject_kind='oidc_user'.
  string subject_ref = 1;
```

`Blockcast/onprem-k8s` `security/bc-elevation/source-of-truth.md:108-110`:

```
For each `subject_ref`, the controller groups active rows and requires at least
two distinct `approver_mb_uuid` values. Duplicate active rows from the same
approver count once.
```

### 2. `admin_elevation` subjects are `oidc_user`, never system principals

```
$ grep -rn "ListSystemPrincipals" approvals.proto
$ echo $?
1
```

Zero matches: **no system-principal list RPC exists.** `system_principal` is the
*break-glass* subject kind (`approvals.proto:38` — "subject_ref is the
SystemPrincipal sp_uuid"), and `approvals.proto:112` documents the enum as
`subject_kind: 'system_principal' | 'oidc_user'`.

**Do not file "Register Paperclip agent SAs as magma system principals."** It is
a category error: `admin_elevation` never uses `system_principal`, and an
`sp_<uuid>` registration would not put anything into `bc-active-elevations`.
This supersedes the precondition as originally worded in BLO-32243.

### 3. `subject_ref` has no format validation

`orc8r/cloud/go/services/tenants/servicers/protected/approvals_servicer.go:220-223`:

```go
	subjectRef := strings.TrimSpace(req.GetSubjectRef())
	if subjectRef == "" {
		return nil, status.Error(codes.InvalidArgument, "subject_ref is required")
	}
```

Only an empty check. magma will therefore **accept** a ServiceAccount username
and store it — which is exactly why the downstream failure in §5 is silent.

### 4. The k8s side is live

Controller (`kubectl -n bc-elevation get deploy bc-elevation-controller`):

```
NAME                      READY   UP-TO-DATE   AVAILABLE   AGE
bc-elevation-controller   1/1     1            1           80d
image: ghcr.io/blockcast/bc-elevation-controller:v0.4.0@sha256:333f0530aa5f...
```

`--enable-reconcile` is not readable from the cluster (the read-only MCP tier
redacts container `args`), so it is verified from the deployed manifest instead:
`Blockcast/onprem-k8s` `security/bc-elevation/deploy/deployment.yaml:68-71`:

```yaml
          args:
            - --enable-reconcile
            - --source=magma-approvals
```

ConfigMap (`kubectl -n bc-elevation get cm bc-active-elevations -o yaml`), read
2026-09-07:

```yaml
data:
  subjects: ""
labels:
  bcast.id/tracking-ticket: BLO-30652
```

VAP `bc-protected-secret-write` (`generation: 17`, `paramKind: v1/ConfigMap`),
first disjunct:

```cel
(
  variables.elevatedSubjects != '' &&
  request.userInfo.username in variables.elevatedSubjects.split(',')
)
```

with `variables.elevatedSubjects` =
`params == null ? '' : params.?data.orValue({}).?subjects.orValue('')`.

### 5. Precondition RESOLVED — the projection is not verbatim, and the agent path cannot work

BLO-32243 asked whether `spec.subjectUserId` reaches `subjects` verbatim. **It
never reaches it at all.** `Blockcast/bc-elevation-controller`
`internal/reconcile/reconcile.go:170-184` builds the list from `SubjectEmail`
with the prefix applied unconditionally, and skips grants with no
`SubjectEmail` (source quoted in full above).

Deployed prefix — `security/bc-elevation/deploy/deployment.yaml:60-67`:

```yaml
            # Compared against request.userInfo.username VERBATIM by
            # bc-protected-secret-write, so this must equal the apiserver
            # authenticator's claimMappings.username.prefix ... A wrong prefix
            # does not error — it silently matches nobody, which looks exactly
            # like "no one is elevated".
            - name: ELEVATION_USERNAME_PREFIX
              value: "oidc:"
```

Confirmed as intended behaviour by the controller's own tests
(`internal/reconcile/param_test.go`):

- `TestParamPublishesElevatedSubjectWithAuthenticatorPrefix` — `want :=
  "oidc:alice@blockcast.net"`
- `TestParamOmitsGrantWithNoSubjectEmail` — "published %v for a grant with no
  SubjectEmail; want empty"
- `TestParamConcurrentGrantsForSameHumanCollapseToOneEntry`

Because a ServiceAccount's `request.userInfo.username` carries no `oidc:`
prefix, no publishable grant can ever match one. Status: **resolved, negative
result.** Follow-up filed — see §7.

### 6. Agents cannot read grants (correct privilege separation)

Live attempt from the read-only MCP tier, 2026-09-07:

```
$ kubectl get elevationgrants.bcast.id -A
Error from server (Forbidden): elevationgrants.bcast.id is forbidden:
User "system:serviceaccount:paperclip:paperclip-k8s-mcp-readonly" cannot list
resource "elevationgrants" in API group "bcast.id" at the cluster scope
```

This is a third Paperclip ServiceAccount confirmed forbidden, alongside
`bc-sa-paperclip` and `paperclip-k8s-mcp-ns-rw`. Working around it is
prohibited.

### 7. Follow-up issue

The negative result in §5 and the stale artifact descriptions noted in
"Superseded recommendation" are tracked in **BLO-32633**
(`https://paperclip.blockcast.net/BLO/issues/BLO-32633`), filed as a child of
BLO-32243.
