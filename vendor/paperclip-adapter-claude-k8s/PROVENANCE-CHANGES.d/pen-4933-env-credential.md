# PEN-4933 — the broker moved the mount, not the credential

PR: [#3089](https://github.com/Blockcast/paperclip/pull/3089)

Supersedes nothing; it closes a gap in
[pen-4933.md](./pen-4933.md) (#3080), which is left as the record of what that
PR did.

## Files

- `src/server/job-manifest.ts`
- `src/server/job-manifest.github-publish-broker.test.ts`

## What changed

`buildJobManifest` now **refuses to render** the publish broker when the agent
container would still carry a GitHub push credential in its *environment*. A
new `findAgentGitHubCredentialEnvNames` reads the container's `env` list for
`GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` or
`GH_SEAT_TOKEN_VALUE`; any hit throws, in the same fail-closed shape as the
broad-data-mount refusal #3080 added.

A `valueFrom` entry counts exactly as much as a literal one. Routing a value
through a `secretKeyRef` changes where the Job stores it, not whether the
process can read it out of its own environment.

The four names are kept deliberately in step with `INHERITED_ENV_NAMES` in
`github-publish-broker.ts` — the same set the broker hands to its own children
as "the credential". A name the broker treats as a credential is a name the
agent container must not carry.

## Why

#3080 moved the credential **Secret volume** out of the agent container and
asserted the boundary against mount paths. That is not the whole credential
surface. `GH_SEAT_TOKEN_VALUE` is a supported, volume-free delivery route
(BLO-18927) that exists precisely so a token can be bound to one agent without
mounting it fleet-wide, and `translateGithubSeatTokenForExecutionTarget`
(`server/src/services/heartbeat.ts`) expands it into `GH_TOKEN`/`GITHUB_TOKEN`
in `adapterConfig.env`, which lands on the agent container.

With one of those present the boundary was **absent while every mount-based
assertion passed** — the failure direction that looks fine. `Dockerfile.runtime`
writes `credential.https://github.com.helper = !/usr/bin/gh auth git-credential`
into `/etc/gitconfig`, which every git in the pod loads, and
`scripts/gh-token-wrapper.sh` answers that from `GH_SEAT_TOKEN_VALUE` in its
first branch, before any broker consideration. So a bare `/usr/bin/git push`
still authenticated, with no mount to read, no intent, and no knowledge of
where the credential lives — PEN-3183 §4.0, the control's own threat.

## Why it throws rather than strips

Stripping the variables would leave a seat-bound agent with no credential
anywhere: the broker's env is filtered to the two variables its own token
wrapper reads, so it would not inherit the seat token either, and every publish
would fail at a boundary that reported success.

Routing the seat token *into* the broker is the fix that preserves the
function — but it mounts a credential into a new container, which is PEN-3183
§7.2 trigger 3: a Security decision under §8, not one this builder takes on its
own. So it refuses, names both ways out in the error, and leaves the fleet on
the mounted-Secret path where the boundary does hold.

## Scope, stated because the defect was a check that overclaimed

This reads the container's `env` **list only**. It cannot cover `envFrom`: a
`secretRef` there injects every key of the referenced Secret, and those keys
live in the Secret rather than the PodSpec, so no manifest-time check can
enumerate them. `selfPod.inheritedEnvFrom` is filtered by
`isAgentInheritableEnvFromRef` (`k8s-client.ts`) by NAME rather than by key, so
a GitHub credential placed in an inheritable `envFrom` source would reach the
agent container past this refusal.

That is a real residual, recorded in §7.3 of
`docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md`. Do not
read a green render as "no credential in this container".
