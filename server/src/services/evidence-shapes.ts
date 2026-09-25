/**
 * Evidence-shape registry for the artifact-evidence gate (BLO-4461).
 *
 * Maps an issue's label name to the set of evidence shapes the agent must
 * produce before transitioning the issue to `in_review`. Each shape names a
 * detectable pattern in the issue's comments or work_products — see
 * `evidence-gate.ts` for the detection logic.
 *
 * The registry is intentionally a plain object so operators can edit the
 * defaults or override per-instance via config at the call-site. The gate
 * evaluator never reads this file directly; it receives the registry as
 * input, which keeps the evaluator pure and testable.
 */

export type EvidenceShape =
  | "screenshot:1440x900"
  | "screenshot:390x844"
  | "checklist:done-when"
  | "test-output"
  | "kubectl-state"
  | "probe-output"
  | "url-probe"
  | "pr-link"
  | "landing-artifact"
  | "ci-green"
  | "e2e-script"
  | "e2e-run"
  | "migration-output"
  | "review:ally-clean"
  | "deploy:landed";

export interface EvidenceRegistryEntry {
  required: EvidenceShape[];
}

export type EvidenceRegistry = Record<string, EvidenceRegistryEntry>;

/**
 * Default registry. Keys are label names as they appear on issues
 * (case-insensitive lookup is the evaluator's job).
 *
 * Tuning notes:
 *   - `frontend`/`ui`/`cms-published` all share the same required set —
 *     viewport screenshots + a per-criterion checklist. Three aliases
 *     because real issues use whichever name the operator typed first.
 *   - `backend` requires a real test banner, not a "tests passed" claim.
 *   - `infra` requires observable post-state, not a "deployed" claim.
 *   - `cms-data-op` is light (single URL probe) because these are
 *     typically one-field CMS edits — over-gating slows the operator.
 *   - `pr` is the lightest of all: just a PR link. CI-green enforcement
 *     comes in Phase 2 (BLO-4828).
 *   - `landing-artifact` (BLO-17560): added to every code-completion label
 *     (`frontend`, `ui`, `cms-published`, `backend`, `db-migration`,
 *     `migration`) after two independent fabrication incidents (BLO-6393
 *     2026-05-22, BLO-6395 2026-06-10) where an agent posted a detailed
 *     "implementation complete, unit-tested" comment — screenshots/test
 *     banner + a fully-checked `checklist:done-when` table — for code that
 *     only ever existed in an ephemeral workspace and was never committed.
 *     Both incidents satisfied every previously-required shape for their
 *     label and still passed the gate. `landing-artifact` closes that hole:
 *     it requires a GitHub PR link OR a commit link in the target repo, and
 *     it is additive to (not a replacement for) the existing shapes — a
 *     passing test banner is necessary but no longer sufficient on its own.
 *     `infra` and `cms-data-op` are intentionally NOT included: their
 *     existing shapes (`kubectl-state`, `url-probe`) already demand live
 *     state that can't be fabricated the same way, and some ops changes are
 *     legitimately applied ahead of a PR landing (e.g. emergency kubectl
 *     edits later backfilled into IaC).
 *   - `review:ally-clean` / `deploy:landed` (BLO-32239): the two shapes an
 *     agent cannot type into existence. Every other shape is a regex over the
 *     agent's OWN comment, so a fabricated comment satisfies it — which is what
 *     both fabrication incidents above did. These two are computed by
 *     `evidence-truth.ts` against GitHub, off the PR work products Paperclip
 *     linked; no comment text can produce them.
 *
 *     Policy (eng review 2026-09-06, D13): they apply to unlabeled issues and
 *     to the code-completion labels. `pr` is deliberately excluded — it
 *     delivers an OPEN PR for a human to decide on, so requiring "merged"
 *     would make the label unsatisfiable by construction. `infra` and
 *     `cms-data-op` are excluded for the same reason `landing-artifact` skips
 *     them: they deliver live state with no PR, and their existing shapes
 *     already demand a real probe.
 *
 *     Only `review:ally-clean` is REQUIRED (CTO ruling 2026-09-17).
 *     `deploy:landed` stays a registered, detected shape — reported through
 *     `allDetected`, which is explicitly "all shapes detected, including
 *     shapes not required" — so the probe still measures it for the rollout
 *     runbook and the scorecards. It is not required because a required shape
 *     must be satisfiable by correct behaviour AT THE MOMENT IT IS EVALUATED,
 *     and the gate fires on exactly one transition: INTO `in_review`, where
 *     merged-ness is unsatisfiable by construction. Requiring it made `pass`
 *     unreachable for every labeled code issue, so the only route to `pass`
 *     was to merge BEFORE requesting review — a metric paying out for exactly
 *     the behaviour BLO-26572 forbids. Inverted, not merely degraded.
 */
