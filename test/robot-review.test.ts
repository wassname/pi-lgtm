import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	archiveCurrentEvidence,
	buildArtifactRecords,
	buildRobotReviewPrompt,
	getCurrentEvidenceIteration,
	getEvidenceHistory,
	renderEvidencePacket,
	renderProofLog,
} from "../src/index.js";
import {
	appendRobotReviewMetadata,
	getLatestRobotReview,
	getRobotReviews,
	hasCompleteProofClaim,
	relaxAdvisoryVerificationHints,
	shouldCompleteAfterAcceptedReview,
} from "../src/robot-review.js";
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

describe("robot review helpers", () => {
	it("completes only after accepted review and complete proof claim", () => {
		const task = makeTask({
			metadata: {
				lgtm_evidence: "literal output",
				lgtm_failure_likely: "wrong command",
				lgtm_failure_sneaky: "right output for wrong reason",
				lgtm_failure_unknown: "untested platform",
				lgtm_falsification_test: "npm test\npass",
				lgtm_evidence_reasoning:
					"the test output rules out the named failures for this scope",
				lgtm_verification_hints: [
					"test/robot-review.test.ts shows the expectation",
				],
				lgtm_remaining_uncertainty: "does not test prod install",
			},
		});
		expect(hasCompleteProofClaim(task)).toBe(true);
		expect(shouldCompleteAfterAcceptedReview(task, true)).toBe(true);
		expect(shouldCompleteAfterAcceptedReview(task, false)).toBe(false);
		expect(
			shouldCompleteAfterAcceptedReview(
				makeTask({ metadata: { lgtm_evidence: "literal output" } }),
				true,
			),
		).toBe(false);
	});

	it("reads legacy single-review metadata", () => {
		const task = makeTask({
			metadata: {
				robot_review_reviewer: "opencode",
				robot_review_scope: "task evidence",
				robot_review_observations: [
					"Observed no command output for the core claim",
				],
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
		const dir = mkdtempSync(join(tmpdir(), "pi-proof-tasks-"));
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
				lgtm_failure_unknown: "untested environment",
				lgtm_falsification_test: "pytest -k check",
				lgtm_evidence_reasoning:
					"pytest output distinguishes the expected passing path from the named failures",
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
		expect(getEvidenceHistory(taskWithHistory)[0].supersede_reason).toBe(
			"threshold changed",
		);
	});

	it("treats advisory rubric failures as non-blocking when core evidence already passes", () => {
		const review = relaxAdvisoryVerificationHints({
			reviewer: "auto",
			scope: "task evidence",
			observations: ["Observed commit, push, and test logs"],
			concerns: [],
			suggestions: [],
			blind_spots: "Did not inspect interactive UI",
			accepted: false,
			evidence_complete: true,
			evidence_convincing: false,
			missing_evidence: [
				"verification_hints_actionable",
				"evidence_distinguishes_success",
			],
			submitted_at: "2026-06-13T00:00:00.000Z",
			mode: "auto",
			rubric: {
				evidence_covers_done_criterion: {
					reason: "verbatim logs match",
					pass: true,
				},
				falsification_test_runnable: {
					reason: "command and output shown",
					pass: true,
				},
				failure_modes_addressed: {
					reason: "plausible top risks named",
					pass: true,
				},
				evidence_distinguishes_success: {
					reason: "reasoning writeup is thin",
					pass: false,
				},
				verification_hints_actionable: {
					reason: "paths are vague",
					pass: false,
				},
			},
		});

		expect(review.accepted).toBe(true);
		expect(review.evidence_convincing).toBe(true);
		expect(
			review.observations.some((item) => item.includes("treated as advisory")),
		).toBe(true);
		expect(review.missing_evidence).toEqual([]);
	});

	it("does not relax verification hints unless the core rubric passes", () => {
		const review = relaxAdvisoryVerificationHints({
			reviewer: "auto",
			scope: "task evidence",
			observations: ["Observed vague summary only"],
			concerns: [],
			suggestions: [],
			blind_spots: "Did not rerun tests",
			accepted: false,
			evidence_complete: true,
			evidence_convincing: false,
			missing_evidence: ["verification_hints_actionable"],
			submitted_at: "2026-06-13T00:00:00.000Z",
			mode: "auto",
			rubric: {
				evidence_covers_done_criterion: { reason: "summary only", pass: false },
				falsification_test_runnable: {
					reason: "command and output shown",
					pass: true,
				},
				failure_modes_addressed: {
					reason: "plausible top risks named",
					pass: true,
				},
				evidence_distinguishes_success: {
					reason: "evidence does not rule out summary-only failure",
					pass: false,
				},
				verification_hints_actionable: {
					reason: "paths are vague",
					pass: false,
				},
			},
		});

		expect(review.accepted).toBe(false);
		expect(review.evidence_convincing).toBe(false);
	});

	it("renders one compact evidence packet for both human and robot review", () => {
		const task = makeTask({
			metadata: {
				lgtm_evidence: "literal output",
				lgtm_failure_likely: "wrong seed",
				lgtm_failure_sneaky: "wrong threshold",
				lgtm_failure_unknown: "does not test UI rendering",
				lgtm_falsification_test: "pytest -k check\nPASSED",
				lgtm_evidence_reasoning:
					"The passing pytest transcript distinguishes success from wrong-threshold and wrong-seed failures for this test scope.",
				lgtm_verification_hints: [
					"test/robot-review.test.ts contains the new guard test",
				],
				lgtm_remaining_uncertainty: "not load tested",
				lgtm_submitted_at: "2026-06-14T00:00:00.000Z",
				lgtm_commands: [
					{ cmd: "npm test", exit_code: 0, stdout_path: "/tmp/test.log" },
				],
				lgtm_evidence_artifacts: [
					{ path: "/tmp/test.log", sha256: "abc", bytes: 123 },
				],
			},
		});

		const packet = renderEvidencePacket(task);
		const prompt = buildRobotReviewPrompt(task);
		expect(packet).toContain("## Goal");
		expect(packet).toContain("## Attempt 1");
		expect(packet).toContain("### Evidence");
		expect(packet).toContain("### Verify");
		expect(prompt).toContain(packet);
		expect(prompt).toContain(
			"does this packet prove the exact user-visible success condition",
		);
		expect(prompt).toContain(
			"Do not reject solely because items 3, 4, or 5 are weak",
		);
		expect(prompt).toContain(
			"concrete missing artifacts or outputs that block acceptance",
		);
	});

	it("truncates long submitted evidence in the rendered proof log and points to the full artifact", () => {
		const longEvidence = Array.from(
			{ length: 35 },
			(_, i) => `line ${i + 1}`,
		).join("\n");
		const task = makeTask({
			metadata: {
				lgtm_evidence: longEvidence,
				lgtm_failure_likely: "wrong seed",
				lgtm_failure_sneaky: "wrong threshold",
				lgtm_failure_unknown: "untested environment",
				lgtm_falsification_test: "pytest -k check\nPASSED",
				lgtm_evidence_reasoning:
					"The transcript rules out the named failures for this scope.",
				lgtm_verification_hints: ["see /tmp/test.log"],
				lgtm_remaining_uncertainty: "not load tested",
				lgtm_submitted_at: "2026-06-14T00:00:00.000Z",
				lgtm_evidence_artifacts: [
					{ path: "/tmp/test.log", sha256: "abc", bytes: 123 },
				],
			},
		});

		const log = renderProofLog(task);
		expect(log).toContain("line 1");
		expect(log).toContain("line 8");
		expect(log).toContain("line 35");
		expect(log).not.toContain("line 9");
		expect(log).toContain("[... 19 middle lines omitted ...]");
		expect(log).toContain(
			"[truncated at 16 lines from 35; showing first 8 and last 8; full text: /tmp/test.log]",
		);
	});

	it("appends robot reviews as iterations", () => {
		const task = makeTask();
		const metadata1 = appendRobotReviewMetadata(task, {
			reviewer: "opencode",
			scope: "task evidence",
			observations: ["Observed missing benchmark output"],
			concerns: ["The current evidence does not show the claimed speedup."],
			suggestions: ["Add the benchmark transcript for the claimed speedup."],
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
			concerns: [],
			suggestions: [],
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

	it("renders a simple proof log with judgement and suggestions", () => {
		const taskWithEvidence = makeTask({
			metadata: {
				lgtm_evidence: "npm test\n125 passed",
				lgtm_failure_likely: "old package name still in README",
				lgtm_failure_sneaky: "top-level direct completion still slips through",
				lgtm_failure_unknown: "fresh judge command fails in a real session",
				lgtm_falsification_test: "npm test\n125 passed",
				lgtm_evidence_reasoning:
					"The test transcript and grep distinguish the intended behavior from stale workflow regressions.",
				lgtm_verification_hints: [
					"README.md install block shows pi-proof-tasks",
				],
				lgtm_remaining_uncertainty: "Did not exercise every model provider.",
				lgtm_submitted_at: "2026-06-14T00:00:00.000Z",
			},
		});
		const task = makeTask({
			metadata: {
				...taskWithEvidence.metadata,
				...appendRobotReviewMetadata(taskWithEvidence, {
					reviewer: "auto",
					scope: "proof log",
					observations: ["Observed the test transcript and renamed package."],
					concerns: ["The live Pi session path is still untested."],
					suggestions: ["Run one self-hosted TaskClaimDone UAT."],
					blind_spots: "Did not inspect external auth state",
					accepted: false,
					evidence_complete: true,
					evidence_convincing: false,
					missing_evidence: ["self-hosted TaskClaimDone UAT"],
					submitted_at: "2026-06-14T00:01:00.000Z",
					mode: "auto",
				}),
			},
		});

		const log = renderProofLog(task);
		expect(log).toContain("# Task #1: Test");
		expect(log).toContain("## Goal");
		expect(log).toContain("## Attempt 1");
		expect(log).toContain("### Evidence");
		expect(log).toContain("### Verify");
		expect(log).toContain("### Judgement");
		expect(log).toContain("Refused by auto");
		expect(log).toContain("Needs:");
		expect(log).toContain("Next:");
		expect(log).toContain("Run one self-hosted TaskClaimDone UAT.");
	});

	it("keeps full submitted evidence in the automatic review packet even when proof logs truncate it", () => {
		const artifactPath = join(tmpdir(), "proof-packet-long-evidence.log");
		const longEvidence = Array.from(
			{ length: 35 },
			(_, i) => `line ${i + 1}`,
		).join("\n");
		writeFileSync(artifactPath, longEvidence);
		const task = makeTask({
			metadata: {
				lgtm_evidence: longEvidence,
				lgtm_failure_likely: "missing artifact",
				lgtm_failure_sneaky: "wrong slice shown",
				lgtm_failure_unknown: "untested provider path",
				lgtm_falsification_test: "npm test\npass",
				lgtm_evidence_reasoning:
					"The full evidence must stay visible to the judge even if humans see a shortened preview.",
				lgtm_verification_hints: [
					"Open the artifact if the inline preview truncates.",
				],
				lgtm_remaining_uncertainty: "Did not inspect live TUI.",
				lgtm_evidence_artifacts: buildArtifactRecords([artifactPath]),
			},
		});

		const proofLog = renderProofLog(task);
		const reviewPacket = renderEvidencePacket(task, {
			truncateEvidence: false,
		});
		expect(proofLog).toContain("line 8");
		expect(proofLog).toContain("line 35");
		expect(proofLog).not.toContain("line 9");
		expect(reviewPacket).toContain("line 35");
		expect(reviewPacket).not.toContain("[truncated at 16 lines");
	});

	it("renders reviewer-unavailable proof logs for fail-open completion notes", () => {
		const task = makeTask({
			status: "completed",
			metadata: {
				lgtm_evidence: "npm test\n125 passed",
				lgtm_failure_likely: "old package name still in README",
				lgtm_failure_sneaky: "top-level direct completion still slips through",
				lgtm_failure_unknown: "fresh judge command fails in a real session",
				lgtm_falsification_test: "npm test\n125 passed",
				lgtm_evidence_reasoning:
					"The test transcript and grep distinguish the intended behavior from stale workflow regressions.",
				lgtm_verification_hints: [
					"README.md install block shows pi-proof-tasks",
				],
				lgtm_remaining_uncertainty: "Did not exercise every model provider.",
				robot_review_last_error: "judge auth failed",
			},
		});

		const log = renderProofLog(task);
		expect(log).toContain("completed with reviewer unavailable");
		expect(log).toContain("### Judgement");
		expect(log).toContain("judge auth failed");
		expect(log).toContain("Autonomy continued without blocking completion.");
		expect(log).not.toContain("Needs:");
	});
});
