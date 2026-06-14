import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import proofTasksExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";

type RegisteredTool = {
	name: string;
	execute: (...args: any[]) => Promise<any>;
};

function makeHarness() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		on: vi.fn((event: string, handler: (...args: any[]) => any) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		}),
		registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
		registerCommand: vi.fn(),
		sendMessage: vi.fn(),
	};

	proofTasksExtension(pi as any);

	async function execTool(name: string, params: Record<string, unknown>) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Tool ${name} not registered`);
		return tool.execute("tool-call", params, undefined, undefined, {});
	}

	async function trigger(event: string, payload: any = {}, ctx: any = {}) {
		for (const handler of handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}

	return { execTool, trigger };
}

const tempDirs: string[] = [];

afterEach(() => {
	delete process.env.PI_TASKS;
	while (tempDirs.length > 0)
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Task tools", () => {
	it("renders a compact one-line-per-task summary", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Design the flux capacitor",
			description: "Desc",
			done_criterion: "done",
		});
		await harness.execTool("TaskCreate", {
			subject: "Acquiring plutonium",
			description: "Desc",
			done_criterion: "done",
			progress_label: "Acquiring plutonium",
		});
		await harness.execTool("TaskCreate", {
			subject: "Install flux capacitor in DeLorean",
			description: "Desc",
			done_criterion: "done",
			parentId: "1",
		});
		await harness.execTool("TaskCreate", {
			subject: "Test time travel at 88 mph",
			description: "Desc",
			done_criterion: "done",
		});

		await harness.execTool("TaskUpdate", { taskId: "1", status: "completed" });
		await harness.execTool("TaskUpdate", {
			taskId: "2",
			status: "in_progress",
		});
		await harness.execTool("TaskUpdate", {
			taskId: "3",
			add_blocked_by: ["1"],
		});
		await harness.execTool("TaskUpdate", {
			taskId: "4",
			add_blocked_by: ["2", "3"],
		});

		const result = await harness.execTool("TaskList", {});
		const text = result.content[0].text;

		expect(text).toContain("● 4 goals (1 in progress, 3 open)");
		expect(text).toContain("◻ #1 Design the flux capacitor");
		expect(text).toContain("◼ #2 Acquiring plutonium");
		expect(text).toContain(
			"◻ #3 Install flux capacitor in DeLorean › subtask of #1 › blocked by #1",
		);
		expect(text).toContain(
			"◻ #4 Test time travel at 88 mph › blocked by #2, #3",
		);
		expect(text).not.toContain("[ACTIVE]");
		expect(text).not.toContain("[PENDING]");
		expect(text).not.toContain("[DONE");
		expect(text).not.toContain("proof claim submitted");
		expect(text).not.toContain("test:");
	});

	it("shows TaskCreate output with metadata and compact previews", async () => {
		const harness = makeHarness();
		const result = await harness.execTool("TaskCreate", {
			subject: "Top-level goal",
			description: "Line 1\nLine 2\nLine 3",
			done_criterion: "observe line a\nobserve line b",
			progress_label: "Running check",
			metadata: { owner: "pi", note: "short" },
		});

		const text = result.content[0].text;
		expect(text).toContain("## TaskCreate -> Task #1: Top-level goal");
		expect(text).toContain("### Metadata");
		expect(text).toContain("- Metadata keys: 2");
		expect(text).toContain("### Done criterion");
		expect(text).toContain("### Description");
		expect(text).toContain("### Progress label");
		expect(text).toContain("### Metadata preview");
	});

	it("shows TaskUpdate output with changed fields and previews", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Top-level goal",
			description: "Desc",
			done_criterion: "done",
		});

		const result = await harness.execTool("TaskUpdate", {
			taskId: "1",
			status: "in_progress",
			progress_label: "Running check",
			metadata: { owner: "pi" },
		});

		const text = result.content[0].text;
		expect(text).toContain("## TaskUpdate -> Task #1: Top-level goal");
		expect(text).toContain(
			"- Updated fields: status, progress_label, metadata",
		);
		expect(text).toContain("- status: pending -> in_progress");
		expect(text).toContain("- progress_label: (missing) -> Running check");
		expect(text).toContain("### Metadata patch");
	});

	it("shows completed subtasks without proof-lane clutter", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Top-level goal",
			description: "Desc",
			done_criterion: "done",
		});
		await harness.execTool("TaskCreate", {
			subject: "Finished checklist item",
			description: "Desc",
			done_criterion: "done",
			parentId: "1",
		});

		await harness.execTool("TaskUpdate", { taskId: "2", status: "completed" });

		const result = await harness.execTool("TaskList", {});
		const text = result.content[0].text;

		expect(text).toContain("● 2 goals (1 done hidden, 1 open)");
		expect(text).toContain("◻ #1 Top-level goal");
		expect(text).not.toContain("#2 Finished checklist item");
		expect(text).not.toContain("[DONE");
		expect(text).not.toContain("proof claim submitted");
	});

	it("keeps persisted completed tasks on startup but hides them from the collapsed list", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-proof-tasks-"));
		tempDirs.push(dir);
		const taskPath = join(dir, "tasks.json");
		process.env.PI_TASKS = taskPath;

		const seeded = new TaskStore(taskPath);
		seeded.create("Finished work", "Desc", "done");
		seeded.complete("1");

		const harness = makeHarness();
		await harness.trigger(
			"before_agent_start",
			{},
			{
				ui: { setWidget() {}, setStatus() {} },
				sessionManager: { getSessionId: () => "session-test" },
			},
		);

		const result = await harness.execTool("TaskList", {});
		expect(result.content[0].text).toContain("● 1 goals (1 done hidden)");
		expect(result.content[0].text).toContain(
			"No open tasks. Completed tasks are hidden by default.",
		);

		const reloaded = new TaskStore(taskPath);
		expect(reloaded.get("1")?.status).toBe("completed");
	});

	it("keeps persisted completed tasks on startup even when one open goal remains", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-proof-tasks-"));
		tempDirs.push(dir);
		const taskPath = join(dir, "tasks.json");
		process.env.PI_TASKS = taskPath;

		const seeded = new TaskStore(taskPath);
		seeded.create("Open goal", "Desc", "done");
		seeded.create("Finished work", "Desc", "done", undefined, undefined, "1");
		seeded.complete("2");

		const harness = makeHarness();
		await harness.trigger(
			"before_agent_start",
			{},
			{
				ui: { setWidget() {}, setStatus() {} },
				sessionManager: { getSessionId: () => "session-test" },
			},
		);

		const result = await harness.execTool("TaskList", {});
		const text = result.content[0].text;
		expect(text).toContain("● 2 goals (1 done hidden, 1 open)");
		expect(text).toContain("◻ #1 Open goal");
		expect(text).not.toContain("Finished work");

		const reloaded = new TaskStore(taskPath);
		expect(reloaded.get("2")?.status).toBe("completed");
	});

	it("keeps completed tasks persisted by default across later turns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-proof-tasks-"));
		tempDirs.push(dir);
		const taskPath = join(dir, "tasks.json");
		process.env.PI_TASKS = taskPath;

		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Persistent completed goal",
			description: "Desc",
			done_criterion: "done",
		});
		await harness.execTool("TaskCreate", {
			subject: "Checklist item",
			description: "Desc",
			done_criterion: "done",
			parentId: "1",
		});
		await harness.execTool("TaskUpdate", { taskId: "2", status: "completed" });

		for (let turn = 0; turn < 8; turn++) {
			await harness.trigger("turn_start", {}, {
				ui: { setWidget() {}, setStatus() {} },
				sessionManager: { getSessionId: () => "session-test" },
			});
		}

		const reloaded = new TaskStore(taskPath);
		expect(reloaded.get("2")?.status).toBe("completed");
	});

	it("stores named PI_TASKS lists inside the repo .pi/tasks directory", async () => {
		process.env.PI_TASKS = `named-${Date.now()}`;
		const expectedPath = join(
			process.cwd(),
			".pi",
			"tasks",
			`${process.env.PI_TASKS}.json`,
		);
		try {
			rmSync(expectedPath);
		} catch {}
		try {
			rmSync(expectedPath + ".lock");
		} catch {}
		try {
			rmSync(expectedPath + ".tmp");
		} catch {}

		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Repo local task",
			description: "Desc",
			done_criterion: "done",
		});

		const reloaded = new TaskStore(expectedPath);
		expect(reloaded.get("1")?.subject).toBe("Repo local task");

		try {
			rmSync(expectedPath);
		} catch {}
		try {
			rmSync(expectedPath + ".lock");
		} catch {}
		try {
			rmSync(expectedPath + ".tmp");
		} catch {}
	});
});
