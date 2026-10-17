import { describe, expect, it } from "vitest";
import {
  compareProjectCheckoutOrigin,
  normalizeRepoIdentity,
} from "./project-checkout-origin.js";
import {
  classifyWorkspaceReuseRefusal,
  ORIGIN_MISMATCH_MARKER,
} from "./workspace-reuse-refusal-class.js";

const CWD = "/paperclip/instances/default/projects/b1d3f3d3/1eb0ea12/penstock-llm-proxy-core";
const HTTPS = "https://github.com/Blockcast/penstock-llm-proxy-core.git";
const SSH = "git@github.com:Blockcast/penstock-llm-proxy-core.git";
/** The repository PEN-3628's checkout was actually pointed at. */
const WRONG = "https://github.com/Blockcast/paperclip.git";

describe("normalizeRepoIdentity", () => {
  it.each([
    ["https with .git", HTTPS],
    ["https without .git", "https://github.com/Blockcast/penstock-llm-proxy-core"],
    ["https with trailing slash", "https://github.com/Blockcast/penstock-llm-proxy-core/"],
    ["scp-style ssh", SSH],
    ["ssh:// url", "ssh://git@github.com/Blockcast/penstock-llm-proxy-core.git"],
    ["lowercased owner", "https://github.com/blockcast/penstock-llm-proxy-core.git"],
    ["uppercased repo", "https://github.com/Blockcast/Penstock-LLM-Proxy-Core.git"],
    ["surrounding whitespace", `  ${HTTPS}\n`],
  ])("reduces %s to owner/repo", (_label, input) => {
    expect(normalizeRepoIdentity(input)).toBe("blockcast/penstock-llm-proxy-core");
  });

  it.each([null, undefined, "", "   "])("returns null for %p", (input) => {
    expect(normalizeRepoIdentity(input)).toBeNull();
  });

  it("does not collapse different repositories in the same org", () => {
    expect(normalizeRepoIdentity(WRONG)).not.toBe(normalizeRepoIdentity(HTTPS));
  });
});

describe("compareProjectCheckoutOrigin", () => {
  /**
   * THE NEGATIVE CONTROL, and the single most important assertion in this file.
   *
   * `/paperclip/.gitconfig` carries
   * `url.git@github.com:Blockcast/.insteadOf = https://github.com/Blockcast/`,
   * so `git remote -v` prints the SSH form on every healthy Blockcast checkout
   * while `repo_url` in the database is HTTPS. A reconciler that compared those
   * verbatim would fire on EVERY healthy Blockcast checkout in the estate --
   * 565 issues' worth on the measured project alone. A detector that cannot
   * pass this is worse than none.
   */
  it("does not fire when the stored origin is the SSH form of an HTTPS repo_url", () => {
    expect(
      compareProjectCheckoutOrigin({ cwd: CWD, expectedRepoUrl: HTTPS, actualUrl: SSH }),
    ).toEqual({ state: "match", identity: "blockcast/penstock-llm-proxy-core" });
  });

  it("does not fire on the identical-URL healthy case", () => {
    expect(
      compareProjectCheckoutOrigin({ cwd: CWD, expectedRepoUrl: HTTPS, actualUrl: HTTPS }),
    ).toMatchObject({ state: "match" });
  });

  it("does not fire when repo_url is SSH and the checkout stores HTTPS", () => {
    expect(
      compareProjectCheckoutOrigin({ cwd: CWD, expectedRepoUrl: SSH, actualUrl: HTTPS }),
    ).toMatchObject({ state: "match" });
  });

  it("fires on the PEN-3628 repointing, carrying both URLs verbatim", () => {
    const verdict = compareProjectCheckoutOrigin({
      cwd: CWD,
      expectedRepoUrl: HTTPS,
      actualUrl: WRONG,
    });
    expect(verdict).toMatchObject({
      state: "mismatch",
      cwd: CWD,
      actualUrl: WRONG,
      expectedRepoUrl: HTTPS,
      actualIdentity: "blockcast/paperclip",
      expectedIdentity: "blockcast/penstock-llm-proxy-core",
    });
  });

  it("fires when only the owner differs", () => {
    expect(
      compareProjectCheckoutOrigin({
        cwd: CWD,
        expectedRepoUrl: HTTPS,
        actualUrl: "https://github.com/attacker/penstock-llm-proxy-core.git",
      }),
    ).toMatchObject({ state: "mismatch" });
  });

  /**
   * The mismatch sentence is the one PEN-3633 item 3's aggregator buckets on.
   * Building it anywhere other than `formatOriginMismatchRefusal` would create
   * a refusal that aggregator cannot see, so round-trip it through the
   * classifier rather than asserting the string.
   */
  it("builds a message the body-bucketed refusal classifier recognises", () => {
    const verdict = compareProjectCheckoutOrigin({
      cwd: CWD,
      expectedRepoUrl: HTTPS,
      actualUrl: WRONG,
    });
    expect(verdict.state).toBe("mismatch");
    if (verdict.state !== "mismatch") return;
    expect(verdict.message).toContain(ORIGIN_MISMATCH_MARKER);
    expect(classifyWorkspaceReuseRefusal(verdict.message)).toBe("origin_mismatch");
    expect(verdict.message).toContain(WRONG);
    expect(verdict.message).toContain(HTTPS);
  });

  it.each([
    ["an unreadable origin", HTTPS, null, "origin_unreadable"],
    ["an empty origin", HTTPS, "", "origin_unreadable"],
    ["no expected repo_url", null, HTTPS, "no_expected_repo_url"],
    ["neither side known", null, null, "no_expected_repo_url"],
  ])("reports %s as unknown rather than as a match", (_label, expected, actual, reason) => {
    expect(
      compareProjectCheckoutOrigin({ cwd: CWD, expectedRepoUrl: expected, actualUrl: actual }),
    ).toEqual({ state: "unknown", reason });
  });
});
