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
