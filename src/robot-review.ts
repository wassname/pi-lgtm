import type { Task } from "./types.js";

export type RobotReviewMode = "manual" | "auto";

export interface RobotReviewRecord {
  iteration: number;
  reviewer: string;
  scope: string;
  observations: string[];
  blind_spots: string;
  evidence_complete: boolean;
  evidence_convincing: boolean;
  missing_evidence: string[];
  submitted_at: string;
  mode: RobotReviewMode;
  raw_output?: string;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeReview(value: unknown, index: number): RobotReviewRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const review = value as Record<string, unknown>;
  const reviewer = typeof review.reviewer === "string" ? review.reviewer : "unknown";
  const scope = typeof review.scope === "string" ? review.scope : "unknown";
  const observations = toStringArray(review.observations);
  if (observations.length === 0) return undefined;
  return {
    iteration: typeof review.iteration === "number" ? review.iteration : index + 1,
    reviewer,
    scope,
    observations,
    blind_spots: typeof review.blind_spots === "string" ? review.blind_spots : "not recorded",
    evidence_complete: typeof review.evidence_complete === "boolean" ? review.evidence_complete : true,
    evidence_convincing: typeof review.evidence_convincing === "boolean" ? review.evidence_convincing : true,
    missing_evidence: toStringArray(review.missing_evidence),
    submitted_at: typeof review.submitted_at === "string" ? review.submitted_at : new Date(0).toISOString(),
    mode: review.mode === "auto" ? "auto" : "manual",
    raw_output: typeof review.raw_output === "string" ? review.raw_output : undefined,
  };
}

function getLegacyRobotReview(task: Task): RobotReviewRecord | undefined {
  const observations = toStringArray(task.metadata?.robot_review_observations);
  if (observations.length === 0) return undefined;
  return {
    iteration: 1,
    reviewer: typeof task.metadata?.robot_review_reviewer === "string" ? task.metadata.robot_review_reviewer : "unknown",
    scope: typeof task.metadata?.robot_review_scope === "string" ? task.metadata.robot_review_scope : "unknown",
    observations,
    blind_spots: typeof task.metadata?.robot_review_blind_spots === "string" ? task.metadata.robot_review_blind_spots : "not recorded",
    evidence_complete: typeof task.metadata?.robot_review_evidence_complete === "boolean" ? task.metadata.robot_review_evidence_complete : true,
    evidence_convincing: typeof task.metadata?.robot_review_evidence_convincing === "boolean" ? task.metadata.robot_review_evidence_convincing : true,
    missing_evidence: toStringArray(task.metadata?.robot_review_missing_evidence),
    submitted_at: typeof task.metadata?.robot_review_submitted_at === "string" ? task.metadata.robot_review_submitted_at : new Date(0).toISOString(),
    mode: task.metadata?.robot_review_mode === "auto" ? "auto" : "manual",
    raw_output: typeof task.metadata?.robot_review_raw_output === "string" ? task.metadata.robot_review_raw_output : undefined,
  };
}

export function getRobotReviews(task: Task): RobotReviewRecord[] {
  const reviews = Array.isArray(task.metadata?.robot_reviews)
    ? task.metadata.robot_reviews
      .map((review: unknown, index: number) => normalizeReview(review, index))
      .filter((review): review is RobotReviewRecord => review !== undefined)
    : [];
  if (reviews.length > 0) {
    return reviews.map((review, index) => ({ ...review, iteration: index + 1 }));
  }
  const legacy = getLegacyRobotReview(task);
  return legacy ? [legacy] : [];
}

export function getLatestRobotReview(task: Task): RobotReviewRecord | undefined {
  const reviews = getRobotReviews(task);
  return reviews.length > 0 ? reviews[reviews.length - 1] : undefined;
}

export function appendRobotReviewMetadata(task: Task, review: Omit<RobotReviewRecord, "iteration">): Record<string, unknown> {
  const robot_reviews = [...getRobotReviews(task), { ...review, iteration: 0 }].map((entry, index) => ({
    ...entry,
    iteration: index + 1,
  }));
  const latest = robot_reviews[robot_reviews.length - 1];
  return {
    robot_reviews,
    robot_review_reviewer: latest.reviewer,
    robot_review_scope: latest.scope,
    robot_review_observations: latest.observations,
    robot_review_blind_spots: latest.blind_spots,
    robot_review_evidence_complete: latest.evidence_complete,
    robot_review_evidence_convincing: latest.evidence_convincing,
    robot_review_missing_evidence: latest.missing_evidence,
    robot_review_submitted_at: latest.submitted_at,
    robot_review_mode: latest.mode,
    robot_review_raw_output: latest.raw_output ?? null,
    robot_review_requires_followup: !(latest.evidence_complete && latest.evidence_convincing),
    robot_review_iteration_count: robot_reviews.length,
  };
}

export function latestRobotReviewPasses(task: Task): boolean {
  const latest = getLatestRobotReview(task);
  return latest ? latest.evidence_complete && latest.evidence_convincing : false;
}
