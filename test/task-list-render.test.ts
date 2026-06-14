import { describe, expect, it, vi } from "vitest";
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

  async function execTool(name: string, params: Record<string, unknown>) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    return tool.execute("tool-call", params, undefined, undefined, {});
  }

  return { execTool };
}

describe("TaskList", () => {
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
    await harness.execTool("TaskUpdate", { taskId: "2", status: "in_progress" });
    await harness.execTool("TaskUpdate", { taskId: "3", add_blocked_by: ["1"] });
    await harness.execTool("TaskUpdate", { taskId: "4", add_blocked_by: ["2", "3"] });

    const result = await harness.execTool("TaskList", {});
    const text = result.content[0].text;

    expect(text).toContain("● 4 tasks (1 in progress, 3 open)");
    expect(text).toContain("◻ #1 Design the flux capacitor");
    expect(text).toContain("◼ #2 Acquiring plutonium");
    expect(text).toContain("◻ #3 Install flux capacitor in DeLorean › subtask of #1 › blocked by #1");
    expect(text).toContain("◻ #4 Test time travel at 88 mph › blocked by #2, #3");
    expect(text).not.toContain("[ACTIVE]");
    expect(text).not.toContain("[PENDING]");
    expect(text).not.toContain("[DONE");
    expect(text).not.toContain("🛠");
    expect(text).not.toContain("test:");
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

    expect(text).toContain("● 2 tasks (1 done, 1 open)");
    expect(text).toContain("✔ #2 Finished checklist item › subtask of #1");
    expect(text).not.toContain("[DONE");
    expect(text).not.toContain("🛠");
  });
});
