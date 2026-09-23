import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  productionFilesImportingTestHelpers,
  serverFilesWritingToGitHub,
  serverSourceFiles,
} from "./helpers/github-writer-derivation.js";

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
 * the callers someone remembered. So these assertions are aimed at the write
 * helpers in `github-app-auth.ts` rather than at their callers. Those helpers
 * are the only way this service puts authored text on GitHub, so covering them
 * covers every present and future caller. `githubPostCheckRun` (BLO-33657)
 * landed after the first two were scrubbed and is held to the same rule: a
 * check-run `summary` is the same verdict prose a status description carries,
 * with no 140-char cap.
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
  githubPostCheckRun,
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
    if (u.includes("/statuses/") || u.includes("/comments") || u.includes("/check-runs")) {
      return jsonResponse({ id: 1 }, true, 201);
    }
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
    return u.includes("/statuses/") || u.includes("/comments") || u.includes("/check-runs");
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

describe("githubPostCheckRun egress scrub", () => {
  it("redacts a credential-shaped summary, which has no 140-char cap to hide behind", async () => {
    // The check-run summary is `verdict.reason` — the very text the commit
    // status description carries — but GitHub does not truncate it, so an
    // unscrubbed check-run publishes MORE of a leaked value than the status.
    setCreds();
    const fetchMock = stubGitHub();
    await githubPostCheckRun({
      repoFullName: REPO,
      sha: SHA,
      name: "review/ally-complete",
      conclusion: "failure",
      title: "Unresolved finding at this head",
      summary: `${"x".repeat(200)} unrecognized ledger verb "${FAKE_AWS_KEY_ID}"`,
    });
    const output = writtenBody(fetchMock).output as { title: string; summary: string };
    expect(output.summary).not.toContain(FAKE_AWS_KEY_ID);
    expect(output.summary).toContain("[paperclip-egress-scrub redacted: vendor-key]");
    expect(output.summary.length).toBeGreaterThan(140);
    expect(output.title).toBe("Unresolved finding at this head");
  });

  it("leaves an ordinary check-run untouched", async () => {
    setCreds();
    const fetchMock = stubGitHub();
    const summary =
      "Ally's most recent consolidated-review comment for this head reports no unresolved findings.";
    await githubPostCheckRun({
      repoFullName: REPO,
      sha: SHA,
      name: "review/ally-complete",
      conclusion: "success",
      title: "Reviewed at this head — no unresolved findings",
      summary,
      detailsUrl: "https://github.com/Blockcast/paperclip/pull/1754",
    });
    expect(writtenBody(fetchMock)).toEqual({
      name: "review/ally-complete",
      head_sha: SHA,
      status: "completed",
      conclusion: "success",
      output: { title: "Reviewed at this head — no unresolved findings", summary },
      details_url: "https://github.com/Blockcast/paperclip/pull/1754",
    });
  });
});

