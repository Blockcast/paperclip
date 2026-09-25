import { describe, expect, it } from "vitest";

import {
  extractRepoReferences,
  parseRepoIdentity,
  repoOwnerFromUrl,
} from "./repo-reference.js";

describe("extractRepoReferences — URL tiers (always accepted)", () => {
  it("extracts an https github URL", () => {
    const refs = extractRepoReferences("Fix lives in https://github.com/Blockcast/paperclip");
    expect(refs).toHaveLength(1);
    expect(refs[0].key).toBe("github.com/blockcast/paperclip");
    expect(refs[0].confidence).toBe("url");
  });

  it("strips a trailing .git and surrounding punctuation", () => {
    const refs = extractRepoReferences(
      "repoUrl:   https://github.com/Blockcast/trafficcontrol.git\n",
    );
    expect(refs.map((r) => r.slug)).toEqual(["blockcast/trafficcontrol"]);
  });

  it("extracts an scp-style ssh remote", () => {
    const refs = extractRepoReferences("clone git@github.com:Blockcast/onprem-k8s.git first");
    expect(refs.map((r) => r.slug)).toEqual(["blockcast/onprem-k8s"]);
  });

  it("extracts a scheme-less github.com reference", () => {
    const refs = extractRepoReferences("see github.com/Blockcast/magma for context");
    expect(refs.map((r) => r.slug)).toEqual(["blockcast/magma"]);
  });

  it("ignores deep paths beyond owner/repo but still captures the repo", () => {
    const refs = extractRepoReferences(
      "https://github.com/Blockcast/paperclip/blob/master/server/src/index.ts#L4",
    );
    expect(refs.map((r) => r.slug)).toEqual(["blockcast/paperclip"]);
  });

  it("does not treat github site routes as owners", () => {
    expect(extractRepoReferences("https://github.com/orgs/Blockcast")).toEqual([]);
    expect(extractRepoReferences("https://github.com/settings/tokens")).toEqual([]);
  });

  it("deduplicates the same repo mentioned several ways", () => {
    const refs = extractRepoReferences(
      "https://github.com/Blockcast/paperclip and git@github.com:Blockcast/paperclip.git",
    );
    expect(refs).toHaveLength(1);
  });
});

describe("extractRepoReferences — bare slugs need backticks plus evidence", () => {
  it("ignores an unquoted bare slug even with a cue word", () => {
    expect(extractRepoReferences("the repo is kkroo/paperclip-adapter-claude-k8s")).toEqual([]);
  });

  it("accepts a backticked slug when a repo cue word is nearby", () => {
    const refs = extractRepoReferences(
      "The code lives in `kkroo/paperclip-adapter-claude-k8s`, vendored at Dockerfile:399-405",
    );
    expect(refs.map((r) => r.slug)).toEqual(["kkroo/paperclip-adapter-claude-k8s"]);
    expect(refs[0].confidence).toBe("cued_slug");
  });

  it("accepts a backticked slug whose owner is already known to the company", () => {
    const refs = extractRepoReferences("touch `Blockcast/shaka-player` please", {
      knownOwners: ["Blockcast"],
    });
    expect(refs.map((r) => r.slug)).toEqual(["blockcast/shaka-player"]);
  });

  it("rejects a backticked slug with no cue word and an unknown owner", () => {
    expect(extractRepoReferences("bump `someone/thing` to v2")).toEqual([]);
  });

  it("does not let a cue word 200 chars away rescue a slug", () => {
    const far = `repository ${"x".repeat(200)} \`someone/thing\``;
    expect(extractRepoReferences(far)).toEqual([]);
  });
});

describe("extractRepoReferences — source paths must never fire", () => {
  const cases = [
    "`packages/db`",
    "`server/src`",
    "`deploy/helm`",
    "`ui/components`",
    "`.github/workflows`",
    "`docs/runbooks`",
    "`scripts/tests`",
    "`node_modules/foo`",
  ];
  for (const path of cases) {
    it(`ignores ${path} even next to a repo cue word`, () => {
      expect(extractRepoReferences(`in this repository, see ${path} for the change`)).toEqual([]);
    });
  }

  it("ignores a backticked file path that looks like a slug", () => {
    expect(extractRepoReferences("the repo file `foo/bar.ts` changed")).toEqual([]);
  });

  it("ignores single-character segments", () => {
    expect(extractRepoReferences("repo `a/b` here")).toEqual([]);
  });

  it("ignores a three-segment path in backticks", () => {
    expect(extractRepoReferences("repo `packages/db/src` here")).toEqual([]);
  });
});

