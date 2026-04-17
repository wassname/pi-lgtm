import { describe, expect, it } from "vitest";
import { getReviewBadges, REVIEW_BADGES } from "../src/review-badges.js";
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
  it("returns no badges when no review artifacts exist", () => {
    expect(getReviewBadges(makeTask())).toEqual([]);
  });

  it("returns tool, robot, and human badges independently", () => {
    const task = makeTask({
      pending_approval: true,
      metadata: {
        lgtm_evidence: "npm test",
        robot_review_observations: ["Observed one unchecked edge case"],
      },
    });

    expect(getReviewBadges(task)).toEqual([
      REVIEW_BADGES.tool,
      REVIEW_BADGES.robot,
      REVIEW_BADGES.human,
    ]);
  });

  it("hides the human badge once the task is completed", () => {
    const task = makeTask({
      pending_approval: true,
      status: "completed",
      metadata: { lgtm_evidence: "ok" },
    });

    expect(getReviewBadges(task)).toEqual([REVIEW_BADGES.tool]);
  });
});
