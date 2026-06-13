import { describe, expect, it } from "vitest";
import { getCompletionMode, getDisplayStatus, getGateStatus, getReviewBadges, getReviewState } from "../src/review-badges.js";
import type { Task } from "../src/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    subject: "Test",
    description: "Desc",
    done_criterion: "done",
    pending_approval: false,
    status: "pending",
    progress_label: undefined,
    metadata: {},
    blocks: [],
    blockedBy: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("getReviewBadges", () => {
  it("renders all dots when no artifacts exist", () => {
    expect(getReviewBadges(makeTask())).toBe("[···]");
  });

  it("fills tool/robot/human slots independently", () => {
    const task = makeTask({
      pending_approval: true,
      metadata: {
        lgtm_evidence: "npm test",
        robot_reviews: [{
          iteration: 1,
          reviewer: "opencode",
          scope: "task evidence",
          observations: ["Observed one unchecked edge case"],
          blind_spots: "Did not inspect prod traffic",
          accepted: false,
          evidence_complete: false,
          evidence_convincing: false,
          missing_evidence: ["Prod traffic sample"],
          submitted_at: "2026-04-17T00:00:00.000Z",
          mode: "manual",
        }],
      },
    });

    expect(getReviewBadges(task)).toBe("[🛠🤖👀]");
  });

  it("hides the human badge once the task is completed", () => {
    const task = makeTask({
      pending_approval: true,
      status: "completed",
      metadata: { lgtm_evidence: "ok" },
    });

    expect(getReviewBadges(task)).toBe("[🛠··]");
  });
});

describe("review state helpers", () => {
  it("reports completion mode as direct before any lgtm evidence", () => {
    expect(getCompletionMode(makeTask())).toBe("direct");
  });

  it("reports completion mode as lgtm after evidence history exists", () => {
    expect(getCompletionMode(makeTask({ metadata: { lgtm_history: [{ iteration: 1 }] } }))).toBe("lgtm");
  });

  it("reports superseded when only history remains", () => {
    expect(getReviewState(makeTask({ metadata: { lgtm_history: [{ iteration: 1 }] } }))).toBe("superseded");
  });
});

describe("getGateStatus", () => {
  it("reports ready when human sign-off is open", () => {
    expect(getGateStatus(makeTask({
      pending_approval: true,
      metadata: { lgtm_evidence: "ok" },
    }))).toBe("ready for human sign-off via /lgtm 1");
  });

  it("reports blocking reviewer failure when human sign-off is closed", () => {
    expect(getGateStatus(makeTask({
      metadata: {
        lgtm_evidence: "ok",
        robot_review_last_error: "Unexpected token 'a'",
      },
    }))).toContain("blocked: automatic robot review failed");
  });

  it("reports reviewer failure as a warning when human sign-off stays open", () => {
    expect(getGateStatus(makeTask({
      pending_approval: true,
      metadata: {
        lgtm_evidence: "ok",
        robot_review_last_error: "Unexpected token 'a'",
      },
    }))).toContain("warning: automatic robot review failed");
  });

  it("reports rejected robot review when latest review does not accept", () => {
    expect(getGateStatus(makeTask({
      metadata: {
        lgtm_evidence: "ok",
        robot_reviews: [{
          iteration: 1,
          reviewer: "opencode",
          scope: "task evidence",
          observations: ["Observed missing output"],
          blind_spots: "none",
          accepted: false,
          evidence_complete: false,
          evidence_convincing: false,
          missing_evidence: ["literal output"],
          submitted_at: "2026-04-17T00:00:00.000Z",
          mode: "manual",
        }],
      },
    }))).toBe("blocked: latest robot review rejected the evidence");
  });

  it("keeps rejection higher priority than a later reviewer warning", () => {
    expect(getGateStatus(makeTask({
      pending_approval: true,
      metadata: {
        lgtm_evidence: "ok",
        robot_review_last_error: "timeout",
        robot_reviews: [{
          iteration: 1,
          reviewer: "opencode",
          scope: "task evidence",
          observations: ["Observed missing output"],
          blind_spots: "none",
          accepted: false,
          evidence_complete: false,
          evidence_convincing: false,
          missing_evidence: ["literal output"],
          submitted_at: "2026-04-17T00:00:00.000Z",
          mode: "manual",
        }],
      },
    }))).toBe("blocked: latest robot review rejected the evidence");
  });
});

describe("getDisplayStatus", () => {
  it("returns pending for fresh tasks", () => {
    expect(getDisplayStatus(makeTask())).toBe("pending");
  });

  it("returns in_progress for active tasks not yet escalated", () => {
    expect(getDisplayStatus(makeTask({ status: "in_progress" }))).toBe("in_progress");
  });

  it("returns awaiting_signoff when pending_approval is set", () => {
    expect(getDisplayStatus(makeTask({ status: "in_progress", pending_approval: true })))
      .toBe("awaiting_signoff");
  });

  it("returns completed regardless of pending_approval flag", () => {
    expect(getDisplayStatus(makeTask({ status: "completed", pending_approval: true })))
      .toBe("completed");
  });
});
