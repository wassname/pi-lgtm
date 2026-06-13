import { getLatestRobotReview, getRobotReviews } from "./robot-review.js";
import type { Task } from "./types.js";

const STAGES = ["🛠", "🤖", "👀"] as const;

function hasCurrentEvidence(task: Task): boolean {
  return typeof task.metadata?.lgtm_evidence === "string" && task.metadata.lgtm_evidence.length > 0;
}

function hasEvidenceHistory(task: Task): boolean {
  return Array.isArray(task.metadata?.lgtm_history) && task.metadata.lgtm_history.length > 0;
}

/** Pipeline stages: `[🛠·🤖·👀]` fills left-to-right as evidence→review→signoff progresses. */
export function getReviewBadges(task: Task): string {
  const filled = [
    !!task.metadata?.lgtm_evidence,
    getRobotReviews(task).length > 0,
    task.pending_approval && task.status !== "completed",
  ];
  const slots = STAGES.map((emoji, i) => filled[i] ? emoji : "·");
  return `[${slots.join("")}]`;
}

export const REVIEW_BADGES = {
  evidence: STAGES[0],
  robot: STAGES[1],
  human: STAGES[2],
  pipeline: STAGES,
};

export type DisplayStatus = "awaiting_signoff" | "in_progress" | "pending" | "completed";

/** Derived display bucket. `awaiting_signoff` is pending_approval && !completed. */
export function getDisplayStatus(task: Task): DisplayStatus {
  if (task.status === "completed") return "completed";
  if (task.pending_approval) return "awaiting_signoff";
  return task.status;
}

export type CompletionMode = "direct" | "lgtm";
export type ReviewState =
  | "no_evidence"
  | "evidence_submitted"
  | "reviewer_failed_to_run"
  | "reviewer_rejected"
  | "ready_for_human"
  | "superseded"
  | "human_signed_off";
export type StateTag = "READY" | "ACTIVE" | "PENDING" | "DONE";

export function getCompletionMode(task: Task): CompletionMode {
  return hasCurrentEvidence(task) || hasEvidenceHistory(task) || getRobotReviews(task).length > 0 || task.pending_approval
    ? "lgtm"
    : "direct";
}

export function getReviewState(task: Task): ReviewState {
  if (task.status === "completed") return "human_signed_off";
  const latest = getLatestRobotReview(task);
  if (latest && !latest.accepted) return "reviewer_rejected";
  if (task.pending_approval && hasCurrentEvidence(task)) return "ready_for_human";
  if (typeof task.metadata?.robot_review_last_error === "string") return "reviewer_failed_to_run";
  if (hasCurrentEvidence(task)) return "evidence_submitted";
  if (hasEvidenceHistory(task)) return "superseded";
  return "no_evidence";
}

export function getGateStatus(task: Task): string {
  const state = getReviewState(task);
  if (state === "human_signed_off") return "human signed off";
  if (state === "no_evidence") return "no lgtm evidence submitted";
  if (state === "ready_for_human") {
    if (typeof task.metadata?.robot_review_last_error === "string") {
      return `warning: automatic robot review failed, human sign-off still allowed via /lgtm ${task.id}: ${task.metadata.robot_review_last_error}`;
    }
    return `ready for human sign-off via /lgtm ${task.id}`;
  }
  if (state === "reviewer_failed_to_run") {
    return `blocked: automatic robot review failed: ${task.metadata.robot_review_last_error}`;
  }
  if (state === "reviewer_rejected") return "blocked: latest robot review rejected the evidence";
  if (state === "superseded") return "current evidence superseded, waiting for a new lgtm submission";
  return "blocked: evidence submitted, robot review still required";
}

/** Short uppercase tag for the human ("can I /lgtm this?" at a glance). */
export function getStateTag(task: Task): StateTag {
  const s = getDisplayStatus(task);
  if (s === "completed") return "DONE";
  if (s === "awaiting_signoff") return "READY";
  if (s === "in_progress") return "ACTIVE";
  return "PENDING";
}

/** Theme colour key for each state tag (only theme colours present in pi-tui are used). */
export function getStateTagColor(tag: StateTag): "success" | "accent" | "dim" | undefined {
  if (tag === "READY") return "success";
  if (tag === "ACTIVE") return "accent";
  if (tag === "DONE") return "dim";
  return undefined; // PENDING — default fg
}
