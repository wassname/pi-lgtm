import { getLatestRobotReview, getRobotReviews } from "./robot-review.js";
import type { Task } from "./types.js";

const STAGES = ["🛠", "🤖", "✓"] as const;

function hasCurrentEvidence(task: Task): boolean {
  return typeof task.metadata?.lgtm_evidence === "string" && task.metadata.lgtm_evidence.length > 0;
}

function hasEvidenceHistory(task: Task): boolean {
  return Array.isArray(task.metadata?.lgtm_history) && task.metadata.lgtm_history.length > 0;
}

/** Pipeline stages: `[🛠·🤖·✓]` fills left-to-right as evidence→review→completed progresses. */
export function getReviewBadges(task: Task): string {
  const filled = [
    !!task.metadata?.lgtm_evidence,
    getRobotReviews(task).length > 0,
    task.status === "completed",
  ];
  const slots = STAGES.map((emoji, i) => filled[i] ? emoji : "·");
  return `[${slots.join("")}]`;
}

export const REVIEW_BADGES = {
  evidence: STAGES[0],
  robot: STAGES[1],
  complete: STAGES[2],
  pipeline: STAGES,
};

export type DisplayStatus = "in_progress" | "pending" | "completed";

export function getDisplayStatus(task: Task): DisplayStatus {
  return task.status;
}

export type CompletionMode = "direct" | "proof";
export type ReviewState =
  | "no_claim"
  | "claim_submitted"
  | "reviewer_failed_to_run"
  | "reviewer_rejected"
  | "reviewer_accepted"
  | "superseded"
  | "completed";
export type StateTag = "ACTIVE" | "PENDING" | "DONE";

export function getCompletionMode(task: Task): CompletionMode {
  return task.parentId ? "direct" : "proof";
}

export function getReviewState(task: Task): ReviewState {
  if (task.status === "completed") return "completed";
  const latest = getLatestRobotReview(task);
  if (latest && !latest.accepted) return "reviewer_rejected";
  if (latest?.accepted) return "reviewer_accepted";
  if (typeof task.metadata?.robot_review_last_error === "string") return "reviewer_failed_to_run";
  if (hasCurrentEvidence(task)) return "claim_submitted";
  if (hasEvidenceHistory(task)) return "superseded";
  return "no_claim";
}

export function getGateStatus(task: Task): string {
  const state = getReviewState(task);
  if (task.parentId) {
    return task.status === "completed" ? "completed directly as subtask" : "subtask: direct completion allowed";
  }
  if (task.status === "completed") {
    if (typeof task.metadata?.robot_review_last_error === "string") {
      return `completed with reviewer unavailable: ${task.metadata.robot_review_last_error}`;
    }
    if (getLatestRobotReview(task)?.accepted) return "completed after accepted proof review";
    return "completed";
  }
  if (state === "no_claim") return "top-level task requires TaskClaimDone evidence before completion";
  if (state === "reviewer_accepted") return "review accepted; task should be completed";
  if (state === "reviewer_failed_to_run") {
    return `review unavailable; autonomy continues: ${task.metadata.robot_review_last_error}`;
  }
  if (state === "reviewer_rejected") return "latest proof review rejected the evidence; strengthen the proof and try again";
  if (state === "superseded") return "current evidence superseded, waiting for a new proof claim";
  return "proof claim submitted, automatic review still required";
}

/** Short uppercase tag for compact task-list display. */
export function getStateTag(task: Task): StateTag {
  const s = getDisplayStatus(task);
  if (s === "completed") return "DONE";
  if (s === "in_progress") return "ACTIVE";
  return "PENDING";
}

/** Theme colour key for each state tag (only theme colours present in pi-tui are used). */
export function getStateTagColor(tag: StateTag): "accent" | "dim" | undefined {
  if (tag === "ACTIVE") return "accent";
  if (tag === "DONE") return "dim";
  return undefined; // PENDING — default fg
}
