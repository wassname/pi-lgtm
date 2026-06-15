import { mkdtempSync, rmSync } from "node:fs";
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
		events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
		registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
		registerCommand: vi.fn(),
	};

	proofTasksExtension(pi as any, { ui: undefined } as any);

	async function execTool(name: string, params: Record<string, unknown>) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Tool ${name} not registered`);
		return tool.execute("tool-call", params, undefined, undefined, {});
	}

	return { execTool };
}

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Task tools", () => {
	it("renders a compact one-line-per-task summary", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", { subject: "Design flux capacitor", done_criterion: "blueprint approved" });
		await harness.execTool("TaskCreate", { subject: "Get plutonium", done_criterion: "1.21 GW available" });
		await harness.execTool("TaskCreate", { subject: "Install in DeLorean", parentId: "1" });
		await harness.execTool("TaskCreate", { subject: "Simple task" });

		const list = await harness.execTool("TaskList", {});
		const text = list.content[0].text;

		// Goals get ★, subtasks and plain tasks don't
		expect(text).toContain("★ #1");
		expect(text).toContain("★ #2");
		expect(text).toContain("#3"); // subtask
		expect(text).toContain("#4"); // plain task
	});

	it("shows TaskCreate output with goal info", async () => {
		const harness = makeHarness();
		const result = await harness.execTool("TaskCreate", {
			subject: "Fix auth bug",
			done_criterion: "pytest test_auth passes",
			failure_mode: "doesn't cover expired tokens",
		});
		const text = result.content[0].text;

		expect(text).toContain("#1 Fix auth bug");
		expect(text).toContain("Done when: pytest test_auth passes");
		expect(text).toContain("Failure mode: doesn't cover expired tokens");
		expect(text).toContain("[goal]");
	});

	it("shows TaskCreate output for plain task", async () => {
		const harness = makeHarness();
		const result = await harness.execTool("TaskCreate", {
			subject: "Write docs",
		});
		const text = result.content[0].text;

		expect(text).toContain("#1 Write docs");
		expect(text).toContain("[task]");
	});

	it("shows TaskUpdate output", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", { subject: "Fix bug" });
		const result = await harness.execTool("TaskUpdate", { taskId: "1", status: "in_progress" });
		const text = result.content[0].text;

		expect(text).toContain("Updated #1 status");
	});

	it("completes subtasks via TaskUpdate", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", { subject: "Parent goal", done_criterion: "all done" });
		await harness.execTool("TaskCreate", { subject: "Subtask", parentId: "1" });
		const result = await harness.execTool("TaskUpdate", { taskId: "2", status: "completed" });
		const text = result.content[0].text;

		expect(text).toContain("Updated #2 status");

		const detail = await harness.execTool("TaskGet", { taskId: "2" });
		expect(detail.content[0].text).toContain("completed");
	});

	it("completes goals via TaskComplete with evidence", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Fix auth bug",
			done_criterion: "test passes",
		});
		const result = await harness.execTool("TaskComplete", {
			taskId: "1",
			evidence: "pytest test_auth → 12/12 passed",
			failure_likely: "doesn't cover expired tokens",
		});
		const text = result.content[0].text;

		expect(text).toContain("✓ #1 Fix auth bug");
		expect(text).toContain("Evidence: pytest test_auth → 12/12 passed");
		expect(text).toContain("Likely failure: doesn't cover expired tokens");

		const detail = await harness.execTool("TaskGet", { taskId: "1" });
		expect(detail.content[0].text).toContain("completed");
	});

	it("shows TaskGet detail for a goal", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Fix auth bug",
			done_criterion: "test passes",
			failure_mode: "doesn't cover expired tokens",
		});
		const result = await harness.execTool("TaskGet", { taskId: "1" });
		const text = result.content[0].text;

		expect(text).toContain("#1 Fix auth bug");
		expect(text).toContain("Status: pending");
		expect(text).toContain("Done when: test passes");
		expect(text).toContain("Failure mode: doesn't cover expired tokens");
	});
});
