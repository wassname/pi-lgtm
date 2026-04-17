import { getRobotReviews } from "./robot-review.js";
import type { Task } from "./types.js";

export const REVIEW_BADGES = {
  tool: "🛠",
  robot: "🤖",
  human: "👀",
} as const;

export function getReviewBadges(task: Task): string[] {
  const badges: string[] = [];
  if (task.metadata?.lgtm_evidence) badges.push(REVIEW_BADGES.tool);
  if (getRobotReviews(task).length > 0) badges.push(REVIEW_BADGES.robot);
  if (task.pending_approval && task.status !== "completed") badges.push(REVIEW_BADGES.human);
  return badges;
}
