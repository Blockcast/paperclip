// PEN-4939: absolute URLs for the security decision records that user-facing
// refusal messages cite.
//
// Every door in this package runs inside an agent container and refuses an
// operation against an ARBITRARY repository. The decision records themselves
// live in exactly one place: `docs/security/` in this repository. They are not
// shipped in the npm package (`files: ["dist"]`), and they are absent from the
// upstream `paperclipai/paperclip` that this repository is a fork of. So a
// repo-relative path in a refusal message resolves for a reader standing in
// this fork and for no one else.
//
// That is not hypothetical. PEN-4939 was filed because a push to
// `Blockcast/onprem-k8s` was refused with a message naming
// `docs/security/PEN-3920-egress-entropy-identifier-decision.md`; the author
// looked for it in the repository they were pushing to, where it 404s, and the
// refusal's only offered route was a dead end. Two separate messages carried
// the same defect, written independently of each other — which is why the
// pointers live HERE now rather than being spelled out at each call site. Add
// a new record to this module, not to a message body.
//
// Keep these ABSOLUTE. A reviewer tidying one back to a relative path restores
// the exact defect this module exists to close.

/** The fork that owns these doors and the decision records behind them. */
const DECISION_RECORD_BASE =
  "https://github.com/Blockcast/paperclip/blob/master/docs/security";

/**
 * PEN-3920: why identifier exoneration is anchored on the BINDING NAME rather
 * than on entropy, and what a reporter should send when a value that cannot
 * leave the blob is refused. Cited by the git egress door's false-positive
 * advice.
 */
export const IDENTIFIER_CLASS_DECISION_URL = `${DECISION_RECORD_BASE}/PEN-3920-egress-entropy-identifier-decision.md`;

/**
 * PEN-3183: where the git egress enforcement boundary sits, and why the publish
 * broker — not the agent at uid 1000 — is the thing that holds the push
 * credential. Section 5 is the part a refused `gh auth` needs.
 */
export const EGRESS_ENFORCEMENT_BOUNDARY_DECISION_URL = `${DECISION_RECORD_BASE}/PEN-3183-git-egress-enforcement-boundary-decision.md`;
