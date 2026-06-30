/**
 * pi-lgtm — Lean task list with evidence sign-off.
 *
 * Three kinds of items:
 * - Goal: has done_criterion + failure_mode. Completes via TaskComplete with evidence.
 * - Subtask: has parentId. Just subject. Completes via TaskUpdate.
 * - Task: no parentId, no done_criterion. Plain checklist item. Completes via TaskUpdate.
 *
 * Tools:
 *   TaskCreate   — Create goal/task/subtask
 *   TaskList     — One line per item
 *   TaskGet      — Readable detail card
 *   TaskUpdate   — Update fields, mark tasks/subtasks done
 *   TaskComplete — Sign off a goal with evidence
 *
 * Commands:
 *   /tasks  — Interactive task management menu
 *   /lgtm   — View proof log
 */

import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AutoClearManager } from "./auto-clear.js";
import {
	type CadenceConfig,
	type CadenceState,
	createCadenceState,
	drainReminderForContext,
	evaluateToolResult,
} from "./reminder-cadence.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import type { Task } from "./types.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Helpers ----

function textResult(msg: string) {
	return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

const TASK_TOOL_NAMES = new Set([
	"TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskComplete",
]);

const REMINDER_INTERVAL = 4;
const SYSTEM_REMINDER = `You have active tasks. Check TaskList and keep working toward them. Mark in_progress before starting, and TaskComplete goals with evidence when done.`;

// ---- /lgtm command parser ----

export type LgtmCommandSpec =
	| { kind: "menu" }
	| { kind: "view_all" }
	| { kind: "view"; ids: string[] }
	| { kind: "error"; message: string };

export function parseLgtmArgs(args: string): LgtmCommandSpec {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "menu" };
	if (trimmed === "*") return { kind: "view_all" };
	const tokens = trimmed.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
	return { kind: "view", ids: tokens.map((t) => t.replace(/^#/, "")).filter(Boolean) };
}

// ---- RPC to pi-subagents ----

function rpcCall<T>(events: any, channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
	const requestId = randomUUID();
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => { unsub(); reject(new Error(`RPC timeout: ${channel}`)); }, timeoutMs);
		const unsub = events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
			unsub(); clearTimeout(timer);
			const reply = raw as { success: boolean; data?: T; error?: string };
			if (reply.success) resolve(reply.data as T);
			else reject(new Error(reply.error ?? "RPC failed"));
		});
		events.emit(channel, { requestId, ...params });
	});
}

let subagentsAvailable = false;

function checkSubagents(events: any): void {
	const requestId = randomUUID();
	const timer = setTimeout(() => { unsub(); }, 5_000);
	const unsub = events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
		unsub(); clearTimeout(timer);
		if ((raw as any)?.success) subagentsAvailable = true;
	});
	events.emit("subagents:rpc:ping", { requestId });
}

async function spawnSanityCheck(
	events: any, taskId: string, subject: string, done_criterion: string, evidence: string, failure_likely: string,
): Promise<string> {
	if (!subagentsAvailable) return "(sanity check skipped: pi-subagents not available)";
	const prompt = [
		`Verify task #${taskId} is actually done.`,
		`Subject: ${subject}`,
		`Done when: ${done_criterion}`,
		`Evidence: ${evidence}`,
		`Likely failure: ${failure_likely}`,
		``,
		`Read the actual files mentioned in the evidence. Run the actual commands if possible.`,
		`Answer: Is the evidence real and does it match the done criterion? One paragraph.`,
	].join("\n");
	try {
		const result = await rpcCall<{ id: string }>(events, "subagents:rpc:spawn", {
			type: "Explore",
			prompt,
			options: {},
		}, 30_000);
		return `(sanity check spawned: ${result.id})`;
	} catch (err: any) {
		return `(sanity check failed: ${err.message})`;
	}
}

// ---- Rendering ----

function renderTaskOneLine(task: Task): string {
	const icon = task.status === "completed" ? "✓" : task.status === "in_progress" ? "►" : "○";
	const label = task.progress_label && task.status === "in_progress" ? task.progress_label : task.subject;
	const isGoal = task.done_criterion ? "★" : " ";
	return `${icon}${isGoal} #${task.id} ${label}`;
}

function renderTaskDetail(task: Task): string {
	const lines: string[] = [];
	lines.push(`#${task.id} ${task.subject}`);
	lines.push(`Status: ${task.status}`);
	if (task.description) lines.push(task.description);
	if (task.done_criterion) lines.push(`Done when: ${task.done_criterion}`);
	if (task.failure_mode) lines.push(`Failure mode: ${task.failure_mode}`);
	if (task.parentId) lines.push(`Parent: #${task.parentId}`);
	if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);

	// Evidence (from TaskComplete)
	if (task.metadata?.lgtm_evidence) {
		lines.push(``);
		lines.push(`Evidence: ${task.metadata.lgtm_evidence}`);
		if (task.metadata?.lgtm_failure_likely) {
			lines.push(`Likely failure: ${task.metadata.lgtm_failure_likely}`);
		}
	}

	return lines.join("\n");
}

