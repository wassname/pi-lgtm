import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

/** Create a mock theme that returns raw text (no ANSI escapes). */
function mockTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => `~~${text}~~`,
	};
}

/** Create a mock UICtx that captures setWidget calls. */
function mockUICtx() {
	const state: {
		widgets: Map<string, any>;
		statuses: Map<string, string | undefined>;
	} = {
		widgets: new Map(),
		statuses: new Map(),
	};

	const ctx: UICtx = {
		setWidget(key, content, options) {
			state.widgets.set(key, { content, options });
		},
		setStatus(key, text) {
			state.statuses.set(key, text);
		},
	};

	return { ctx, state };
}

/** Render the widget and return its lines (the widget is a single line). */
function renderWidget(state: ReturnType<typeof mockUICtx>["state"]): string[] {
	const entry = state.widgets.get("tasks");
	if (!entry?.content) return [];
	const theme = mockTheme();
	const tui = { terminal: { columns: 200 }, requestRender() {} };
	const result = entry.content(tui, theme);
	return result.render();
}

/** The single rendered line, or "" when the widget is hidden. */
function line(state: ReturnType<typeof mockUICtx>["state"]): string {
	const lines = renderWidget(state);
	return lines[0] ?? "";
}

describe("TaskWidget", () => {
	let store: TaskStore;
	let widget: TaskWidget;
	let ui: ReturnType<typeof mockUICtx>;

	beforeEach(() => {
		vi.useFakeTimers();
		store = new TaskStore();
		widget = new TaskWidget(store);
		ui = mockUICtx();
		widget.setUICtx(ui.ctx);
	});

	afterEach(() => {
		widget.dispose();
		vi.useRealTimers();
	});

	it("shows nothing when no tasks exist", () => {
		widget.update();
		const entry = ui.state.widgets.get("tasks");
		expect(entry?.content).toBeUndefined();
	});

	it("renders a single line with the goal marker before the count title", () => {
		store.create("Do something", "Desc", "done");
		widget.update();

		const lines = renderWidget(ui.state);
		expect(lines).toHaveLength(1);
		const l = lines[0];
		// Marker comes before the title.
		expect(l.indexOf("Do something")).toBeLessThan(l.indexOf("1 goals"));
		expect(l).toContain("◻");
		expect(l).toContain("1 open");
		// done_criterion text is not shown inline.
		expect(l).not.toContain("done");
	});

	it("renders in-progress tasks with ◼ marker", () => {
		store.create("Working on it", "Desc", "done");
		store.update("1", { status: "in_progress" });
		widget.update();

		expect(line(ui.state)).toContain("◼");
		expect(line(ui.state)).toContain("Working on it");
	});

	it("hides the widget when only completed tasks remain", () => {
		store.create("Done task", "Desc", "done");
		store.complete("1");
		widget.update();

		expect(renderWidget(ui.state)).toEqual([]);
	});

	it("does not leak metadata into the line", () => {
		store.create("Open task", "Desc", "done");
		store.create("Done task", "Desc", "done");
		store.update("2", {
			metadata: {
				robot_review_observations: ["Observed output drift on seed 2"],
				lgtm_evidence: "verbatim output",
			},
		});
		store.complete("2");
		widget.update();

		const l = line(ui.state);
		expect(l).toContain("Open task");
		expect(l).not.toContain("robot_review_observations");
		expect(l).not.toContain("lgtm_evidence");
	});

	it("renders active tasks with progress label and no ◼", () => {
		store.create("Running thing", "Desc", "done criterion", "Processing data");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		const l = line(ui.state);
		expect(l).toContain("Processing data…");
		expect(l).not.toContain("◼");
	});

	it("shows status summary in the count title", () => {
		store.create("Task A", "Desc", "done");
		store.create("Task B", "Desc", "done");
		store.create("Task C", "Desc", "done");
		store.complete("1");
		store.update("2", { status: "in_progress" });
		widget.update();

		const l = line(ui.state);
		expect(l).toContain("3 goals");
		expect(l).toContain("1 in progress");
		expect(l).toContain("1 open");
		expect(l).toContain("1 done");
	});

	it("clears widget when all tasks are deleted", () => {
		store.create("Task", "Desc", "done");
		widget.update();
		expect(ui.state.widgets.get("tasks")?.content).toBeDefined();

		store.update("1", { status: "deleted" });
		widget.update();
		expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
	});

	it("collapses overflow past MAX_VISIBLE_TASKS into '+N more', still one line", () => {
		for (let i = 0; i < 15; i++) {
			store.create(`Task ${i + 1}`, "Desc", "done");
		}
		widget.update();

		const lines = renderWidget(ui.state);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("+10 more");
	});

	it("deactivates a task with setActiveTask(id, false)", () => {
		store.create("Task", "Desc", "done criterion", "Doing work");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		expect(line(ui.state)).toContain("Doing work…");

		widget.setActiveTask("1", false);
		const l = line(ui.state);
		expect(l).toContain("◼");
		expect(l).not.toContain("Doing work…");
	});

	it("prunes stale active IDs on update", () => {
		store.create("Task", "Desc", "done");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		store.complete("1");
		widget.update();

		expect(renderWidget(ui.state)).toEqual([]);
	});

	it("supports multiple active tasks on the same line", () => {
		store.create("Task A", "Desc", "done criterion", "Processing A");
		store.create("Task B", "Desc", "done criterion", "Processing B");
		store.update("1", { status: "in_progress" });
		store.update("2", { status: "in_progress" });
		widget.setActiveTask("1", true);
		widget.setActiveTask("2", true);

		const l = line(ui.state);
		expect(l).toContain("Processing A…");
		expect(l).toContain("Processing B…");
	});

	it("dispose clears widget and timer", () => {
		store.create("Task", "Desc", "done");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		widget.dispose();
		expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
	});

	it("uses subject as fallback when no progress_label", () => {
		store.create("My Subject", "Desc", "done");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		expect(line(ui.state)).toContain("My Subject…");
	});

	it("widget is placed aboveEditor", () => {
		store.create("Task", "Desc", "done");
		widget.update();

		const entry = ui.state.widgets.get("tasks");
		expect(entry?.options?.placement).toBe("aboveEditor");
	});
});

