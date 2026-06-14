import { describe, expect, it } from "vitest";
import {
	getCompletionMode,
	getDisplayStatus,
	getGateStatus,
	getReviewState,
} from "../src/review-badges.js";
import type { Task } from "../src/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "1",
		subject: "Test",
		description: "Desc",
		done_criterion: "done",
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

describe("review state helpers", () => {
	it("reports completion mode as proof for top-level tasks", () => {
		expect(getCompletionMode(makeTask())).toBe("proof");
	});

	it("reports completion mode as direct for subtasks", () => {
		expect(getCompletionMode(makeTask({ parentId: "1" }))).toBe("direct");
	});

	it("reports superseded when only history remains", () => {
		expect(
			getReviewState(
				makeTask({ metadata: { lgtm_history: [{ iteration: 1 }] } }),
			),
		).toBe("superseded");
	});
});

describe("getGateStatus", () => {
	it("reports top-level proof requirement before evidence", () => {
		expect(getGateStatus(makeTask())).toBe(
			"top-level task requires TaskClaimDone evidence before completion",
		);
	});

	it("reports non-blocking reviewer failure", () => {
		expect(
			getGateStatus(
				makeTask({
					metadata: {
						lgtm_evidence: "ok",
						robot_review_last_error: "Unexpected token 'a'",
					},
				}),
			),
		).toContain("review unavailable; autonomy continues");
	});

	it("reports rejected robot review when latest review does not accept", () => {
		expect(
			getGateStatus(
				makeTask({
					metadata: {
						lgtm_evidence: "ok",
						robot_reviews: [
							{
								iteration: 1,
								reviewer: "opencode",
								scope: "task evidence",
								observations: ["Observed missing output"],
								concerns: ["The current evidence is summary-only."],
								suggestions: ["Paste the literal output."],
								blind_spots: "none",
								accepted: false,
								evidence_complete: false,
								evidence_convincing: false,
								missing_evidence: ["literal output"],
								submitted_at: "2026-04-17T00:00:00.000Z",
								mode: "manual",
							},
						],
					},
				}),
			),
		).toBe(
			"latest proof review rejected the evidence; strengthen the proof and try again",
		);
	});

	it("keeps rejection higher priority than a later reviewer warning", () => {
		expect(
			getGateStatus(
				makeTask({
					metadata: {
						lgtm_evidence: "ok",
						robot_review_last_error: "timeout",
						robot_reviews: [
							{
								iteration: 1,
								reviewer: "opencode",
								scope: "task evidence",
								observations: ["Observed missing output"],
								concerns: ["The current evidence is summary-only."],
								suggestions: ["Paste the literal output."],
								blind_spots: "none",
								accepted: false,
								evidence_complete: false,
								evidence_convincing: false,
								missing_evidence: ["literal output"],
								submitted_at: "2026-04-17T00:00:00.000Z",
								mode: "manual",
							},
						],
					},
				}),
			),
		).toBe(
			"latest proof review rejected the evidence; strengthen the proof and try again",
		);
	});
});

describe("getDisplayStatus", () => {
	it("returns pending for fresh tasks", () => {
		expect(getDisplayStatus(makeTask())).toBe("pending");
	});

	it("returns in_progress for active tasks not yet escalated", () => {
		expect(getDisplayStatus(makeTask({ status: "in_progress" }))).toBe(
			"in_progress",
		);
	});

	it("returns completed for completed tasks", () => {
		expect(getDisplayStatus(makeTask({ status: "completed" }))).toBe(
			"completed",
		);
	});
});
