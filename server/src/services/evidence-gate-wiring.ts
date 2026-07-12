/**
 * Wiring layer between the pure `evidence-gate.ts` evaluator and the
 * `issues.ts` PATCH handler (BLO-4824 / BLO-4461 Phase 1).
 *
 * Kept separate from the evaluator so the evaluator stays IO-free (and
 * therefore trivially unit-testable), and separate from `issues.ts` so the
 * wiring is unit-testable too — `runEvidenceGate` takes a `fetch` callback
 * that the production caller wires to live DB queries and the test caller
 * wires to a hard-coded fixture.
 */

import {
  evaluateEvidence,
  type EvidenceCommentLite,
  type EvidenceVerdict,
} from "./evidence-gate.js";
import { DEFAULT_EVIDENCE_REGISTRY } from "./evidence-shapes.js";

export interface EvidenceFetchResult {
  description: string | null;
  doneWhenBulletsRemoved?: boolean;
  labels: Array<{ name: string }>;
  comments: EvidenceCommentLite[];
  workProducts: Array<{
    type: string;
    metadata: Record<string, unknown> | null;
    status: string | null;
  }>;
}

export type FetchEvidenceForGate = (
  issueId: string,
) => Promise<EvidenceFetchResult>;

export interface EvidenceVerdictRecord {
  verdict: EvidenceVerdict;
  missing: string[];
  evidenceFound: string[];
  requiredFound: string[];
  allDetected: string[];
  unlabeledFallback: boolean;
  diagnostics: string[];
  overridden?: boolean;
  overrideReason?: string;
  evaluatedAt: string;
}

const OPERATOR_OVERRIDE_PATTERN = /^evidence-gate: override (.+)$/;
const OPERATOR_OVERRIDE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Run the gate for one issue. Returns the verdict record the caller should
 * persist to `issues.lastEvidenceVerdict`. Caller is responsible for
 * deciding what to do with the verdict (Phase 1: record only; Phase 2:
 * throw on `block`).
 *
 * Work-product `type` → evaluator `kind` mapping is intentional: the
 * evaluator's input shape is its own contract, not tied to the DB's column
 * naming. Mapping at this layer keeps the evaluator portable.
 *
 * Work-product `status` → evaluator `result` mapping treats the DB's status
 * as the canonical pass/fail signal. Producers writing work_products should
 * use status === "pass" for an e2e-run that succeeded — see BLO-4826's
 * skill guidance for how agents are expected to populate this.
 */
export async function runEvidenceGate(
  fetch: FetchEvidenceForGate,
  issueId: string,
  now: Date = new Date(),
): Promise<EvidenceVerdictRecord> {
  const data = await fetch(issueId);
  const override = data.comments
    .filter((comment) => comment.authorUserId !== null && comment.authorAgentId === null)
    .map((comment) => ({
      createdAt: new Date(comment.createdAt).getTime(),
      match: OPERATOR_OVERRIDE_PATTERN.exec(comment.body),
    }))
    .filter(({ createdAt, match }) =>
      match !== null &&
      match[1]!.trim().length > 0 &&
      Number.isFinite(createdAt) &&
      createdAt <= now.getTime() &&
      now.getTime() - createdAt <= OPERATOR_OVERRIDE_MAX_AGE_MS
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (override?.match) {
    return {
      verdict: "pass",
      missing: [],
      evidenceFound: [],
      requiredFound: [],
      allDetected: [],
      unlabeledFallback: false,
      diagnostics: [],
      overridden: true,
      overrideReason: override.match[1]!.trim(),
      evaluatedAt: now.toISOString(),
    };
  }
  const evaluation = evaluateEvidence({
    issue: {
      description: data.description,
      labels: data.labels,
    },
    comments: data.comments,
    workProducts: data.workProducts.map((wp) => ({
      kind: wp.type,
      metadata: wp.metadata,
      result: wp.status,
    })),
    registry: DEFAULT_EVIDENCE_REGISTRY,
    doneWhenBulletsRemoved: data.doneWhenBulletsRemoved,
  });
  return {
    verdict: evaluation.verdict,
    missing: evaluation.missing,
    evidenceFound: evaluation.evidenceFound,
    requiredFound: evaluation.requiredFound,
    allDetected: evaluation.allDetected,
    unlabeledFallback: evaluation.unlabeledFallback,
    diagnostics: evaluation.diagnostics,
    evaluatedAt: now.toISOString(),
  };
}
