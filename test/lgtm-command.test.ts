import { describe, expect, it, vi } from "vitest";
import proofTasksExtension, { parseLgtmArgs } from "../src/index.js";

type RegisteredTool = {
	name: string;
	execute: (...args: any[]) => Promise<any>;
};

type RegisteredCommand = {
	handler: (args: string, ctx: any) => Promise<void>;
};

function makeHarness() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();

	const pi = {
		on: vi.fn(),
		events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
		registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
		registerCommand: vi.fn((name: string, command: RegisteredCommand) =>
			commands.set(name, command),
		),
	};

	proofTasksExtension(pi as any, { ui: undefined } as any);

	async function execTool(name: string, params: Record<string, unknown>) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Tool ${name} not registered`);
		return tool.execute("tool-call", params, undefined, undefined, {});
	}

	function makeUi(overrides: { select?: Array<string | undefined> } = {}) {
		const selectQueue = [...(overrides.select ?? [])];
		return {
			notify: vi.fn(),
			select: vi.fn(async () => selectQueue.shift()),
			input: vi.fn(async () => ""),
		};
	}

	return { tools, commands, execTool, makeUi };
}

describe("parseLgtmArgs", () => {
	it("parses menu and view forms", () => {
		expect(parseLgtmArgs("")).toEqual({ kind: "menu" });
		expect(parseLgtmArgs("*")).toEqual({ kind: "view_all" });
		expect(parseLgtmArgs("1 #2")).toEqual({ kind: "view", ids: ["1", "2"] });
	});

	it("treats unknown args as view IDs", () => {
		// "clear" and "delete" are just treated as task IDs now
		expect(parseLgtmArgs("clear")).toEqual({ kind: "view", ids: ["clear"] });
		expect(parseLgtmArgs("1 2")).toEqual({ kind: "view", ids: ["1", "2"] });
	});
});

describe("/lgtm command", () => {
	it("shows proof logs from picker", async () => {
		const harness = makeHarness();
		await harness.execTool("TaskCreate", {
			subject: "Goal A",
			done_criterion: "test passes",
		});

		const ui = harness.makeUi({ select: ["○★ #1 Goal A", "← Back"] });
		const command = harness.commands.get("lgtm");
		if (!command) throw new Error("/lgtm not registered");

		await command.handler("", { ui });

		// Should have shown the task in the select options
		expect(ui.select).toHaveBeenCalled();
	});
});
