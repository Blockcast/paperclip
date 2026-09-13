import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-3157: the egress scrub must be on the path of every server-side GitHub
 * write that can carry authored text.
 *
 * ## The gap this pins shut
 *
 * PEN-2527 scrubbed the `gh` binary. PEN-3152 scrubbed `github-mcp-server`.
 * Both reasoned about the agent sandbox. But `paperclip-api` writes to GitHub
 * over HTTP from `server/`, reaching no wrapper — and `scrubGitHubEgressText`
 * was not re-exported from `packages/adapter-utils`'s barrel, so it was
 * structurally unreachable from server code even by a caller who wanted it.
 * `grep -rn 'scrubGitHubEgressText' server` returned nothing at all.
 *
 * The same shape produced the gap twice: a scrub applied per-caller closes only
 * the callers someone remembered. So these assertions are aimed at the two
 * write helpers in `github-app-auth.ts` rather than at their callers. Those two
 * functions are the only way this service puts authored text on GitHub, so
 * covering them covers every present and future caller.
 *
 * ## What a passing run here does and does not establish
 *
 * It establishes that credential-shaped strings handed to either helper do not
 * reach `fetch` intact. It does NOT establish that the detectors catch any
 * particular secret — that is `github-egress-scrub.test.ts`'s job, over the
 * same shared detector set. Nor does it say anything has ever leaked.
 *
 * ## Fixtures are assembled from parts, deliberately
 *
 * No contiguous credential-shaped literal appears in this file. A pasteable
 * `ghp_…` would be a real-looking token in a tracked file: GitHub push
 * protection pattern-matches on shape rather than validity, and PEN-3156 is
 * adding a refusal at the git publish boundary that would reject this very
 * file. The parts are joined at runtime, where only the detectors see them.
 */

const h = vi.hoisted(() => ({
  cfg: {
    githubAppId: "",
    githubAppInstallationId: "",
    githubAppPrivateKey: "",
    prReviewerBotLogin: "allyblockcast[bot]",
  } as Record<string, string>,
}));

vi.mock("../config.js", () => ({ loadConfig: () => h.cfg }));

import {
  githubPostCommitStatusDetailed,
  githubPostIssueComment,
  _resetInstallationTokenCache,
} from "../services/github-app-auth.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const FUTURE_ISO = "2999-01-01T00:00:00Z";

const REPO = "Blockcast/paperclip";
const SHA = "45eb633e348a826f43dc68b0c25fe83a96300cea";

const OPAQUE_TAIL = "A1b2C3d4E5f6G7h8I9j0K1l2";
/** Shape of a GitHub PAT: `gh[pousr]_` + 20 or more token characters. */
const FAKE_GITHUB_PAT = ["gh", "p_", OPAQUE_TAIL].join("");
/** Shape of an AWS access key id: `AKIA` + exactly 16 uppercase/digits. */
const FAKE_AWS_KEY_ID = ["AK", "IA", "IOSFODNN7DUMMYXQ"].join("");
/** Short on purpose: under the 20-char vendor-key tail, so this fixture can
 *  only be caught as a credentialed URI and the assertion stays honest. */
const FAKE_URI_SECRET = ["gh", "s_", "faketoken"].join("");

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, headers: new Headers(), json: async () => data } as unknown as Response;
}

