---
name: paperclip-evidence-before-in-review
required: true
description: >
  Before moving a Paperclip issue to `in_review`, produce the label-keyed
  evidence required by the server's artifact-evidence gate. Use on any
  transition to `in_review` or completion claim; missing evidence records a
  `block` verdict (warn-only in Phase 1, HTTP 422 in Phase 2).
---

# Evidence Before in_review

## Why

The paperclip `in_review` gate exists because agents historically claimed completion 4-5 times per issue with no real artifact verification — operators had to manually catch over-claiming each cycle. BLO-3979 spent ~5 reject cycles + ~30 runs over 2 days for exactly this reason. The gate (BLO-4461) verifies you attached **observable evidence** matching the issue's class.

This is a SHAPE check, not a TRUTH check. The gate only confirms you pasted the receipt. QA Engineer re-runs the receipt against the live artifact to catch fakery. Both lines of defense matter.

**Update (BLO-17560, 2026-07-22):** two independent fabrication incidents (BLO-6393 2026-05-22, BLO-6395 2026-06-10) posted a fully-shaped "implementation complete" claim — screenshots or a test banner, plus a fully-checked done-when checklist — for code that only ever existed in an ephemeral workspace and was **never committed**. Both satisfied every shape the gate required at the time and still passed. The gate now also requires `landing-artifact` (a PR link or a commit link in the target repo) for every code-completion label. A passing test banner or a screenshot is necessary but no longer sufficient — see the `landing-artifact` section below.

## Procedure

### 1. Read the issue's labels

```
paperclipGetIssue(issueId)
```

Look at the `labels` array. The label name(s) tell you which evidence shapes the gate requires.

### 2. Look up required shapes

| Label | Required shapes |
|---|---|
| `frontend`, `ui`, `cms-published` | `screenshot:1440x900` + `screenshot:390x844` + `checklist:done-when` + `landing-artifact` |
| `backend` | `test-output` + `checklist:done-when` + `landing-artifact` |
| `infra` | `kubectl-state` + `probe-output` |
| `cms-data-op` | `url-probe` |
| `db-migration`, `migration` | `migration-output` + `landing-artifact` |
| `pr` | `pr-link` |
| (no label or unrecognized) | `checklist:done-when` (weak default — verdict will be `warn`, not `block`) |

Multiple labels union their required sets. A `frontend + pr` issue needs all of `screenshot:1440x900`, `screenshot:390x844`, `checklist:done-when`, `landing-artifact`, `pr-link`.

`infra` and `cms-data-op` intentionally do NOT require `landing-artifact`: their existing shapes already demand live, hard-to-fake state (a real `kubectl get`, a real HTTP probe), and some ops changes are legitimately applied ahead of a PR landing.

Source of truth: `server/src/services/evidence-shapes.ts` (`DEFAULT_EVIDENCE_REGISTRY`).

### 3. Produce each required shape

#### `landing-artifact`

**A completion claim for code is not "done" until the code exists in the target repo.** Paste one of:

- A GitHub PR URL: `https://github.com/Blockcast/paperclip/pull/N`
- A GitHub commit URL: `https://github.com/Blockcast/paperclip/commit/<full sha>`

Either satisfies the shape — you don't need both, and you don't need a merged PR, just an open one pointing at real code. A draft PR is fine.

```markdown
Implementation complete: https://github.com/Blockcast/paperclip/pull/774
```

**Common mistakes the gate detects:**
- No link at all — just "implementation complete" prose, however detailed. This is exactly the shape of both BLO-17560 fabrication incidents: specific filenames + a passing test banner + a fully-checked checklist, but zero repo-resident evidence. **Pasted test/lint output alone does not clear this shape.**
- A short/abbreviated SHA (`f64be7b`) instead of a full commit URL — too collision-prone to trust and not clickable-verifiable by QA/the operator.
- A link to a different repo than the one you're actually working in — the gate can be scoped to `allowedPrRepos`; a mismatched repo doesn't count.
- Editing a screenshot's alt-text or a checklist row to *say* "PR #774" without an actual `github.com/.../pull/N` URL — the detector matches URLs, not prose claims about URLs.

