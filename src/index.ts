/**
 * pi-proof-tasks — Hermes-style evidence + judge task list for pi coding agent.
 *
 * Two-tier model:
 *   - Subtasks: agent self-manages. Checklist work completes via TaskUpdate.
 *   - Top-level tasks: goals. TaskClaimDone submits a compact proof/UAT packet,
 *     a fresh judge gives an independent perspective, and explicit rejection keeps
 *     the task open for a stronger retry.
 *
 * Tools:
 *   TaskCreate       — Create a task with done_criterion
 *   TaskList         — List tasks grouped by status
 *   TaskGet          — Get full task details
 *   TaskUpdate       — Update task fields/status (gated for top-level proof goals)
 *   TaskClaimDone    — Present evidence + failure modes for proof review
 *   robot_review_ask — Attach observational review from a fresh-perspective agent
 *   robot_review_run — Re-run the automatic robot reviewer
 *
 * Commands:
 *   /tasks            — Interactive task management menu
 *   /lgtm <id...>     — View the proof log for one or more tasks
 *   /lgtm *           — View all open task proof logs
 *   /lgtm             — Pick a task to inspect proof logs
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AutoClearManager } from "./auto-clear.js";
import {
	type CompletionMode,
	getCompletionMode,
	getDisplayStatus,
	getGateStatus,
	getReviewState,
	type ReviewState,
} from "./review-badges.js";
import {
	appendRobotReviewMetadata,
	getLatestRobotReview,
	getRobotReviews,
	type RobotReviewRecord,
	relaxAdvisoryVerificationHints,
	shouldCompleteAfterAcceptedReview,
} from "./robot-review.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import type { Task } from "./types.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

function textResult(msg: string) {
	return {
		content: [{ type: "text" as const, text: msg }],
		details: undefined as any,
	};
}

export type LgtmCommandSpec =
	| { kind: "menu" }
	| { kind: "view_all" }
	| { kind: "view"; ids: string[] }
	| { kind: "error"; message: string };

export function parseLgtmArgs(args: string): LgtmCommandSpec {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "menu" };
	if (trimmed === "*") return { kind: "view_all" };

	const tokens = trimmed
		.split(/[\s,]+/)
		.map((token) => token.trim())
		.filter(Boolean);
	if (["clear", "delete"].includes(tokens[0])) {
		return {
			kind: "error",
			message: "Task management lives in /tasks now. /lgtm is viewer-only.",
		};
	}

	return {
		kind: "view",
		ids: tokens.map((token) => token.replace(/^#/, "")).filter(Boolean),
	};
}

const TASK_TOOL_NAMES = new Set([
	"TaskCreate",
	"TaskList",
	"TaskGet",
	"TaskUpdate",
	"TaskClaimDone",
	"lgtm_supersede",
	"robot_review_ask",
	"robot_review_run",
]);
const REMINDER_INTERVAL = 4;
const AUTO_CLEAR_DELAY = 4;
export const DEFAULT_ROBOT_REVIEW_TIMEOUT_MS = 120_000;

type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

export function getPiInvocation(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
	const configured = env.PI_PROOF_TASKS_PI_BIN?.trim();
	return { command: configured || "pi", args };
}

export function getRobotReviewTimeoutMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const configured = Number.parseInt(
		env.PI_PROOF_TASKS_ROBOT_REVIEW_TIMEOUT_MS ?? "",
		10,
	);
	return Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_ROBOT_REVIEW_TIMEOUT_MS;
}

/** Format pi's current model object as the CLI's provider/model reference. */
export function getCurrentModelRef(model: unknown): string | undefined {
	if (!model || typeof model !== "object") return undefined;
	const provider =
		typeof (model as any).provider === "string"
			? (model as any).provider
			: typeof (model as any).providerId === "string"
				? (model as any).providerId
				: undefined;
	const id =
		typeof (model as any).id === "string"
			? (model as any).id
			: typeof (model as any).modelId === "string"
				? (model as any).modelId
				: undefined;
	return provider && id ? `${provider}/${id}` : undefined;
}

function getAssistantTextFromPiEvent(event: any): string | undefined {
	if (
		event?.type !== "message_end" ||
		event.message?.role !== "assistant" ||
		!Array.isArray(event.message.content)
	) {
		return undefined;
	}
	const text = event.message.content.find(
		(part: any) => part?.type === "text",
	)?.text;
	return typeof text === "string" ? text : undefined;
}

export function extractFinalAssistantTextFromPiJsonl(output: string): string {
	let buffer = "";
	let finalAssistantText = "";
	const lines = output.split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		buffer = line;
		try {
			const text = getAssistantTextFromPiEvent(JSON.parse(line));
			if (text) finalAssistantText = text;
			buffer = "";
		} catch {
			// ignore malformed line noise from the child process
		}
	}
	if (buffer.trim()) {
		try {
			const text = getAssistantTextFromPiEvent(JSON.parse(buffer));
			if (text) finalAssistantText = text;
		} catch {
			// ignore malformed trailing line
		}
	}
	return finalAssistantText;
}

export async function runRobotReviewCommand(
	invocation: { command: string; args: string[] },
	signal?: AbortSignal,
	timeoutMs = getRobotReviewTimeoutMs(),
): Promise<CommandResult> {
	return new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const killTimer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(() =>
				reject(new Error(`Robot reviewer timed out after ${timeoutMs}ms.`)),
			);
		}, timeoutMs);

		child.stdout.on("data", (data) => stdoutChunks.push(data));
		child.stderr.on("data", (data) => stderrChunks.push(data));
		child.on("error", (err) => {
			clearTimeout(killTimer);
			finish(() => reject(err));
		});
		const onAbort = () => {
			clearTimeout(killTimer);
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (exitCode) => {
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				finish(() => reject(new Error("aborted")));
				return;
			}
			const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
			finish(() =>
				resolve({
					stdout: extractFinalAssistantTextFromPiJsonl(stdout) || stdout,
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode,
				}),
			);
		});
	});
}

function summarizeRawOutput(output: string, maxChars = 400): string {
	const singleLine = output.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxChars) return singleLine;
	return `${singleLine.slice(0, maxChars)}...`;
}

function stripMarkdownCodeFence(text: string): string {
	const trimmed = text.trim();
	const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fence ? fence[1].trim() : trimmed;
}

function extractBalancedJsonObject(text: string): string | undefined {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") {
			if (depth === 0) start = index;
			depth++;
			continue;
		}
		if (char === "}") {
			if (depth === 0) continue;
			depth--;
			if (depth === 0 && start >= 0) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

interface EvidenceCommandRecord {
	cmd: string;
	exit_code: number;
	stdout_path?: string;
	stderr_path?: string;
}

interface EvidenceArtifactRecord {
	path: string;
	sha256: string;
	bytes: number;
}

interface EvidenceIterationRecord {
	iteration: number;
	submitted_at: string;
	superseded_at?: string;
	supersede_reason?: string;
	evidence: string;
	failure_likely: string;
	failure_sneaky: string;
	failure_unknown: string;
	falsification_test: string;
	evidence_reasoning: string;
	verification_hints: string[];
	remaining_uncertainty: string;
	commands: EvidenceCommandRecord[];
	evidence_artifacts: EvidenceArtifactRecord[];
	falsification_artifacts: EvidenceArtifactRecord[];
	robot_reviews: RobotReviewRecord[];
	automatic_review_failure?: { message: string; raw_output?: string };
}

const AUTOMATIC_REVIEW_ERROR_KEYS = [
	"robot_review_last_error",
	"robot_review_last_error_output",
	"robot_review_last_error_at",
] as const;

const ROBOT_REVIEW_KEYS = [
	"robot_reviews",
	"robot_review_reviewer",
	"robot_review_scope",
	"robot_review_observations",
	"robot_review_concerns",
	"robot_review_suggestions",
	"robot_review_blind_spots",
	"robot_review_accepted",
	"robot_review_evidence_complete",
	"robot_review_evidence_convincing",
	"robot_review_missing_evidence",
	"robot_review_submitted_at",
	"robot_review_mode",
	"robot_review_raw_output",
	"robot_review_reason",
	"robot_review_requires_followup",
	"robot_review_iteration_count",
] as const;

const CURRENT_EVIDENCE_KEYS = [
	"lgtm_evidence",
	"lgtm_failure_likely",
	"lgtm_failure_sneaky",
	"lgtm_failure_unknown",
	"lgtm_falsification_test",
	"lgtm_evidence_reasoning",
	"lgtm_verification_hints",
	"lgtm_remaining_uncertainty",
	"lgtm_submitted_at",
	"lgtm_commands",
	"lgtm_evidence_artifacts",
	"lgtm_falsification_artifacts",
] as const;

const RESERVED_METADATA_PREFIXES = ["lgtm_", "robot_review"];

function assertNoReservedMetadata(
	metadata: Record<string, any> | undefined,
): string | null {
	if (!metadata) return null;
	for (const key of Object.keys(metadata)) {
		if (RESERVED_METADATA_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			return `Metadata key ${key} is reserved for proof/review internals. Use TaskClaimDone or robot_review_run instead.`;
		}
	}
	return null;
}

function requiredTextError(
	fields: Record<string, unknown>,
	names: string[],
): string | null {
	for (const name of names) {
		const value = fields[name];
		if (typeof value !== "string" || value.trim().length === 0)
			return `${name} is required and cannot be blank.`;
	}
	return null;
}

function nullRecord(keys: readonly string[]): Record<string, null> {
	return Object.fromEntries(keys.map((key) => [key, null]));
}

function getAutomaticReviewFailureMetadata(
	message: string,
	rawOutput?: string,
): Record<string, unknown> {
	return {
		robot_review_last_error: message,
		robot_review_last_error_output: rawOutput ?? null,
		robot_review_last_error_at: new Date().toISOString(),
	};
}

function clearAutomaticReviewFailureMetadata(): Record<string, unknown> {
	return nullRecord(AUTOMATIC_REVIEW_ERROR_KEYS);
}

function clearRobotReviewMetadata(): Record<string, unknown> {
	return nullRecord(ROBOT_REVIEW_KEYS);
}

function clearCurrentEvidenceMetadata(): Record<string, unknown> {
	return nullRecord(CURRENT_EVIDENCE_KEYS);
}

function normalizeCommandRecords(value: unknown): EvidenceCommandRecord[] {
	return Array.isArray(value)
		? value.flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const command = entry as Record<string, unknown>;
				if (
					typeof command.cmd !== "string" ||
					typeof command.exit_code !== "number"
				)
					return [];
				return [
					{
						cmd: command.cmd,
						exit_code: command.exit_code,
						stdout_path:
							typeof command.stdout_path === "string"
								? command.stdout_path
								: undefined,
						stderr_path:
							typeof command.stderr_path === "string"
								? command.stderr_path
								: undefined,
					},
				];
			})
		: [];
}