function stubGitHub() {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/access_tokens")) {
      return jsonResponse({ token: ["gh", "s_test"].join(""), expires_at: FUTURE_ISO });
    }
    if (u.includes("/statuses/") || u.includes("/comments")) return jsonResponse({ id: 1 }, true, 201);
    throw new Error(`unexpected url ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setCreds() {
  h.cfg.githubAppId = "3966421";
  h.cfg.githubAppInstallationId = "12345678";
  h.cfg.githubAppPrivateKey = PRIVATE_KEY_PEM;
}

/** The JSON body of the single write call, whichever endpoint it hit. */
function writtenBody(fetchMock: ReturnType<typeof stubGitHub>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => {
    const u = String(url);
    return u.includes("/statuses/") || u.includes("/comments");
  });
  expect(call, "no write reached fetch").toBeDefined();
  return JSON.parse(((call as unknown[])[1] as { body?: string }).body ?? "{}");
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetInstallationTokenCache();
  h.cfg.githubAppId = "";
  h.cfg.githubAppInstallationId = "";
  h.cfg.githubAppPrivateKey = "";
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("githubPostIssueComment egress scrub", () => {
  it("redacts a private key from the comment body rather than publishing it", async () => {
    setCreds();
    const fetchMock = stubGitHub();
    await expect(
      githubPostIssueComment({
        repoFullName: REPO,
        prNumber: 7,
        body: `Here is the runbook:\n${PRIVATE_KEY_PEM}\nrotate it.`,
      }),
    ).resolves.toBe(true);

    const body = String(writtenBody(fetchMock).body);
    expect(body).not.toContain(PRIVATE_KEY_PEM);
    expect(body).toContain("[paperclip-egress-scrub redacted: private-key-block]");
    // The surrounding prose is the point of the comment and must survive.
    expect(body).toContain("Here is the runbook:");
    expect(body).toContain("rotate it.");
  });

  it("redacts a vendor token from the comment body", async () => {
    setCreds();
    const fetchMock = stubGitHub();
    await githubPostIssueComment({
      repoFullName: REPO,
      prNumber: 7,
      body: `the token is ${FAKE_GITHUB_PAT} — revoke it`,
    });
    const body = String(writtenBody(fetchMock).body);
    expect(body).not.toContain(FAKE_GITHUB_PAT);
    expect(body).toContain("[paperclip-egress-scrub redacted: vendor-key]");
  });

  it("passes ordinary prose through byte-for-byte", async () => {
    setCreds();
    const fetchMock = stubGitHub();
    const original = "Linked to PEN-3157. Head 81e0218 — see server/src/services/github-fetch.ts:19.";
    await githubPostIssueComment({ repoFullName: REPO, prNumber: 7, body: original });
    expect(writtenBody(fetchMock).body).toBe(original);
  });

  it("names the class it removed without reprinting the secret", async () => {
    // A log line quoting the match would republish the secret into the very
    // run transcripts PEN-3139 is narrowing — moving a leak rather than
    // closing it.
    setCreds();
    stubGitHub();
    await githubPostIssueComment({
      repoFullName: REPO,
      prNumber: 7,
      body: `token ${FAKE_GITHUB_PAT}`,
    });
    const logged = warnSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("vendor-key");
    expect(logged).not.toContain(FAKE_GITHUB_PAT);
  });
});

describe("githubPostCommitStatusDetailed egress scrub", () => {
  it("redacts a credential-shaped description before it reaches GitHub", async () => {
    setCreds();
    const fetchMock = stubGitHub();
    await githubPostCommitStatusDetailed({
      repoFullName: REPO,
      sha: SHA,
      context: "review/ally-complete",
      state: "failure",
      description: `unrecognized ledger verb "${FAKE_AWS_KEY_ID}"`,
    });
    const description = String(writtenBody(fetchMock).description);
    expect(description).not.toContain(FAKE_AWS_KEY_ID);
    expect(description).toContain("[paperclip-egress-scrub redacted: vendor-key]");
  });

  it("scrubs BEFORE the 140-character trim, not after", async () => {
    // Order matters and is not cosmetic. Trimming first can cut a token in
    // half; half a vendor key matches no detector, and what survives the cut is
    // still most of the secret.
    //
    // Only a token that straddles the cap can tell the two orders apart. If it
    // sits entirely inside 140 chars both orders redact it, and if it is cut
    // short enough to stop matching, trim-first drops it by truncation — which
    // looks like success for the wrong reason. So the fixture is sized to put
    // the token past the cap with fewer than 20 tail characters surviving a
    // trim, below what VENDOR_KEY_RE needs:
    //
    //   trim-then-scrub -> 117 filler + "gh"+"p_" + 19 chars -> no match, NO marker
    //   scrub-then-trim -> 117 filler + a marker, cut at 140  -> marker PREFIX
    //
    // The marker is necessarily truncated for the same reason it is diagnostic:
    // it begins where the token began, past the cap. A prefix is therefore the
    // strongest available evidence, not a weakened assertion.
    setCreds();
    const fetchMock = stubGitHub();
    // Ends in a space on purpose: VENDOR_KEY_RE is `\b`-anchored, and a token
    // glued to a word character does not match. Filler of `x` with no separator
    // silently produces a no-scrub run that reads like a trim-order failure.
    const filler = `${"x".repeat(116)} `;
    const raw = `${filler}${FAKE_GITHUB_PAT}`;
    expect(filler).toHaveLength(117);
    expect(raw.length).toBeGreaterThan(140);
    await githubPostCommitStatusDetailed({
      repoFullName: REPO,
      sha: SHA,
      context: "review/ally-complete",
      state: "failure",
      description: raw,
    });
    const description = String(writtenBody(fetchMock).description);
    expect(description.length).toBeLessThanOrEqual(140);
    expect(description).not.toContain(FAKE_GITHUB_PAT);
    expect(description).toContain("[paperclip-egress-scrub");
  });

  it("leaves an ordinary gate verdict and target URL untouched", async () => {
    setCreds();
    const fetchMock = stubGitHub();
    const description =
      "Ally's most recent consolidated-review comment for this head reports no unresolved findings.";
    const targetUrl = "https://github.com/Blockcast/paperclip/pull/1747";
    await githubPostCommitStatusDetailed({
      repoFullName: REPO,
      sha: SHA,
      context: "review/ally-complete",
      state: "success",
      description,
      targetUrl,
    });
    expect(writtenBody(fetchMock)).toEqual({
      state: "success",
      context: "review/ally-complete",
      description,
      target_url: targetUrl,
    });
  });

  it("redacts a credential embedded in target_url", async () => {
    // A credentialed URI is the one shape an "it's only a URL" field carries.
    setCreds();
    const fetchMock = stubGitHub();
    await githubPostCommitStatusDetailed({
      repoFullName: REPO,
      sha: SHA,
      context: "review/ally-complete",
      state: "success",
      targetUrl: `https://x-access-token:${FAKE_URI_SECRET}@github.com/Blockcast/paperclip`,
    });
    const targetUrl = String(writtenBody(fetchMock).target_url);
    expect(targetUrl).not.toContain(FAKE_URI_SECRET);
    expect(targetUrl).toContain("[paperclip-egress-scrub redacted: credentialed-uri]");
  });
});

