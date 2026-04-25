import { describe, expect, it } from "vitest";
import { appendRobotReviewMetadata, getLatestRobotReview, getRobotReviews } from "../src/robot-review.js";
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

describe("robot review helpers", () => {
  it("reads legacy single-review metadata", () => {
    const task = makeTask({
      metadata: {
        robot_review_reviewer: "opencode",
        robot_review_scope: "task evidence",
        robot_review_observations: ["Observed no command output for the core claim"],
        robot_review_blind_spots: "Did not rerun tests",
        robot_review_submitted_at: "2026-04-17T00:00:00.000Z",
      },
    });

    const reviews = getRobotReviews(task);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewer).toBe("opencode");
    expect(reviews[0].iteration).toBe(1);
    expect(reviews[0].accepted).toBe(true);
  });

  it("appends robot reviews as iterations", () => {
    const task = makeTask();
    const metadata1 = appendRobotReviewMetadata(task, {
      reviewer: "opencode",
      scope: "task evidence",
      observations: ["Observed missing benchmark output"],
      blind_spots: "Did not inspect prod config",
      accepted: false,
      evidence_complete: false,
      evidence_convincing: false,
      missing_evidence: ["Benchmark output for the claimed speedup"],
      submitted_at: "2026-04-17T00:00:00.000Z",
      mode: "auto",
    });
    const task1 = makeTask({ metadata: metadata1 });
    const metadata2 = appendRobotReviewMetadata(task1, {
      reviewer: "opencode",
      scope: "updated task evidence",
      observations: ["Observed benchmark output and test transcript"],
      blind_spots: "Did not inspect long-run stability",
      accepted: true,
      evidence_complete: true,
      evidence_convincing: true,
      missing_evidence: [],
      submitted_at: "2026-04-17T01:00:00.000Z",
      mode: "auto",
    });

    const task2 = makeTask({ metadata: metadata2 });
    const reviews = getRobotReviews(task2);
    expect(reviews).toHaveLength(2);
    expect(reviews[0].iteration).toBe(1);
    expect(reviews[1].iteration).toBe(2);
    expect(getLatestRobotReview(task2)?.evidence_convincing).toBe(true);
    expect(task2.metadata.robot_review_iteration_count).toBe(2);
  });
});

