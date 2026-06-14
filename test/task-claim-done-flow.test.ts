import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import proofTasksExtension from "../src/index.js";

type RegisteredTool = {
	name: string;
	execute: (...args: any[]) => Promise<any>;
};

function makeHarness() {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		on: vi.fn(),
		registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
		registerCommand: vi.fn(),
		sendMessage: vi.fn(),
	};

	proofTasksExtension(pi as any);

	async function execTool(
		name: string,
		params: Record<string, unknown>,
		ctx: Record<string, unknown> = {},
	) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Tool ${name} not registered`);
		return tool.execute("tool-call", params, undefined, undefined, ctx);
	}

	return { execTool };
}

function writeReviewerScript(source: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-proof-reviewer-"));
	const path = join(dir, "reviewer.js");
	writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
	chmodSync(path, 0o755);
	return path;
}

const ORIGINAL_PI_BIN = process.env.PI_PROOF_TASKS_PI_BIN;
afterEach(() => {
	if (ORIGINAL_PI_BIN === undefined) delete process.env.PI_PROOF_TASKS_PI_BIN;
	else process.env.PI_PROOF_TASKS_PI_BIN = ORIGINAL_PI_BIN;
});

describe("TaskClaimDone end-to-end proof flow", () => {
	it("keeps the task open on rejected review and /lgtm-style TaskGet shows truncated evidence", async () => {
		const reviewer = writeReviewerScript(`
const review = {
  reviewer: "fake-judge",
  scope: "task evidence",
  rubric: {
    evidence_covers_done_criterion: { reason: "missing one artifact", pass: false },
    falsification_test_runnable: { reason: "ok", pass: true },
    failure_modes_addressed: { reason: "ok", pass: true },
    evidence_distinguishes_success: { reason: "not enough", pass: false },
    verification_hints_actionable: { reason: "ok", pass: true }
  },
  observations: ["Observed truncated proof packet"],
  concerns: ["Need stronger evidence"],
  suggestions: ["Add one more artifact"],
  blind_spots: "Did not inspect live TUI",
  missing_evidence: ["evidence_covers_done_criterion", "evidence_distinguishes_success"],
  evidence_complete: false,
  evidence_convincing: false,
  accepted: false
};
console.log("ROBOT_REVIEW_JSON_START");
console.log(JSON.stringify(review));
console.log("ROBOT_REVIEW_JSON_END");
`);
		process.env.PI_PROOF_TASKS_PI_BIN = reviewer;

		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Proof task",
			description: "Desc",
			done_criterion: "done",
		});

		const artifactPath = join(tmpdir(), "proof-long-evidence.log");
		const longEvidence = Array.from(
			{ length: 35 },
			(_, i) => `line ${i + 1}`,
		).join("\n");
		writeFileSync(artifactPath, longEvidence);

		const claim = await harness.execTool(
			"TaskClaimDone",
			{
				taskId: "1",
				evidence: longEvidence,
				failure_likely: "missing artifact",
				failure_sneaky: "right shape for wrong reason",
				failure_unknown: "untested provider path",
				falsification_test: "npm test\npass",
				evidence_reasoning:
					"The packet distinguishes the named failures for this test scope.",
				verification_hints: ["look at the proof log"],
				remaining_uncertainty: "Did not inspect live TUI",
				evidence_paths: [artifactPath],
			},
			{ model: { provider: "openai", id: "gpt-5" } },
		);

		const claimText = claim.content[0].text;

		const taskGet = await harness.execTool("TaskGet", { taskId: "1" });
		const text = taskGet.content[0].text;

		expect(claimText).toContain("## TaskClaimDone -> Task #1: Proof task");
		expect(claimText).toContain("### Metadata");
		expect(claimText).toContain("- Proof iterations: 1");
		expect(claimText).toContain("- Robot reviews: 1");
		expect(text).toContain("Status: pending");
		expect(text).toContain(
			"Gate status: latest proof review rejected the evidence; strengthen the proof and try again",
		);
		expect(text).toContain("line 1");
		expect(text).toContain("line 8");
		expect(text).toContain("line 35");
		expect(text).not.toContain("line 9");
		expect(text).toContain("[... 19 middle lines omitted ...]");
		expect(text).toContain(
			`[truncated at 16 lines from 35; showing first 8 and last 8; full text: ${artifactPath}]`,
		);
		expect(text).toContain("### Judgement");
		expect(text).toContain("Refused");
		expect(text).toContain("Needs:");
		expect(text).toContain("Add one more artifact");
	});

	it("completes the task fail-open on parse failure and preserves the failure note", async () => {
		const reviewer = writeReviewerScript(`
console.log("ROBOT_REVIEW_JSON_START and nope ROBOT_REVIEW_JSON_END");
`);
		process.env.PI_PROOF_TASKS_PI_BIN = reviewer;

		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Proof task",
			description: "Desc",
			done_criterion: "done",
		});

		const claim = await harness.execTool(
			"TaskClaimDone",
			{
				taskId: "1",
				evidence: "short evidence",
				failure_likely: "missing artifact",
				failure_sneaky: "right shape for wrong reason",
				failure_unknown: "untested provider path",
				falsification_test: "npm test\npass",
				evidence_reasoning:
					"The packet distinguishes the named failures for this test scope.",
				verification_hints: ["look at the proof log"],
				remaining_uncertainty: "Did not inspect live TUI",
			},
			{ model: { provider: "openai", id: "gpt-5" } },
		);

		const claimText = claim.content[0].text;

		const taskGet = await harness.execTool("TaskGet", { taskId: "1" });
		const text = taskGet.content[0].text;

		expect(claimText).toContain("## TaskClaimDone -> Task #1: Proof task");
		expect(claimText).toContain("### Metadata");
		expect(claimText).toContain(
			"- Gate status: completed with reviewer unavailable",
		);
		expect(text).toContain("Status: completed");
		expect(text).toContain("completed with reviewer unavailable");
		expect(text).toContain("Raw output:");
		expect(text).toContain("Autonomy continued without blocking completion.");
		expect(text).not.toContain("Needs:");
		expect(text).toContain(
			"ROBOT_REVIEW_JSON_START and nope ROBOT_REVIEW_JSON_END",
		);
		expect(text).toContain("Autonomy continued without blocking completion.");
	});
});
