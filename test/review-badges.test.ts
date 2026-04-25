import { describe, expect, it } from "vitest";
import { getDisplayStatus, getReviewBadges } from "../src/review-badges.js";
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
