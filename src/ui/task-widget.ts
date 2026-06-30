/**
 * task-widget.ts — Persistent one-line widget showing open goals inline.
 *
 * Single line, goal markers first then a short count, e.g.
 *   ◼#12 fix auth  ◻#13 add tests  ✳#14 deploying…  ·  3 goals (1 in progress)
 * Kept to one line to stay out of the way (pi widgets eat bottom space).
 *
 * Markers:
 *   ◼ in_progress   ◻ pending   ✳/✽ actively executing (star spinner + progress_label)
 * Completed tasks stay in storage but are hidden here.
 */

import type { TaskStore } from "../task-store.js";
import type { Task } from "../types.js";

// ANSI-aware truncation: count only visible chars, never cut inside an escape
// sequence (which would corrupt the terminal), and reset color at the cut.
const ANSI = /\x1b\[[0-9;]*m/y;
function truncateToWidth(line: string, maxWidth: number): string {
	let visible = 0;
	let out = "";
	let i = 0;
	while (i < line.length) {
		ANSI.lastIndex = i;
		const m = ANSI.exec(line);
		if (m) {
			out += m[0];
			i = ANSI.lastIndex;
			continue;
		}
		if (visible >= maxWidth - 1) return out + "…\x1b[0m";
		out += line[i];
		visible++;
		i++;
	}
	return out;
}

function getDisplayStatus(task: Task): "in_progress" | "pending" | "completed" {
	return task.status;
}

// ---- Types ----

export type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
};

export type UICtx = {
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content:
			| undefined
			| ((
					tui: any,
					theme: Theme,
			  ) => { render(): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};

/** Star spinner frames for animated active task indicator (matches Claude Code). */
const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

const MAX_VISIBLE_TASKS = 5;

/** Per-task runtime metrics (elapsed time). */
export interface TaskMetrics {
	startedAt: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

// ---- Widget ----

export class TaskWidget {
	private uiCtx: UICtx | undefined;
	private widgetFrame = 0;
	private widgetInterval: ReturnType<typeof setInterval> | undefined;
	/** IDs of tasks currently being actively executed (show spinner). */
	private activeTaskIds = new Set<string>();
	/** Per-task runtime metrics keyed by task ID. */
	private metrics = new Map<string, TaskMetrics>();
	/** Cached TUI instance for requestRender() calls. */
	private tui: any | undefined;
	/** Whether the widget callback is currently registered. */
	private widgetRegistered = false;

	constructor(private store: TaskStore) {}

	setStore(store: TaskStore) {
		this.store = store;
	}

	setUICtx(ctx: UICtx) {
		this.uiCtx = ctx;
	}

	/** Add or remove a task from the active spinner set. */
	setActiveTask(taskId: string | undefined, active = true) {
		if (taskId && active) {
			this.activeTaskIds.add(taskId);
			if (!this.metrics.has(taskId)) {
				this.metrics.set(taskId, { startedAt: Date.now() });
			}
			this.ensureTimer();
		} else if (taskId) {
			this.activeTaskIds.delete(taskId);
		}
		this.update();
	}

	/** Ensure the widget update timer is running. */
	ensureTimer() {
		if (!this.widgetInterval) {
			this.widgetInterval = setInterval(() => this.update(), 80);
		}
	}

	/** Build the single widget line from current live state. Called from the render callback. */
	private renderWidget(tui: any, theme: Theme): string[] {
		const tasks = this.store.list();
		const w = tui.terminal.columns;

		if (tasks.length === 0) return [];

		const counts = { completed: 0, in_progress: 0, pending: 0 };
		for (const t of tasks) counts[getDisplayStatus(t)]++;

		const visibleTasks = tasks.filter((task) => task.status !== "completed");
		if (visibleTasks.length === 0) return [];

		// Goal markers inline, active task first so its progress always shows.
		const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
		const ordered = [...visibleTasks].sort((a, b) => {
			const aActive = this.activeTaskIds.has(a.id) && a.status === "in_progress" ? 0 : 1;
			const bActive = this.activeTaskIds.has(b.id) && b.status === "in_progress" ? 0 : 1;
			return aActive - bActive;
		});

		const markers: string[] = [];
		for (const task of ordered.slice(0, MAX_VISIBLE_TASKS)) {
			const isActive =
				this.activeTaskIds.has(task.id) && task.status === "in_progress";
			const id = theme.fg("dim", "#" + task.id);
			if (isActive) {
				const form = task.progress_label || task.subject;
				const m = this.metrics.get(task.id);
				const elapsed = m ? ` ${theme.fg("dim", `(${formatDuration(Date.now() - m.startedAt)})`)}` : "";
				markers.push(`${theme.fg("accent", spinnerChar)}${id} ${theme.fg("accent", form + "…")}${elapsed}`);
			} else if (task.status === "in_progress") {
				markers.push(`${theme.fg("accent", "◼")}${id} ${task.subject}`);
			} else {
				markers.push(`◻${id} ${task.subject}`);
			}
		}
		if (visibleTasks.length > MAX_VISIBLE_TASKS) {
			markers.push(theme.fg("dim", `+${visibleTasks.length - MAX_VISIBLE_TASKS} more`));
		}

		// Short count title, after the markers.
		const parts: string[] = [];
		if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
		if (counts.pending > 0) parts.push(`${counts.pending} open`);
		if (counts.completed > 0) parts.push(`${counts.completed} done`);
		const title = theme.fg("accent", `${tasks.length} goals (${parts.join(", ")})`);

		const line = markers.join("  ") + theme.fg("dim", "  ·  ") + title;
		return [truncateToWidth(line, w)];
	}

	/** Force an immediate widget update. */
	update() {
		if (!this.uiCtx) return;
		const tasks = this.store.list();
		const visibleTasks = tasks.filter((task) => task.status !== "completed");

		// Transition: visible → hidden
		if (visibleTasks.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget("tasks", undefined);
				this.widgetRegistered = false;
			}
			if (this.widgetInterval) {
				clearInterval(this.widgetInterval);
				this.widgetInterval = undefined;
			}
			return;
		}

		// Prune stale active IDs (deleted or no longer in_progress)
		for (const id of this.activeTaskIds) {
			const t = this.store.get(id);
			if (!t || t.status !== "in_progress") {
				this.activeTaskIds.delete(id);
				this.metrics.delete(id);
			}
		}

		// Check if any task needs animation
		const hasActiveSpinner = tasks.some(
			(t) => this.activeTaskIds.has(t.id) && t.status === "in_progress",
		);
		if (hasActiveSpinner) {
			this.ensureTimer();
		} else if (!hasActiveSpinner && this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = undefined;
		}

		this.widgetFrame++;

		// Transition: hidden → visible — register widget callback once
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				"tasks",
				(tui, theme) => {
					this.tui = tui;
					return {
						render: () => this.renderWidget(tui, theme),
						invalidate: () => {},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else if (this.tui) {
			// Widget already registered — just request a re-render
			this.tui.requestRender();
		}
	}

	dispose() {
		if (this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = undefined;
		}
		if (this.uiCtx) {
			this.uiCtx.setWidget("tasks", undefined);
		}
		this.widgetRegistered = false;
		this.tui = undefined;
	}
}