function normalizeArtifactRecords(value: unknown): EvidenceArtifactRecord[] {
	return Array.isArray(value)
		? value.flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const artifact = entry as Record<string, unknown>;
				if (
					typeof artifact.path !== "string" ||
					typeof artifact.sha256 !== "string" ||
					typeof artifact.bytes !== "number"
				)
					return [];
				return [
					{
						path: artifact.path,
						sha256: artifact.sha256,
						bytes: artifact.bytes,
					},
				];
			})
		: [];
}

export function buildArtifactRecords(
	paths?: string[],
): EvidenceArtifactRecord[] {
	return (paths ?? []).map((path) => {
		const resolvedPath = resolve(path);
		const content = readFileSync(resolvedPath);
		return {
			path: resolvedPath,
			sha256: createHash("sha256").update(content).digest("hex"),
			bytes: content.length,
		};
	});
}

export function getEvidenceHistory(task: Task): EvidenceIterationRecord[] {
	return Array.isArray(task.metadata?.lgtm_history)
		? task.metadata.lgtm_history.filter(
				(entry: unknown): entry is EvidenceIterationRecord =>
					!!entry && typeof entry === "object",
			)
		: [];
}

export function getCurrentEvidenceIteration(
	task: Task,
): EvidenceIterationRecord | undefined {
	const metadata = task.metadata ?? {};
	if (typeof metadata.lgtm_evidence !== "string") return undefined;
	return {
		iteration: getEvidenceHistory(task).length + 1,
		submitted_at:
			typeof metadata.lgtm_submitted_at === "string"
				? metadata.lgtm_submitted_at
				: new Date(0).toISOString(),
		evidence: metadata.lgtm_evidence,
		failure_likely:
			typeof metadata.lgtm_failure_likely === "string"
				? metadata.lgtm_failure_likely
				: "",
		failure_sneaky:
			typeof metadata.lgtm_failure_sneaky === "string"
				? metadata.lgtm_failure_sneaky
				: "",
		failure_unknown:
			typeof metadata.lgtm_failure_unknown === "string"
				? metadata.lgtm_failure_unknown
				: "",
		falsification_test:
			typeof metadata.lgtm_falsification_test === "string"
				? metadata.lgtm_falsification_test
				: "",
		evidence_reasoning:
			typeof metadata.lgtm_evidence_reasoning === "string"
				? metadata.lgtm_evidence_reasoning
				: "",
		verification_hints: Array.isArray(metadata.lgtm_verification_hints)
			? metadata.lgtm_verification_hints.filter(
					(hint: unknown): hint is string => typeof hint === "string",
				)
			: [],
		remaining_uncertainty:
			typeof metadata.lgtm_remaining_uncertainty === "string"
				? metadata.lgtm_remaining_uncertainty
				: "",
		commands: normalizeCommandRecords(metadata.lgtm_commands),
		evidence_artifacts: normalizeArtifactRecords(
			metadata.lgtm_evidence_artifacts,
		),
		falsification_artifacts: normalizeArtifactRecords(
			metadata.lgtm_falsification_artifacts,
		),
		robot_reviews: getRobotReviews(task),
		automatic_review_failure:
			typeof metadata.robot_review_last_error === "string"
				? {
						message: metadata.robot_review_last_error,
						raw_output:
							typeof metadata.robot_review_last_error_output === "string"
								? metadata.robot_review_last_error_output
								: undefined,
					}
				: undefined,
	};
}

export function getEvidenceIterationCount(task: Task): number {
	return (
		getEvidenceHistory(task).length +
		(getCurrentEvidenceIteration(task) ? 1 : 0)
	);
}

export function archiveCurrentEvidence(
	task: Task,
	reason: string,
): Record<string, unknown> {
	const current = getCurrentEvidenceIteration(task);
	if (!current) return {};
	return {
		lgtm_history: [
			...getEvidenceHistory(task),
			{
				...current,
				superseded_at: new Date().toISOString(),
				supersede_reason: reason,
			},
		],
	};
}

function presentOrMissing(value: string | undefined): string {
	return value && value.trim().length > 0 ? value : "(missing)";
}

function formatBulletList(
	title: string,
	items: string[],
	empty = "(none)",
): string {
	return `### ${title}\n${items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`}`;
}

function formatCommandRecords(
	commands: EvidenceCommandRecord[],
): string | undefined {
	if (commands.length === 0) return undefined;
	return `### Commands\n${commands.map((command) => `- \`${command.cmd}\` (exit ${command.exit_code})${command.stdout_path ? ` stdout: ${command.stdout_path}` : ""}${command.stderr_path ? ` stderr: ${command.stderr_path}` : ""}`).join("\n")}`;
}

function formatArtifactRecords(
	title: string,
	artifacts: EvidenceArtifactRecord[],
): string | undefined {
	if (artifacts.length === 0) return undefined;
	return `### ${title}\n${artifacts.map((artifact) => `- ${artifact.path} (${artifact.bytes} bytes, sha256 ${artifact.sha256})`).join("\n")}`;
}

const MAX_INLINE_PROOF_LINES = 16;
const MAX_INLINE_TOOL_LINES = 8;
const MAX_INLINE_REVIEW_ITEMS = 3;

function truncateProofBlock(
	body: string,
	maxLines = MAX_INLINE_PROOF_LINES,
): {
	preview: string;
	truncated: boolean;
	totalLines: number;
	headLines: number;
	tailLines: number;
} {
	const lines = body.split("\n");
	if (lines.length <= maxLines) {
		return {
			preview: body,
			truncated: false,
			totalLines: lines.length,
			headLines: lines.length,
			tailLines: 0,
		};
	}
	const headLines = Math.ceil(maxLines / 2);
	const tailLines = Math.floor(maxLines / 2);
	const omitted = lines.length - headLines - tailLines;
	return {
		preview: [
			...lines.slice(0, headLines),
			`[... ${omitted} middle lines omitted ...]`,
			...lines.slice(lines.length - tailLines),
		].join("\n"),
		truncated: true,
		totalLines: lines.length,
		headLines,
		tailLines,
	};
}

function summarizeList(
	items: string[],
	maxItems = MAX_INLINE_REVIEW_ITEMS,
): string[] {
	if (items.length <= maxItems) return items;
	return [
		...items.slice(0, maxItems),
		`(${items.length - maxItems} more omitted)`,
	];
}

function getEvidenceOverflowPath(
	entry: EvidenceIterationRecord,
): string | undefined {
	return (
		entry.evidence_artifacts[0]?.path ??
		entry.commands.find((command) => typeof command.stdout_path === "string")
			?.stdout_path ??
		entry.commands.find((command) => typeof command.stderr_path === "string")
			?.stderr_path
	);
}

function formatReviewTextBlock(
	title: string,
	body: string,
	options?: { maxLines?: number; overflowPath?: string },
): string {
	const truncated = options?.maxLines
		? truncateProofBlock(body, options.maxLines)
		: {
				preview: body,
				truncated: false,
				totalLines: body.split("\n").length,
				headLines: body.split("\n").length,
				tailLines: 0,
			};
	const overflowNote = truncated.truncated
		? `\n\n[truncated at ${options?.maxLines ?? MAX_INLINE_PROOF_LINES} lines from ${truncated.totalLines}; showing first ${truncated.headLines} and last ${truncated.tailLines}; full text: ${options?.overflowPath ?? "(no stored artifact path)"}]`
		: "";
	return `### ${title}\n\n\`\`\`text\n${truncated.preview}${overflowNote}\n\`\`\``;
}

function formatTaskStatusLine(task: Task): string {
	return `Status: ${task.status}`;
}

function formatTaskToolMetadata(
	task: Task,
	options?: { updatedFields?: string[] },
): string {
	const current = getCurrentEvidenceIteration(task);
	const metadataKeys = Object.keys(getNonReviewMetadata(task));
	return [
		"### Metadata",
		`- Completion mode: ${getCompletionMode(task)}`,
		`- Review state: ${getReviewState(task)}`,
		`- Gate status: ${getGateStatus(task)}`,
		options?.updatedFields?.length
			? `- Updated fields: ${options.updatedFields.join(", ")}`
			: undefined,
		`- Metadata keys: ${metadataKeys.length}`,
		`- Proof iterations: ${getEvidenceIterationCount(task)}`,
		`- Robot reviews: ${getRobotReviews(task).length}`,
		current?.submitted_at
			? `- Submitted at: ${current.submitted_at}`
			: undefined,
		`- Updated at: ${new Date(task.updatedAt).toISOString()}`,
	]
		.filter(Boolean)
		.join("\n");
}

function renderTaskToolResult(
	title: string,
	task: Task,
	body: string,
	options?: { updatedFields?: string[] },
): string {
	return [
		`## ${title} -> Task #${task.id}: ${task.subject}`,
		formatTaskStatusLine(task),
		formatTaskToolMetadata(task, options),
		body,
	].join("\n\n");
}