describe("extractRepoReferences — misc", () => {
  it("returns nothing for empty or absent text", () => {
    expect(extractRepoReferences(null)).toEqual([]);
    expect(extractRepoReferences(undefined)).toEqual([]);
    expect(extractRepoReferences("")).toEqual([]);
    expect(extractRepoReferences("a description naming no repository at all")).toEqual([]);
  });

  it("orders URL matches ahead of cued slugs", () => {
    const refs = extractRepoReferences(
      "vendored `kkroo/adapter-thing` but fix https://github.com/Blockcast/paperclip",
    );
    expect(refs.map((r) => r.confidence)).toEqual(["url", "cued_slug"]);
  });

  it("prefers the URL match when the same repo appears both ways", () => {
    const refs = extractRepoReferences(
      "repo `Blockcast/paperclip` — https://github.com/Blockcast/paperclip",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].confidence).toBe("url");
  });
});

describe("extractRepoReferences — citations are not location claims", () => {
  // Each case below is a real false positive from the BLO-20341 sweep over
  // 100 live sub-issues.
  it("BLO-24543: ignores a pull-request link", () => {
    expect(
      extractRepoReferences(
        "AC4 is not satisfied by the predicate shipped in [#1203](https://github.com/Blockcast/paperclip/pull/1203).",
      ),
    ).toEqual([]);
  });

  it("BLO-23732: ignores an actions-run link", () => {
    expect(
      extractRepoReferences(
        "| [30991505142](https://github.com/Blockcast/shaka-player/actions/runs/30991505142) | success |",
      ),
    ).toEqual([]);
  });

  const citationPaths = ["issues/12", "commit/abc1234", "compare/a...b", "releases/tag/v1", "security/advisories"];
  for (const path of citationPaths) {
    it(`ignores a /${path.split("/")[0]} link`, () => {
      expect(extractRepoReferences(`see https://github.com/Blockcast/magma/${path} for detail`)).toEqual([]);
    });
  }

  it("still accepts a blob link, which names a code location", () => {
    const refs = extractRepoReferences(
      "the templating is at https://github.com/Blockcast/paperclip/blob/master/server/src/index.ts",
    );
    expect(refs.map((r) => r.slug)).toEqual(["blockcast/paperclip"]);
  });

  it("still accepts a plain repo link", () => {
    expect(
      extractRepoReferences("move it to https://github.com/Blockcast/paperclip").map((r) => r.slug),
    ).toEqual(["blockcast/paperclip"]);
  });

  it("ignores a truncated link that leaves a one-character repo name", () => {
    expect(extractRepoReferences("| [31303188009](https://github.com/Blockcast/s")).toEqual([]);
  });
});

describe("extractRepoReferences — branch names are not repos", () => {
  it("BLO-23599: ignores a branch name that looks like a slug", () => {
    expect(
      extractRepoReferences(
        "The stale shared workspace is a multicast checkout parked on `codex/blo-17910-settlement-core` — the branch of PR #386.",
      ),
    ).toEqual([]);
  });

  const branchy = ["`cto/blo-20341-guard`", "`feat/new-thing`", "`dependabot/npm_and_yarn/foo`", "`release/v2`"];
  for (const branch of branchy) {
    it(`ignores the branch-prefixed slug ${branch}`, () => {
      expect(extractRepoReferences(`the repo has a branch ${branch} open`)).toEqual([]);
    });
  }

  it("a git-ref cue beats a known owner", () => {
    expect(
      extractRepoReferences("rebase onto the `Blockcast/some-branch` ref", {
        knownOwners: ["Blockcast"],
      }),
    ).toEqual([]);
  });

  it("still accepts a known-owner slug with no git-ref cue", () => {
    expect(
      extractRepoReferences("swap `Blockcast/shaka-player` onto the canonical action", {
        knownOwners: ["Blockcast"],
      }).map((r) => r.slug),
    ).toEqual(["blockcast/shaka-player"]);
  });
});

