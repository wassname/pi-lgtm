/**
 * Tests for task-subagent integration: TaskExecute tool, completion listener,
 * auto-cascade, and widget agent ID display.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type UICtx, type Theme } from "../src/ui/task-widget.js";
import type { SubagentBridge } from "../src/types.js";
import initExtension from "../src/index.js";

// ---- Mock pi ----

/** Minimal mock of ExtensionAPI with events, tool capture, and event hooks. */
function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    /** Execute a registered tool by name. */
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    /** Fire lifecycle event handlers (turn_start, tool_result, etc.) */
    async fireLifecycle(event: string, ...args: any[]) {
      for (const h of lifecycleHandlers.get(event) ?? []) {
        await h(...args);
      }
    },
    /** Emit an event on pi.events (simulates subagent extension). */
    emitEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
  };
}

/** Minimal mock ExtensionContext. */
function mockCtx() {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

// ---- Mock subagent bridge ----

function mockBridge(): SubagentBridge & { spawned: Array<{ type: string; prompt: string; options: any }> } {
  let idCounter = 0;
  const spawned: Array<{ id: string; type: string; prompt: string; options: any }> = [];

  return {
    spawned,
    waitForAll: async () => {},
    hasRunning: () => false,
    spawn(_pi: any, _ctx: any, type: string, prompt: string, options: any) {
      const id = `agent-${++idCounter}`;
      spawned.push({ id, type, prompt, options });
      return id;
    },
    getRecord(id: string) {
      return spawned.find(s => s.id === id) ? { id, status: "running" } : undefined;
    },
  };
}

/** Install/remove a mock bridge on the global registry. */
function installBridge(bridge: SubagentBridge) {
  const key = Symbol.for("pi-subagents:manager");
  (globalThis as any)[key] = bridge;
  return () => { delete (globalThis as any)[key]; };
}

// ---- Tests ----

describe("TaskExecute", () => {
  let mock: ReturnType<typeof mockPi>;
  let bridge: ReturnType<typeof mockBridge>;
  let removeBridge: () => void;

  beforeEach(() => {
    mock = mockPi();
    initExtension(mock.pi as any);
    bridge = mockBridge();
    removeBridge = installBridge(bridge);
  });

  afterEach(() => {
    removeBridge();
  });

  it("is registered as a tool", () => {
    expect(mock.tools.has("TaskExecute")).toBe(true);
  });

  it("returns error when subagent bridge is not loaded", async () => {
    removeBridge();
    // Create a task with agentType
    await mock.executeTool("TaskCreate", {
      subject: "Test task",
      description: "Do something",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("requires the pi-chonky-subagents extension");
  });

  it("rejects non-existent tasks", async () => {
    const result = await mock.executeTool("TaskExecute", { task_ids: ["999"] });
    expect(result.content[0].text).toContain("#999: not found");
  });

  it("rejects tasks without agentType", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "No agent type",
      description: "Plain task",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: no agentType set");
  });

  it("rejects non-pending tasks", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Already started",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: not pending");
  });

  it("rejects tasks with unresolved blockers", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Blocked",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("#2: blocked by #1");
  });

  it("spawns agent for valid task and updates metadata", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Run tests",
      description: "Run the test suite",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(result.content[0].text).toContain("#1 → agent agent-1");

    // Verify the bridge was called
    expect(bridge.spawned).toHaveLength(1);
    expect(bridge.spawned[0].type).toBe("general-purpose");
    expect(bridge.spawned[0].prompt).toContain("Run the test suite");
    expect(bridge.spawned[0].options.isBackground).toBe(true);
  });

  it("passes additional_context and max_turns to spawned agents", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Explore codebase",
      description: "Find all API endpoints",
      agentType: "Explore",
    });

    await mock.executeTool("TaskExecute", {
      task_ids: ["1"],
      additional_context: "Focus on REST endpoints only",
      max_turns: 10,
    });

    expect(bridge.spawned[0].prompt).toContain("Focus on REST endpoints only");
    expect(bridge.spawned[0].options.maxTurns).toBe(10);
  });

  it("allows executing tasks whose blockers are all completed", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Dependent",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
  });

  it("handles mixed valid and invalid tasks in one call", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Valid",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "No agent type",
      description: "Desc",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1", "2", "999"] });
    const text = result.content[0].text;
    expect(text).toContain("Launched 1 agent");
    expect(text).toContain("#2: no agentType set");
    expect(text).toContain("#999: not found");
  });
});

describe("Completion listener", () => {
  let mock: ReturnType<typeof mockPi>;
  let bridge: ReturnType<typeof mockBridge>;
  let removeBridge: () => void;

  beforeEach(() => {
    mock = mockPi();
    initExtension(mock.pi as any);
    bridge = mockBridge();
    removeBridge = installBridge(bridge);
  });

  afterEach(() => {
    removeBridge();
  });

  it("marks task completed on subagents:completed event", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Simulate agent completion
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
  });

  it("reverts task to pending on subagents:failed event", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Failing task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Simulate agent failure
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "Out of turns", status: "error" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("ignores events for unknown agent IDs", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Unrelated",
      description: "Desc",
    });

    // Should not throw or modify anything
    mock.emitEvent("subagents:completed", { id: "unknown-agent" });
    mock.emitEvent("subagents:failed", { id: "unknown-agent", error: "boom", status: "error" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });
});