function renderTaskSnapshot(
	task: Task,
	options?: {
		includeDescription?: boolean;
		includeDoneCriterion?: boolean;
		includeProgressLabel?: boolean;
		includeMetadata?: boolean;
	},
): string {
	const sections: string[] = [];
	if (options?.includeDoneCriterion !== false) {
		sections.push(
			formatReviewTextBlock(
				"Done criterion",
				presentOrMissing(task.done_criterion),
				{ maxLines: MAX_INLINE_TOOL_LINES },
			),
		);
	}
	if (options?.includeDescription) {
		sections.push(
			formatReviewTextBlock("Description", presentOrMissing(task.description), {
				maxLines: MAX_INLINE_TOOL_LINES,
			}),
		);
	}
	if (options?.includeProgressLabel && task.progress_label) {
		sections.push(
			formatReviewTextBlock("Progress label", task.progress_label, {
				maxLines: MAX_INLINE_TOOL_LINES,
			}),
		);
	}
	if (options?.includeMetadata) {
		const metadata = getNonReviewMetadata(task);
		if (Object.keys(metadata).length > 0) {
			sections.push(
				formatReviewTextBlock(
					"Metadata preview",
					JSON.stringify(metadata, null, 2),
					{ maxLines: MAX_INLINE_TOOL_LINES },
				),
			);
		}
	}
	return sections.join("\n\n");
}

function renderTaskUpdateSummary(
	before: Task | undefined,
	task: Task,
	changedFields: string[],
	metadataPatch?: Record<string, unknown>,
): string {
	const lines = ["### Changes"];
	for (const field of changedFields) {
		if (field === "status") {
			lines.push(
				`- status: ${before?.status ?? "(missing)"} -> ${task.status}`,
			);
			continue;
		}
		if (field === "subject") {
			lines.push(
				`- subject: ${before?.subject ?? "(missing)"} -> ${task.subject}`,
			);
			continue;
		}
		if (field === "progress_label") {
			lines.push(
				`- progress_label: ${before?.progress_label ?? "(missing)"} -> ${task.progress_label ?? "(missing)"}`,
			);
			continue;
		}
		if (field === "description") {
			lines.push(
				formatReviewTextBlock(
					"Description",
					presentOrMissing(task.description),
					{ maxLines: MAX_INLINE_TOOL_LINES },
				),
			);
			continue;
		}
		if (field === "done_criterion") {
			lines.push(
				formatReviewTextBlock(
					"Done criterion",
					presentOrMissing(task.done_criterion),
					{ maxLines: MAX_INLINE_TOOL_LINES },
				),
			);
			continue;
		}
		if (field === "metadata") {
			const metadata = metadataPatch ?? getNonReviewMetadata(task);
			lines.push(
				formatReviewTextBlock(
					"Metadata patch",
					JSON.stringify(metadata, null, 2),
					{ maxLines: MAX_INLINE_TOOL_LINES },
				),
			);
			continue;
		}
		if (field === "blocks") {
			lines.push(
				`- blocks: ${task.blocks.length > 0 ? task.blocks.map((id) => `#${id}`).join(", ") : "(none)"}`,
			);
			continue;
		}
		if (field === "blockedBy") {
			lines.push(
				`- blockedBy: ${task.blockedBy.length > 0 ? task.blockedBy.map((id) => `#${id}`).join(", ") : "(none)"}`,
			);
			continue;
		}
		lines.push(`- ${field}`);
	}
	return lines.join("\n");
}

function renderCompactRobotReview(review: RobotReviewRecord): string {
	const verdict = review.accepted ? "Accepted" : "Refused";
	const lines = [`${verdict} by ${review.reviewer}.`];
	if (review.reason) {
		lines.push(review.reason);
	} else if (review.observations.length > 0) {
		lines.push(review.observations[0]);
	}
	if (review.blind_spots) lines.push(`Blind spots: ${review.blind_spots}`);
	if (!review.accepted && review.missing_evidence.length > 0) {
		lines.push(`Needs: ${review.missing_evidence.join("; ")}`);
	}
	if (!review.accepted && review.suggestions.length > 0) {
		lines.push(`Next: ${review.suggestions.join("; ")}`);
	}
	return lines.join(" ");
}

function renderCurrentProofSummary(task: Task): string {
	const sections = [renderEvidencePacket(task)];
	const latestReview = getLatestRobotReview(task);
	if (latestReview) sections.push(renderCompactRobotReview(latestReview));
	const automaticReviewFailure = renderAutomaticReviewFailure(task);
	if (automaticReviewFailure) sections.push(automaticReviewFailure);
	return sections.join("\n\n");
}

function renderPlannedEvidence(
	entry: EvidenceIterationRecord,
	options?: { truncateFalsification?: boolean },
): string {
	return [
		"### Verify",
		formatBulletList(
			"Verification hints",
			entry.verification_hints,
			"(missing)",
		),
		formatReviewTextBlock(
			"Falsification test",
			presentOrMissing(entry.falsification_test),
			options?.truncateFalsification === false
				? undefined
				: {
						maxLines: MAX_INLINE_PROOF_LINES,
						overflowPath: entry.falsification_artifacts[0]?.path,
					},
		),
	].join("\n\n");
}

function summarizeJudgement(entry: EvidenceIterationRecord): {
	title: string;
	body: string;
	observations: string[];
	concerns: string[];
	suggestions: string[];
	missingEvidence: string[];
} {
	const latestReview = entry.robot_reviews[entry.robot_reviews.length - 1];
	if (latestReview) {
		return {
			title: latestReview.accepted ? "Accepted" : "Refused",
			body: `${latestReview.accepted ? "Accepted" : "Refused"} by ${latestReview.reviewer} on ${latestReview.submitted_at}.`,
			observations: latestReview.observations,
			concerns: latestReview.concerns,
			suggestions:
				latestReview.suggestions.length > 0
					? latestReview.suggestions
					: latestReview.accepted
						? []
						: latestReview.missing_evidence.map(
								(item) => `Strengthen the proof for: ${item}`,
							),
			missingEvidence: latestReview.missing_evidence,
		};
	}
	if (entry.automatic_review_failure) {
		return {
			title: "Reviewer unavailable",
			body: entry.automatic_review_failure.message,
			observations: [],
			concerns: [],
			suggestions: [
				"Autonomy continued without blocking completion.",
				"Inspect the reviewer failure note if you want a fresh external perspective later.",
			],
			missingEvidence: [],
		};
	}
	return {
		title: "Pending review",
		body: "No judge result recorded yet.",
		observations: [],
		concerns: [],
		suggestions: [],
		missingEvidence: [],
	};
}

function renderAttempt(
	entry: EvidenceIterationRecord,
	options?: { truncateEvidence?: boolean; truncateFalsification?: boolean },
): string {
	const judgement = summarizeJudgement(entry);
	const evidenceBlock =
		options?.truncateEvidence === false
			? formatReviewTextBlock("Evidence", presentOrMissing(entry.evidence))
			: formatReviewTextBlock("Evidence", presentOrMissing(entry.evidence), {
					maxLines: MAX_INLINE_PROOF_LINES,
					overflowPath: getEvidenceOverflowPath(entry),
				});
	return [
		`## Attempt ${entry.iteration}`,
		evidenceBlock,
		renderPlannedEvidence(entry, options),
		"### Check notes",
		`- likely wrong: ${presentOrMissing(entry.failure_likely)}`,
		`- sneaky wrong: ${presentOrMissing(entry.failure_sneaky)}`,
		`- unknown left: ${presentOrMissing(entry.failure_unknown)}`,
		`- why this counts: ${presentOrMissing(entry.evidence_reasoning)}`,
		`- remaining uncertainty: ${presentOrMissing(entry.remaining_uncertainty)}`,
		`### Judgement\n${judgement.title}`,
		judgement.body,
		judgement.observations.length > 0 ? judgement.observations[0] : "",
		judgement.concerns.length > 0 ? `Concerns: ${judgement.concerns.join("; ")}` : "",
		judgement.missingEvidence.length > 0 ? `Needs: ${judgement.missingEvidence.join("; ")}` : "",
		judgement.suggestions.length > 0 ? `Next: ${judgement.suggestions.join("; ")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

export function renderEvidencePacket(
	task: Task,
	options?: { truncateEvidence?: boolean; truncateFalsification?: boolean },
): string {
	const current = getCurrentEvidenceIteration(task);
	if (!current)
		return "(No current proof claim. The agent never called TaskClaimDone, or the prior claim was superseded.)";

	return [
		"## Goal",
		`Task #${task.id}: ${task.subject}`,
		`Done criterion: ${presentOrMissing(task.done_criterion)}`,
		renderAttempt(current, options),
		formatCommandRecords(current.commands),
		formatArtifactRecords("Evidence artifacts", current.evidence_artifacts),
		formatArtifactRecords(
			"Falsification artifacts",
			current.falsification_artifacts,
		),
	]
		.filter(
			(section): section is string =>
				typeof section === "string" && section.length > 0,
		)
		.join("\n\n");
}

function renderAutomaticReviewFailure(task: Task): string | undefined {
	if (typeof task.metadata?.robot_review_last_error !== "string")
		return undefined;
	const sections = [
		`### Automatic robot review failure\n${task.metadata.robot_review_last_error}`,
	];
	if (
		typeof task.metadata?.robot_review_last_error_output === "string" &&
		task.metadata.robot_review_last_error_output.trim()
	) {
		sections.push(
			formatReviewTextBlock(
				"Reviewer raw output",
				task.metadata.robot_review_last_error_output,
				{ maxLines: MAX_INLINE_PROOF_LINES },
			),
		);
	}
	return sections.join("\n\n");
}

export function renderProofLog(task: Task): string {
	const history = getEvidenceHistory(task);
	const attempts = history.map((entry) => renderAttempt(entry));
	const current = getCurrentEvidenceIteration(task);
	const lines = [
		`# Task #${task.id}: ${task.subject}`,
		`Status: ${task.status}`,
		`Gate status: ${getGateStatus(task)}`,
		"",
		"## Goal",
		`Done criterion: ${presentOrMissing(task.done_criterion)}`,
	];
	if (current) {
		lines.push("", ...attempts, renderAttempt(current));
	} else if (attempts.length > 0) {
		lines.push("", ...attempts);
	} else {
		lines.push("", "(No current proof claim.)");
	}
	return lines.join("\n");
}