describe("formatDuration (via widget rendering)", () => {
	let store: TaskStore;
	let widget: TaskWidget;
	let ui: ReturnType<typeof mockUICtx>;

	beforeEach(() => {
		vi.useFakeTimers();
		store = new TaskStore();
		widget = new TaskWidget(store);
		ui = mockUICtx();
		widget.setUICtx(ui.ctx);
	});

	afterEach(() => {
		widget.dispose();
		vi.useRealTimers();
	});

	function activeLine(): string {
		const lines = renderWidget(ui.state);
		return lines[0] ?? "";
	}

	it("shows seconds for short durations", () => {
		store.create("Quick", "Desc", "done criterion", "Working");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		vi.advanceTimersByTime(30_000);
		widget.update();

		expect(activeLine()).toContain("30s");
	});

	it("shows hours and minutes for long durations", () => {
		store.create("Long", "Desc", "done criterion", "Working");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		vi.advanceTimersByTime(3_723_000); // 1h 2m 3s → "1h 2m"
		widget.update();

		expect(activeLine()).toContain("1h 2m");
	});

	it("shows exact hours without minutes", () => {
		store.create("Exact", "Desc", "done criterion", "Working");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		vi.advanceTimersByTime(7_200_000); // 2h exactly
		widget.update();

		expect(activeLine()).toContain("2h)");
	});

	it("shows minutes and seconds", () => {
		store.create("Medium", "Desc", "done criterion", "Working");
		store.update("1", { status: "in_progress" });
		widget.setActiveTask("1", true);

		vi.advanceTimersByTime(169_000); // 2m 49s
		widget.update();

		expect(activeLine()).toContain("2m 49s");
	});
});
