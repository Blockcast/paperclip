// @vitest-environment jsdom

/**
 * PEN-6107 — the edit marker has to reach the SCREEN, not just the wire.
 *
 * `payloadRevision`/`payloadEditedAt` shipped on `GET /approvals/:id` and on the
 * default list view with PEN-5766, and the board queue is served from that list —
 * so the fields were already arriving. They were simply not in the shared `Approval`
 * type and not rendered anywhere, which means a decider scanning the queue saw a
 * card whose text had changed exactly as they saw one whose text had not.
 *
 * ⚠️ That matters most on the QUEUE CARD, not the detail page: `ApprovalCard`
 * carries working Approve and Reject buttons, so deciding without opening the card
 * is not a careless path, it is the primary one the UI offers. Disclosure is the
 * whole mitigation for an editable payload — prevention was deliberately deferred —
 * so a marker only the detail page renders is a mitigation the primary decision path
 * never meets.
 *
 * Both tests assert the NEGATIVE case too. A badge that renders on every card
 * discloses nothing; it has to discriminate.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import { approvalWasEdited } from "./ApprovalEditMarker";
import type { Approval } from "@paperclipai/shared";

const card = (over: Partial<Approval> = {}): Approval =>
  ({
    id: "9bd4ae7e-0a05-4a43-9f8b-4a4e9df2f0c1",
    companyId: "company-1",
    type: "request_board_approval",
    linkedAgentId: null,
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: { title: "Merge PR 3456 — fully green" },
    payloadRevision: 0,
    payloadEditedAt: null,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-11-08T09:36:00.000Z"),
    updatedAt: new Date("2026-11-08T09:36:00.000Z"),
    ...over,
  }) as Approval;

describe("approvalWasEdited", () => {
  it("is false for a never-edited card", () => {
    expect(approvalWasEdited(card())).toBe(false);
  });

  it("is true once the payload has been edited in place", () => {
    expect(approvalWasEdited(card({ payloadRevision: 1 }))).toBe(true);
  });

  // An older server omits the field entirely, and an absent key is not a `0`. It
  // has to read as "not edited" rather than throw or render a broken badge — that
  // is the safe direction for a predicate, even though it is the unsafe direction
  // for a caller reasoning about edit state, which is why the tool description
  // tells agents to gate on key presence instead.
  it("is false when the server did not send the field at all", () => {
    const legacy = card();
    delete (legacy as Partial<Approval>).payloadRevision;
    expect(approvalWasEdited(legacy)).toBe(false);
  });
});

describe("ApprovalCard edit marker", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function render(approval: Approval) {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ApprovalCard
          approval={approval}
          requesterAgent={null}
          onApprove={() => {}}
          onReject={() => {}}
        />,
      );
    });
    return root;
  }

  it("⭐ marks an edited card on the queue card that carries the Approve button", () => {
    const root = render(
      card({
        payloadRevision: 1,
        payloadEditedAt: new Date("2026-11-08T09:42:17.485Z"),
        payload: { title: "Merge PR 3456 — 5 checks now red" },
      }),
    );

    expect(container.textContent).toContain("Edited");
    expect(container.textContent).toContain("edited after this request was filed");

    // The marker and the decision affordance have to be on the SAME surface, or
    // the disclosure is not reaching the path the decision is taken on.
    const approve = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Approve",
    );
    expect(approve).not.toBeUndefined();

    act(() => {
      root.unmount();
    });
  });

  it("says nothing on a card whose text never moved", () => {
    const root = render(card());

    expect(container.textContent).not.toContain("Edited");
    expect(container.textContent).not.toContain("edited after this request was filed");

    act(() => {
      root.unmount();
    });
  });
});