describe("Auto-cascade", () => {
  let mock: ReturnType<typeof mockPi>;
  let bridge: ReturnType<typeof mockBridge>;
  let removeBridge: () => void;

  beforeEach(() => {
    mock = mockPi();
    initExtension(mock.pi as any);
    bridge = mockBridge();
    removeBridge = installBridge(bridge);
  });

  afterEach(() => {
    removeBridge();
  });

  /** Enable auto-cascade by toggling the setting via the /tasks command mock. */
  function enableAutoCascade() {
    // Auto-cascade is toggled via module-level state. Since we can't access it
    // directly, we test that WITHOUT enabling it, cascade doesn't happen,
    // and test the cascade logic indirectly via event flow.
    // For a proper toggle test we'd need to invoke the /tasks command handler,
    // but that requires a full UI mock. Instead we test the default (off) behavior.
  }

  it("does NOT cascade when auto-cascade is off (default)", async () => {
    // Create A → B chain
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    // Execute A
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(bridge.spawned).toHaveLength(1);

    // Complete A
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    // B should NOT have been auto-started
    expect(bridge.spawned).toHaveLength(1);

    // B should still be pending
    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("does NOT cascade on failure (branch stops)", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "crashed", status: "error" });

    // B should not start
    expect(bridge.spawned).toHaveLength(1);
    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("tasks without agentType are not cascaded even if unblocked", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Manual task",
      description: "Desc",
      // No agentType — manual
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    // Manual task should stay pending
    expect(bridge.spawned).toHaveLength(1);
  });
});

describe("System prompt READY tags", () => {
  it("marks unblocked agent-typed pending tasks as READY", async () => {
    // Capture return values from lifecycle handlers
    const lifecycleHandlers: Array<(...args: any[]) => any> = [];
    const mock = mockPi();
    const origOn = mock.pi.on.bind(mock.pi);
    mock.pi.on = ((event: string, handler: any) => {
      origOn(event, handler);
      if (event === "before_agent_start") lifecycleHandlers.push(handler);
    }) as any;

    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Ready task",
      description: "Desc",
      agentType: "general-purpose",
    });

    // Call the before_agent_start handler directly to get its return value
    const result = await lifecycleHandlers[0]({ systemPrompt: "base" });
    expect(result.systemPrompt).toContain("[READY — use TaskExecute to start]");
    expect(result.systemPrompt).toContain("Ready task");
  });

  it("does not mark blocked agent tasks as READY", async () => {
    const lifecycleHandlers: Array<(...args: any[]) => any> = [];
    const mock = mockPi();
    const origOn = mock.pi.on.bind(mock.pi);
    mock.pi.on = ((event: string, handler: any) => {
      origOn(event, handler);
      if (event === "before_agent_start") lifecycleHandlers.push(handler);
    }) as any;

    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Blocked task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await lifecycleHandlers[0]({ systemPrompt: "base" });
    // Task 1 should be READY, task 2 should NOT
    expect(result.systemPrompt).toContain("#1 [pending] Blocker [READY");
    expect(result.systemPrompt).not.toContain("#2 [pending] Blocked task [READY");
  });

  it("does not mark tasks without agentType as READY", async () => {
    const lifecycleHandlers: Array<(...args: any[]) => any> = [];
    const mock = mockPi();
    const origOn = mock.pi.on.bind(mock.pi);
    mock.pi.on = ((event: string, handler: any) => {
      origOn(event, handler);
      if (event === "before_agent_start") lifecycleHandlers.push(handler);
    }) as any;

    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Manual task",
      description: "Desc",
    });

    const result = await lifecycleHandlers[0]({ systemPrompt: "base" });
    expect(result.systemPrompt).not.toContain("READY");
  });
});

describe("Widget agent ID display", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  function mockUICtx() {
    const state = {
      widgets: new Map<string, any>(),
      statuses: new Map<string, string | undefined>(),
    };
    const ctx: UICtx = {
      setWidget(key, content, options) { state.widgets.set(key, { content, options }); },
      setStatus(key, text) { state.statuses.set(key, text); },
    };
    return { ctx, state };
  }

  function mockTheme(): Theme {
    return {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => `~~${text}~~`,
    };
  }

  function renderWidget(state: ReturnType<typeof mockUICtx>["state"]): string[] {
    const entry = state.widgets.get("tasks");
    if (!entry?.content) return [];
    const theme = mockTheme();
    const tui = { terminal: { columns: 200 } };
    return entry.content(tui, theme).render();
  }

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

  it("shows agent ID for active agent-backed tasks", () => {
    store.create("Agent task", "Desc", "Running tests", { agentType: "general-purpose", agentId: "abc1234567890" });
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent abc12");
    expect(lines[1]).toContain("Running tests");
  });

  it("shows agent ID for non-active in_progress agent-backed tasks", () => {
    store.create("Agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "xyz9876543210" });
    store.update("1", { status: "in_progress" });
    // NOT calling setActiveTask — simulates external agent management
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent xyz98");
    expect(lines[1]).toContain("Agent task");
  });

  it("does not show agent ID for tasks without agentId", () => {
    store.create("Manual task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent");
    expect(lines[1]).toContain("Manual task");
  });

  it("does not show agent ID for pending tasks", () => {
    store.create("Pending agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });

  it("does not show agent ID for completed tasks", () => {
    store.create("Done", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });
});
