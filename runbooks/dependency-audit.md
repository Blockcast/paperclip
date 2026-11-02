# Dependency audit (scheduled)

**Workflow:** `.github/workflows/dependency-audit.yml` — daily `37 7 * * *`, plus `workflow_dispatch`.
**Check:** `scripts/check-dependency-audit.mjs`
**Triage artifact:** `scripts/dependency-audit-baseline.json`
**Alert:** `DependencyAdvisoryUnaccounted` (Alertmanager, 26h TTL)
**Row:** PEN-5285

## What this exists for

Before PEN-5285, `grep -rln 'pnpm audit\|npm audit' .github/workflows/` returned nothing. The
repo's dependency-security posture was entirely **static** — `pnpm.overrides` floors, a
`securityAuditRemediations` ledger, and per-package guard tests asserting the lockfile honours
those floors. Every one of those compares the tree against a number a human wrote into the repo,
so none can see an advisory published after the number was written.

That is not a hypothetical weakness. When this landed, `pnpm.overrides` pinned `hono: ^4.12.21`
and `qs: ^6.15.2` — both green against their own guards — while the live feed wanted `>=4.13.11`
and `>=6.16.1`. PEN-5284 is the same shape for `fast-uri`: two `pr.yml`-registered guards, both
green, over a version five live advisories called vulnerable.

The static guards are not wrong and are not being replaced. This lane is the detector they
structurally cannot be.

## Why it is scheduled and not a PR gate

The input is a live external feed. A PR gate on it goes red for reasons no PR caused, making
every PR hostage to upstream publication timing. That is also why
`scripts/security-audit-overrides.test.js` is deliberately reachable from no workflow (PEN-5272).

The **comparison logic**, however, is static, and it *is* gated on every PR:
`scripts/check-dependency-audit.test.mjs` runs in `pr.yml`, offline and clock-free. Logic on the
PR gate; live feed on the schedule. Nothing in the PR-gated half reads the real date, so an
entry's review-by passing can never turn the merge gate red.

## The failure criterion

The lane fails when an advisory is **not individually accounted for**, where being accounted for
carries an expiry. Three failing conditions:

| kind | meaning |
|---|---|
| `unbaselined` | a live advisory at or above `moderate` with no baseline entry — the new-advisory case |
| `expired` | a baseline entry whose `reviewBy` has passed **and** which the feed still reports |
| `severity-escalated` | a baselined entry the feed now rates higher than the severity it was triaged at |

Reported but **not** failing: advisories below the `moderate` threshold, and baseline entries the
feed no longer reports (remediated — an expiry that fired on good news would be a false alarm).

Two simpler criteria were considered and rejected; the reasoning is in the header of
`scripts/check-dependency-audit.mjs`. In short: *fail only on high/critical* is a blanket
suppression of a whole severity class, and all 36 known advisories are moderate, so a 37th
moderate would be exactly as invisible as the 36. *Triage to zero first* is open-ended — the
remediation set includes four major-version bumps — and leaves no detector meanwhile.

## The baseline is keyed on (advisory, package)

One GHSA id can be reported under more than one package, and one is here:
`GHSA-82fw-gwwq-j7x9` appears under both `vitest` and `@vitest/mocker`. Keyed on the id alone,
baselining either would silently suppress the other's finding. `check-dependency-audit.test.mjs`
pins this against that real pair.

## When the lane goes red

1. **Read the run log.** The report names every violation with its kind, package, resolved
   version, and the version that fixes it.
2. **`unbaselined`** — a new advisory. Triage it: remediate, or add an entry with a verdict, a
   substantive reason and a `reviewBy`. Do not add an entry without reading what the advisory
   actually says.
3. **`expired`** — a prior acceptance has come due. **Re-triage it; do not simply move the date.**
   Moving the date without re-reading the advisory converts the artifact back into the invisible
   silence it exists to replace.
4. **`severity-escalated`** — the recorded verdict was reached against a lower severity, so it no
   longer stands on its own evidence. Re-triage.

To reproduce locally from a clean checkout — no `pnpm install` needed, the audit reads the
committed lockfile:

```sh
node ./scripts/check-dependency-audit.mjs ; echo "exit=$?"
```

## Entry shape

```json
{
  "ghsa": "GHSA-....", "package": "hono", "severity": "moderate",
  "cve": "CVE-...", "title": "...", "observedVersions": ["4.12.25"],
  "patched": ">=4.13.11", "introducedVia": "the dependency path, measured from the lockfile",
  "verdict": "remediate | risk-accept | not-applicable",
  "reviewBy": "2026-12-15", "reason": "why this verdict, in enough detail to re-judge it"
}
```

`verdict` means:

- **`remediate`** — in a shipped path; we intend to fix it. The `reviewBy` is short, and it is
  what stops this from being a risk-accept wearing a different label.
- **`risk-accept`** — in a shipped path, fix is expensive (typically a major bump of someone
  else's transitive). The reason must say what makes it acceptable. Where exploitability in our
  own usage has *not* been assessed, the reason says so rather than implying it has.
- **`not-applicable`** — evidence that the package is not in a shipped path at all. `--prod` is
  pnpm's own scope determination and it is not always right: the four `vitest`/`vite` entries are
  in scope only because `better-auth` declares `vitest` an *optional peer*, which pnpm records in
  its peer-resolution key while `server/package.json` has vitest in `devDependencies` only.

## Known limitation: not watched by `scheduled-guard-liveness.yml`

A scheduled guard that silently stops running emits nothing anywhere (PEN-3281), and this one is
not yet in `WATCHED_GUARDS`. That registry requires a threshold derived from the guard's **own**
measured completion-gap distribution, and says so emphatically — registering this workflow with
an invented number would reproduce the PEN-3379 defect inside a new guard. It should be added
once a few weeks of completions exist to derive one from. Until then, a silent stop of this lane
is undetected.
