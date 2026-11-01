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
matched nothing. That is the signal that someone added a log line and these
queries have gone stale.

## What reaches the broker container's stderr, and what does not

Read from source at `master` `8be492039` on 2026-11-01. **Grep the symbol, not
the line number** — these anchors move; §5.3's own citations (`:271,329,419`)
had already rotted to `:278,366,417` by the time this was written.

| §5.3 category | Observable in Loki? | Where |
|---|---|---|
| (a) startup failures | ✅ yes | `github-publish-broker-runtime.ts` — the listen line, and `process.stderr.write` on the catch |
| (b) policy refusals | ⚠️ **partly** | `PublishBrokerRefusal` from `github-publish-broker-policy.ts`, logged via `ctx.log` in `github-publish-broker.ts`. The four protocol-level `refuse()` calls are **socket-only** |
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
{namespace="paperclip",container="github-publish-broker"} |= `paperclip-github-broker: listening on`

# (a) startup FAILURE, named
{namespace="paperclip",container="github-publish-broker"} |= `paperclip-github-broker: PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset`

# (a) startup FAILURE, unexpected — unprefixed, and not a refusal
{namespace="paperclip",container="github-publish-broker"} != `paperclip-github-broker: ` !~ `(?i)^(refusing |the\ broker\ performs\ pushes,\ and\ this\ is\ )`

# (b) policy refusal
{namespace="paperclip",container="github-publish-broker"} |~ `^(refusing |the\ broker\ performs\ pushes,\ and\ this\ is\ )`

# denominator: publish attempts, per door
{namespace="paperclip",container="github-publish-broker"} |~ `^paperclip\-github\-broker:\ (git|gh|github\-mcp\-server) in /`
```

**Why the refusal matcher is anchored and unprefixed.** Lines the broker writes
about *itself* carry `paperclip-github-broker: `. `PublishBrokerRefusal`
messages do **not** — the handler passes `error.message` through verbatim, and
every refusal in the policy module opens with `refusing ` or `the broker
performs pushes, and this is `. Anchoring stops a refusal that *quotes* a
command from being counted as an invocation.

## Verifying the tooling itself

```bash
node --test scripts/github-publish-broker-soak-queries.test.mjs
```

The tests assert the shipped LogQL regexes against message strings copied
verbatim from the broker source, in both directions (every refusal matches, no
accept or startup line does). If a broker message is reworded, re-copy the
fixtures from source — they are the guard against the queries silently ceasing
to match.

## Related

- `docs/security/PEN-5016-github-publish-broker-enablement-plan.md` §5.3 (the
  requirement), §5.2 (the per-door detection asymmetry), §7 (stage shape).
- `runbooks/grafana-dashboard-as-code.md` — why a dashboard is not the primary
  artifact here: those dashboards are Prometheus-backed, `grafanaDashboard` is
  disabled by default, and the chart ships on a manual deploy.
