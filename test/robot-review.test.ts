import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveCurrentEvidence, buildArtifactRecords, getCurrentEvidenceIteration, getEvidenceHistory } from "../src/index.js";
import { appendRobotReviewMetadata, getLatestRobotReview, getRobotReviews, relaxAdvisoryVerificationHints, shouldOpenHumanSignoffGate } from "../src/robot-review.js";
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
  it("reopens the human gate when accepted review exists for stored evidence", () => {
    expect(shouldOpenHumanSignoffGate(makeTask({ metadata: { lgtm_evidence: "literal output" } }), true)).toBe(true);
    expect(shouldOpenHumanSignoffGate(makeTask({ metadata: { lgtm_evidence: "literal output" } }), false)).toBe(false);
    expect(shouldOpenHumanSignoffGate(makeTask(), true)).toBe(false);
  });

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

  it("builds artifact records with absolute path and sha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lgtm-"));
    const path = join(dir, "evidence.log");
    writeFileSync(path, "hello\n");

    const [artifact] = buildArtifactRecords([path]);
    expect(artifact.path).toBe(path);
    expect(artifact.bytes).toBe(6);
    expect(artifact.sha256).toHaveLength(64);
  });

  it("archives current evidence with reason", () => {
    const task = makeTask({
      metadata: {
        lgtm_evidence: "literal output",
        lgtm_failure_likely: "wrong seed",
        lgtm_failure_sneaky: "wrong threshold",
        lgtm_falsification_test: "pytest -k check",
        lgtm_verification_hints: ["see line 5"],
        lgtm_remaining_uncertainty: "not load tested",
        lgtm_submitted_at: "2026-06-07T00:00:00.000Z",
        lgtm_commands: [{ cmd: "pytest", exit_code: 0 }],
      },
    });

    const archived = archiveCurrentEvidence(task, "threshold changed");
    const taskWithHistory = makeTask({ metadata: archived });
    expect(getCurrentEvidenceIteration(task)?.iteration).toBe(1);
    expect(getEvidenceHistory(taskWithHistory)).toHaveLength(1);
    expect(getEvidenceHistory(taskWithHistory)[0].supersede_reason).toBe("threshold changed");
  });

  it("treats verification hints as advisory when core evidence already passes", () => {
    const review = relaxAdvisoryVerificationHints({
      reviewer: "auto",
      scope: "task evidence",
      observations: ["Observed commit, push, and test logs"],
      blind_spots: "Did not inspect interactive UI",
      accepted: false,
      evidence_complete: true,
      evidence_convincing: false,
      missing_evidence: ["verification_hints_actionable"],
      submitted_at: "2026-06-13T00:00:00.000Z",
      mode: "auto",
      rubric: {
        evidence_covers_done_criterion: { reason: "verbatim logs match", pass: true },
        falsification_test_runnable: { reason: "command and output shown", pass: true },
        failure_modes_addressed: { reason: "plausible top risks named", pass: true },
        verification_hints_actionable: { reason: "paths are vague", pass: false },
      },
    });

    expect(review.accepted).toBe(true);
    expect(review.evidence_convincing).toBe(true);
    expect(review.observations.at(-1)).toContain("treated as advisory");
    expect(review.missing_evidence).toEqual([]);
  });

  it("does not relax verification hints unless the core rubric passes", () => {
    const review = relaxAdvisoryVerificationHints({
      reviewer: "auto",
      scope: "task evidence",
      observations: ["Observed vague summary only"],
      blind_spots: "Did not rerun tests",
      accepted: false,
      evidence_complete: true,
      evidence_convincing: false,
      missing_evidence: ["verification_hints_actionable"],
      submitted_at: "2026-06-13T00:00:00.000Z",
      mode: "auto",
      rubric: {
        evidence_covers_done_criterion: { reason: "summary only", pass: false },
        falsification_test_runnable: { reason: "command and output shown", pass: true },
        failure_modes_addressed: { reason: "plausible top risks named", pass: true },
        verification_hints_actionable: { reason: "paths are vague", pass: false },
      },
    });

    expect(review.accepted).toBe(false);
    expect(review.evidence_convincing).toBe(false);
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