describe("identity fields are refused, not redacted (PEN-3391)", () => {
  /**
   * PEN-3391 done-when 3/4: `context` was scrubbed on the way out while the
   * delivery outbox keyed its upsert on the RAW value and
   * `githubGetLatestCommitStatusForContext` filtered on the RAW value. Had a
   * context ever matched a detector, the status would have been published under
   * a redacted name while every lookup used the unredacted one — the gate
   * unable to observe its own status.
   *
   * The resolution is neither "scrub everywhere" nor "exempt it": the write is
   * REFUSED when the identity would change. That keeps the leak closed AND
   * makes publish/lookup agreement structural — the write proceeds only when
   * the scrub is a no-op, so a caller keying on the raw value is provably
   * keying on what was published.
   *
   * These tests exist so a later "make the scrub consistent" refactor cannot
   * silently flip it back. The row asked for exactly that pin.
   */
  it("refuses a commit status whose context carries credential-shaped material", async () => {
    setCreds();
    const fetchMock = stubGitHub();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await githubPostCommitStatusDetailed({
      repoFullName: REPO,
      sha: SHA,
      context: `review/${FAKE_GITHUB_PAT}`,
      state: "success",
      description: "ok",
    });

    expect(result).toEqual({
      ok: false,
      retryable: false,
      reason: "commit_status_context_not_publishable",
    });
    // Nothing was published — not a redacted status, nothing at all.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/statuses/")),
      "a status was published despite the refusal",
    ).toHaveLength(0);
    // Non-retryable is load-bearing: the same input scrubs the same way every
    // time, so a retrying caller would spin forever on a configuration bug.
    expect(errorSpy).toHaveBeenCalled();
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("REFUSED");
    // The log must name the classes, never the matched text — quoting it would
    // re-publish the secret into the transcripts PEN-3139 is narrowing.
    expect(logged).not.toContain(FAKE_GITHUB_PAT);
  });

  it("refuses a check-run whose name carries credential-shaped material", async () => {
    setCreds();
    const fetchMock = stubGitHub();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await githubPostCheckRun({
      repoFullName: REPO,
      sha: SHA,
      name: `verify-${FAKE_AWS_KEY_ID}`,
      conclusion: "success",
      title: "t",
      summary: "s",
    });

    expect(result).toEqual({
      ok: false,
      retryable: false,
      reason: "check_run_name_not_publishable",
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/check-runs")),
    ).toHaveLength(0);
  });

  it("publishes an ordinary context and name byte-for-byte, so lookups still match", async () => {
    // The other half of the pin, and the one that makes the refusal safe to
    // ship: the overwhelmingly common path must be untouched. A required
    // context is matched by exact string, so any rewriting here — including a
    // well-meaning normalisation — breaks branch protection silently.
    setCreds();
    const fetchMock = stubGitHub();

    await expect(
      githubPostCommitStatusDetailed({
        repoFullName: REPO,
        sha: SHA,
        context: "review/ally-complete",
        state: "success",
        description: "Ally reviewed this head, clean.",
      }),
    ).resolves.toEqual({ ok: true, statusCode: 201 });

    expect(writtenBody(fetchMock).context).toBe("review/ally-complete");
  });

  it("keeps the outbox key and the lookup filter equal to what was published", () => {
    // The disagreement PEN-3391 names is between three sites, so pin the
    // invariant that ties them rather than restating one of them: the outbox
    // persists `input.context` verbatim and the lookup filters on
    // `input.context`, and both are now correct precisely because the write
    // helper publishes `input.context` unchanged or not at all.
    const appAuth = readFileSync(
      path.join(repoRoot, "server/src/services/github-app-auth.ts"),
      "utf8",
    );
    const statusHelper = appAuth.slice(
      appAuth.indexOf("export async function githubPostCommitStatusDetailed"),
    );
    // Refused, not redacted. If someone reintroduces the scrub here, the outbox
    // key and the published context diverge again — and this fails.
    expect(statusHelper).not.toContain('scrubOutboundGitHubText(input.context');
    expect(statusHelper).toContain('gitHubIdentityFieldRedaction(input.context');

    const lookupHelper = appAuth.slice(
      appAuth.indexOf("export async function githubGetLatestCommitStatusForContext"),
    );
    expect(lookupHelper).toContain("status.context === input.context");

    const outbox = readFileSync(
      path.join(repoRoot, "server/src/services/github-status-delivery-outbox.ts"),
      "utf8",
    );
    expect(outbox).toContain("context: input.context");
  });

  it("applies the same refusal to the one writer outside the shared helper", () => {
    // github-review-gate-authority.ts builds its own request, so it is the
    // place a per-call-site control goes stale. It scrubs its prose fields and
    // must refuse on its identity field, exactly like the shared helper.
    const authority = readFileSync(
      path.join(repoRoot, "server/src/services/github-review-gate-authority.ts"),
      "utf8",
    );
    expect(authority).toContain("gitHubIdentityFieldRedaction(input.row.statusContext");
    expect(authority).not.toContain("scrubOutboundGitHubText(input.row.statusContext");
    // Its prose fields stay scrubbed — the refusal narrows nothing.
    expect(authority).toContain('"commit-status description"');
    expect(authority).toContain('"commit-status target_url"');
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
    const checkRunHelper = source.slice(source.indexOf("export async function githubPostCheckRun"));
    expect(checkRunHelper).toContain("scrubOutboundGitHubText(input.summary");
    expect(checkRunHelper).toContain("scrubOutboundGitHubText(input.title");
  });

  it("leaves no server-side GitHub writer outside the scrub", () => {
    // Derived from source at file granularity, the same way PEN-3152's outbound
    // coverage table derives its writer set — and now from the SAME function, in
    // `helpers/github-writer-derivation.ts`. The two copies were byte-identical
    // and were widened by hand in lockstep once already (PEN-3157); PEN-3391
    // extracted them so the next widening cannot reach only one.
    //
    // Enumerate-then-filter rather than grepping for an expected name: a
    // pathspec that matches nothing returns the same empty set as "everything
    // is covered", and that failure mode is silent.
    //
    // The walk is RECURSIVE over `server/src`, not one level of
    // `server/src/services`. Ally caught the narrower scope on #1754:
    // `server/src/routes/` (63 files, including `github-webhook.ts`) and
    // `server/src/services/recovery/` (a real subdirectory today) were both
    // outside it, so a new `ghFetch`-based write in either would ship
    // unscrubbed with this test green. Widening it finds the same two writers
    // today — the gap was in what the guard could see, not in what it covered.
    //
    // PEN-3391 fixed the second half of that same shape: the walk saw every
    // file, but the PREDICATE recognised only `ghFetch(` plus an inline
    // double-quoted upper-case method, so an aliased call or a `'post'` was
    // classified as a read and never checked. It is now fail-closed — a
    // candidate must be PROVABLY read-only — and the alphabet it accepts is
    // pinned by a fail-first suite next to the helper.
    const serverSrc = path.join(repoRoot, "server/src");
    const scanned = serverSourceFiles(serverSrc);

    // Scope control. A non-recursive regression still finds both writers below
    // (they sit directly in `services/`), so the only thing that catches it is
    // asserting the walk reaches a file it could not otherwise see.
    expect(scanned).toContain("routes/github-webhook.ts");

    // The walk skips `__tests__/` so the derivation helper does not classify
    // itself. That is sound only while the running server imports nothing from
    // there, which is checked rather than assumed (PEN-3391).
    expect(
      productionFilesImportingTestHelpers(serverSrc),
      "a production file imports from __tests__/, so skipping it no longer excludes only test code",
    ).toEqual([]);

    const writers = serverFilesWritingToGitHub(serverSrc);
    // Positive control: the derivation must actually find the file we know
    // writes, or an empty `writers` would make the assertion below vacuous.
    // The predicate's own alphabet — aliased calls, non-literal methods — is
    // pinned separately in `helpers/github-writer-derivation.test.ts`, because
    // a positive control over the tree can only prove it finds TODAY's writers.
    expect(writers).toContain("services/github-app-auth.ts");

    for (const writer of writers) {
      const source = readFileSync(path.join(serverSrc, writer), "utf8");
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
