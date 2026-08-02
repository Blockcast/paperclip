// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel, approvalSubject } from "./ApprovalPayload";
import { ApprovalCard } from "./ApprovalCard";
import type { Approval } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});

describe("blank payload.title fallback (BLO-21032)", () => {
  const untitledPayload = {
    title: null,
    summary: "Human decision needed: coordinated disclosure for an unpatched auth bypass.",
    decision_requested: ["Do we disclose? (recommended: yes)"],
  };

  it("approvalSubject falls back to summary when payload.title is null", () => {
    expect(approvalSubject(untitledPayload)).toBe(
      "Human decision needed: coordinated disclosure for an unpatched auth bypass.",
    );
  });

  it("approvalLabel is non-blank for a null-title, summary-only payload", () => {
    expect(approvalLabel("request_board_approval", untitledPayload)).toBe(
      "Board Approval: Human decision needed: coordinated disclosure for an unpatched auth bypass.",
    );
  });

  it("approvalLabel falls back to the approval type when neither title nor summary is present", () => {
    expect(approvalLabel("request_board_approval", {})).toBe("Board Approval");
    expect(approvalLabel("request_board_approval", null)).toBe("Board Approval");
  });

  it("ApprovalCard renders a non-blank heading for a card with payload.title = null", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const approval: Approval = {
      id: "2141dc60-b081-4d2c-9633-3a5f5d569561",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: untitledPayload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-08-02T05:52:24.279Z"),
      updatedAt: new Date("2026-08-02T05:52:24.275Z"),
    };

    act(() => {
      root.render(<ApprovalCard approval={approval} requesterAgent={null} />);
    });

    const heading = container.querySelector("h3");
    expect(heading?.textContent?.trim()).not.toBe("");
    expect(heading?.textContent).toContain(
      "Human decision needed: coordinated disclosure for an unpatched auth bypass.",
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