function getNonReviewMetadata(task: Task): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(task.metadata ?? {}).filter(
			([key]) =>
				!key.startsWith("lgtm_") &&
				!key.startsWith("robot_review_") &&
				key !== "lgtm_history" &&
				key !== "robot_reviews",
		),
	);
}

function formatHistorySummary(task: Task): string | undefined {
	const history = getEvidenceHistory(task);
	if (history.length === 0) return undefined;
	return `Superseded evidence:\n${history.map((entry) => `- #${entry.iteration} superseded ${entry.superseded_at ?? "?"}: ${entry.supersede_reason ?? "(no reason recorded)"}`).join("\n")}`;
}

export function extractRobotReviewJson(
	output: string,
): Record<string, unknown> {
	const match = output.match(
		/ROBOT_REVIEW_JSON_START\s*([\s\S]*?)\s*ROBOT_REVIEW_JSON_END/,
	);
	const source = match ? match[1] : output;
	const candidates = [
		source.trim(),
		stripMarkdownCodeFence(source),
		extractBalancedJsonObject(source) ?? "",
		extractBalancedJsonObject(stripMarkdownCodeFence(source)) ?? "",
	].filter(Boolean);

	let lastError: unknown;
	for (const candidate of [...new Set(candidates)]) {
		try {
			return JSON.parse(candidate) as Record<string, unknown>;
		} catch (error) {
			lastError = error;
		}
	}

	const prefix = match
		? "Robot reviewer returned invalid JSON"
		: "Robot reviewer did not return the expected JSON markers or a parseable JSON object";
	const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(
		`${prefix}${detail}. Raw output: ${summarizeRawOutput(output)}`,
	);
}

export function buildRobotReviewPrompt(task: Task): string {
	return [
		"You are a fresh validation judge for a Hermes-style proof log.",
		"Question: does this packet prove the exact user-visible success condition in the done criterion?",
		"If the done criterion asks for a specific output or direction of change, check that the quoted output actually shows that result, not merely that a command ran.",
		"If not, say no and explain what concrete output is still missing. Suggestions are advisory guidance, not a separate gate.",
		"",
		"## Critical: Evidence must be verbatim",
		"",
		"Evidence should contain literal output, exact log lines, markdown block quotes, table rows, and URLs, not summaries or interpretations.",
		"A human must be able to inspect the evidence alone without re-running anything.",
		"",
		"## Rubric (rate each item pass/fail)",
		"",
		"1. evidence_covers_done_criterion: Does the packet show the concrete observable thing the done criterion asks for, in the right direction or state?",
		"2. falsification_test_runnable: Is there a concrete check with literal output that would come out differently if the claim were wrong?",
		"3. failure_modes_addressed: Are the likely, sneaky, and unknown failure modes plausible enough to guide what evidence matters? Advisory.",
		"4. evidence_distinguishes_success: Does the packet explain, at least briefly, why the shown evidence rules out the main failure modes? Advisory.",
		"5. verification_hints_actionable: Can a human inspect the claim without re-running everything? Advisory.",
		"",
		"Set evidence_complete=true only if items 1 and 2 pass.",
		"Set evidence_convincing=true if items 1 and 2 pass and you do not see a concrete contradiction in the packet.",
		"Set accepted=true if items 1 and 2 pass and you do not see a concrete contradiction in the packet. Do not reject solely because items 3, 4, or 5 are weak if the verbatim evidence already proves the done criterion.",
		"",
		"reason: 1-3 sentence summary of why you accepted or rejected. Be concrete: cite specific test counts, file paths, or output lines you checked. Example: 'Pass, I checked the evidence it shows all 142 tests pass and HEAD=origin/main.'",
		"observations: kept for audit only. One line max, not a repeat of the evidence.",
		"When rejecting, prefer missing outputs like 'nll_val never decreases in the quoted log' over process complaints like 'too much text'.",
		"concerns: kept for audit only. One line max when rejecting, empty when accepting.",
		"suggestions: what the agent should do next if rejected. 1-3 bullets max.",
		"missing_evidence: concrete missing artifacts or outputs that block acceptance. Only when rejecting.",
		"blind_spots: what you could not check. Always include this. Example: 'only reviewed the verbatim packet, did not inspect the actual artifact files.'",
		"",
		"Return exactly one JSON object between the markers ROBOT_REVIEW_JSON_START and ROBOT_REVIEW_JSON_END.",
		"JSON schema:",
		'{"reviewer":"string","scope":"string","rubric":{"evidence_covers_done_criterion":{"reason":"...","pass":true},"falsification_test_runnable":{"reason":"...","pass":true},"failure_modes_addressed":{"reason":"...","pass":true},"evidence_distinguishes_success":{"reason":"...","pass":true},"verification_hints_actionable":{"reason":"...","pass":true}},"reason":"1-3 sentence summary of why you accepted or rejected","observations":["string"],"concerns":["string"],"suggestions":["string"],"blind_spots":"string","missing_evidence":["string"],"evidence_complete":true,"evidence_convincing":true,"accepted":true}',
		"",
		"You are reviewing exactly the same proof packet shown by TaskGet and /lgtm. Do not assume hidden context beyond this packet.",
		"",
		renderEvidencePacket(task, { truncateEvidence: false }),
		"Output format:",
		"ROBOT_REVIEW_JSON_START",
		'{"reviewer":"...","scope":"...","rubric":{...},"reason":"Pass, I checked the evidence it shows all 142 tests pass and HEAD=origin/main.","observations":["..."],"concerns":["..."],"suggestions":["..."],"blind_spots":"...","missing_evidence":["..."],"evidence_complete":true,"evidence_convincing":true,"accepted":true}',
		"ROBOT_REVIEW_JSON_END",
	].join("\n");
}

async function runAutomaticRobotReview(
	task: any,
	signal?: AbortSignal,
	currentModelRef?: string,
): Promise<{ review: Omit<RobotReviewRecord, "iteration">; command: string }> {
	if (!currentModelRef) {
		throw new Error(
			"Automatic robot review requires an active current session model.",
		);
	}
	const prompt = buildRobotReviewPrompt(task);
	// Keep reviewer model selection simple: reuse the active session model in a fresh Pi process.
	// This avoids picking a registry-listed judge model that exists but lacks working auth.
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--model",
		currentModelRef,
	];
	args.push(prompt);
	const invocation = getPiInvocation(args);
	const timeoutMs = getRobotReviewTimeoutMs();
	const commandLabel = `${invocation.command} ${invocation.args.slice(0, -1).join(" ")}`;
	const result = await runRobotReviewCommand(invocation, signal, timeoutMs);
	if (result.exitCode !== 0) {
		const error = new Error(
			`Robot reviewer failed (${result.exitCode ?? "?"}): ${(result.stderr || result.stdout).trim()}`,
		) as Error & { rawOutput?: string };
		error.rawOutput = (result.stderr || result.stdout).trim();
		throw error;
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = extractRobotReviewJson(result.stdout);
	} catch (error) {
		const wrapped = new Error(
			error instanceof Error ? error.message : String(error),
		) as Error & { rawOutput?: string };
		wrapped.rawOutput = result.stdout.trim();
		throw wrapped;
	}
	const observations = Array.isArray(parsed.observations)
		? parsed.observations.filter(
				(item): item is string => typeof item === "string",
			)
		: [];
	if (observations.length === 0) {
		const error = new Error(
			"Robot reviewer returned no observations.",
		) as Error & { rawOutput?: string };
		error.rawOutput = result.stdout.trim();
		throw error;
	}
	const concerns = Array.isArray(parsed.concerns)
		? parsed.concerns.filter((item): item is string => typeof item === "string")
		: [];
	const suggestions = Array.isArray(parsed.suggestions)
		? parsed.suggestions.filter(
				(item): item is string => typeof item === "string",
			)
		: [];
	const rawMissing: string[] = Array.isArray(parsed.missing_evidence)
		? parsed.missing_evidence.filter(
				(item): item is string => typeof item === "string",
			)
		: [];
	const missing_evidence = rawMissing;
	// Extract rubric with per-item reasoning
	let rubric: Record<string, { reason: string; pass: boolean }> | undefined;
	if (parsed.rubric && typeof parsed.rubric === "object") {
		const r: Record<string, { reason: string; pass: boolean }> = {};
		for (const [key, val] of Object.entries(
			parsed.rubric as Record<string, unknown>,
		)) {
			if (
				val &&
				typeof val === "object" &&
				"reason" in (val as any) &&
				"pass" in (val as any)
			) {
				const v = val as { reason: unknown; pass: unknown };
				r[key] = {
					reason: typeof v.reason === "string" ? v.reason : "",
					pass: v.pass === true,
				};
			}
		}
		if (Object.keys(r).length > 0) rubric = r;
	}
	const review = relaxAdvisoryVerificationHints({
		reviewer:
			typeof parsed.reviewer === "string" ? parsed.reviewer : commandLabel,
		scope:
			typeof parsed.scope === "string" ? parsed.scope : "task evidence package",
		observations,
		concerns,
		suggestions,
		blind_spots:
			typeof parsed.blind_spots === "string"
				? parsed.blind_spots
				: "not stated",
		accepted:
			typeof parsed.accepted === "boolean"
				? parsed.accepted
				: parsed.evidence_complete === true &&
					parsed.evidence_convincing === true,
		evidence_complete: parsed.evidence_complete === true,
		evidence_convincing: parsed.evidence_convincing === true,
		missing_evidence,
		submitted_at: new Date().toISOString(),
		mode: "auto",
		raw_output: result.stdout.trim(),
		rubric,
	});
	return {
		command: commandLabel,
		review,
	};
}

const SYSTEM_REMINDER = `<system-reminder>
The user is trusting you to be autonomous and work towards acheiving these goals.

Goal tools haven't been used in a while, so check the goal list and keep it accurate:
- Progress existing open goals before drifting to unrelated work.
- Treat rejected proof-gated top-level goals as needing immediate follow-up: strengthen proof, block, supersede, or delete them explicitly.
- Mark goals in_progress when you start them (TaskUpdate status=in_progress).
- Complete subtasks directly: TaskUpdate(status=completed). Drop irrelevant ones with status=deleted.
A stale goal list is worse than no goal list. Ignore this reminder if not applicable. Never mention it to the user.
</system-reminder>`;