If you legitimately have no PR yet (e.g. you're still iterating locally), you are not ready for `in_review` — open a draft PR first. See the Staff Engineer / implementer instructions for "GitHub PR Review Handoff Hygiene": draft PRs are valid early-review artifacts.

#### `screenshot:1440x900` and `screenshot:390x844`

**For published-URL work**, take Playwright screenshots at exactly these viewports against the production URL. Not the Designer canvas. Not the bot's 1280x720. **The exact viewport string must appear in the filename, alt-text, OR work-product metadata.**

```ts
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto("https://www.blockcast.network/<your-url>");
await page.screenshot({ path: "blog_entry_desktop_1440x900.png", fullPage: true });

await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: "blog_entry_mobile_390x844.png", fullPage: true });
```

Then attach inline in your `in_review` comment using markdown image syntax:

```markdown
![desktop 1440x900](./blog_entry_desktop_1440x900.png)
![mobile 390x844](./blog_entry_mobile_390x844.png)
```

**Common mistakes the gate detects:**
- Bot screenshots at 1280x720 — doesn't match either required viewport.
- Designer canvas snapshots instead of published-URL — different DOM.
- Filename without the viewport string (e.g. `screenshot1.png`) — gate can't tell which viewport it is.

#### `checklist:done-when`

Map each bullet in the issue description's `## Done when` section to a row in a markdown table with a status marker. Number of rows must be ≥ number of bullets.

```markdown
| Criterion | Status | Evidence |
|---|---|---|
| entry page renders | ✅ | screenshot above + `curl https://www.blockcast.network/blog/...` returned 200 |
| listing page renders | ✅ | screenshot above |
| footer at bottom | ✅ | DOM probe in this comment showing footer.y > article.y + article.height |
```

Accepted status markers: ✅ ✓ ✔ ❌ ✗ ⏸ ⏹ ⚠️ `[x]` `[X]` `[ ]` and the bare words `pass` / `fail`.

**Pin every row to specific evidence** — a filename, a URL, a line of DOM-probe output. "✅ done" with no pointer doesn't help QA Engineer's re-verify.

#### `test-output`

Paste the actual test runner banner. Not a paraphrase.

```
 ✓ src/__tests__/foo.test.ts (12 tests) 23ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Accepted formats: vitest (`Test Files N passed`), pytest (`N passed in Ns`), jest (`Tests: N passed`), mocha (`N tests passing`).

**Common mistakes:**
- "All tests pass" with no banner — gate won't detect this.
- A failing run with `0 failed, 12 passed` — gate counts the `12 passed` so it satisfies the shape, but operator review will reject anyway.
- **A real test banner from a real local run, with no `landing-artifact`** — this is the exact fabrication shape from BLO-6393/BLO-6395. The test banner alone no longer clears `backend`'s requirements; you also need a PR or commit link.

#### `kubectl-state`

Paste a `kubectl get` output. Pod listing, service listing, or `kubectl rollout status` success line all work.

```
NAME                       READY   STATUS    RESTARTS   AGE
paperclip-0                1/1     Running   0          5m
```

#### `probe-output`

A `curl`/`wget`/`http` invocation followed within ~500 chars by an HTTP status line, a JSON body, or HTML.

```
$ curl http://paperclip.paperclip.svc:3100/api/ccrotate/status
HTTP/1.1 200 OK
{"updatedAt":"2026-05-11T...","accounts":[...]}
```

#### `url-probe`

A `curl https://…` invocation. Lighter than `probe-output` — used for `cms-data-op` issues where the goal is just to confirm a field landed.

```
$ curl https://www.blockcast.network/blog/making-traffic-federation-easier | grep -c 'blog-lede'
1
```

#### `migration-output`

Paste **observable output** from the migration run — not a prose claim. Exactly three evidence paths satisfy the gate:

**1. Migration runner banner** (drizzle-kit, Flyway, Liquibase, Alembic, or similar):

```
$ npx drizzle-kit push
[✓] Applied 1 migration
```
```
Flyway Community Edition 10.x
Database: jdbc:postgresql://...
Successfully applied 1 migration (execution time 00:00.123s)
```
```
INFO  [alembic.runtime.migration] Running upgrade abc123 -> def456, add_users_table
```

**2. EXPLAIN / EXPLAIN ANALYZE plan output** (for index/query correctness checks):

```
Seq Scan on users  (cost=0.00..42.00 rows=1000 width=64)
```
```
Index Scan on issue_events  (cost=0.56..8.58 rows=1 width=32)
  Index Cond: (issue_id = $1)
Planning Time: 0.123 ms  Execution Time: 0.045 ms
```

**3. psql row-count PAIRED with runner output:**

The `(N rows)` / `(1 row)` psql suffix satisfies the gate **only when migration runner output also appears in the same comment**. A bare row-count from a standalone SELECT is not enough.

```
Applied 1 migration successfully.

SELECT COUNT(*) FROM issue_events;
 count
-------
 98432
(1 row)
```

**Common mistakes:**
- "Migration applied successfully" prose with no runner output — gate can't detect this.
- Pasting only the migration SQL DDL (`ALTER TABLE …`, `CREATE INDEX …`) — raw SQL is **not** runner output and **blocks** the gate.
- Posting `(N rows)` without runner output in the same comment — the detector requires a runner signal alongside the row-count.
- A screenshot of a migration tool's UI — gate scans comment text, not images.
- Posting migration output in the issue description rather than a comment — gate only scans agent-authored comments.
- Migration runner output with no `landing-artifact` — the migration file itself needs to exist in a PR/commit, same as any other code change.

#### `pr-link`

A full GitHub PR URL: `https://github.com/Blockcast/paperclip/pull/N`. Not "see PR" or "PR opened".

### 4. Only THEN transition to in_review

After all required shapes are in your closing comment, PATCH the issue:

```
paperclipUpdateIssue(issueId, { status: "in_review" })
```

The gate runs synchronously and writes its verdict to `issues.last_evidence_verdict`. Operator + QA Engineer see the verdict via the UI badge. If your evidence shape was complete, verdict is `pass`. If it wasn't, verdict is `block` (Phase 1: telemetry only; Phase 2: 422).

## Anti-patterns

These have all happened on real issues and the gate exists to catch them:

1. **"Trust me, it works."** No evidence. Block.
2. **Screenshots at the wrong viewport.** Bot's 1280x720, Designer's canvas size, or arbitrary heights. Gate matches the exact filename/metadata viewport string.
3. **Checklist without per-row evidence pointers.** Counts as `checklist:done-when` satisfied, but operator + QA will reject on review. Save the cycle by including pointers.
4. **DOM probes in agent-workspace files instead of inline.** The gate only scans comment bodies + work_products. Files in your shared workspace don't count.
5. **Operator pasting the receipt for you.** The gate ignores `authorUserId` comments — only `authorAgentId` comments produce evidence. Paste your own.
6. **Editing the issue description to remove `## Done when` bullets** to bypass the checklist requirement. Currently a Phase-1 bypass (see BLO-4828 punch list); will be detected in Phase 2.
7. **A detailed "implementation complete, unit-tested" claim with no PR/commit link** (BLO-6393, BLO-6395; remediated as BLO-17560). Specific filenames, a real-looking test banner, and a fully-checked checklist are not evidence the code landed anywhere — they're evidence you ran something locally. `landing-artifact` exists specifically to catch this: if you can't paste a PR or commit URL, the code isn't committed, and the issue isn't ready for `in_review`.

## After landing

- If verdict is `pass`: operator + QA can review.
- If verdict is `block` (or `warn` for unlabeled): re-read your `in_review` comment. The `missing` array on the verdict points you exactly at what's missing. Add the evidence. Comment again. The gate re-evaluates on every PATCH to in_review.

## Reference

- Pure evaluator: `server/src/services/evidence-gate.ts`
- Label registry: `server/src/services/evidence-shapes.ts`
- Wiring: `server/src/services/evidence-gate-wiring.ts`
- Schema: `issues.last_evidence_verdict` (jsonb, nullable)
- Tracking: BLO-4461 (parent), BLO-4829 (evaluator), BLO-4824 (wiring), BLO-4828 (Phase-2 enforce), BLO-17560 (`landing-artifact` shape)