describe("extractRepoReferences — the host must actually be github.com", () => {
  // Ally review on PR #1323: an unanchored host pattern matched any host
  // *ending* in github.com and read the next two path segments as owner/repo.
  // These land in the `url` tier, which no denylist or cue rule filters, so
  // each one used to fire an advisory naming a repository that does not exist.
  const notGithub = [
    "https://api.github.com/repos/Blockcast/paperclip/pulls/1323",
    "https://docs.github.com/en/actions/using-workflows",
    "https://gist.github.com/someuser/2f00e557e1da40262556496b5501fc6f4f9ec658",
    "https://raw.githubusercontent.com/Blockcast/paperclip/master/README.md",
    "mirror at notgithub.com/Blockcast/paperclip",
    "our fork at evilgithub.com/Blockcast/paperclip",
  ];
  for (const text of notGithub) {
    it(`ignores a non-github.com host: ${text}`, () => {
      expect(extractRepoReferences(text)).toEqual([]);
    });
  }

  it("still matches the real host in the shapes that occur in prose", () => {
    const cases: Array<[string, string]> = [
      ["https://github.com/Blockcast/paperclip", "blockcast/paperclip"],
      ["see github.com/Blockcast/magma for context", "blockcast/magma"],
      ["[the fix](https://github.com/Blockcast/frr)", "blockcast/frr"],
      ["<https://www.github.com/Blockcast/hindsight>", "blockcast/hindsight"],
      ["clone git@github.com:Blockcast/onprem-k8s.git", "blockcast/onprem-k8s"],
      ["repo:github.com/Blockcast/trafficcontrol", "blockcast/trafficcontrol"],
    ];
    for (const [text, slug] of cases) {
      expect(extractRepoReferences(text).map((r) => r.slug), text).toEqual([slug]);
    }
  });

  it("does not treat the REST `repos` prefix as an owner", () => {
    expect(
      extractRepoReferences("call github.com/repos/Blockcast/paperclip/pulls"),
    ).toEqual([]);
  });

  it("PCL-601: the `organizations` site route is not an owner", () => {
    // Found by the post-fix sweep: a runbook step linking the GitHub App
    // creation page read as owner `organizations`, repo `Blockcast`.
    expect(
      extractRepoReferences(
        "Browse to **<https://github.com/organizations/Blockcast/settings/apps/new>** and fill in:",
      ),
    ).toEqual([]);
  });
});

describe("parseRepoIdentity", () => {
  it("normalizes an https workspace repoUrl", () => {
    expect(parseRepoIdentity("https://github.com/Blockcast/paperclip.git")).toMatchObject({
      host: "github.com",
      owner: "Blockcast",
      repo: "paperclip",
      key: "github.com/blockcast/paperclip",
      slug: "blockcast/paperclip",
    });
  });

  it("normalizes an scp-style remote", () => {
    expect(parseRepoIdentity("git@github.com:Blockcast/trafficcontrol.git")?.key).toBe(
      "github.com/blockcast/trafficcontrol",
    );
  });

  it("normalizes an ssh:// remote", () => {
    expect(parseRepoIdentity("ssh://git@github.com/Blockcast/magma.git")?.key).toBe(
      "github.com/blockcast/magma",
    );
  });

  it("keeps a non-github host distinct", () => {
    expect(parseRepoIdentity("https://gitlab.com/Blockcast/paperclip.git")?.key).toBe(
      "gitlab.com/blockcast/paperclip",
    );
  });

  it("agrees with the extractor identity for the same repo", () => {
    const bound = parseRepoIdentity("https://github.com/Blockcast/paperclip.git");
    const [referenced] = extractRepoReferences("see https://github.com/Blockcast/paperclip");
    expect(referenced.key).toBe(bound?.key);
  });

  it("returns null for unusable input", () => {
    expect(parseRepoIdentity(null)).toBeNull();
    expect(parseRepoIdentity("")).toBeNull();
    expect(parseRepoIdentity("   ")).toBeNull();
    expect(parseRepoIdentity("not-a-url")).toBeNull();
    expect(parseRepoIdentity("https://github.com/onlyowner")).toBeNull();
  });

  it("exposes the owner for knownOwners seeding", () => {
    expect(repoOwnerFromUrl("https://github.com/Blockcast/paperclip.git")).toBe("Blockcast");
    expect(repoOwnerFromUrl(null)).toBeNull();
  });

  // Regression: every one of these was measured extracting a bogus `owner/repo`
  // in the 2026-08-15 sweep over 387 real child issues (BLO-20341). Together
  // they were 4 of the 5 references the cue tier accepted on an unknown owner,
  // and they caused 3 of 36 firings to be wholly spurious. `knownOwners` is
  // seeded here exactly as the guard seeds it, so the cue path is the only way
  // in — which is the path each of these has to be rejected by.
  describe("sweep-measured cue-tier false positives (BLO-20341)", () => {
    const knownOwners = new Set(["Blockcast", "kkroo", "paperclipai"]);
    const cases: [string, string][] = [
      ["review/ally-complete", "the `review/ally-complete` status on that repository is pending"],
      ["origin/main", "in this repository nothing is unpushed against `origin/main` right now"],
      ["origin/master", "the repo shows `origin/master` already carries the fix"],
      ["bgpd/bgp_mvpn.c", "upstream repo change lands in `bgpd/bgp_mvpn.c` for the MVPN path"],
    ];
    for (const [label, text] of cases) {
      it(`extracts nothing from ${label}`, () => {
        expect(extractRepoReferences(text, { knownOwners })).toEqual([]);
      });
    }

    it("still extracts a real known-owner slug from the same shaped prose", () => {
      const refs = extractRepoReferences("in this repository see `Blockcast/frr` for the port", {
        knownOwners,
      });
      expect(refs.map((ref) => ref.slug)).toEqual(["blockcast/frr"]);
    });
  });
});