describe("the scrub is reachable from server/ at all", () => {
  it("is exported from the adapter-utils barrel", () => {
    // The mechanical fact PEN-3157 turned on: `server/` imports the package by
    // name, and before this export the scrub could not be named from server
    // code. This is the counterpart of the assertion in
    // `github-egress-outbound-coverage.test.ts` that recorded the scrub as
    // structurally unreachable — that one was written to fail at exactly this
    // moment, and this is the moment.
    const barrel = readFileSync(path.join(repoRoot, "packages/adapter-utils/src/index.ts"), "utf8");
    expect(barrel).toContain("github-egress-scrub.js");
    expect(barrel).toContain("scrubGitHubEgressText");
  });

  it("is applied inside the write helpers, not at their call sites", () => {
    // A per-call-site scrub is the shape that produced this gap twice. If a
    // future change moves the scrub out to the callers, this fails.
    const source = readFileSync(path.join(repoRoot, "server/src/services/github-app-auth.ts"), "utf8");
    const commentHelper = source.slice(source.indexOf("export async function githubPostIssueComment"));
    expect(commentHelper).toContain("scrubOutboundGitHubText(input.body");
    const statusHelper = source.slice(
      source.indexOf("export async function githubPostCommitStatusDetailed"),
    );
    expect(statusHelper).toContain("scrubOutboundGitHubText(input.description");
  });

  it("leaves no server-side GitHub writer outside the scrub", () => {
    // Derived from source at file granularity, the same way PEN-3152's outbound
    // coverage table derives its writer set: a `ghFetch(` call plus a mutating
    // method. A NEW service file that starts writing to GitHub fails here until
    // it either routes through the shared helpers or calls the scrub itself.
    //
    // Enumerate-then-filter rather than grepping for an expected name: a
    // pathspec that matches nothing returns the same empty set as "everything
    // is covered", and that failure mode is silent.
    const servicesDir = path.join(repoRoot, "server/src/services");
    const writers: string[] = [];
    for (const entry of readdirSync(servicesDir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const source = readFileSync(path.join(servicesDir, entry), "utf8");
      if (!source.includes("ghFetch(")) continue;
      if (!/method:\s*"(?:POST|PATCH|PUT|DELETE)"/.test(source)) continue;
      writers.push(entry);
    }
    // Positive control: the derivation must actually find the file we know
    // writes, or an empty `writers` would make the assertion below vacuous.
    expect(writers).toContain("github-app-auth.ts");

    for (const writer of writers) {
      const source = readFileSync(path.join(servicesDir, writer), "utf8");
      expect(source, `${writer} writes to GitHub without reaching the egress scrub`).toContain(
        "scrubOutboundGitHubText",
      );
    }
  });
});

describe("unrecognized ledger verbs cannot carry a credential (PEN-3157 #3)", () => {
  it("admits only lowercase letters and hyphens as a disposition verb", () => {
    // PEN-3157 filed this as a live leak of model-authored text: the verb is
    // lifted verbatim out of an Ally review comment body and interpolated, in
    // quotes, into a public commit-status description. Re-reading the parser
    // corrected that. The verb is unbounded in LENGTH but not in ALPHABET, and
    // the alphabet is what decides whether a credential fits. This pins the
    // alphabet, because widening it is the change that would make the original
    // filing true.
    //
    // `([a-z][a-z-]*)` is the fourth capture group of
    // PRIOR_FINDING_DISPOSITION_PATTERN, and the single `disposition:` write in
    // extractAllyPriorFindingDispositions is the only producer of the value.
    const source = readFileSync(
      path.join(repoRoot, "server/src/services/ally-review-detection.ts"),
      "utf8",
    );
    const pattern = /PRIOR_FINDING_DISPOSITION_PATTERN[\s\S]{0,600}?"gim"/.exec(source);
    expect(pattern, "PRIOR_FINDING_DISPOSITION_PATTERN moved or changed shape").not.toBeNull();
    expect((pattern as RegExpExecArray)[0]).toContain("([a-z][a-z-]*)");
  });

  it("is a class no credential shape the scrubber knows can satisfy", () => {
    // Cross-check the claim instead of asserting it in prose: every vendor
    // shape needs a character outside [a-z-].
    for (const sample of [FAKE_GITHUB_PAT, FAKE_AWS_KEY_ID, "eyJhbGciOiJIUzI1NiJ9"]) {
      expect(/^[a-z][a-z-]*$/.test(sample)).toBe(false);
    }
  });
});
