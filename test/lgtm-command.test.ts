import { describe, expect, it, vi } from "vitest";
import proofTasksExtension, { parseLgtmArgs } from "../src/index.js";

type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<any>;
};

type RegisteredCommand = {
  handler: (args: string, ctx: any) => Promise<void>;
  getArgumentCompletions?: (args: string) => Promise<string[]>;
};

function makeHarness() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: any[] = [];

  const pi = {
    on: vi.fn(),
    registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: RegisteredCommand) => commands.set(name, command)),
    sendMessage: vi.fn((message: any) => sentMessages.push(message)),
  };

  proofTasksExtension(pi as any);

  async function execTool(name: string, params: Record<string, unknown>) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    return tool.execute("tool-call", params, undefined, undefined, {});
  }

  function makeUi(overrides: {
    select?: Array<string | undefined>;
    confirm?: Array<boolean>;
  } = {}) {
    const selectQueue = [...(overrides.select ?? [])];
    const confirmQueue = [...(overrides.confirm ?? [])];
    return {
      notify: vi.fn(),
      select: vi.fn(async () => selectQueue.shift()),
      confirm: vi.fn(async () => confirmQueue.shift() ?? false),
    };
  }

  return { tools, commands, sentMessages, execTool, makeUi };
}

describe("parseLgtmArgs", () => {
  it("parses menu and view forms", () => {
    expect(parseLgtmArgs("")).toEqual({ kind: "menu" });
    expect(parseLgtmArgs("*")).toEqual({ kind: "view_all" });
    expect(parseLgtmArgs("1 #2")).toEqual({ kind: "view", ids: ["1", "2"] });
  });

  it("rejects task-management forms", () => {
    expect(parseLgtmArgs("clear")).toEqual({ kind: "error", message: "Task management lives in /tasks now. /lgtm is viewer-only." });
    expect(parseLgtmArgs("clear *")).toEqual({ kind: "error", message: "Task management lives in /tasks now. /lgtm is viewer-only." });
    expect(parseLgtmArgs("clear #7")).toEqual({ kind: "error", message: "Task management lives in /tasks now. /lgtm is viewer-only." });
    expect(parseLgtmArgs("delete #7")).toEqual({ kind: "error", message: "Task management lives in /tasks now. /lgtm is viewer-only." });
  });
});

describe("/lgtm command", () => {
  it("shows all open proof logs from the picker", async () => {
    const harness = makeHarness();
    await harness.execTool("TaskCreate", { subject: "Task A", description: "Desc", done_criterion: "done" });
    await harness.execTool("TaskCreate", { subject: "Task B", description: "Desc", done_criterion: "done" });

    const ui = harness.makeUi({ select: ["View all open proof logs"] });
    const command = harness.commands.get("lgtm");
    if (!command) throw new Error("/lgtm not registered");

    await command.handler("", { ui });

    expect(harness.sentMessages).toHaveLength(2);
    expect(harness.sentMessages[0].customType).toBe("proof-log");
    expect(harness.sentMessages[0].content).toContain("Task #1");
    expect(harness.sentMessages[1].content).toContain("Task #2");
  });

  it("shows one proof log from the picker", async () => {
    const harness = makeHarness();
    await harness.execTool("TaskCreate", { subject: "Task A", description: "Desc", done_criterion: "done" });

    const ui = harness.makeUi({ select: ["[PENDING] #1 Task A"] });
    const command = harness.commands.get("lgtm");
    if (!command) throw new Error("/lgtm not registered");

    await command.handler("", { ui });

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0].content).toContain("Task #1");
  });

  it("rejects /lgtm clear and points task management back to /tasks", async () => {
    const harness = makeHarness();
    await harness.execTool("TaskCreate", { subject: "Task A", description: "Desc", done_criterion: "done" });

    const ui = harness.makeUi();
    const command = harness.commands.get("lgtm");
    if (!command) throw new Error("/lgtm not registered");

    await command.handler("clear 1", { ui });

    expect(harness.sentMessages).toHaveLength(0);
    expect(ui.notify).toHaveBeenCalledWith("Task management lives in /tasks now. /lgtm is viewer-only.", "error");
  });

  it("rejects /lgtm delete and points task management back to /tasks", async () => {
    const harness = makeHarness();
    await harness.execTool("TaskCreate", { subject: "Task A", description: "Desc", done_criterion: "done" });

    const ui = harness.makeUi();
    const command = harness.commands.get("lgtm");
    if (!command) throw new Error("/lgtm not registered");

    await command.handler("delete 1", { ui });

    expect(harness.sentMessages).toHaveLength(0);
    expect(ui.notify).toHaveBeenCalledWith("Task management lives in /tasks now. /lgtm is viewer-only.", "error");
  });
});
