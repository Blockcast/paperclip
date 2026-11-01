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

1. **Category (c) — child non-zero exits — is NOT OBSERVABLE.** Not "currently
   quiet". Structurally absent. The script prints `NOT OBSERVABLE`, never `0`.
   See the next section.
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

Read from source at `master` `8be492039` on 2026-11-01. **Grep the symbol, not
the line number** — these anchors move; §5.3's own citations (`:271,329,419`)
had already rotted to `:278,366,417` by the time this was written.

| §5.3 category | Observable in Loki? | Where |
|---|---|---|
| (a) startup failures | ✅ yes | `github-publish-broker-runtime.ts` — the listen line, and `process.stderr.write` on the catch |
| (b) policy refusals | ⚠️ **partly** | Two observable sites, both through `ctx.log` in `github-publish-broker.ts`: a `PublishBrokerRefusal` from `github-publish-broker-policy.ts` (unprefixed), and the **non-refusal** branch of the same `catch` — anything `parsePublishBrokerRequest` or `startChild` throws, prefixed. The four protocol-level `refuse()` calls are **socket-only** |
| (c) child non-zero exits | ⛔ **no** | `sendExit()` frames the exit code to the **socket**. Nothing writes it to stderr |

⚠️ **§5.3 states the broker "writes refusals and child stderr to its own
container's stderr". That is wrong for child stderr entirely** — `child.stderr`
is relayed to the socket, i.e. back to the agent — **and partly wrong for
refusals.** There are exactly three stderr sites in `github-publish-broker.ts`
(the `log` default and its two call sites) plus two in the runtime module.
Everything else is socket-bound.

**Consequence for the soak.** You can measure *how many publishes were
attempted* (the per-invocation accept line) and *how many were refused by
policy*. You **cannot** measure *whether the tool the broker ran succeeded*.
Stage 1's observations (b) `git push` reaching GitHub, (c) a real `gh` call and
(d) an MCP tool call must therefore be confirmed **agent-side** — from the run
log, and from the PR existing — not from the broker container. §5.2 already
predicts this asymmetry for `gh` and MCP ("the quiet one"); what is new here is
that the broker's own logs do not close it.

**The fix, if someone wants category (c) for real,** is one line beside
`sendExit` in `github-publish-broker.ts`: log the tool and a non-zero code to
stderr before framing it. It is deliberately **not** bundled into stage 0 —
§7 is explicit that stage 0 carries no PR merges and changes nothing about the
broker, and a logging change to the component under test, made days before its
first soak, is the wrong moment. The query is already in `BROKER_QUERIES` with
`observable: false`, so it starts working the moment that line lands.

## The saved queries

`scripts/github-publish-broker-soak-queries.mjs` is the source of truth —
`BROKER_QUERIES` carries each one with the source site it was derived from.
Copy-pasteable equivalents:

```logql
# (a) startup OK — the denominator. A brokered pod with no listen line did not start.
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: listening on`

# (a) startup FAILURE, named
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset`

# (a) startup FAILURE, unexpected — unprefixed, and not a refusal
{namespace="paperclip",container="github-publish-broker"} !~ `^paperclip-github-broker: ` !~ `^(refusing |the broker performs pushes, and this is )`

# (b) policy refusal
{namespace="paperclip",container="github-publish-broker"} |~ `^(refusing |the broker performs pushes, and this is )`

# (b) request rejected by a NON-refusal error (malformed request, workspace-prep failure)
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: ` !~ `^paperclip-github-broker: (listening on|PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset|(git|gh|github-mcp-server) in /)`

# denominator: publish attempts, per door
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip-github-broker: (git|gh|github-mcp-server) in /`
```

Every matcher above is **anchored** at `^` and **case-sensitive**, because
`classifyBrokerLine` partitions with `startsWith` and the test suite asserts the
two agree line-for-line. An unanchored `|=` or `!=` matches the prefix anywhere
in the line, which a refusal quoting an agent-supplied path can satisfy.

**Why the refusal matcher is anchored and unprefixed.** Lines the broker writes
about *itself* carry `paperclip-github-broker: `. `PublishBrokerRefusal`
messages do **not** — the handler passes `error.message` through verbatim, and
every refusal in the policy module opens with `refusing ` or `the broker
performs pushes, and this is `. Anchoring stops a refusal that *quotes* a
command from being counted as an invocation.

## ⚠️ These counters are agent-forgeable today

Refusal messages interpolate agent-supplied values verbatim — the working
directory and argument tokens in `github-publish-broker-policy.ts` — and
nothing on the path to `ctx.log` strips CR/LF. An agent that sends a `cwd`
containing a newline plus a line of its own choosing gets that line into
`container="github-publish-broker"`, indistinguishable from one the broker
wrote. It can inflate any counter here, including a forged accept line.

**Read a mid-soak spike with that in mind.** The impact today is bounded to
these counters, which are a dashboard — this is **not** a merge or soak
blocker, and the same primitive was rated non-blocking on review of
[#3205](https://github.com/Blockcast/paperclip/pull/3205) at that scope.

⛔ **It stops being bounded the moment category (c) lands.** That change makes
these lines the durable record of publish *outcomes*, and the principal who can
forge them is the one the broker exists to constrain. **PEN-5185 owns the
sanitiser and must land it in the same change as the (c) logging**, not as a
follow-up: a sanitiser that arrives afterwards leaves a window in which the
lines are trusted and still forgeable.

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
