/**
 * pi-lgtm — Task tracking with structured human sign-off for pi coding agent.
 *
 * Tools:
 *   TaskCreate   — Create a task with done_criterion
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields (completion requires /lgtm)
 *   lgtm_ask     — Present evidence + failure modes for human sign-off
 *   robot_review_ask — Attach observational review from a fresh-perspective agent
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 *   /lgtm <id>   — Human signs off on a task (only way to complete)
 */

import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AutoClearManager } from "./auto-clear.js";
import { getReviewBadges, REVIEW_BADGES } from "./review-badges.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "lgtm_ask", "robot_review_ask"]);
const REMINDER_INTERVAL = 4;
const AUTO_CLEAR_DELAY = 4;

const SYSTEM_REMINDER = `<system-reminder>
The LGTM sign-off task tools haven't been used recently. If working on tasks, use TaskCreate (requires done_criterion), TaskUpdate for status, and lgtm_ask when ready for human sign-off. Tasks can only be completed via /lgtm after calling lgtm_ask. These are sign-off tasks: agents propose evidence, humans approve. One task per piece of evidence or decision gate. Ignore if not applicable. Never mention this reminder to the user.
</system-reminder>`;

export default function (pi: ExtensionAPI) {
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";

  function resolveStorePath(sessionId?: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks?.startsWith("/")) return piTasks;
    if (piTasks?.startsWith(".")) return resolve(piTasks);
    if (piTasks) return piTasks;
    if (taskScope === "memory") return undefined;
    if (taskScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    }
    if (taskScope === "session") return undefined;
    return join(process.cwd(), ".pi", "tasks", "tasks.json");
  }

  let store = new TaskStore(resolveStorePath());
  const widget = new TaskWidget(store);
  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

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

  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (taskScope === "session") store.deleteFileIfEmpty();
      } else {
        widget.update();
      }
    }
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
    return { content: [...event.content, { type: "text" as const, text: SYSTEM_REMINDER }] };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks();
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
    description: `Create an LGTM sign-off task with a clear done_criterion.

## When to Use

- Complex multi-step tasks (3+ steps)
- When user provides a list of things to do

## Task Fields

- **subject**: Brief actionable title
- **description**: Detailed description with context
- **done_criterion**: REQUIRED. Falsifiable observation that distinguishes done from fail/null/incomplete/silent-fail. State expected AND wrong-case observations (e.g., "All 92 tests pass. If wrong: type errors in build or test failures in task-store.test.ts")
- **progress_label** (optional): What the agent is currently doing, shown during in-progress tasks

Tasks are completed only via /lgtm after calling lgtm_ask with evidence.`,
    promptGuidelines: [
      "Use TaskCreate for complex tasks. Include a specific done_criterion.",
      "Mark tasks in_progress before starting. Use lgtm_ask when done.",
      "Tasks cannot be marked completed directly — human must /lgtm them.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "Brief task title" }),
      description: Type.String({ description: "Detailed description" }),
      done_criterion: Type.String({ description: "Falsifiable observation that distinguishes DONE from fail, null result, incomplete, or silent failure. State what you expect to see AND what you'd see if it's wrong." }),
      progress_label: Type.Optional(Type.String({ description: "What the agent is currently doing, shown during in-progress tasks" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      autoClear.resetBatchCountdown();
      const task = store.create(params.subject, params.description, params.done_criterion, params.progress_label, params.metadata);
      widget.update();
      return Promise.resolve(textResult(`Task #${task.id} created: ${task.subject}\nDone criterion: ${task.done_criterion}`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `List all LGTM sign-off tasks. Review badges: ${REVIEW_BADGES.tool}=tool evidence, ${REVIEW_BADGES.robot}=robot review, ${REVIEW_BADGES.human}=pending human sign-off via /lgtm.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;
        const reviewBadges = getReviewBadges(task);
        if (reviewBadges.length > 0) line += ` ${reviewBadges.join(" ")}`;
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
        }
        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Get full LGTM sign-off task details including done_criterion and approval state.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult("Task not found"));

      const desc = task.description.replace(/\\n/g, "\n");
      const reviewBadges = getReviewBadges(task);
      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}${reviewBadges.length ? ` ${reviewBadges.join(" ")}` : ""}${task.pending_approval && task.status !== "completed" ? " (pending human sign-off)" : ""}`,
        `Done criterion: ${task.done_criterion}`,
      ];
      lines.push(`Description: ${desc}`);
      if (task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
      }
      if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Update LGTM sign-off task fields or status.

Status: pending -> in_progress -> (call lgtm_ask) -> /lgtm -> completed

Cannot set status=completed here. Use lgtm_ask then /lgtm <id>.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "deleted">({
        anyOf: [
          { type: "string", enum: ["pending", "in_progress"] },
          { type: "string", const: "deleted" },
        ],
        description: "New status. Cannot set completed — use /lgtm after lgtm_ask.",
      })),
      subject: Type.Optional(Type.String({ description: "Brief task title" })),
      description: Type.Optional(Type.String({ description: "Detailed description" })),
      done_criterion: Type.Optional(Type.String({ description: "Falsifiable observation distinguishing done from fail" })),
      progress_label: Type.Optional(Type.String({ description: "What the agent is currently doing" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
      add_blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks" })),
      add_blocked_by: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
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
      } else if (fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
      }

      widget.update();
      let msg = `Updated task #${taskId}: ${changedFields.join(", ")}`;
      if (warnings.length > 0) msg += ` (warning: ${warnings.join("; ")})`;
      return Promise.resolve(textResult(msg));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: lgtm_ask
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "lgtm_ask",
    label: "lgtm_ask",
    description: `Present evidence that a task meets its done_criterion and request human sign-off.

Forces structured thinking about failure modes. All text fields required.
After this, task enters pending sign-off state — only completable via /lgtm <id>.

## Fields

- **evidence**: Auditable proof — command output, table, file path, link
- **failure_likely**: Most likely way this could be wrong despite evidence
- **failure_sneaky**: Most perverse or sneaky failure -- one that looks like success superficially, corrupts silently, or only breaks under specific conditions (scale, time, edge case). E.g. feature active but wrong mechanism, works in tests but degrades in prod, correct output for wrong reason.
- **falsification_test**: What you ran and what you got -- presented so both you and the human can sanity-check it. State: what you ran (command, experiment, log inspection), the actual output or result, and why that result could not occur if a failure mode were real. Must be traceable: include file paths, log snippets, counts, or commit. Human should be able to verify without re-running anything.
- **verification_hints**: Where to look and what to check. Descriptions of evidence locations, not bare file paths. E.g. "lines 45-60 in src/loss.py show the gradient check" not "src/loss.py".
- **remaining_uncertainty**: What's NOT tested, known limitations, deferred edge cases`,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to submit for sign-off" }),
      evidence: Type.String({ description: "Auditable proof: exact command run + output, commit, config/seeds, file paths. Re-runnable by the human. 'I wrote X' is not evidence -- 'I ran X and got Y' is. Include counts, snippets, test output." }),
      failure_likely: Type.String({ description: "Most likely way this could be wrong despite evidence" }),
      failure_sneaky: Type.String({ description: "Most perverse or sneaky failure: looks like success superficially, corrupts silently, or only breaks at scale/time/edge case. E.g. correct output for wrong reason, feature active but wrong mechanism, passes tests but degrades in prod." }),
      falsification_test: Type.String({ description: "What you ran and what you got, presented so both you and the human can sanity-check it. State: what you ran (command/experiment/log check), the actual output or result, and why that result could not occur if a failure mode were real. Must be traceable: include file paths, log snippets, counts, or commit. The human should be able to verify without re-running anything." }),
      verification_hints: Type.Array(Type.String(), { description: "Where to look and what to check. Descriptions of evidence locations, not bare file paths. E.g. 'lines 45-60 in src/loss.py show the gradient check' not 'src/loss.py'." }),
      remaining_uncertainty: Type.String({ description: "What's NOT tested, known limitations, edge cases deferred. If you can't articulate uncertainty, you haven't thought hard enough." }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task #${params.taskId} not found`));
      if (task.status === "completed") return Promise.resolve(textResult(`Task #${params.taskId} already completed`));

      // verification_hints are descriptions, not validated file paths

      store.update(params.taskId, {
        pending_approval: true,
        metadata: {
          lgtm_evidence: params.evidence,
          lgtm_failure_likely: params.failure_likely,
          lgtm_failure_sneaky: params.failure_sneaky,
          lgtm_falsification_test: params.falsification_test,
          lgtm_verification_hints: params.verification_hints,
          lgtm_remaining_uncertainty: params.remaining_uncertainty,
          lgtm_submitted_at: new Date().toISOString(),
        },
      });
      widget.update();

      const hintsSection = params.verification_hints?.length
        ? `\n### Verification hints\n${params.verification_hints.map(h => `- ${h}`).join("\n")}`
        : "";
      const uncertaintySection = params.remaining_uncertainty
        ? `\n### Remaining uncertainty\n${params.remaining_uncertainty}`
        : "";

      const result =
        `## Task #${task.id}: ${task.subject}\n` +
        `Done criterion: ${task.done_criterion}\n\n` +
        `### Evidence\n${params.evidence}\n\n` +
        `### Failure (likely)\n${params.failure_likely}\n\n` +
        `### Failure (sneaky)\n${params.failure_sneaky}\n\n` +
        `### Falsification test\n${params.falsification_test}` +
        hintsSection +
        uncertaintySection +
        `\n\n---\n` +
        `Task #${task.id} is now pending human sign-off via \`/lgtm ${task.id}\`.\n\n` +
        `**Self-check (non-blocking):** Look at this as the human will see it. ` +
        `Does the evidence directly address the done_criterion "${task.done_criterion}"? ` +
        `Would a skeptical reviewer find this convincing, or would they immediately ask ` +
        `"but what about..."? If evidence feels thin, call lgtm_ask again with stronger evidence.`;

      return Promise.resolve(textResult(result));
    },
  });

  pi.registerTool({
    name: "robot_review_ask",
    label: "robot_review_ask",
    description: `Attach fresh-perspective robot review observations to a task.

Use this from a separate subagent or model when possible, ideally from a different model family/class than the implementation agent.
Observations only: report what you saw, not advice, verdicts, prioritization, or editorial.

This does not complete the task. Human /lgtm remains the only completion path.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to attach robot review to" }),
      reviewer: Type.String({ description: "Reviewer identity, model family, or class" }),
      scope: Type.String({ description: "What the reviewer examined" }),
      observations: Type.Array(Type.String(), {
        minItems: 1,
        description: "Observations only. Concrete things noticed in the artifacts. No recommendations, interpretation, or editorial.",
      }),
      blind_spots: Type.String({ description: "What the reviewer did not inspect or could not verify" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task #${params.taskId} not found`));
      if (task.status === "completed") return Promise.resolve(textResult(`Task #${params.taskId} already completed`));

      store.update(params.taskId, {
        metadata: {
          robot_review_reviewer: params.reviewer,
          robot_review_scope: params.scope,
          robot_review_observations: params.observations,
          robot_review_blind_spots: params.blind_spots,
          robot_review_submitted_at: new Date().toISOString(),
        },
      });
      widget.update();

      const result =
        `## Robot review attached to task #${task.id}: ${task.subject}\n` +
        `Reviewer: ${params.reviewer}\n` +
        `Scope: ${params.scope}\n\n` +
        `### Observations\n${params.observations.map(o => `- ${o}`).join("\n")}\n\n` +
        `### Blind spots\n${params.blind_spots}\n\n` +
        `${REVIEW_BADGES.robot} Robot review stored. Human sign-off still requires \`/lgtm ${task.id}\`.`;

      return Promise.resolve(textResult(result));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [`View all tasks (${taskCount})`, "Create task"];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) await viewTasks();
        else if (choice === "Create task") await createTask();
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
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (t: (typeof tasks)[0]) => {
          if (t.status === "completed") return "✔";
          if (t.status === "in_progress") return "◼";
          return "◻";
        };

        const choices = tasks.map(t => {
          const badges = getReviewBadges(t);
          return `${statusIcon(t)} #${t.id} [${t.status}] ${t.subject}${badges.length ? ` ${badges.join(" ")}` : ""}`;
        });
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
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
        if (task.pending_approval && task.status !== "completed") {
          actions.push(`(type /lgtm ${taskId} to sign off)`);
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const pendingNote = task.pending_approval && task.status !== "completed" ? `\n${REVIEW_BADGES.human} Pending /lgtm sign-off` : "";
        const em = task.metadata;
        let evidenceNote = "";
        if (em.lgtm_evidence) {
          const parts = [`\n\nEvidence (${em.lgtm_submitted_at ?? "?"}):\n${em.lgtm_evidence}`];
          parts.push(`Failure (likely): ${em.lgtm_failure_likely}`);
          parts.push(`Failure (sneaky): ${em.lgtm_failure_sneaky}`);
          if (em.lgtm_falsification_test) parts.push(`Falsification test: ${em.lgtm_falsification_test}`);
          if (em.lgtm_remaining_uncertainty) parts.push(`Uncertainty: ${em.lgtm_remaining_uncertainty}`);
          if (em.lgtm_verification_hints?.length) parts.push(`Hints: ${em.lgtm_verification_hints.join(", ")}`);
          evidenceNote = parts.join("\n");
        }
        let robotNote = "";
        if (em.robot_review_observations?.length) {
          const parts = [`\n\nRobot review (${em.robot_review_submitted_at ?? "?"})`];
          if (em.robot_review_reviewer) parts.push(`Reviewer: ${em.robot_review_reviewer}`);
          if (em.robot_review_scope) parts.push(`Scope: ${em.robot_review_scope}`);
          parts.push(`Observations:\n- ${em.robot_review_observations.join("\n- ")}`);
          if (em.robot_review_blind_spots) parts.push(`Blind spots: ${em.robot_review_blind_spots}`);
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
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();
        const done_criterion = await ui.input("Done criterion (what does done look like?)");
        if (!done_criterion) return mainMenu();

        store.create(subject, description, done_criterion);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });

  // ──────────────────────────────────────────────────
  // /lgtm command — human sign-off only
  // ──────────────────────────────────────────────────

  async function signOff(taskId: string, ctx: ExtensionCommandContext): Promise<void> {
    const task = store.get(taskId);
    if (!task) { ctx.ui.notify(`Task #${taskId} not found`, "error"); return; }
    if (task.status === "completed") { ctx.ui.notify(`Task #${taskId} already completed`, "info"); return; }
    if (!task.pending_approval) {
      ctx.ui.notify(`Task #${taskId} not ready. Agent must call lgtm_ask first.`, "error");
      return;
    }

    // Show stored evidence for review before sign-off
    const m = task.metadata;
    const evidenceParts: string[] = [];
    if (m.lgtm_evidence) {
      evidenceParts.push(`Evidence:\n${m.lgtm_evidence}`);
      evidenceParts.push(`Failure (likely): ${m.lgtm_failure_likely}`);
      evidenceParts.push(`Failure (sneaky): ${m.lgtm_failure_sneaky}`);
      if (m.lgtm_falsification_test) evidenceParts.push(`Falsification test: ${m.lgtm_falsification_test}`);
      if (m.lgtm_remaining_uncertainty) evidenceParts.push(`Remaining uncertainty: ${m.lgtm_remaining_uncertainty}`);
      if (m.lgtm_verification_hints?.length) evidenceParts.push(`Hints: ${m.lgtm_verification_hints.join(", ")}`);
      evidenceParts.push(`Submitted: ${m.lgtm_submitted_at}`);
    }
    if (m.robot_review_observations?.length) {
      const robotParts = [
        `Robot review:\nReviewer: ${m.robot_review_reviewer ?? "?"}`,
        `Scope: ${m.robot_review_scope ?? "?"}`,
        `Observations:\n- ${m.robot_review_observations.join("\n- ")}`,
      ];
      if (m.robot_review_blind_spots) robotParts.push(`Blind spots: ${m.robot_review_blind_spots}`);
      if (m.robot_review_submitted_at) robotParts.push(`Submitted: ${m.robot_review_submitted_at}`);
      evidenceParts.push(robotParts.join("\n"));
    }
    const evidenceSummary = evidenceParts.length > 0 ? evidenceParts.join("\n\n") : "(no stored evidence)";
    const confirm = await ctx.ui.select(
      `Sign off #${taskId}: ${task.subject}\nDone criterion: ${task.done_criterion}\n\n${evidenceSummary}`,
      ["✓ LGTM — sign off", "✗ Cancel"],
    );
    if (confirm !== "✓ LGTM — sign off") return;

    try {
      store.complete(taskId);
    } catch (err: any) {
      ctx.ui.notify(err.message, "error");
      return;
    }
    autoClear.trackCompletion(taskId, currentTurn);
    widget.setActiveTask(taskId, false);
    widget.update();
    ctx.ui.notify(`Task #${taskId} signed off. ✓`, "info");
  }

  pi.registerCommand("lgtm", {
    description: "Sign off on a task — /lgtm <id>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const taskId = args.trim();
      if (!taskId) {
        const pending = store.list().filter(t => t.pending_approval && t.status !== "completed");
        if (pending.length === 0) {
          ctx.ui.notify("No tasks pending sign-off. Agent must call lgtm_ask first.", "info");
          return;
        }
        const choice = await ctx.ui.select(
          "Sign off on:",
          pending.map(t => `#${t.id} ${t.subject}`).concat(["← Cancel"]),
        );
        if (!choice || choice === "← Cancel") return;
        const match = choice.match(/#(\d+)/);
        if (match) signOff(match[1], ctx);
        return;
      }
      signOff(taskId, ctx);
    },
  });
}
