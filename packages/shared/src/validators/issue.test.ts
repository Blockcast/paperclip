import { describe, expect, it } from "vitest";
import { MAX_ISSUE_REQUEST_DEPTH } from "../index.js";
import {
  addIssueCommentSchema,
  createIssueSchema,
  issueBlockedInboxAttentionSchema,
  issueExecutionPolicySchema,
  MISPLACED_ISSUE_MONITOR_INPUT_KEYS,
  misplacedIssueMonitorInputMessage,
  MISPLACED_ISSUE_PARKED_INPUT_KEYS,
  PARKED_DISPOSITION_MAX_HORIZON_DAYS,
  resolveIssueRecoveryActionSchema,
  respondIssueThreadInteractionSchema,
  suggestedTaskDraftSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
} from "./issue.js";
import { createAgentSchema } from "./agent.js";

describe("issue validators", () => {
  it("passes real line breaks through unchanged", () => {
    const parsed = createIssueSchema.parse({
      title: "Follow up PR",
      description: "Line 1\n\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("accepts null and omitted optional multiline issue fields", () => {
    expect(createIssueSchema.parse({ title: "Follow up PR", description: null }).description)
      .toBeNull();
    expect(createIssueSchema.parse({ title: "Follow up PR" }).description)
      .toBeUndefined();
    expect(updateIssueSchema.parse({ comment: undefined }).comment)
      .toBeUndefined();
  });

  it("normalizes JSON-escaped line breaks in issue descriptions", () => {
    const parsed = createIssueSchema.parse({
      title: "Follow up PR",
      description: "PR: https://example.com/pr/1\\n\\nShip the follow-up.",
    });

    expect(parsed.description).toBe("PR: https://example.com/pr/1\n\nShip the follow-up.");
  });

  it("normalizes escaped line breaks in issue update comments", () => {
    const parsed = updateIssueSchema.parse({
      comment: "Done\\n\\n- Verified the route",
    });

    expect(parsed.comment).toBe("Done\n\n- Verified the route");
  });

  it("keeps issue attribution fields create-only", () => {
    const created = createIssueSchema.parse({
      title: "Preserve attribution input for route checks",
      createdByUserId: "spoofed-creator",
      responsibleUserId: "spoofed-responsible",
    });
    const updated = updateIssueSchema.parse({
      title: "Do not update attribution",
      createdByUserId: "spoofed-creator",
      responsibleUserId: "spoofed-responsible",
    });

    expect(created.createdByUserId).toBe("spoofed-creator");
    expect(created.responsibleUserId).toBe("spoofed-responsible");
    expect(updated).not.toHaveProperty("createdByUserId");
    expect(updated).not.toHaveProperty("responsibleUserId");
  });

  it("allows false-positive recovery resolutions to atomically restore the source issue status", () => {
    expect(
      resolveIssueRecoveryActionSchema.parse({
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
      }),
    ).toMatchObject({
      outcome: "false_positive",
      sourceIssueStatus: "in_review",
    });

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "false_positive",
        sourceIssueStatus: "blocked",
      }).success,
    ).toBe(false);

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "false_positive",
      }).success,
    ).toBe(false);
  });

  it("allows restored recovery resolutions to return the source issue to todo", () => {
    expect(
      resolveIssueRecoveryActionSchema.parse({
        outcome: "restored",
        sourceIssueStatus: "todo",
      }),
    ).toMatchObject({
      outcome: "restored",
      sourceIssueStatus: "todo",
    });

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "false_positive",
        sourceIssueStatus: "todo",
      }).success,
    ).toBe(false);
  });

  it("allows cancelled recovery resolutions to atomically restore the source issue status", () => {
    expect(
      resolveIssueRecoveryActionSchema.parse({
        outcome: "cancelled",
        sourceIssueStatus: "in_review",
      }),
    ).toMatchObject({
      outcome: "cancelled",
      sourceIssueStatus: "in_review",
    });

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "cancelled",
        sourceIssueStatus: "blocked",
      }).success,
    ).toBe(false);

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "cancelled",
      }).success,
    ).toBe(false);
  });

  it("lets a restored recovery resolution omit sourceIssueStatus to leave the source issue unchanged", () => {
    // PEN-2756: the disposal path for a beacon on a row whose status is already
    // correct — a live `in_progress` run, or a board-approved `backlog` park.
    // Neither status is in the enum, so before this the only resolutions available
    // asserted something false and the cheapest correct action was to leave the
    // beacon active forever.
    const parsed = resolveIssueRecoveryActionSchema.parse({ outcome: "restored" });
    expect(parsed.outcome).toBe("restored");
    expect(parsed.sourceIssueStatus).toBeUndefined();

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "restored",
        resolutionNote: "PR merged 4h11m after the beacon fired; run is still live.",
      }).success,
    ).toBe(true);
  });

  it("confines the leave-unchanged path to restored outcomes", () => {
    // `blocked` must still land the row on `blocked` (the route additionally
    // requires a real first-class blocker), and the board-only outcomes must still
    // say where the row lands rather than retire the premise mid-flight.
    expect(
      resolveIssueRecoveryActionSchema.safeParse({ outcome: "blocked" }).success,
    ).toBe(false);
    expect(
      resolveIssueRecoveryActionSchema.safeParse({ outcome: "false_positive" }).success,
    ).toBe(false);
    expect(
      resolveIssueRecoveryActionSchema.safeParse({ outcome: "cancelled" }).success,
    ).toBe(false);
  });

  it("still refuses statuses the resolver must never assert", () => {
    // `in_progress` and `backlog` stay out of the enum. Omission, not widening, is
    // how a row in either state is disposed — a resolver that wrote `in_progress`
    // would claim execution state it cannot verify and would route the write
    // through issue-update side effects purely to clear an unrelated beacon.
    for (const sourceIssueStatus of ["in_progress", "backlog"]) {
      expect(
        resolveIssueRecoveryActionSchema.safeParse({
          outcome: "restored",
          sourceIssueStatus,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects recovery outcomes that are not supported by the source-scoped resolution endpoint", () => {
    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "delegated",
      }).success,
    ).toBe(false);

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "escalated",
      }).success,
    ).toBe(false);
  });

  it("normalizes escaped line breaks in issue comment bodies", () => {
    const parsed = addIssueCommentSchema.parse({
      body: "Progress update\\r\\n\\r\\nNext action.",
    });

    expect(parsed.body).toBe("Progress update\n\nNext action.");
  });

  it("accepts structured issue comment presentation and metadata", () => {
    const parsed = addIssueCommentSchema.parse({
      body: "Paperclip needs a disposition before this issue can continue.",
      authorType: "system",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Needs disposition",
      },
      metadata: {
        version: 1,
        sourceRunId: "11111111-1111-4111-8111-111111111111",
        sections: [
          {
            title: "Evidence",
            rows: [
              { type: "key_value", label: "Cause", value: "successful_run_missing_state" },
              { type: "issue_link", label: "Source issue", identifier: "PAP-3440" },
              { type: "run_link", label: "Run", runId: "11111111-1111-4111-8111-111111111111" },
            ],
          },
        ],
      },
    });

    expect(parsed.presentation?.detailsDefaultOpen).toBe(false);
    expect(parsed.metadata?.sourceRunId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.metadata?.sections[0]?.rows).toHaveLength(3);
  });

  it("rejects arbitrary issue comment metadata", () => {
    const parsed = addIssueCommentSchema.safeParse({
      body: "Hidden details",
      metadata: {
        version: 1,
        transcript: "raw log dump",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("normalizes escaped line breaks in generated task drafts", () => {
    const parsed = suggestedTaskDraftSchema.parse({
      clientKey: "task-1",
      title: "Follow up",
      description: "Line 1\\n\\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("normalizes escaped line breaks in thread summaries and documents", () => {
    const response = respondIssueThreadInteractionSchema.parse({
      answers: [],
      summaryMarkdown: "Summary\\n\\nNext action",
    });
    const document = upsertIssueDocumentSchema.parse({
      format: "markdown",
      body: "# Plan\\n\\nShip it",
    });

    expect(response.summaryMarkdown).toBe("Summary\n\nNext action");
    expect(document.body).toBe("# Plan\n\nShip it");
  });

  it("clamps oversized requestDepth values on create", () => {
    const parsed = createIssueSchema.parse({
      title: "Clamp request depth",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 500,
    });

    expect(parsed.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });

  it("defaults omitted create status to todo when an assignee is present", () => {
    expect(createIssueSchema.parse({
      title: "Assigned work",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    }).status).toBe("todo");
    expect(createIssueSchema.parse({ title: "Unassigned work" }).status).toBe("backlog");
    expect(createIssueSchema.parse({
      title: "Deliberately parked",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      status: "backlog",
    }).status).toBe("backlog");
  });

  it("defaults issue work mode to standard and accepts ask, planning, and skill_test", () => {
    expect(createIssueSchema.parse({ title: "Plan first" }).workMode).toBe("standard");
    expect(createIssueSchema.parse({ title: "Ask first", workMode: "ask" }).workMode).toBe("ask");
    expect(createIssueSchema.parse({ title: "Plan first", workMode: "planning" }).workMode).toBe("planning");
    expect(createIssueSchema.parse({
      title: "Harness test",
      workMode: "skill_test",
      harnessKind: "skill_test",
    })).toMatchObject({ workMode: "skill_test", harnessKind: "skill_test" });
    expect(updateIssueSchema.parse({ workMode: "ask" }).workMode).toBe("ask");
    expect(updateIssueSchema.parse({ workMode: "planning" }).workMode).toBe("planning");
    expect(updateIssueSchema.parse({ workMode: "skill_test" }).workMode).toBe("skill_test");
    expect(suggestedTaskDraftSchema.parse({
      clientKey: "ask-child",
      title: "Ask child",
      workMode: "ask",
    }).workMode).toBe("ask");
    expect(suggestedTaskDraftSchema.parse({
      clientKey: "planning-child",
      title: "Plan child",
      workMode: "planning",
    }).workMode).toBe("planning");
    expect(suggestedTaskDraftSchema.parse({
      clientKey: "skill-test-child",
      title: "Test child",
      workMode: "skill_test",
    }).workMode).toBe("skill_test");
  });

  it("validates blocked inbox attention payloads and requires redacted secret fields", () => {
    const parsed = issueBlockedInboxAttentionSchema.parse({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_unassigned_issue",
      severity: "critical",
      stoppedSinceAt: "2026-05-09T12:00:00.000Z",
      owner: { type: "unknown", agentId: null, userId: null, label: null },
      action: { label: "Assign blocker", detail: "Assign the leaf blocker." },
      sourceIssue: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-1",
        title: "Blocked source",
        status: "blocked",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      leafIssue: {
        id: "22222222-2222-4222-8222-222222222222",
        identifier: "PAP-2",
        title: "Unassigned leaf",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      recoveryIssue: null,
      approvalId: null,
      interactionId: null,
      sampleIssueIdentifier: "PAP-2",
      redaction: {
        externalDetailsRedacted: false,
        secretFieldsOmitted: true,
      },
    });

    expect(parsed.redaction.secretFieldsOmitted).toBe(true);
    expect(issueBlockedInboxAttentionSchema.safeParse({
      ...parsed,
      redaction: { externalDetailsRedacted: false, secretFieldsOmitted: false },
    }).success).toBe(false);
  });

  it("rejects unknown issue work modes", () => {
    expect(createIssueSchema.safeParse({ title: "Plan first", workMode: "normal" }).success).toBe(false);
    expect(suggestedTaskDraftSchema.safeParse({
      clientKey: "bad-child",
      title: "Bad child",
      workMode: "analysis",
    }).success).toBe(false);
  });

  it("clamps oversized requestDepth values on update", () => {
    const parsed = updateIssueSchema.parse({
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 1,
    });

    expect(parsed.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });

  // BLO-18790: these keys used to be stripped by the non-strict object schema, so a caller that
  // guessed the wrong monitor shape got 200 OK with nothing persisted and no way to notice.
  describe("misplaced monitor input keys (BLO-18790)", () => {
    it.each(MISPLACED_ISSUE_MONITOR_INPUT_KEYS)("rejects top-level `%s` on update instead of stripping it", (key) => {
      const parsed = updateIssueSchema.safeParse({
        [key]: key === "monitor"
          ? { nextCheckAt: "2099-12-01T12:00:00.000Z", notes: "signature=unchanged" }
          : "2099-12-01T12:00:00.000Z",
      });

      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const message = parsed.error.issues.map((issue) => issue.message).join("\n");
      // The message has to name the shape that actually works, otherwise this is just a
      // differently-shaped dead end for the caller.
      expect(message).toContain("executionPolicy.monitor");
      expect(message).toContain(key);
    });

    it("rejects top-level `monitor` on create as well, so both paths agree", () => {
      const parsed = createIssueSchema.safeParse({
        title: "Watch a PR",
        status: "in_progress",
        monitor: { nextCheckAt: "2099-12-01T12:00:00.000Z" },
      });

      expect(parsed.success).toBe(false);
    });

    it("still accepts the nested executionPolicy.monitor shape", () => {
      const parsed = updateIssueSchema.parse({
        executionPolicy: {
          monitor: {
            nextCheckAt: "2099-12-01T12:00:00.000Z",
            notes: "signature=unchanged",
            scheduledBy: "assignee",
          },
        },
      });

      expect(parsed.executionPolicy?.monitor?.nextCheckAt).toBe("2099-12-01T12:00:00.000Z");
      expect(parsed.executionPolicy?.monitor?.notes).toBe("signature=unchanged");
    });

    it("does not fire on an absent or explicitly-undefined key", () => {
      expect(updateIssueSchema.safeParse({ title: "No monitor here" }).success).toBe(true);
      expect(updateIssueSchema.safeParse({ monitorNextCheckAt: undefined }).success).toBe(true);
    });

    // An update REPLACES executionPolicy rather than merging into it. That bites arming and
    // re-arming as hard as it bites clearing: a monitor-only body is a policy with no stages, so
    // it erases stages/reviewPreset/authorizationPolicy on any issue that had them. Guidance that
    // only warns about the clear path teaches a destructive re-arm, so assert both agent-facing
    // strings cover the whole verb set.
    it.each([
      ["validation message", misplacedIssueMonitorInputMessage("monitorNextCheckAt")],
      ["executionPolicy.monitor description", issueExecutionPolicySchema.shape.monitor.description ?? ""],
    ])("warns in the %s that any policy write — arm, re-arm or clear — replaces the whole policy", (_label, text) => {
      expect(text).toMatch(/replaces the whole|REPLACES the whole `executionPolicy`/i);
      expect(text).toContain("complete");
      // The warning must not be scoped to clearing only.
      expect(text).toMatch(/re-arm/i);
      expect(text).toMatch(/only on an issue|ONLY on an issue/);
      for (const clobbered of ["stages", "reviewPreset", "authorizationPolicy"]) {
        expect(text).toContain(clobbered);
      }
    });

    // attemptCount survives a re-arm and is compared against the *incoming* maxAttempts, so
    // "re-arming resets a wedged monitor" is only true when maxAttempts is omitted.
    it("qualifies the re-arm-resets-a-wedged-monitor claim with the attemptCount caveat", () => {
      const text = issueExecutionPolicySchema.shape.monitor.description ?? "";
      expect(text).toContain("attemptCount");
      expect(text).toContain("maxAttempts");
    });
  });

  describe("misplaced parked input keys (BLO-27912)", () => {
    const future = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    it.each(MISPLACED_ISSUE_PARKED_INPUT_KEYS)(
      "rejects flat `%s` on update instead of stripping it",
      (key) => {
        const parsed = updateIssueSchema.safeParse({
          [key]: key === "parkedReason" || key === "parkedByAgentId"
            ? "waiting on an upstream decision"
            : future(),
        });

        expect(parsed.success).toBe(false);
        if (parsed.success) return;
        const message = parsed.error.issues.map((issue) => issue.message).join("\n");
        // Same standard as the monitor guard: the rejection has to name the shape that
        // actually works, or it is just a differently-shaped dead end.
        expect(message).toContain("parkedDisposition");
        expect(message).toContain(key);
      },
    );

    it.each(MISPLACED_ISSUE_PARKED_INPUT_KEYS)(
      "rejects flat `%s` on create as well, so both paths agree",
      (key) => {
        expect(createIssueSchema.safeParse({
          title: "Park me",
          status: "backlog",
          [key]: key === "parkedReason" || key === "parkedByAgentId"
            ? "waiting on an upstream decision"
            : future(),
        }).success).toBe(false);
      },
    );

    // The nested key had the same hole as the flat ones: `createIssueBaseSchema` is not
    // `.strict()`, so this used to return a parsed object with `parkedDisposition` stripped
    // — a 201 and an UNPARKED row, with no signal to the caller who guessed RIGHT about the
    // shape. Asserting the strip is gone is the whole point of the guard.
    it("rejects `parkedDisposition` on create rather than silently stripping it", () => {
      const parsed = createIssueSchema.safeParse({
        title: "Parked at birth",
        status: "backlog",
        parkedDisposition: { reason: "waiting on an upstream decision", until: future() },
      });

      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const message = parsed.error.issues.map((issue) => issue.message).join("\n");
      // Must state the verb that works and why create is refused, not merely that it failed.
      expect(message).toContain("PATCH");
      expect(message).toContain("pre-suppressed");
      // The message is built by a function declared above the horizon constant it reads, so
      // assert the interpolation actually resolved rather than emitting `undefined`.
      expect(message).toContain(`${PARKED_DISPOSITION_MAX_HORIZON_DAYS} days`);
      expect(message).not.toContain("undefined");
    });

    // Negative control for the guard above: it must be scoped to create. If this regresses,
    // the park becomes unrecordable on every path and the feature is inert — a failure the
    // create-side assertion alone cannot see.
    it("still accepts `parkedDisposition` on update", () => {
      const until = future();
      const parsed = updateIssueSchema.parse({
        parkedDisposition: { reason: "waiting on an upstream decision", until },
      });

      expect(parsed.parkedDisposition?.reason).toBe("waiting on an upstream decision");
      expect(parsed.parkedDisposition?.until).toBe(until);
    });

    it("still accepts `parkedDisposition: null` on update, so un-parking survives the guard", () => {
      expect(updateIssueSchema.parse({ parkedDisposition: null }).parkedDisposition).toBeNull();
    });

    it("does not fire on an absent or explicitly-undefined key", () => {
      expect(createIssueSchema.safeParse({ title: "No park here" }).success).toBe(true);
      expect(createIssueSchema.safeParse({
        title: "No park here",
        parkedDisposition: undefined,
      }).success).toBe(true);
      expect(updateIssueSchema.safeParse({ parkedUntil: undefined }).success).toBe(true);
    });
  });

  it("accepts the cheap model profile in issue assignee adapter overrides", () => {
    const parsed = createIssueSchema.parse({
      title: "Run a cheap heartbeat",
      assigneeAdapterOverrides: {
        modelProfile: "cheap",
      },
    });

    expect(parsed.assigneeAdapterOverrides?.modelProfile).toBe("cheap");
  });

  it("rejects unknown issue model profile keys", () => {
    const parsed = updateIssueSchema.safeParse({
      assigneeAdapterOverrides: {
        modelProfile: "fast",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("validates agent runtime cheap model profile config without rejecting other runtime fields", () => {
    const parsed = createAgentSchema.parse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        heartbeat: { enabled: true },
        modelProfiles: {
          cheap: {
            enabled: true,
            label: "Cheap Codex",
            adapterConfig: {
              model: "gpt-5.3-codex-spark",
            },
          },
        },
      },
    });

    expect(parsed.runtimeConfig.modelProfiles?.cheap?.adapterConfig).toEqual({
      model: "gpt-5.3-codex-spark",
    });
    expect(parsed.runtimeConfig.heartbeat).toEqual({ enabled: true });
  });

  it("validates cheap model profile env bindings like top-level adapter config", () => {
    const parsed = createAgentSchema.safeParse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              env: {
                API_TOKEN: 123,
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown agent runtime model profile keys", () => {
    const parsed = createAgentSchema.safeParse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          fast: {
            adapterConfig: {
              model: "gpt-5-mini",
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