export const DEFAULT_EVIDENCE_REGISTRY: EvidenceRegistry = {
  frontend: {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when", "landing-artifact", "review:ally-clean"],
  },
  ui: {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when", "landing-artifact", "review:ally-clean"],
  },
  "cms-published": {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when", "landing-artifact", "review:ally-clean"],
  },
  backend: {
    required: ["test-output", "checklist:done-when", "landing-artifact", "review:ally-clean"],
  },
  infra: {
    required: ["kubectl-state", "probe-output"],
  },
  "cms-data-op": {
    required: ["url-probe"],
  },
  pr: {
    required: ["pr-link"],
  },
  "db-migration": {
    required: ["migration-output", "landing-artifact", "review:ally-clean"],
  },
  migration: {
    required: ["migration-output", "landing-artifact", "review:ally-clean"],
  },
};

/**
 * Required evidence for issues that match no registry entry. The checklist is
 * a weak shape, so the gate's verdict for unlabeled work is `warn` (not
 * `block`) — historically not every issue gets labeled, and we don't want the
 * gate to become a chore for refactor / doc-only issues.
 *
 * `review:ally-clean` is required here as well (D13). It does not by itself
 * change the verdict: an unlabeled issue missing it still only warns, unless
 * `PAPERCLIP_EVIDENCE_UNLABELED_BLOCK` is on AND the probe actually
 * established truth — see `unlabeledTruthBlock` in `evidence-gate.ts`.
 *
 * ...and it is dropped from `required` entirely when the probe establishes
 * there is no linked PR, so it never shows up in `missing` for work that can
 * never acquire a head to review. The same unsatisfiable-at-evaluation test
 * that demoted `deploy:landed` below, applied to the one population this
 * fallback exists for. Without that, every doc-only issue's verdict was a
 * permanent `warn` and `reviewPassRate` carried a not-pass no agent behaviour
 * could clear. The shape stays registered and detected; `allDetected` still
 * reports it.
 *
 * The two shapes are still treated differently, and the line is WHO can satisfy
 * them, not how much they bite:
 *   - `deploy:landed` is unsatisfiable for EVERY issue at the only transition
 *     the gate runs on, so it is required nowhere.
 *   - `review:ally-clean` is satisfiable by anyone with an open PR, so it stays
 *     required — including on a LABELED issue with no linked PR, whose assignee
 *     can open one. Only the PR-less UNLABELED case is exempt.
 *
 * `deploy:landed` is deliberately NOT required, here or on any labeled path
 * (CTO ruling 2026-09-17) — see the registry comment above. Unlabeled is the
 * majority shape in this estate, so requiring an unsatisfiable-at-evaluation
 * shape here would turn nearly every issue's verdict into a permanent `warn`
 * and flatten `reviewPassRate` (`agent-scorecards.ts`) for reasons no agent
 * behaviour could ever change. The probe still detects it; `allDetected`
 * still reports it.
 */
export const DEFAULT_UNLABELED_REQUIRED: EvidenceShape[] = [
  "checklist:done-when",
  "review:ally-clean",
];
