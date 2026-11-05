# Reading the GitHub publish broker's logs during the D1 soak

**Trigger.** `enableGitHubPublishBroker` is on for some population and you need
to answer "is the broker working?" — or you are about to start a stage of the
PEN-5016 soak and need its evidence surface to exist first.

**Owning lane.** DevOps / Platform.

**Why this exists.** §5.3 of
`docs/security/PEN-5016-github-publish-broker-enablement-plan.md` makes the
saved queries a **stage-0 exit item**, and says why in one line: *"Without it
stage 1 is unfalsifiable, because a silent broker and a broker nobody asked to
publish are the same observation."* Carrier row:
[PEN-5181](https://paperclip.blockcast.net/PEN/issues/PEN-5181).

---

## The short version

```bash
node scripts/github-publish-broker-soak-queries.mjs --window 24h
node scripts/github-publish-broker-soak-queries.mjs --window 7d --json
```

No credential, no Grafana access, no deploy. Loki
(`http://loki.monitoring.svc.cluster.local:3100`) is reachable unauthenticated
from any agent pod and from ARC runners; override with `PAPERCLIP_LOKI_URL`.

## ⛔ Read this before you trust a zero

Three ways this surface reports "nothing wrong" when it has measured nothing.
The script handles all three, which is the main reason to use it rather than
pasting LogQL into Grafana.

1. **Every §5.3 category is now a real count** — category (c) included, since
   PEN-5185. The `NOT OBSERVABLE` machinery is retained for whatever goes dark
   next: the script prints that, never `0`, for any category the broker cannot
   emit. ⛔ One class is dark **on purpose** and must stay so — see the next
   section.
2. **An empty stream is not a clean stream.** While the gate is off no broker
   pod exists, so every count is 0 and the stream has no lines at all. The
   script detects `streamTotal === 0` and says so explicitly.
3. **`ttlSecondsAfterFinished: 300`.** Agent Jobs are deleted five minutes
   after they finish, so Loki is the *only* durable record of what the broker
   did. **Collect soak evidence inside the window.** It cannot be reconstructed
   from the cluster afterwards, and polling live pods silently misses short
   runs.

The script also checks that the categories **partition** the stream: if the
counted categories do not sum to the stream total, it says how many lines
matched nothing.

⚠️ **That is not a "someone added a log line" signal, and it used to say it
was.** The categories are a *total* partition by construction — every prefixed
line the matchers do not recognise is counted as **request rejected
(unexpected error)**, and every unprefixed one as **startup FAILURE
(unexpected)**. So a novel line is always counted somewhere, and a non-zero
residual instead means a shipped LogQL matcher does not behave in Loki's RE2
engine the way `classifyBrokerLine` does in JS. **Novelty shows up as one of
those two counts moving, not as a partition gap.**

## What reaches the broker container's stderr, and what does not

Read from source at `master` `71d2d07e3` (the PEN-5185 merge). **Grep the
symbol, not the line number** — these anchors move; §5.3's own citations
(`:271,329,419`) had already rotted to `:278,366,417` before PEN-5185 moved them
again (PEN-5091).

Two families reach it, and the split is what makes the counts readable:

- **INPUT**, one line per accepted invocation — `${tool} in ${cwd}` from
  `startChild`. The denominator.
- **OUTCOME**, exactly one line per connection, from `formatBrokerOutcomeLine`
  via `sendExit`:

  ```
  paperclip-github-broker: <verb> <tool|-> code=<n> [detail=<reason>]
  ```

| §5.3 category | Observable? | Where |
|---|---|---|
| (a) startup failures | ✅ | `main()` in `github-publish-broker-runtime.ts` — the listen line and the catch |
| (b) policy refusals | ✅ | `refused` with a reason opening `refusing ` / `the broker performs pushes, and this is ` |
| (b) protocol refusals | ✅ | `refused` with one of the four protocol reasons. Dark before PEN-5185 |
| (b) other rejections | ✅ | `refused` with any other reason — a bad JSON body, a workspace-prep failure |
| (c) child non-zero exits | ✅ | `exit <tool> code=<n≠0>`. **The category PEN-5185 exists to create** |
| spawn failures | ✅ | `spawn-failed`. §5.3 did not name this class at all |
| the child's own stderr | ⛔ **never** | Relayed to the **socket**, back to the agent. See below |

⛔ **The child's bytes are not here and must never be.** `child.stderr` is
`git`/`gh` output and can carry a push URL with an embedded token; the broker's
stderr reaches Loki, which outlives the pod's `ttlSecondsAfterFinished: 300`.
Teeing it into the container log would convert this observability surface into a
durable credential-disclosure path. **This is the one way to get the change
wrong, and it is the obvious way.** The test suite pins it: there is no
`child_stderr` query, and a `ctx.log` near `child.stderr` fails the suite.
To find out *why* a child exited non-zero, read the **agent's** run log.

### Telling a bypass attempt from a client stutter

Every `refuse()` exits **64**, so the exit code cannot separate them — the
**verb** and the **reason** carry it. That distinction is the most
security-relevant thing the broker reports:

- **`policy_refusal`** — the boundary refused an attempt to reach the
  credential (`gh auth`, a push that sets `credential.helper`, a path outside
  the workspace). **Investigate every one.** It is never a client bug.
- **`protocol_refusal`** — a malformed or out-of-sequence frame. Ordinarily a
  client bug.
- **`request_error_other`** — the residual, and the novelty signal.

⚠️ `PublishBrokerRefusal` prefixes **every** message with
`paperclip-github-broker: `, and has since the broker's first commit. The
reason therefore appears inside `detail=` as `detail=paperclip-github-broker: …`
and a matcher anchored on the bare prose matches **nothing**. That shipped once:
the pre-PEN-5185 `policy_refusal` query returned 0 for every window.

### Comparing accepts against outcomes

Every accepted invocation ends in exactly one of `exit` 0, `exit` non-zero, or
`spawn-failed`. A refusal is **not** in that sum — a refused request never
reached `startChild`, so it has no accept line.

The script computes this and flags a mismatch. It matters because the outcome
log is deliberately **best-effort**: a throw from `ctx.log` is swallowed so it
cannot kill the sidecar (an uncaught throw in an EventEmitter callback would end
the broker process and every publish for the rest of the Job's life). §5.3 tells
the reader what a dropped line looks like — **an imbalance between the accept
count and the outcome count, not a miscount inside a category.**

## The saved queries

`scripts/github-publish-broker-soak-queries.mjs` is the source of truth —
`BROKER_QUERIES` carries each one with the source site it was derived from.
Copy-pasteable equivalents:

```logql
# [a] startup OK (broker reached listen)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: listening on`

# [a] startup FAILURE (workspace root unset)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset`

# [a] startup FAILURE (unexpected — unprefixed error)
{namespace="paperclip",container="github-publish-broker"} !~ `^paperclip-github-broker: ` !~ `^(refusing |the broker performs pushes, and this is )`

# [b] policy refusal (attempted egress-policy bypass)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: refused ` |~ `detail=paperclip-github-broker: (refusing |the broker performs pushes, and this is )`

# [b] protocol refusal (malformed frame / bad sequence)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: refused ` |~ `detail=paperclip-github-broker: (frame declares |a second request on one connection|stdin arrived before a request|unknown frame kind 0x)`

# [b] request rejected (unexpected error — neither policy nor protocol)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: ` !~ `^paperclip-github-broker: (listening on|PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset|(git|gh|github-mcp-server) in /)` !~ `^paperclip-github-broker: (exit|spawn-failed) (git|gh|github-mcp-server|-) code=[0-9]+` !~ `^paperclip-github-broker: refused (git|gh|github-mcp-server|-) code=[0-9]+ detail=paperclip-github-broker: (refusing |the broker performs pushes, and this is |frame declares |a second request on one connection|stdin arrived before a request|unknown frame kind 0x)`

# [denominator] invocations accepted (publish attempts)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: (git|gh|github-mcp-server) in /`

# [denominator] child exited 0 (publish succeeded)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: exit (git|gh|github-mcp-server|-) code=0($| )`

# [c] child non-zero exits
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: exit (git|gh|github-mcp-server|-) code=[1-9][0-9]*($| )`

# [c] spawn failures (the tool never started)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: spawn-failed `
```
```

Every matcher above is **anchored** at `^` and **case-sensitive**, because
`classifyBrokerLine` partitions with `startsWith` and the test suite asserts the
two agree line-for-line. An unanchored `|=` or `!=` matches the prefix anywhere
in the line, which a refusal quoting an agent-supplied path can satisfy.

**Why the refusal matchers look doubly prefixed.** They are. The outcome line
carries `paperclip-github-broker: `, and the reason inside `detail=` carries it
again because `PublishBrokerRefusal` added it. Anchoring stops a refusal that
*quotes* a command from being counted as an invocation, and the test suite
derives the openings from `github-publish-broker-policy.ts` rather than
restating them — a hand-copied opening is how the unprefixed matcher shipped.

## Log forgery: closed by PEN-5185, and why it had to be

Refusal messages and the accept line interpolate agent-supplied values — the
working directory and argument tokens. A directory name may legitimately contain
a newline, so an agent that publishes from
`…/work/x\npaperclip-github-broker: exit git code=0` could emit a **second**
line into `container="github-publish-broker"`, byte-identical to one the broker
wrote, forging any counter here including a publish outcome.

That was a bounded nuisance while these lines were a dashboard, and was rated
non-blocking at that scope on review of
[#3205](https://github.com/Blockcast/paperclip/pull/3205). It stopped being
bounded the moment PEN-5185 made them the **durable record of publish
outcomes** — the principal who can forge them is exactly the one the broker
exists to constrain, and a forged `exit 0` is what a later reader finds instead
of the real outcome, five minutes after the pod is gone.

`toSingleLogLine` now collapses CR/LF (and U+2028/U+2029) where `log` is built,
so the one-physical-line property holds **by construction** for every call site
including a caller-supplied `log`. ⛔ Do not move this guard to the call sites:
a guard each caller must remember is one the next call site will omit.

⚠️ This bounds forgery to *content within a line*. An agent can still choose a
`cwd` that makes an accept line read oddly; it can no longer manufacture an
extra line, which is what made counters forgeable.

## Verifying the tooling itself

```bash
node --test scripts/github-publish-broker-soak-queries.test.mjs
```

The tests assert the shipped LogQL against message strings copied verbatim from
the broker source. The central one evaluates each query's **actual line-filter
chain** and requires that **exactly one** observable query match each fixture,
and that it be the one `classifyBrokerLine` picks — so a line the broker really
writes can neither go uncounted (which is what produced the false "queries have
gone stale" alarm) nor be counted twice. The LogQL fences in this file are
checked against `BROKER_QUERIES` by the same suite, so this runbook cannot drift
from the shipped queries.

If a broker message is reworded, re-copy the fixtures from source — they are the
guard against the queries silently ceasing to match.

## Related

- `docs/security/PEN-5016-github-publish-broker-enablement-plan.md` §5.3 (the
  requirement), §5.2 (the per-door detection asymmetry), §7 (stage shape).
- `runbooks/grafana-dashboard-as-code.md` — why a dashboard is not the primary
  artifact here: those dashboards are Prometheus-backed, `grafanaDashboard` is
  disabled by default, and the chart ships on a manual deploy.
