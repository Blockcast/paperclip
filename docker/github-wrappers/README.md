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

## The duplicate copies, and when they go

The `seed` initContainer still writes its own copies, and the chart still keeps
`<mountPath>/.local/bin` and `<mountPath>/bin` on PATH **behind** this directory.
That is a deliberate rollout fallback: an agent pod on a pre-PEN-3713 image has
no root-owned copy, and removing the PVC install in the same change would drop
it straight through to the unscrubbed `/usr/bin/gh`. With both present, a new
image wins outright and an old one still resolves something that scrubs, so
neither rollout order has a window.

While both exist they are two copies of one rule, so
`deploy/helm/paperclip/tests/agent-egress-path.test.mjs` compares them and fails
on drift. Deleting the seed block, dropping the PVC entries from PATH, and
removing the stale files from the volume is the PEN-3713 follow-up, gated on the
fleet being on images that carry this directory.

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
