/**
 * PEN-2370 door #7: the GitHub webhook mirrors externally-authored review and
 * comment bodies into `authorType: "system"` issue comments. Before this
 * suite, that path applied no redaction at all -- which is how a reviewer's
 * runtime environment ended up mirrored onto a `critical` issue thread
 * (PEN-2526) where no principal can delete it: the delete route is gated on
 * authorship and a `system` comment has no author to match.
 *
 * Every credential-shaped value in this file is synthetic and has never been
 * live. Do not paste real values into fixtures.
 */
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../redaction.js";
import {
  __test_buildPrReviewFeedbackComment,
  __test_resolveEventContext,
} from "../routes/github-webhook.js";

const FAKE_TOKEN = "sk-ant-api03-NOTAREALTOKENjustlongenoughtoresembleone0123456789";
const FAKE_PW = "NotARealPassword123";
const FAKE_PG = `postgresql://pcuser:${FAKE_PW}@db.internal:5432/paperclip`;
const FAKE_REDIS = `redis://cacheuser:${FAKE_PW}@cache.internal:6379`;

function reviewPayload(body: string) {
  return {
    action: "submitted",
    review: {
      id: 55,
      body,
      state: "changes_requested",
      html_url: "https://github.com/Blockcast/paperclip/pull/1435#pullrequestreview-55",
      user: { login: "allyblockcast", type: "Bot" },
      commit_id: "deadbeef",
    },
    pull_request: {
      number: 1435,
      title: "Fix PEN-2370 mirror",
      body: null,
      html_url: "https://github.com/Blockcast/paperclip/pull/1435",
      head: { ref: "fix/pen-2370", sha: "deadbeef" },
    },
    repository: { full_name: "Blockcast/paperclip" },
  };
}

describe("PEN-2370: value-shaped URI credential redaction", () => {
  it("redacts credentials in a connection string regardless of variable spelling", () => {
    // DATABASE_URL only ever matched the name-based rule by accident (it
    // contains the substring "BASE_URL"). These do not match it at all.
    for (const [label, input] of [
      ["bare DSN in prose", `run against ${FAKE_PG} to reproduce`],
      ["REDIS_URL assignment", `REDIS_URL=${FAKE_REDIS}`],
      ["DATABASE_URL assignment", `DATABASE_URL=${FAKE_PG}`],
    ] as const) {
      const out = redactSensitiveText(input);
      expect(out, `${label} must not retain the password`).not.toContain(FAKE_PW);
    }
  });

  it("keeps the principal but not the secret, so the value stays diagnostic", () => {
    const out = redactSensitiveText(`connect via ${FAKE_PG}`);
    expect(out).toContain("pcuser");
    expect(out).not.toContain(FAKE_PW);
  });

  it("redacts the no-username DSN form Redis and AMQP actually emit", () => {
    // Not an exotic edge case: Redis and AMQP authenticate with a password and
    // no username (`requirepass`), so `scheme://:secret@host` is their ORDINARY
    // spelling. A userinfo pattern written as `user:pass@` -- the textbook form
    // -- misses exactly the two services this rule was added to cover.
    for (const [label, input] of [
      ["no-user redis", `redis://:${FAKE_PW}@cache.internal:6379`],
      ["no-user amqp", `amqp://:${FAKE_PW}@mq.internal:5672`],
      ["no-user in assignment", `REDIS_URL=redis://:${FAKE_PW}@cache.internal:6379`],
    ] as const) {
      expect(redactSensitiveText(input), `${label} must not retain the password`).not.toContain(
        FAKE_PW,
      );
    }
  });

  it("negative control: leaves credential-free URLs untouched", () => {
    for (const url of [
      "https://github.com/Blockcast/paperclip/pull/1435",
      "https://example.com:8080/path",
      "postgresql://db.internal:5432/paperclip",
      // Bare userinfo with no password. Widening the user component to `*` for
      // the no-username DSN case must not turn this into a match -- there is no
      // secret here, and the `:` before `@` is what distinguishes the two.
      "https://someuser@github.com/Blockcast/paperclip.git",
    ]) {
      expect(redactSensitiveText(`see ${url} for detail`)).toContain(url);
    }
  });
});

describe("PEN-2370: the webhook mirror scrubs before it stores", () => {
  it("redacts an env dump carried in a review body", () => {
    const ctx = __test_resolveEventContext(
      "pull_request_review",
      reviewPayload(
        [
          "Env for repro:",
          "",
          "```",
          `PAPERCLIP_API_KEY=${FAKE_TOKEN}`,
          `ANTHROPIC_API_KEY=${FAKE_TOKEN}`,
          `GITHUB_WEBHOOK_SECRET=${FAKE_TOKEN}`,
          `DATABASE_URL=${FAKE_PG}`,
          "```",
        ].join("\n"),
      ),
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.reviewBody).not.toContain(FAKE_TOKEN);
    expect(ctx!.reviewBody).not.toContain(FAKE_PW);
    // Names survive: knowing *which* variables were set is the diagnostic
    // value the reader legitimately needs (ask 1 of PEN-2370).
    expect(ctx!.reviewBody).toContain("PAPERCLIP_API_KEY");
    expect(ctx!.reviewBody).toContain("DATABASE_URL");
  });

  it("the rendered system comment carries no secret value", () => {
    const ctx = __test_resolveEventContext(
      "pull_request_review",
      reviewPayload(`deploy used ${FAKE_PG} and PAPERCLIP_API_KEY=${FAKE_TOKEN}`),
    );
    const comment = __test_buildPrReviewFeedbackComment(ctx!);
    expect(comment).not.toContain(FAKE_TOKEN);
    expect(comment).not.toContain(FAKE_PW);
  });

  it("a secret straddling the truncation boundary is still redacted", () => {
    // Discriminating fixture, not just a long one. REVIEW_BODY_MAX_BYTES is
    // 4096, and URI_CREDENTIAL_RE needs the trailing "@" to match. Position the
    // password so the clamp lands *inside* it: the "@" is then cut off.
    //
    //   redact -> clamp (correct): the whole DSN is redacted first, so nothing
    //                             of the password survives.
    //   clamp -> redact (the bug): the clamp removes the "@", the URI rule no
    //                             longer matches, and the visible head of the
    //                             password is mirrored verbatim.
    //
    // A fixture that merely overflows the limit passes under both orderings,
    // because truncation deletes the secret outright. This one does not.
    const PW = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8";
    const prefix = "postgresql://u:";
    const filler = "a".repeat(4096 - prefix.length - 18);
    const ctx = __test_resolveEventContext(
      "pull_request_review",
      reviewPayload(`${filler}${prefix}${PW}@db.internal:5432/paperclip`),
    );
    expect(ctx!.reviewBody).not.toContain(PW);
    expect(ctx!.reviewBody).not.toContain(PW.slice(0, 18));
  });
});
