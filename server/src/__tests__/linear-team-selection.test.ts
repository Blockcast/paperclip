import { describe, expect, it } from "vitest";
import {
  linearTeamResolutionError,
  resolveLinearTeam,
  type LinearTeam,
} from "../lib/linear-team.js";

// BLO-31227: both the Linear OAuth callback and `/status` selected a team with
// `teams.nodes[0]`. Linear's `teams` query returns every team the token can
// see, with no ordering guarantee, and the callback wrote that guess into
// company identity. On the Blockcast company it resolved to `EGY`, which would
// have rewritten `issuePrefix` BLO -> EGY and moved `issueCounter` BACKWARDS
// 31222 -> 363 — colliding every new identifier with 31k rows of history.
//
// The failure direction is the expensive one: the wrong team is reported
// confidently, reads as a real scoping of the connection, and sends anyone
// debugging it after the wrong problem. So the regression that matters is
// ordering: the configured team must win even when it is not first.

const BLO: LinearTeam = { id: "0241f28e-e546-48d9-a1a2-c1655adf9ba4", key: "BLO", name: "Blockcast" };
const EGY: LinearTeam = { id: "11111111-1111-1111-1111-111111111111", key: "EGY", name: "Egypt" };

describe("resolveLinearTeam", () => {
  it("selects the configured team when it is NOT first in the response", () => {
    // The exact BLO-31227 shape: >= 2 teams, configured team last.
    const resolution = resolveLinearTeam([EGY, BLO], { configuredTeamId: BLO.id });
    expect(resolution.team?.key).toBe("BLO");
    expect(resolution.team?.id).toBe(BLO.id);
    expect(resolution).toMatchObject({ matchedBy: "configured-team-id" });
  });

  it("is independent of list order", () => {
    for (const order of [[EGY, BLO], [BLO, EGY]] as LinearTeam[][]) {
      expect(resolveLinearTeam(order, { configuredTeamId: BLO.id }).team?.key).toBe("BLO");
    }
  });

  it("falls back to the company issue prefix when no team id is configured", () => {
    const resolution = resolveLinearTeam([EGY, BLO], { issuePrefix: "blo" });
    expect(resolution.team?.key).toBe("BLO");
    expect(resolution).toMatchObject({ matchedBy: "issue-prefix" });
  });

  it("prefers the configured team id over the issue prefix", () => {
    const resolution = resolveLinearTeam([EGY, BLO], {
      configuredTeamId: EGY.id,
      issuePrefix: "BLO",
    });
    expect(resolution.team?.key).toBe("EGY");
  });

  it("fails closed when several teams are visible and nothing matches", () => {
    const resolution = resolveLinearTeam([EGY, BLO], { issuePrefix: "NOPE" });
    expect(resolution.team).toBeNull();
    expect(resolution).toMatchObject({ reason: "ambiguous" });
  });

  it("fails closed when several teams are visible and nothing is configured", () => {
    const resolution = resolveLinearTeam([EGY, BLO]);
    expect(resolution.team).toBeNull();
    expect(resolution).toMatchObject({ reason: "ambiguous" });
  });

  it("accepts a sole visible team when nothing is configured (first connect)", () => {
    const resolution = resolveLinearTeam([EGY], { issuePrefix: "BLO" });
    expect(resolution.team?.key).toBe("EGY");
    expect(resolution).toMatchObject({ matchedBy: "sole-team" });
  });

  it("refuses a sole visible team that contradicts a configured team id", () => {
    // The connection moved to another workspace: never silently re-point.
    const resolution = resolveLinearTeam([EGY], { configuredTeamId: BLO.id });
    expect(resolution.team).toBeNull();
    expect(resolution).toMatchObject({ reason: "ambiguous" });
  });

  it("refuses a same-key team when the configured team id is not visible", () => {
    // Key collision across workspaces: the prefix matches, the team does not.
    const otherBlo: LinearTeam = { id: "22222222-2222-2222-2222-222222222222", key: "BLO" };
    for (const visible of [[EGY, otherBlo], [otherBlo]] as LinearTeam[][]) {
      const resolution = resolveLinearTeam(visible, { configuredTeamId: BLO.id, issuePrefix: "BLO" });
      expect(resolution.team).toBeNull();
      expect(resolution).toMatchObject({ reason: "ambiguous" });
    }
  });

  it("reports no-teams distinctly from ambiguous", () => {
    const resolution = resolveLinearTeam([], { configuredTeamId: BLO.id });
    expect(resolution).toMatchObject({ team: null, reason: "no-teams" });
  });

  it("ignores blank configuration rather than treating it as a match", () => {
    const resolution = resolveLinearTeam([EGY, BLO], { configuredTeamId: "  ", issuePrefix: "  " });
    expect(resolution.team).toBeNull();
  });
});

describe("linearTeamResolutionError", () => {
  it("names every visible team and id so the operator can set one", () => {
    const resolution = resolveLinearTeam([EGY, BLO]);
    expect(resolution.team).toBeNull();
    if (resolution.team !== null) throw new Error("expected an unresolved team");

    const message = linearTeamResolutionError(resolution);
    expect(message).toContain("EGY");
    expect(message).toContain(EGY.id);
    expect(message).toContain("BLO");
    expect(message).toContain(BLO.id);
    expect(message).toContain("teamId");
  });

  it("explains the no-teams case separately", () => {
    const resolution = resolveLinearTeam([]);
    if (resolution.team !== null) throw new Error("expected an unresolved team");
    expect(linearTeamResolutionError(resolution)).toContain("no teams");
  });
});
