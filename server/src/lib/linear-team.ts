/**
 * Deterministic Linear team selection.
 *
 * BLO-31227: the OAuth callback and `/status` both used
 * `teams.nodes[0]` — the first element of an *unordered* GraphQL list — and
 * the callback wrote that guess straight into company identity
 * (`companies.issuePrefix` / `companies.issueCounter`). On the Blockcast
 * company the guess resolved to `EGY`, which would have rewritten the prefix
 * `BLO` -> `EGY` and moved the counter *backwards* 31222 -> 363, colliding
 * every subsequent identifier with 31k rows of existing history.
 *
 * Selection is therefore explicit, and ambiguity fails closed rather than
 * guessing. Companion guard (make a wrong choice non-destructive): BLO-31228.
 */

export interface LinearTeam {
  id: string;
  key: string;
  name?: string;
}

export type LinearTeamMatch = "configured-team-id" | "issue-prefix" | "sole-team";
export type LinearTeamFailure = "no-teams" | "ambiguous";

export type LinearTeamResolution =
  | { team: LinearTeam; matchedBy: LinearTeamMatch }
  | { team: null; reason: LinearTeamFailure; visible: LinearTeam[] };

export interface LinearTeamExpectation {
  /** `teamId` from the installed Linear plugin's config, when present. */
  configuredTeamId?: string | null;
  /** The company's current `issuePrefix`, matched against `team.key`. */
  issuePrefix?: string | null;
}

/**
 * Resolve which Linear team a connection is bound to.
 *
 * Order: configured plugin `teamId`; only when no `teamId` is configured,
 * the company's existing `issuePrefix`, then a sole visible team. Anything
 * else is ambiguous and returns no team.
 */
export function resolveLinearTeam(
  teams: readonly LinearTeam[],
  expectation: LinearTeamExpectation = {},
): LinearTeamResolution {
  const visible = [...teams];
  if (visible.length === 0) {
    return { team: null, reason: "no-teams", visible };
  }

  const configuredTeamId = expectation.configuredTeamId?.trim();
  if (configuredTeamId) {
    const byId = visible.find((team) => team.id === configuredTeamId);
    if (byId) return { team: byId, matchedBy: "configured-team-id" };
  }

  // A configured `teamId` that failed to match suppresses BOTH fallbacks: a
  // team with the same key in another workspace would otherwise be adopted
  // here, and its issue numbers would overwrite `issueCounter`.
  const prefix = expectation.issuePrefix?.trim().toUpperCase();
  if (prefix && !configuredTeamId) {
    const byPrefix = visible.find((team) => team.key.toUpperCase() === prefix);
    if (byPrefix) return { team: byPrefix, matchedBy: "issue-prefix" };
  }

  // A single visible team is not a choice — the token is scoped to it, so
  // there is no unordered list to guess from. But a configured `teamId` that
  // failed to match means the connection now points somewhere else; never
  // silently re-point company identity at a different workspace.
  if (visible.length === 1 && !configuredTeamId) {
    return { team: visible[0], matchedBy: "sole-team" };
  }

  return { team: null, reason: "ambiguous", visible };
}

/** Operator-facing message naming what to set so the next attempt resolves. */
export function linearTeamResolutionError(
  resolution: Extract<LinearTeamResolution, { team: null }>,
): string {
  if (resolution.reason === "no-teams") {
    return (
      "The Linear token can see no teams, so this connection cannot be bound to one. " +
      "Check that the OAuth app has read access to at least one team, then reconnect."
    );
  }
  const list = resolution.visible.map((team) => `${team.key} (${team.id})`).join(", ");
  return (
    "Could not determine which Linear team this connection is for, so it was refused " +
    "rather than guessed — guessing would overwrite this company's issue prefix and " +
    `issue counter. Visible teams: ${list}. Set the Linear plugin's "teamId" to one of ` +
    "those ids (or, if no teamId is set, align the company's issue prefix with one of " +
    "those keys), then reconnect."
  );
}