function renderLgtmLog(task: Task): string {
	if (!task.metadata?.lgtm_evidence) {
		return `#${task.id} ${task.subject}\nStatus: ${task.status}\nNo evidence yet.`;
	}
	return renderTaskDetail(task);
}

// ---- Extension ----

export default function register(pi: any, ctx: ExtensionContext): void {
	const config = loadTasksConfig();
	const store = new TaskStore(config.taskScope === "project" ? "default" : undefined);
	const widget = new TaskWidget(store);
	const autoClear = new AutoClearManager(
		() => store,
		() => (config.autoClearCompleted ?? "never") as any,
		config.clearDelayTurns ?? 4,
	);

	// Cadence state for reminders
	const cadence: CadenceState = createCadenceState();
	const cadenceConfig: CadenceConfig = {
		reminderInterval: config.reminderInterval ?? REMINDER_INTERVAL,
		taskToolNames: TASK_TOOL_NAMES,
	};

	// Detect pi-subagents
	checkSubagents(pi.events);

	// Widget setup
	if (ctx?.ui) {
		widget.setUICtx(ctx.ui as unknown as UICtx);
		widget.setStore(store);
	}

	// ── TaskCreate ──────────────────────────────────────

	pi.registerTool({
		name: "TaskCreate",
		label: "TaskCreate",
		description: `Create a task, goal, or subtask.

- Task: just a subject (checklist item). Mark done via TaskUpdate.
- Goal: add done_criterion + failure_mode. Sign off via TaskComplete with evidence.
- Subtask: add parentId. Mark done via TaskUpdate.

When creating a goal, break it into subtasks too.`,
		promptGuidelines: [
			"Create tasks BEFORE starting work. Mark in_progress before doing them.",
			"done_criterion must be externally verifiable — not 'I implemented X' but 'test X passes'.",
			"failure_mode: how could this still be wrong even if it looks done? Optional but valuable for goals.",
			"When creating a goal, break it into subtasks too.",
		],
		parameters: Type.Object({
			subject: Type.String({ description: "What to do (imperative, e.g. 'Fix auth bug')" }),
			done_criterion: Type.Optional(Type.String({ description: "Falsifiable test distinguishing done from not-done. Makes this a goal." })),
			failure_mode: Type.Optional(Type.String({ description: "How this could still be wrong even if it looks done. Optional — add for tricky goals." })),
			description: Type.Optional(Type.String({ description: "Extra context about what this goal involves" })),
			parentId: Type.Optional(Type.String({ description: "Make this a subtask of another task" })),
			progress_label: Type.Optional(Type.String({ description: "Present-continuous label shown while working (e.g. 'Fixing auth bug')" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to set. Set a key to null to delete it." })),
			add_blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that cannot start until this one finishes" })),
			add_blocked_by: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must finish before this one can start" })),
		}),

		execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
			const task = store.create(
				params.subject,
				params.done_criterion ?? "",
				params.failure_mode,
				params.progress_label,
				params.metadata,
				params.parentId,
			);

			// Set description separately
			if (params.description) {
				store.update(task.id, { metadata: { lgtm_description: params.description } });
			}

			if (params.add_blocks?.length || params.add_blocked_by?.length) {
				store.update(task.id, {
					add_blocks: params.add_blocks,
					add_blocked_by: params.add_blocked_by,
				});
			}

			autoClear.resetBatchCountdown();
			widget.setActiveTask(task.id);
			widget.update();

			const kind = params.parentId ? "subtask" : params.done_criterion ? "goal" : "task";
			let msg = `#${task.id} ${task.subject}`;
			if (params.done_criterion) msg += `\nDone when: ${params.done_criterion}`;
			if (params.failure_mode) msg += `\nFailure mode: ${params.failure_mode}`;
			if (params.description) msg += `\n${params.description}`;
			msg += `\n[${kind}]`;
			return Promise.resolve(textResult(msg));
		},
	});

	// ── TaskList ────────────────────────────────────────

	pi.registerTool({
		name: "TaskList",
		label: "TaskList",
		description: "List all tasks, one line each. ★ = goal, no star = task/subtask.",
		parameters: Type.Object({}),

		execute(_toolCallId: string, _params: any, _signal: any, _onUpdate: any, _ctx: any) {
			const tasks = store.list();
			if (tasks.length === 0) return Promise.resolve(textResult("No tasks."));

			const open = tasks.filter((t) => t.status !== "completed");
			const done = tasks.filter((t) => t.status === "completed");
			const lines = [
				...open.map(renderTaskOneLine),
				...done.map(renderTaskOneLine),
			];
			if (done.length > 0) lines.push(`(${done.length} completed)`);
			return Promise.resolve(textResult(lines.join("\n")));
		},
	});

	// ── TaskGet ────────────────────────────────────────

	pi.registerTool({
		name: "TaskGet",
		label: "TaskGet",
		description: "Get task detail — short, readable.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID" }),
		}),

		execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
			const task = store.get(params.taskId);
			if (!task) return Promise.resolve(textResult(`Task #${params.taskId} not found`));
			return Promise.resolve(textResult(renderTaskDetail(task)));
		},
	});

	// ── TaskUpdate ─────────────────────────────────────

	pi.registerTool({
		name: "TaskUpdate",
		label: "TaskUpdate",
		description: `Update a task. Mark in_progress before starting, completed when done.

Subtasks and plain tasks: mark completed directly.
Goals: use TaskComplete with evidence.`,
		promptGuidelines: [
			"Mark in_progress BEFORE starting work.",
			"Subtasks/tasks: mark completed directly.",
			"Goals: use TaskComplete with evidence, not this.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID" }),
			status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
				type: "string",
				enum: ["pending", "in_progress", "completed", "deleted"],
				description: "New status. Use 'deleted' to remove.",
			})),
			subject: Type.Optional(Type.String({ description: "New subject" })),
			done_criterion: Type.Optional(Type.String({ description: "New done criterion" })),
			failure_mode: Type.Optional(Type.String({ description: "New failure mode" })),
			progress_label: Type.Optional(Type.String({ description: "Label shown while working" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Merge metadata. Set key to null to delete." })),
			add_blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this blocks" })),
			add_blocked_by: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this" })),
		}),

		execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
			const { taskId, ...fields } = params;
			const { task, changedFields, warnings } = store.update(taskId, fields);

			if (changedFields.length === 0 && !task) {
				return Promise.resolve(textResult(`Task #${taskId} not found`));
			}

			if (fields.status === "in_progress") {
				widget.setActiveTask(taskId);
				autoClear.resetBatchCountdown();
			} else if (fields.status === "completed") {
				widget.setActiveTask(taskId, false);
				autoClear.trackCompletion(taskId, cadence.currentTurn);
			} else if (fields.status === "pending") {
				autoClear.resetBatchCountdown();
			} else if (fields.status === "deleted") {
				widget.setActiveTask(taskId, false);
			}

			widget.update();
			let msg = `Updated #${taskId} ${changedFields.join(", ")}`;
			if (warnings.length > 0) msg += ` (${warnings.join("; ")})`;
			return Promise.resolve(textResult(msg));
		},
	});

	// ── TaskComplete ───────────────────────────────────

	pi.registerTool({
		name: "TaskComplete",
		label: "TaskComplete",
		description: `Sign off a goal with evidence and failure analysis.

Two fields:
- evidence: what you actually saw (verbatim output, file paths, test results). Not summaries.
- failure_likely: the most likely way this could still be wrong. One sentence.

A sanity check subagent is spawned to verify the evidence is real.

Example:
  TaskComplete({ taskId: "1", evidence: "npm test → 12/12 passed", failure_likely: "doesn't cover expired tokens" })`,
		promptGuidelines: [
			"Evidence must be verbatim — paste actual output, not 'I ran the tests and they passed'.",
			"failure_likely: the ONE most plausible way this is still wrong, not a list.",
			"For subtasks and plain tasks, just use TaskUpdate with status:completed.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to complete" }),
			evidence: Type.String({ description: "Verbatim proof — paste actual output, file paths, test results. Not summaries." }),
			failure_likely: Type.String({ description: "Most likely way this could still be wrong despite the evidence. One sentence." }),
		}),

		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
			const task = store.get(params.taskId);
			if (!task) return textResult(`Task #${params.taskId} not found`);
			if (task.status === "completed") return textResult(`#${params.taskId} already completed`);

			// Store evidence, then mark completed
			store.update(params.taskId, {
				metadata: {
					lgtm_evidence: params.evidence,
					lgtm_failure_likely: params.failure_likely,
					lgtm_completed_at: new Date().toISOString(),
				},
			});
			store.complete(params.taskId);

			widget.setActiveTask(params.taskId, false);
			autoClear.trackCompletion(params.taskId, cadence.currentTurn);
			widget.update();

			// Spawn sanity check (non-blocking, result appended to output)
			const sanityResult = await spawnSanityCheck(
				pi.events, params.taskId, task.subject,
				task.done_criterion ?? "", params.evidence, params.failure_likely,
			);

			return textResult(
				`✓ #${params.taskId} ${task.subject}\n` +
				`Evidence: ${params.evidence}\n` +
				`Likely failure: ${params.failure_likely}\n` +
				sanityResult,
			);
		},
	});

	// ── /tasks command ──────────────────────────────────

	pi.registerCommand("tasks", {
		description: "Manage tasks — view, create, clear completed",
		handler: async (_args: string, commandCtx: ExtensionCommandContext) => {
			const ui = commandCtx.ui;
			const mainMenu = async (): Promise<void> => {
				const tasks = store.list();
				const completedCount = tasks.filter((t) => t.status === "completed").length;
				const choices: string[] = ["View all tasks", "Create task"];
				if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
				if (tasks.length > 0) choices.push(`Clear all (${tasks.length})`);

				const choice = await ui.select("Tasks", choices);
				if (!choice) return;

				if (choice.startsWith("View")) {
					const items = tasks.map((t) => renderTaskOneLine(t));
					await ui.select("Tasks", [...items, "← Back"]);
					await mainMenu();
				} else if (choice === "Create task") {
					const subject = await ui.input("Subject");
					if (!subject) return;
					const doneCriterion = await ui.input("Done when (optional — adds goal)");
					if (!doneCriterion) return;
					const failureMode = await ui.input("Failure mode (optional)");
					store.create(subject, doneCriterion || undefined, failureMode || undefined);
					widget.update();
					await mainMenu();
				} else if (choice.startsWith("Clear completed")) {
					store.clearCompleted();
					widget.update();
					await mainMenu();
				} else if (choice.startsWith("Clear all")) {
					store.clearAll();
					widget.update();
					await mainMenu();
				}
			};
			await mainMenu();
		},
	});

	// ── /lgtm command ──────────────────────────────────

	pi.registerCommand("lgtm", {
		description: "View proof log for tasks",
		handler: async (args: string, commandCtx: ExtensionCommandContext) => {
			const spec = parseLgtmArgs(args);
			const ui = commandCtx.ui;

			if (spec.kind === "error") {
				await ui.select("Error", [spec.message, "← Back"]);
				return;
			}

			const tasks = store.list();
			if (tasks.length === 0) {
				await ui.select("No tasks", ["← Back"]);
				return;
			}

			if (spec.kind === "menu") {
				const items = tasks.map((t) => renderTaskOneLine(t));
				const choice = await ui.select("Proof logs", [...items, "← Back"]);
				if (!choice || choice === "← Back") return;
				const idx = items.indexOf(choice);
				if (idx >= 0 && idx < tasks.length) {
					await ui.select(`Task #${tasks[idx].id}`, [renderLgtmLog(tasks[idx]), "← Back"]);
				}
				return;
			}

			if (spec.kind === "view_all") {
				const logs = tasks.map(renderLgtmLog).join("\n---\n");
				await ui.select("All proof logs", [logs, "← Back"]);
				return;
			}

			// View specific IDs
			const selected = spec.ids
				.map((id) => store.get(id))
				.filter((t): t is Task => t !== undefined);
			if (selected.length === 0) {
				await ui.select("Not found", ["No matching tasks", "← Back"]);
				return;
			}
			const logs = selected.map(renderLgtmLog).join("\n---\n");
			await ui.select("Proof logs", [logs, "← Back"]);
		},
	});

	// ── Turn lifecycle ──────────────────────────────────

	pi.on("turn_start", async (_event: any, turnCtx: any) => {
		onTurnStart(cadence);
		if (turnCtx?.ui) widget.setUICtx(turnCtx.ui as UICtx);
		if (autoClear.onTurnStart(cadence.currentTurn)) widget.update();
	});

	pi.on("tool_result", async (event: any) => {
		const isTaskTool = TASK_TOOL_NAMES.has(event.toolName);
		if (
			!isTaskTool &&
			cadence.currentTurn - cadence.lastTaskToolUseTurn < cadenceConfig.reminderInterval
		) {
			return {};
		}
		if (!isTaskTool && cadence.reminderInjectedThisCycle) return {};

		const hasTasks = isTaskTool ? false : store.list().length > 0;
		evaluateToolResult(cadence, event.toolName, hasTasks, cadenceConfig);
		return {};
	});

	pi.on("context", async (event: any) => {
		if (!drainReminderForContext(cadence)) return {};
		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: SYSTEM_REMINDER }],
					timestamp: Date.now(),
				},
			],
		};
	});
}

// Re-export cadence helpers for use in the extension
function onTurnStart(state: CadenceState): void {
	state.currentTurn++;
}
