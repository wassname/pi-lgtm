import { getRobotReviews } from "./robot-review.js";
import type { Task } from "./types.js";

const STAGES = ["🛠", "🤖", "👀"] as const;

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

export type DisplayStatus = "awaiting_signoff" | "in_progress" | "pending" | "completed";

/** Derived display bucket. `awaiting_signoff` is pending_approval && !completed. */
export function getDisplayStatus(task: Task): DisplayStatus {
  if (task.status === "completed") return "completed";
  if (task.pending_approval) return "awaiting_signoff";
  return task.status;
}

export type StateTag = "READY" | "ACTIVE" | "PENDING" | "DONE";

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
