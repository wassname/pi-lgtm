import { getLatestRobotReview } from "./robot-review.js";
import type { Task } from "./types.js";

function hasCurrentEvidence(task: Task): boolean {
	return (
		typeof task.metadata?.lgtm_evidence === "string" &&
		task.metadata.lgtm_evidence.length > 0
	);
}

function hasEvidenceHistory(task: Task): boolean {
	return (
		Array.isArray(task.metadata?.lgtm_history) &&
		task.metadata.lgtm_history.length > 0
	);
}

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
export function getCompletionMode(task: Task): CompletionMode {
	return task.parentId ? "direct" : "proof";
}

export function getReviewState(task: Task): ReviewState {
	if (task.status === "completed") return "completed";
	const latest = getLatestRobotReview(task);
	if (latest && !latest.accepted) return "reviewer_rejected";
	if (latest?.accepted) return "reviewer_accepted";
	if (typeof task.metadata?.robot_review_last_error === "string")
		return "reviewer_failed_to_run";
	if (hasCurrentEvidence(task)) return "claim_submitted";
	if (hasEvidenceHistory(task)) return "superseded";
	return "no_claim";
}

export function needsProofAttention(task: Task): boolean {
	if (task.parentId || task.status === "completed") return false;
	const state = getReviewState(task);
	return (
		state === "reviewer_rejected" ||
		state === "reviewer_accepted" ||
		state === "reviewer_failed_to_run"
	);
}

export function getGateStatus(task: Task): string {
	const state = getReviewState(task);
	if (task.parentId) {
		return task.status === "completed"
			? "completed directly as subtask"
			: "subtask: direct completion allowed";
	}
	if (task.status === "completed") {
		if (typeof task.metadata?.robot_review_last_error === "string") {
			return `completed with reviewer unavailable: ${task.metadata.robot_review_last_error}`;
		}
		if (getLatestRobotReview(task)?.accepted)
			return "completed after accepted proof review";
		return "completed";
	}
	if (state === "no_claim")
		return "top-level task requires TaskClaimDone evidence before completion";
	if (state === "reviewer_accepted")
		return "review accepted; task should be completed";
	if (state === "reviewer_failed_to_run") {
		return `review unavailable; autonomy continues: ${task.metadata.robot_review_last_error}`;
	}
	if (state === "reviewer_rejected")
		return "latest proof review rejected the evidence; strengthen the proof and try again";
	if (state === "superseded")
		return "current evidence superseded, waiting for a new proof claim";
	return "proof claim submitted, automatic review still required";
}