export default function (pi: ExtensionAPI) {
	const cfg = loadTasksConfig();
	const piTasks = process.env.PI_TASKS;
	const taskScope = cfg.taskScope ?? "session";

	function resolveStorePath(sessionId?: string): string | undefined {
		if (piTasks === "off") return undefined;
		if (piTasks?.startsWith("/")) return piTasks;
		if (piTasks?.startsWith(".")) return resolve(piTasks);
		if (piTasks) return join(process.cwd(), ".pi", "tasks", `${piTasks}.json`);
		if (taskScope === "memory") return undefined;
		if (taskScope === "session" && sessionId) {
			return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
		}
		if (taskScope === "session") return undefined;
		return join(process.cwd(), ".pi", "tasks", "tasks.json");
	}

	let store = new TaskStore(resolveStorePath());
	const widget = new TaskWidget(store);
	const autoClear = new AutoClearManager(
		() => store,
		() => cfg.autoClearCompleted ?? "never",
		AUTO_CLEAR_DELAY,
	);

	let storeUpgraded = false;
	let persistedTasksShown = false;
	function upgradeStoreIfNeeded(ctx: ExtensionContext) {
		if (storeUpgraded) return;
		if (taskScope === "session" && !piTasks) {
			const sessionId = ctx.sessionManager.getSessionId();
			const path = resolveStorePath(sessionId);
			store = new TaskStore(path);
			widget.setStore(store);
		}
		storeUpgraded = true;
	}

	function showPersistedTasks(_isResume = false) {
		if (persistedTasksShown) return;
		persistedTasksShown = true;
		const tasks = store.list();
		if (tasks.length > 0) widget.update();
	}

	let currentTurn = 0;
	let lastTaskToolUseTurn = 0;
	let reminderInjectedThisCycle = false;

	pi.on("turn_start", async (_event, ctx) => {
		currentTurn++;
		widget.setUICtx(ctx.ui as UICtx);
		upgradeStoreIfNeeded(ctx);
		if (autoClear.onTurnStart(currentTurn)) widget.update();
	});

	pi.on("turn_end", async (event) => {
		const msg = event.message as any;
		if (msg?.role === "assistant" && msg.usage) {
			widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
		}
	});

	pi.on("tool_result", async (event) => {
		if (TASK_TOOL_NAMES.has(event.toolName)) {
			lastTaskToolUseTurn = currentTurn;
			reminderInjectedThisCycle = false;
			return {};
		}
		if (currentTurn - lastTaskToolUseTurn < REMINDER_INTERVAL) return {};
		if (reminderInjectedThisCycle) return {};
		const tasks = store.list();
		if (tasks.length === 0) return {};
		reminderInjectedThisCycle = true;
		lastTaskToolUseTurn = currentTurn;
		return {
			content: [
				...event.content,
				{ type: "text" as const, text: SYSTEM_REMINDER },
			],
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx);
		upgradeStoreIfNeeded(ctx);
		showPersistedTasks();
	});

	pi.on("before_agent_start", async (event) => {
		const followups = store.list().flatMap((task) => {
			const latest = getLatestRobotReview(task);
			return latest && !latest.accepted ? [{ task, latest }] : [];
		});
		if (followups.length === 0) return undefined;

		const reminder = followups
			.map(({ task, latest }) => {
				const missing =
					latest.missing_evidence.length > 0
						? ` Missing evidence: ${latest.missing_evidence.join("; ")}.`
						: "";
				return `- Task #${task.id} ${task.subject}: latest proof review rejected the evidence.${missing} Strengthen the evidence and call TaskClaimDone again.`;
			})
			.join("\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n<system-reminder>\nLatest proof review follow-up required:\n${reminder}\nDo not complete the top-level task until the latest proof review accepts the evidence.\n</system-reminder>\n`,
		};
	});

	pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
		widget.setUICtx(ctx.ui as UICtx);
		const isResume = event?.reason === "resume";
		storeUpgraded = false;
		persistedTasksShown = false;
		currentTurn = 0;
		lastTaskToolUseTurn = 0;
		reminderInjectedThisCycle = false;
		autoClear.reset();
		if (!isResume && taskScope === "memory") store.clearAll();
		upgradeStoreIfNeeded(ctx);
		showPersistedTasks(isResume);
	});

	// ──────────────────────────────────────────────────
	// Tool 1: TaskCreate
	// ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskCreate",
		label: "TaskCreate",
		description: `Create a task with a clear done_criterion.

## Two tiers

- **Top-level tasks**: goals with proof. They cannot be completed directly; call TaskClaimDone with evidence and failure modes.
- **Subtasks**: agent-managed checklist items under a top-level task. They can be completed directly via TaskUpdate(status=completed).

## Task Fields

- **subject**: Brief actionable title
- **description**: Detailed description with context
- **done_criterion**: REQUIRED. Falsifiable observation that distinguishes done from fail/null/incomplete/silent-fail. State expected AND wrong-case observations (e.g., "All 92 tests pass. If wrong: type errors in build or test failures in task-store.test.ts")
- **progress_label** (optional): What the agent is currently doing, shown during in-progress tasks
- **parentId** (optional): Set this to make a directly tickable subtask. Omit it for a proof-gated top-level goal.`,
		promptGuidelines: [
			"Use TaskCreate for complex top-level goals. Include a specific done_criterion.",
			"Mark tasks in_progress before starting. Complete subtasks via TaskUpdate; complete top-level tasks via TaskClaimDone with proof evidence.",
		],
		parameters: Type.Object({
			subject: Type.String({ description: "Brief task title" }),
			description: Type.String({ description: "Detailed description" }),
			done_criterion: Type.String({
				description:
					"Falsifiable observation that distinguishes DONE from fail, null result, incomplete, or silent failure. State what you expect to see AND what you'd see if it's wrong.",
			}),
			progress_label: Type.Optional(
				Type.String({
					description:
						"What the agent is currently doing, shown during in-progress tasks",
				}),
			),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
			parentId: Type.Optional(
				Type.String({
					description:
						"Parent task ID. If set, this task is a directly tickable subtask; if omitted, this is a proof-gated top-level goal.",
				}),
			),
		}),

		execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const metadataError = assertNoReservedMetadata(params.metadata);
			if (metadataError) return Promise.resolve(textResult(metadataError));
			autoClear.resetBatchCountdown();
			let task: Task;
			try {
				task = store.create(
					params.subject,
					params.description,
					params.done_criterion,
					params.progress_label,
					params.metadata,
					params.parentId,
				);
			} catch (err: any) {
				return Promise.resolve(textResult(err.message));
			}
			widget.update();
			return Promise.resolve(
				textResult(
					renderTaskToolResult(
						"TaskCreate",
						task,
						renderTaskSnapshot(task, {
							includeDescription: true,
							includeDoneCriterion: true,
							includeProgressLabel: true,
							includeMetadata: true,
						}),
					),
				),
			);
		},
	});

	// ──────────────────────────────────────────────────
	// Tool 2: TaskList
	// ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskList",
		label: "TaskList",
		description: `List all tasks in a compact one-line format with one primary state per row. Proof details live in TaskGet and /lgtm.`,
		parameters: Type.Object({}),

		execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const tasks = store.list();
			if (tasks.length === 0)
				return Promise.resolve(textResult("No tasks found"));

			const counts = { completed: 0, in_progress: 0, pending: 0 };
			for (const task of tasks) counts[getDisplayStatus(task)]++;

			const visibleTasks = tasks.filter((task) => task.status !== "completed");

			const parts: string[] = [];
			if (counts.completed > 0) parts.push(`${counts.completed} done hidden`);
			if (counts.in_progress > 0)
				parts.push(`${counts.in_progress} in progress`);
			if (counts.pending > 0) parts.push(`${counts.pending} open`);

			const statusIcon = (task: (typeof tasks)[number]) => {
				if (task.status === "in_progress") return "◼";
				return "◻";
			};

			const renderTask = (task: (typeof tasks)[number]) => {
				const parent = task.parentId ? ` › subtask of #${task.parentId}` : "";
				let blocked = "";
				if (task.blockedBy.length > 0) {
					const openBlockers = task.blockedBy.filter((bid) => {
						const blocker = store.get(bid);
						return blocker && blocker.status !== "completed";
					});
					if (openBlockers.length > 0)
						blocked = ` › blocked by ${openBlockers.map((id) => "#" + id).join(", ")}`;
				}
				return `  ${statusIcon(task)} #${task.id} ${task.subject}${parent}${blocked}`;
			};

			const lines = [`● ${tasks.length} goals (${parts.join(", ")})`];
			if (visibleTasks.length === 0) {
				lines.push("  No open tasks. Completed tasks are hidden by default.");
			} else {
				lines.push(
					...visibleTasks
						.sort((a, b) => Number(a.id) - Number(b.id))
						.map(renderTask),
				);
			}

			return Promise.resolve(textResult(lines.join("\n")));
		},
	});

	// ──────────────────────────────────────────────────
	// Tool 3: TaskGet
	// ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskGet",
		label: "TaskGet",
		description: `Get full proof-gated task details including done_criterion, evidence packet, and reviewer state.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to retrieve" }),
		}),

		execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = store.get(params.taskId);
			if (!task) return Promise.resolve(textResult("Task not found"));

			const desc = task.description.replace(/\\n/g, "\n");
			const robotReviews = getRobotReviews(task);
			const completionMode: CompletionMode = getCompletionMode(task);
			const reviewState: ReviewState = getReviewState(task);
			const currentEvidence = getCurrentEvidenceIteration(task);
			const history = getEvidenceHistory(task);
			const lines: string[] = [
				`Task #${task.id}: ${task.subject}`,
				`Status: ${task.status}`,
				`Completion mode: ${completionMode}`,
				`Review state: ${reviewState}`,
				`Gate status: ${getGateStatus(task)}`,
				`Done criterion: ${task.done_criterion}`,
				`Description: ${desc}`,
			];
			lines.push(
				`Evidence iterations: total=${getEvidenceIterationCount(task)}, current=${currentEvidence ? currentEvidence.iteration : 0}, superseded=${history.length}`,
			);
			lines.push(
				`Task kind: ${task.parentId ? `subtask of #${task.parentId}` : "top-level proof goal"}`,
			);
			if (robotReviews.length > 0) {
				const latest = robotReviews[robotReviews.length - 1];
				lines.push(
					`Robot reviews on current evidence: ${robotReviews.length} (latest: accepted=${latest.accepted ? "yes" : "no"}, complete=${latest.evidence_complete ? "yes" : "no"}, convincing=${latest.evidence_convincing ? "yes" : "no"})`,
				);
			}
			lines.push(renderEvidencePacket(task));
			const automaticReviewFailure = renderAutomaticReviewFailure(task);
			if (automaticReviewFailure) lines.push(automaticReviewFailure);
			if (robotReviews.length > 0) {
				lines.push(
					`### Robot reviews\n${robotReviews.map(renderCompactRobotReview).join("\n\n")}`,
				);
			}
			const historySummary = formatHistorySummary(task);
			if (historySummary) lines.push(historySummary);
			if (task.blockedBy.length > 0) {
				const openBlockers = task.blockedBy.filter((bid) => {
					const blocker = store.get(bid);
					return blocker && blocker.status !== "completed";
				});
				if (openBlockers.length > 0)
					lines.push(
						`Blocked by: ${openBlockers.map((id) => "#" + id).join(", ")}`,
					);
			}
			if (task.blocks.length > 0)
				lines.push(`Blocks: ${task.blocks.map((id) => "#" + id).join(", ")}`);
			const metadata = getNonReviewMetadata(task);
			if (Object.keys(metadata).length > 0)
				lines.push(`Metadata: ${JSON.stringify(metadata)}`);

			return Promise.resolve(textResult(lines.join("\n\n")));
		},
	});

	// ──────────────────────────────────────────────────
	// Tool 4: TaskUpdate
	// ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskUpdate",
		label: "TaskUpdate",
		description: `Update task fields or status.

Two-tier model:
- Subtasks can be marked completed directly here.
- Top-level tasks are proof goals: TaskUpdate(status=completed) is rejected. Use TaskClaimDone so the failure-mode/evidence form and automatic reviewer run.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to update" }),
			status: Type.Optional(
				Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
					anyOf: [
						{ type: "string", enum: ["pending", "in_progress", "completed"] },
						{ type: "string", const: "deleted" },
					],
					description:
						"New status. Setting completed is allowed for subtasks only; top-level tasks must complete via TaskClaimDone.",
				}),
			),
			subject: Type.Optional(Type.String({ description: "Brief task title" })),
			description: Type.Optional(
				Type.String({ description: "Detailed description" }),
			),
			done_criterion: Type.Optional(
				Type.String({
					description: "Falsifiable observation distinguishing done from fail",
				}),
			),
			progress_label: Type.Optional(
				Type.String({ description: "What the agent is currently doing" }),
			),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
			add_blocks: Type.Optional(
				Type.Array(Type.String(), { description: "Task IDs this task blocks" }),
			),
			add_blocked_by: Type.Optional(
				Type.Array(Type.String(), {
					description: "Task IDs that block this task",
				}),
			),
		}),

		execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const metadataError = assertNoReservedMetadata(params.metadata);
			if (metadataError) return Promise.resolve(textResult(metadataError));

			const { taskId, ...fields } = params;
			const currentTask = store.get(taskId);
			const before = currentTask
				? (JSON.parse(JSON.stringify(currentTask)) as Task)
				: undefined;
			let task: any, changedFields: string[], warnings: string[];
			try {
				({ task, changedFields, warnings } = store.update(taskId, fields));
			} catch (err: any) {
				return Promise.resolve(textResult(err.message));
			}

			if (changedFields.length === 0 && !task) {
				return Promise.resolve(textResult(`Task #${taskId} not found`));
			}

			if (fields.status === "in_progress") {
				widget.setActiveTask(taskId);
				autoClear.resetBatchCountdown();
			} else if (fields.status === "pending") {
				autoClear.resetBatchCountdown();
			} else if (fields.status === "completed") {
				widget.setActiveTask(taskId, false);
				autoClear.trackCompletion(taskId, currentTurn);
			} else if (fields.status === "deleted") {
				widget.setActiveTask(taskId, false);
				warnings.push(
					"Task deleted via agent tool. Use /tasks to confirm or undo. Deleting tasks should be reserved for dismissed or irrelevant work.",
				);
			}

			widget.update();
			const warningBlock =
				warnings.length > 0
					? `\n\n### Warnings\n- ${warnings.join("\n- ")}`
					: "";
			if (!task && fields.status === "deleted" && before) {
				return Promise.resolve(
					textResult(
						[
							`## TaskUpdate -> Task #${before.id}: ${before.subject}`,
							"Status: deleted",
							"### Metadata",
							`- Completion mode: ${getCompletionMode(before)}`,
							"- Review state: deleted",
							"- Updated fields: deleted",
							"### Changes",
							"- task removed from the store",
							warningBlock.trim(),
						]
							.filter(Boolean)
							.join("\n\n"),
					),
				);
			}
			const summary = renderTaskUpdateSummary(
				before,
				task,
				changedFields,
				fields.metadata,
			);
			return Promise.resolve(
				textResult(
					renderTaskToolResult(
						"TaskUpdate",
						task,
						`${summary}${warningBlock}`,
						{ updatedFields: changedFields },
					),
				),
			);
		},
	});

	// ──────────────────────────────────────────────────
	// Tool 5: TaskClaimDone
	// ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskClaimDone",
		label: "TaskClaimDone",
		description: `Claim that a top-level task meets its done_criterion.

Forces structured thinking about failure modes and cheap evidence. All text fields required.
Accepted automatic review completes the task. Rejected review leaves it open with guidance. Reviewer infrastructure failure is logged but does not block autonomy.

## CRITICAL: Evidence must be verbatim

Do NOT summarize or interpret. Paste literal command output, exact log lines, markdown block quotes, table rows, URLs. 'I ran X and it worked' is not evidence — paste the actual output of X. A human must be able to verify from the evidence alone without re-running anything.

## Fields

- **evidence**: Verbatim auditable proof — literal output, not summaries
- **failure_likely**: Most likely way this could be wrong despite evidence
- **failure_sneaky**: Subtle/sneaky failure -- one that looks like success superficially, corrupts silently, or only breaks under specific conditions (scale, time, edge case). E.g. feature active but wrong mechanism, works in tests but degrades in prod, correct output for wrong reason.
- **failure_unknown**: What class of unknown/untested failure could remain even if the evidence is true
- **falsification_test**: What you ran and the literal output you got, with reasoning why that output disproves the failure mode
- **evidence_reasoning**: Why this evidence cheaply distinguishes done-criterion success from the likely/subtle/unknown failures
- **verification_hints**: Where to look and what to check, with specific content quoted (not bare paths or counts)
- **remaining_uncertainty**: What's NOT tested, known limitations, deferred edge cases
- **commands**: Optional first-class command records for the evidence package
- **evidence_paths / falsification_paths**: Optional local artifact paths. The tool stores absolute path, sha256, and byte size for auditability.
- **supersede_reason**: Optional reason when this submission replaces an older one on the same task`,
		parameters: Type.Object({
			taskId: Type.String({ description: "Top-level task ID to claim done" }),
			evidence: Type.String({
				description:
					"Verbatim auditable proof: literal command output, exact log lines, markdown block quotes, table rows, URLs. NOT summaries or interpretations. 'I ran X and got Y' is not evidence -- paste the actual output of X. A human must verify from this alone without re-running. (One short paragraph is fine; verbatim matters more than length.)",
			}),
			failure_likely: Type.String({
				description:
					"Most likely way this could be wrong despite evidence. One short sentence preferred — pick the top one, not a list.",
			}),
			failure_sneaky: Type.String({
				description:
					"Subtle/sneaky failure: looks like success superficially, corrupts silently, or only breaks at scale/time/edge case. One short sentence preferred.",
			}),
			failure_unknown: Type.String({
				description:
					"What unknown or untested failure class could remain even if this evidence is true. One short sentence preferred.",
			}),
			falsification_test: Type.String({
				description:
					"What you ran and the literal output you got. Include verbatim command + output, not 'it worked'. State why that output could not occur if a failure mode were real. Brevity is fine; the verbatim output is what counts.",
			}),
			evidence_reasoning: Type.String({
				description:
					"Why this evidence cheaply distinguishes done-criterion success from the likely/subtle/unknown failures.",
			}),
			verification_hints: Type.Array(Type.String(), {
				description:
					"Where to look, with specific content quoted (not bare paths or counts). E.g. 'src/loss.py:45-60 shows grad_norm=0.001'. One or two short hints is enough.",
			}),
			remaining_uncertainty: Type.String({
				description:
					"What's NOT tested, known limitations, deferred edges. One short sentence preferred. If you can't articulate uncertainty, you haven't thought hard enough.",
			}),
			commands: Type.Optional(
				Type.Array(
					Type.Object({
						cmd: Type.String({ description: "Exact command that was run" }),
						exit_code: Type.Number({ description: "Process exit code" }),
						stdout_path: Type.Optional(
							Type.String({ description: "Optional path to captured stdout" }),
						),
						stderr_path: Type.Optional(
							Type.String({ description: "Optional path to captured stderr" }),
						),
					}),
				),
			),
			evidence_paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional local artifact paths backing the evidence. Stored as absolute path + sha256 + byte size.",
				}),
			),
			falsification_paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional local artifact paths backing the falsification test. Stored as absolute path + sha256 + byte size.",
				}),
			),
			supersede_reason: Type.Optional(
				Type.String({
					description:
						"Why this evidence replaces an older submission on the same task.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const task = store.get(params.taskId);
			if (!task)
				return Promise.resolve(textResult(`Task #${params.taskId} not found`));
			if (task.status === "completed")
				return Promise.resolve(
					textResult(`Task #${params.taskId} already completed`),
				);

			// verification_hints are descriptions, not validated file paths

			if (task.parentId)
				return Promise.resolve(
					textResult(
						`Task #${params.taskId} is a subtask. Use TaskUpdate(status=completed) for subtasks; TaskClaimDone is for top-level proof goals.`,
					),
				);
			const blankField = requiredTextError(params, [
				"evidence",
				"failure_likely",
				"failure_sneaky",
				"failure_unknown",
				"falsification_test",
				"evidence_reasoning",
				"remaining_uncertainty",
			]);
			if (blankField) return Promise.resolve(textResult(blankField));
			if (
				!params.verification_hints.some(
					(hint: string) => hint.trim().length > 0,
				)
			) {
				return Promise.resolve(
					textResult(
						"verification_hints must include at least one non-blank hint.",
					),
				);
			}

			store.update(params.taskId, {
				metadata: {
					...archiveCurrentEvidence(
						task,
						params.supersede_reason ?? "replaced by newer proof claim",
					),
					...clearCurrentEvidenceMetadata(),
					...clearRobotReviewMetadata(),
					lgtm_evidence: params.evidence,
					lgtm_failure_likely: params.failure_likely,
					lgtm_failure_sneaky: params.failure_sneaky,
					lgtm_failure_unknown: params.failure_unknown,
					lgtm_falsification_test: params.falsification_test,
					lgtm_evidence_reasoning: params.evidence_reasoning,
					lgtm_verification_hints: params.verification_hints,
					lgtm_remaining_uncertainty: params.remaining_uncertainty,
					lgtm_submitted_at: new Date().toISOString(),
					lgtm_commands: params.commands ?? [],
					lgtm_evidence_artifacts: buildArtifactRecords(params.evidence_paths),
					lgtm_falsification_artifacts: buildArtifactRecords(
						params.falsification_paths,
					),
					...clearAutomaticReviewFailureMetadata(),
				},
			});
			let robotReviewNote = "";
			const refreshedTask = store.get(params.taskId);
			if (!refreshedTask)
				return textResult(
					`Task #${params.taskId} not found after evidence update`,
				);
			try {
				const { review, command } = await runAutomaticRobotReview(
					refreshedTask,
					signal,
					getCurrentModelRef(ctx.model),
				);
				store.update(params.taskId, {
					metadata: {
						...appendRobotReviewMetadata(refreshedTask, review),
						...clearAutomaticReviewFailureMetadata(),
					},
				});
				if (
					shouldCompleteAfterAcceptedReview(
						store.get(params.taskId) ?? refreshedTask,
						review.accepted,
					)
				) {
					store.complete(params.taskId);
					autoClear.trackCompletion(params.taskId, currentTurn);
					widget.setActiveTask(params.taskId, false);
				}
				const storedReview = getLatestRobotReview(
					store.get(params.taskId) ?? refreshedTask,
				);
				robotReviewNote =
					`\n\n### Automatic robot review\n` +
					`Reviewer command: ${command}\n\n` +
					`${storedReview ? renderCompactRobotReview(storedReview) : renderCompactRobotReview({ ...review, iteration: 1 })}`;
				if (!review.accepted) {
					robotReviewNote += `\n\nResult: task remains open until the evidence is strengthened and reviewed again.`;
				}
			} catch (err: any) {
				store.update(params.taskId, {
					metadata: getAutomaticReviewFailureMetadata(
						err.message,
						err.rawOutput,
					),
				});
				const taskAfterFailure = store.get(params.taskId) ?? refreshedTask;
				if (!taskAfterFailure.parentId) {
					store.complete(params.taskId);
					autoClear.trackCompletion(params.taskId, currentTurn);
					widget.setActiveTask(params.taskId, false);
				}
				robotReviewNote =
					`\n\n### Automatic robot review\n` +
					`Reviewer unavailable: ${err.message}\n` +
					`Autonomy continued without blocking completion.` +
					(typeof err.rawOutput === "string" && err.rawOutput.trim()
						? `\n\n${formatReviewTextBlock("Reviewer raw output", err.rawOutput.trim(), { maxLines: MAX_INLINE_PROOF_LINES })}`
						: "");
			}
			widget.update();

			const updatedTask = store.get(task.id) ?? task;
			const result = renderTaskToolResult(
				"TaskClaimDone",
				updatedTask,
				`${renderCurrentProofSummary(updatedTask)}` +
					robotReviewNote +
					`\n\nSelf-check: if a skeptical reviewer would still ask "but what about...", call TaskClaimDone again with stronger proof.`,
			);

			return textResult(result);
		},
	});

	pi.registerTool({
		name: "lgtm_supersede",
		label: "lgtm_supersede",
		description: `Mark the current proof package as superseded without completing the task.

Use this when a prior claim is stale or wrong and reviewers should stop treating it as the current evidence. The current evidence, robot reviews, and reviewer-failure context are archived into history with your reason. Submit a fresh TaskClaimDone claim to complete the task.`,
		parameters: Type.Object({
			taskId: Type.String({
				description: "Task ID whose current evidence should be superseded",
			}),
			reason: Type.String({
				description: "Why the current evidence is stale or replaced",
			}),
		}),

		execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = store.get(params.taskId);
			if (!task)
				return Promise.resolve(textResult(`Task #${params.taskId} not found`));
			if (!getCurrentEvidenceIteration(task)) {
				return Promise.resolve(
					textResult(
						`Task #${params.taskId} has no current evidence to supersede.`,
					),
				);
			}

			store.update(params.taskId, {
				metadata: {
					...archiveCurrentEvidence(task, params.reason),
					...clearCurrentEvidenceMetadata(),
					...clearRobotReviewMetadata(),
					...clearAutomaticReviewFailureMetadata(),
				},
			});
			widget.update();

			const updatedTask = store.get(params.taskId) ?? task;
			return Promise.resolve(
				textResult(
					renderTaskToolResult(
						"lgtm_supersede",
						updatedTask,
						`Reason: ${params.reason}\n\n` +
							`${formatHistorySummary(updatedTask) ?? "No evidence history found."}`,
					),
				),
			);
		},
	});

	pi.registerTool({
		name: "robot_review_ask",
		label: "robot_review_ask",
		description: `Attach fresh-perspective robot review observations to a task.

Use this from a separate subagent or model when possible, ideally from a different model family/class than the implementation agent.
Your role is VALIDATION, not flaw-finding. Sanity-check that the evidence addresses the done criterion. Observations, concerns, and suggestions are welcome, but the gate is only the rubric items.

This records an independent review but does not itself complete the task. Use TaskClaimDone or robot_review_run for the automatic completion gate.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to attach robot review to" }),
			reviewer: Type.String({
				description: "Reviewer identity, model family, or class",
			}),
			scope: Type.String({ description: "What the reviewer examined" }),
			observations: Type.Array(Type.String(), {
				minItems: 1,
				description: "Concrete things noticed in the artifacts.",
			}),
			concerns: Type.Optional(
				Type.Array(Type.String(), {
					description: "Why the current evidence may not yet prove success.",
				}),
			),
			suggestions: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"What the agent should do next if the evidence is not yet enough.",
				}),
			),
			blind_spots: Type.String({
				description: "What the reviewer did not inspect or could not verify",
			}),
			evidence_complete: Type.Boolean({
				description:
					"Whether the supplied evidence covers the claimed done criterion.",
			}),
			evidence_convincing: Type.Boolean({
				description:
					"Whether the supplied evidence would convince a skeptical reviewer.",
			}),
			accepted: Type.Optional(
				Type.Boolean({
					description:
						"Overall review decision. Defaults to evidence_complete && evidence_convincing.",
				}),
			),
			missing_evidence: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Concrete missing checks, artifacts, or observations needed before completion.",
				}),
			),
		}),

		execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = store.get(params.taskId);
			if (!task)
				return Promise.resolve(textResult(`Task #${params.taskId} not found`));
			if (task.status === "completed")
				return Promise.resolve(
					textResult(`Task #${params.taskId} already completed`),
				);

			const accepted =
				params.accepted ??
				(params.evidence_complete && params.evidence_convincing);
			store.update(params.taskId, {
				metadata: {
					...appendRobotReviewMetadata(task, {
						reviewer: params.reviewer,
						scope: params.scope,
						observations: params.observations,
						concerns: params.concerns ?? [],
						suggestions: params.suggestions ?? [],
						blind_spots: params.blind_spots,
						accepted,
						evidence_complete: params.evidence_complete,
						evidence_convincing: params.evidence_convincing,
						missing_evidence: params.missing_evidence ?? [],
						submitted_at: new Date().toISOString(),
						mode: "manual",
					}),
					...clearAutomaticReviewFailureMetadata(),
				},
			});
			widget.update();

			const updatedTask = store.get(params.taskId) ?? task;
			const result = renderTaskToolResult(
				"robot_review_ask",
				updatedTask,
				[
					`Iteration: ${getRobotReviews(updatedTask).length}`,
					`Reviewer: ${params.reviewer}`,
					`Scope: ${params.scope}`,
					`Accepted: ${accepted ? "yes" : "no"}`,
					`Evidence complete: ${params.evidence_complete ? "yes" : "no"}`,
					`Evidence convincing: ${params.evidence_convincing ? "yes" : "no"}`,
					formatBulletList("Observations", summarizeList(params.observations)),
					(params.concerns?.length ?? 0) > 0
						? formatBulletList("Concerns", summarizeList(params.concerns ?? []))
						: "",
					(params.suggestions?.length ?? 0) > 0
						? formatBulletList(
								"Suggestions",
								summarizeList(params.suggestions ?? []),
							)
						: "",
					(params.missing_evidence?.length ?? 0) > 0
						? formatBulletList(
								"Missing evidence",
								summarizeList(params.missing_evidence ?? []),
							)
						: "",
					`### Blind spots\n${params.blind_spots}`,
					`Robot review stored. Manual reviews are advisory; the automatic proof gate runs through TaskClaimDone or robot_review_run.`,
				]
					.filter(Boolean)
					.join("\n\n"),
			);

			return Promise.resolve(textResult(result));
		},
	});

	pi.registerTool({
		name: "robot_review_run",
		label: "robot_review_run",
		description: `Run the automatic robot reviewer against the current task evidence using the current session model.

Runs the same Pi-native reviewer stage used automatically by \`TaskClaimDone\`.

This appends a new robot-review iteration. If accepted for a top-level proof task, the task completes. If rejected, the task stays open. Reviewer infrastructure failure is logged but does not block autonomy.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to review" }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const task = store.get(params.taskId);
			if (!task) return textResult(`Task #${params.taskId} not found`);
			if (!task.metadata?.lgtm_evidence) {
				return textResult(
					`Task #${params.taskId} has no stored evidence yet. Call TaskClaimDone first.`,
				);
			}

			try {
				const { review, command } = await runAutomaticRobotReview(
					task,
					signal,
					getCurrentModelRef(_ctx.model),
				);
				store.update(params.taskId, {
					metadata: {
						...appendRobotReviewMetadata(task, review),
						...clearAutomaticReviewFailureMetadata(),
					},
				});
				const reviewedTask = store.get(params.taskId) ?? task;
				if (
					!reviewedTask.parentId &&
					shouldCompleteAfterAcceptedReview(reviewedTask, review.accepted)
				) {
					store.complete(params.taskId);
					autoClear.trackCompletion(params.taskId, currentTurn);
					widget.setActiveTask(params.taskId, false);
				}
				widget.update();

				const updatedTask = store.get(params.taskId) ?? task;
				const storedReview = getLatestRobotReview(updatedTask);
				return textResult(
					renderTaskToolResult(
						"robot_review_run",
						updatedTask,
						`${renderCurrentProofSummary(updatedTask)}\n\n` +
							`### Automatic robot review\nReviewer command: ${command}` +
							`${storedReview ? `\n\n${renderCompactRobotReview(storedReview)}` : `\n\n${renderCompactRobotReview({ ...review, iteration: 1 })}`}`,
					),
				);
			} catch (err: any) {
				store.update(params.taskId, {
					metadata: getAutomaticReviewFailureMetadata(
						err.message,
						err.rawOutput,
					),
				});
				const failedTask = store.get(params.taskId) ?? task;
				if (!failedTask.parentId && failedTask.status !== "completed") {
					store.complete(params.taskId);
					autoClear.trackCompletion(params.taskId, currentTurn);
					widget.setActiveTask(params.taskId, false);
				}
				widget.update();
				const updatedTask = store.get(params.taskId) ?? task;
				return textResult(
					renderTaskToolResult(
						"robot_review_run",
						updatedTask,
						`${renderCurrentProofSummary(updatedTask)}\n\n` +
							`### Automatic robot review\nReviewer unavailable: ${err.message}\n\nAutonomy continued without blocking completion.` +
							(typeof err.rawOutput === "string" && err.rawOutput.trim()
								? `\n\n${formatReviewTextBlock("Reviewer raw output", err.rawOutput.trim(), { maxLines: MAX_INLINE_PROOF_LINES })}`
								: ""),
					),
				);
			}
		},
	});

	// ──────────────────────────────────────────────────
	// /tasks command
	// ──────────────────────────────────────────────────

	pi.registerCommand("tasks", {
		description: "Manage goals — view, create, clear completed",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const ui = ctx.ui;

			const mainMenu = async (): Promise<void> => {
				const tasks = store.list();
				const taskCount = tasks.length;
				const completedCount = tasks.filter(
					(t) => t.status === "completed",
				).length;

				const choices: string[] = [
					`View all goals (${taskCount})`,
					"Create goal",
				];
				if (completedCount > 0)
					choices.push(`Clear completed (${completedCount})`);
				if (taskCount > 0) choices.push(`Clear all (${taskCount})`);

				const choice = await ui.select("Goals", choices);
				if (!choice) return;

				if (choice.startsWith("View")) await viewTasks();
				else if (choice === "Create goal") await createTask();
				else if (choice.startsWith("Clear completed")) {
					store.clearCompleted();
					if (taskScope === "session") store.deleteFileIfEmpty();
					widget.update();
					await mainMenu();
				} else if (choice.startsWith("Clear all")) {
					store.clearAll();
					if (taskScope === "session") store.deleteFileIfEmpty();
					widget.update();
					await mainMenu();
				}
			};

			const viewTasks = async (): Promise<void> => {
				const tasks = store.list();
				if (tasks.length === 0) {
					await ui.select("No goals", ["← Back"]);
					return mainMenu();
				}

				const statusIcon = (t: (typeof tasks)[0]) => {
					if (t.status === "completed") return "done";
					if (t.status === "in_progress") return "◼";
					return "◻";
				};

				const choices = tasks.map(
					(t) => `${statusIcon(t)} #${t.id} ${t.subject}`,
				);
				choices.push("← Back");

				const selected = await ui.select("Goals", choices);
				if (!selected || selected === "← Back") return mainMenu();

				const match = selected.match(/#(\d+)/);
				if (match) await viewTaskDetail(match[1]);
				else return viewTasks();
			};

			const viewTaskDetail = async (taskId: string): Promise<void> => {
				const task = store.get(taskId);
				if (!task) return viewTasks();

				const actions: string[] = [];
				if (task.status === "pending") actions.push("▸ Start (in_progress)");
				if (task.metadata.lgtm_evidence) {
					actions.push(`(type /lgtm ${taskId} to view proof evidence)`);
				}
				actions.push("✗ Delete");
				actions.push("← Back");

				const pendingNote =
					task.metadata.lgtm_evidence && task.status !== "completed"
						? `\nProof review: ${getGateStatus(task)}`
						: "";
				const em = task.metadata;
				let evidenceNote = "";
				if (em.lgtm_evidence) {
					evidenceNote = `\n\n${renderEvidencePacket(task)}`;
					const automaticReviewFailure = renderAutomaticReviewFailure(task);
					if (automaticReviewFailure)
						evidenceNote += `\n\n${automaticReviewFailure}`;
				}
				let robotNote = "";
				const robotReviews = getRobotReviews(task);
				if (robotReviews.length > 0) {
					const latest = robotReviews[robotReviews.length - 1];
					const parts = [`\n\nRobot reviews: ${robotReviews.length}`];
					parts.push(renderCompactRobotReview(latest));
					robotNote = parts.join("\n");
				}
				const title = `#${task.id} [${task.status}] ${task.subject}\nDone: ${task.done_criterion}${pendingNote}\n${task.description}${evidenceNote}${robotNote}`;
				const action = await ui.select(title, actions);

				if (action === "▸ Start (in_progress)") {
					store.update(taskId, { status: "in_progress" });
					widget.setActiveTask(taskId);
					widget.update();
					return viewTasks();
				} else if (action === "✗ Delete") {
					store.update(taskId, { status: "deleted" });
					widget.setActiveTask(taskId, false);
					widget.update();
					return viewTasks();
				}
				return viewTasks();
			};

			const createTask = async (): Promise<void> => {
				const subject = await ui.input("Goal subject");
				if (!subject) return mainMenu();
				const description = await ui.input("Goal description");
				if (!description) return mainMenu();
				const done_criterion = await ui.input(
					"Done criterion (what does done look like?)",
				);
				if (!done_criterion) return mainMenu();

				store.create(subject, description, done_criterion);
				widget.update();
				return mainMenu();
			};

			await mainMenu();
		},
	});

	// ──────────────────────────────────────────────────
	// /lgtm command — proof log viewer
	// ──────────────────────────────────────────────────

	function renderTaskEvidenceForHuman(task: Task): string {
		return renderProofLog(task);
	}

	function showProofLog(task: Task) {
		pi.sendMessage({
			customType: "proof-log",
			content: renderTaskEvidenceForHuman(task),
			display: true,
			details: { taskId: task.id },
		});
	}

	function getLgtmTaskLabel(task: Task): string {
		const tag =
			task.status === "completed"
				? "[DONE]    "
				: task.status === "in_progress"
					? "[ACTIVE]  "
					: "[PENDING] ";
		return `${tag}#${task.id} ${task.subject}`;
	}

	async function viewEvidence(
		taskId: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const task = store.get(taskId);
		if (!task) {
			ctx.ui.notify(`Task #${taskId} not found`, "error");
			return;
		}
		showProofLog(task);
	}

	async function viewAllOpenProofLogs(
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const open = store.list().filter((t) => t.status !== "completed");
		if (open.length === 0) {
			ctx.ui.notify("No open tasks to inspect.", "info");
			return;
		}
		for (const task of open) showProofLog(task);
	}

	pi.registerCommand("lgtm", {
		description:
			"View the proof log and judge notes. /lgtm <id> [<id>...] shows specific tasks; /lgtm * shows all open tasks; task management lives in /tasks.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseLgtmArgs(args);
			if (parsed.kind === "error") {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			if (parsed.kind === "menu") {
				const tasks = store.list();
				const choice = await ctx.ui.select("LGTM", [
					"View all open proof logs",
					...tasks.map(getLgtmTaskLabel),
					"← Cancel",
				]);
				if (!choice || choice === "← Cancel") return;
				if (choice === "View all open proof logs")
					return viewAllOpenProofLogs(ctx);
				const match = choice.match(/#(\d+)/);
				if (match) return viewEvidence(match[1], ctx);
				return;
			}
			if (parsed.kind === "view_all") return viewAllOpenProofLogs(ctx);
			for (const id of parsed.ids) await viewEvidence(id, ctx);
		},
		getArgumentCompletions: (args: string) => {
			const trimmed = args.trim();
			const tasks = store.list();
			if (!trimmed) return [{ value: "*", label: "*" }];
			const prefix = trimmed.replace(/^#/, "");
			return [
				"*",
				...tasks
					.filter((task) => task.id.startsWith(prefix))
					.map((task) => task.id),
			].map((value) => ({ value, label: value }));
		},
	});
}
