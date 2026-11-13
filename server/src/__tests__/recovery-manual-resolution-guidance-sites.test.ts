import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManualResolutionGuidance, issueRecoveryActionResolvePath } from "@paperclipai/shared";

/**
 * PEN-5714: every site that tells a recovery owner to "record an intentional
 * manual resolution" must name the route, via `buildManualResolutionGuidance`.
 *
 * PEN-5707 built the guidance and applied it at ONE of nine sites
 * (`stranded_assigned_issue`). The other five emitting sites kept the bare
 * clause, so the measured cost it was built to stop -- four path-shaped guesses,
 * all 404, written up as "the disposition cannot be recorded in the field built
 * for it", then propagated to three other seats -- stayed reachable for every
 * other action kind. The builder's own unit tests
 * (`packages/shared/src/recovery-action-resolve-guidance.test.ts`) pin what the
 * guidance SAYS; nothing pinned where it is USED, which is why a one-site fix
 * read as complete.
 *
 * This guard is deliberately a lexical sweep of the two emitting services, and
 * the scoping is the whole design:
 *
 *   - It is keyed on ONE highly specific clause, not a generic token. A
 *     whole-document negative over a generic token is a tripwire on every
 *     future author -- its blast radius grows with the document and the author
 *     who trips it is never the author who wrote it. Here the only way to trip
 *     the negative is to commit the exact defect it exists to catch, so the
 *     tripwire and the property are the same thing.
 *   - It is scoped to the two files that EMIT this prose. Test fixtures under
 *     `src/__tests__` deliberately still carry the bare clause: they stand in
 *     for rows written before PEN-5707 landed, which is what a real upgraded
 *     database contains. Widening this sweep to `server/src` would force those
 *     fixtures to misrepresent production data.
 *   - Full-line comments are stripped, so a historical note that QUOTES the old
 *     clause stays legal. Quoting it cannot emit it.
 *
 * A route rename moves `ISSUE_RECOVERY_ACTION_RESOLVE_ROUTE`, which moves the
 * builder's output, which the controls below re-check -- so the rename cannot
 * silently re-open this.
 */

const SERVICES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "services");

/** PEN-5714's own issue id, so the rendered example is a real row. */
const ISSUE_ID = "28494839-c5c1-40b3-9600-6de1795d8d3a";

/** The clause whose every emission must carry the route. */
const BARE_CLAUSE = "record an intentional manual resolution";

/** Characters after a lead-in within which the builder call must appear. */
const HANDOFF_WINDOW = 160;

type Handoff = {
  /** Prose immediately preceding the handoff. */
  leadIn: string;
  /** Sites known to use this lead-in. More is fine; fewer means one was dropped. */
  knownSites: number;
};

type EmittingFile = {
  label: string;
  path: string;
  /**
   * A construct that MUST be present. Without this, a failed or mis-resolved
   * read yields "" -- and "" contains no bare clause, so the sweep below would
   * report a clean file. PASS has to require a present value, not an absent one.
   */
  anchor: string;
  /** Floor well under the real size, to catch a truncated read. */
  minBytes: number;
  handoffs: Handoff[];
};

const EMITTING_FILES: EmittingFile[] = [
  {
    label: "services/recovery/service.ts",
    path: join(SERVICES_DIR, "recovery", "service.ts"),
    anchor: "function buildExecutionReviewParticipantRecoveryComment(",
    minBytes: 500_000,
    handoffs: [
      // buildExecutionReviewParticipantRecoveryComment + ...UnavailableComment
      { leadIn: '"restore the review stage, or "', knownSites: 2 },
      // the recovery-issue requiredAction bullet, review-participant arm
      { leadIn: 'with a live participant, or "', knownSites: 1 },
      // the recovery-horizon retirement discharge comment
      { leadIn: 'discharge or cancel this recovery action, or "', knownSites: 1 },
    ],
  },
  {
    label: "services/heartbeat.ts",
    path: join(SERVICES_DIR, "heartbeat.ts"),
    anchor: "function buildExecutionReviewParticipantRecoveryComment(",
    minBytes: 1_000_000,
    handoffs: [{ leadIn: '"restore the review stage, or "', knownSites: 1 }],
  },
];

function stripFullLineComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

function indexesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

describe("buildManualResolutionGuidance still says what this sweep assumes", () => {
  const guidance = buildManualResolutionGuidance(ISSUE_ID);

  it("still opens with the exact clause the sweep greps for", () => {
    // CONTROL. If this fails the clause was RENAMED, which makes every
    // "no bare clause remains" assertion below vacuously true. Update the
    // constant; do not delete the sweep.
    expect(guidance).toContain(BARE_CLAUSE);
  });

  it("carries the mounted route, so reaching the builder is sufficient", () => {
    // This is what lets the sweep assert on the CALL rather than on the prose:
    // a site that reaches the builder provably names the route.
    expect(guidance).toContain(issueRecoveryActionResolvePath(ISSUE_ID));
    expect(guidance).toContain("POST");
  });
});

for (const file of EMITTING_FILES) {
  describe(`${file.label} emits the manual-resolution clause only with its route`, () => {
    const source = readFileSync(file.path, "utf8");

    it("was actually read, so a clean result means clean and not absent", () => {
      expect(source.length).toBeGreaterThan(file.minBytes);
      expect(source).toContain(file.anchor);
    });

    it("carries no bare occurrence of the clause outside a comment", () => {
      const code = stripFullLineComments(source);
      expect(indexesOf(code, BARE_CLAUSE)).toEqual([]);
    });

    it("reaches the guidance builder", () => {
      expect(source).toContain("buildManualResolutionGuidance");
    });

    for (const handoff of file.handoffs) {
      it(`hands off to the builder after ${handoff.leadIn}`, () => {
        const sites = indexesOf(source, handoff.leadIn);
        // At least the known sites must survive: fewer means a site was deleted
        // or its prose rewritten, and the sweep would otherwise go quiet.
        expect(sites.length).toBeGreaterThanOrEqual(handoff.knownSites);
        for (const at of sites) {
          const window = source.slice(at, at + handoff.leadIn.length + HANDOFF_WINDOW);
          expect(window).toContain("buildManualResolutionGuidance(");
        }
      });
    }
  });
}
