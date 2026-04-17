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

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AutoClearManager } from "./auto-clear.js";
import { getReviewBadges, REVIEW_BADGES } from "./review-badges.js";
import {
  appendRobotReviewMetadata,
  getLatestRobotReview,
  getRobotReviews,
  latestRobotReviewPasses,
  type RobotReviewRecord,
} from "./robot-review.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "lgtm_ask", "robot_review_ask", "robot_review_run"]);
const REMINDER_INTERVAL = 4;
const AUTO_CLEAR_DELAY = 4;

type CommandResult = { stdout: string; stderr: string; exitCode: number | null };

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

function extractRobotReviewJson(output: string): Record<string, unknown> {
  const match = output.match(/ROBOT_REVIEW_JSON_START\s*([\s\S]*?)\s*ROBOT_REVIEW_JSON_END/);
  if (!match) throw new Error("Robot reviewer did not return the expected JSON markers.");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function formatRobotReview(review: RobotReviewRecord): string {
  const parts = [
    `Robot review #${review.iteration} (${review.submitted_at})`,
    `Reviewer: ${review.reviewer}${review.mode === "auto" ? " [auto]" : ""}`,
    `Scope: ${review.scope}`,
    `Accepted: ${review.accepted ? "yes" : "no"}`,
    `Evidence complete: ${review.evidence_complete ? "yes" : "no"}`,
    `Evidence convincing: ${review.evidence_convincing ? "yes" : "no"}`,
    `Observations:\n- ${review.observations.join("\n- ")}`,
  ];
  if (review.missing_evidence.length > 0) parts.push(`Missing evidence:\n- ${review.missing_evidence.join("\n- ")}`);
  if (review.blind_spots) parts.push(`Blind spots: ${review.blind_spots}`);
  return parts.join("\n");
}

function buildRobotReviewPrompt(task: any): string {
  const priorReviews = getRobotReviews(task);
  const priorSection = priorReviews.length > 0
    ? `\nPrevious robot reviews:\n${priorReviews.map(formatRobotReview).join("\n\n")}\n`
    : "\nPrevious robot reviews:\n(none)\n";
  return [
    "Review the task evidence with a fresh perspective.",
    "Observations should stay concrete and source-grounded.",
    "Set evidence_complete=false if the supplied evidence does not cover the claimed done criterion.",
    "Set evidence_convincing=false if the evidence exists but would not convince a skeptical reviewer.",
    "Return exactly one JSON object between the markers ROBOT_REVIEW_JSON_START and ROBOT_REVIEW_JSON_END.",
    "JSON schema:",
    '{"reviewer":"string","scope":"string","observations":["string"],"blind_spots":"string","accepted":true,"evidence_complete":true,"evidence_convincing":true,"missing_evidence":["string"]}',
    "",
    `Task #${task.id}: ${task.subject}`,
    `Done criterion: ${task.done_criterion}`,
    `Description: ${task.description}`,
    "",
    "Evidence package:",
    `Evidence: ${task.metadata?.lgtm_evidence ?? "(missing)"}`,
    `Failure likely: ${task.metadata?.lgtm_failure_likely ?? "(missing)"}`,
    `Failure sneaky: ${task.metadata?.lgtm_failure_sneaky ?? "(missing)"}`,
    `Falsification test: ${task.metadata?.lgtm_falsification_test ?? "(missing)"}`,
    `Verification hints: ${Array.isArray(task.metadata?.lgtm_verification_hints) ? task.metadata.lgtm_verification_hints.join(" | ") : "(missing)"}`,
    `Remaining uncertainty: ${task.metadata?.lgtm_remaining_uncertainty ?? "(missing)"}`,
    priorSection,
    "Output format:",
    "ROBOT_REVIEW_JSON_START",
    '{"reviewer":"...","scope":"...","observations":["..."],"blind_spots":"...","accepted":true,"evidence_complete":true,"evidence_convincing":true,"missing_evidence":["..."]}',
    "ROBOT_REVIEW_JSON_END",
  ].join("\n");
}

async function runAutomaticRobotReview(
  task: any,
  signal?: AbortSignal,
): Promise<{ review: Omit<RobotReviewRecord, "iteration">; command: string }> {
  const prompt = buildRobotReviewPrompt(task);
  const args = ["--mode", "json", "-p", "--no-session"];
  const reviewerModel = process.env.PI_LGTM_ROBOT_REVIEW_MODEL?.trim();
  if (reviewerModel) args.push("--model", reviewerModel);
  args.push(prompt);
  const invocation = getPiInvocation(args);
  const commandLabel = `${invocation.command} ${args.slice(0, reviewerModel ? 6 : 4).join(" ")}`;
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let buffer = "";
    let finalAssistantText = "";
    child.stdout.on("data", (data) => {
      stdoutChunks.push(data);
      buffer += data.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as any;
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const text = Array.isArray(event.message.content)
              ? event.message.content.find((part: any) => part.type === "text")?.text
              : undefined;
            if (typeof text === "string") finalAssistantText = text;
          }
        } catch {
          // ignore malformed line noise
        }
      }
    });
    child.stderr.on("data", (data) => stderrChunks.push(data));
    child.on("error", reject);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (exitCode) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as any;
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const text = Array.isArray(event.message.content)
              ? event.message.content.find((part: any) => part.type === "text")?.text
              : undefined;
            if (typeof text === "string") finalAssistantText = text;
          }
        } catch {
          // ignore malformed trailing line
        }
      }
      resolve({
        stdout: finalAssistantText || Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode,
      });
    });
  });
  if (result.exitCode !== 0) {
    throw new Error(`Robot reviewer failed (${result.exitCode ?? "?"}): ${(result.stderr || result.stdout).trim()}`);
  }
  const parsed = extractRobotReviewJson(result.stdout);
  const observations = Array.isArray(parsed.observations) ? parsed.observations.filter((item): item is string => typeof item === "string") : [];
  if (observations.length === 0) throw new Error("Robot reviewer returned no observations.");
  const missing_evidence = Array.isArray(parsed.missing_evidence)
    ? parsed.missing_evidence.filter((item): item is string => typeof item === "string")
    : [];
  return {
    command: commandLabel,
    review: {
      reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : commandLabel,
      scope: typeof parsed.scope === "string" ? parsed.scope : "task evidence package",
      observations,
      blind_spots: typeof parsed.blind_spots === "string" ? parsed.blind_spots : "not stated",
      accepted: typeof parsed.accepted === "boolean"
        ? parsed.accepted
        : parsed.evidence_complete === true && parsed.evidence_convincing === true,
      evidence_complete: parsed.evidence_complete === true,
      evidence_convincing: parsed.evidence_convincing === true,
      missing_evidence,
      submitted_at: new Date().toISOString(),
      mode: "auto",
      raw_output: result.stdout.trim(),
    },
  };
}

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

  pi.on("before_agent_start", async (event) => {
    const followups = store.list().flatMap(task => {
      const latest = getLatestRobotReview(task);
      return latest && !latest.accepted ? [{ task, latest }] : [];
    });
    if (followups.length === 0) return undefined;

    const reminder = followups.map(({ task, latest }) => {
      const missing = latest.missing_evidence.length > 0
        ? ` Missing evidence: ${latest.missing_evidence.join("; ")}.`
        : "";
      return `- Task #${task.id} ${task.subject}: latest robot review rejected the evidence.${missing} Strengthen the evidence, call lgtm_ask again, then rerun robot_review_run before asking for human sign-off.`;
    }).join("\n");

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n<system-reminder>\nLatest robot review follow-up required:\n${reminder}\nDo not ask for human sign-off until the latest robot review accepts the evidence.\n</system-reminder>\n`,
    };
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
      const robotReviews = getRobotReviews(task);
      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}${reviewBadges.length ? ` ${reviewBadges.join(" ")}` : ""}${task.pending_approval && task.status !== "completed" ? " (pending human sign-off)" : ""}`,
        `Done criterion: ${task.done_criterion}`,
      ];
      lines.push(`Description: ${desc}`);
      if (robotReviews.length > 0) {
        const latest = robotReviews[robotReviews.length - 1];
        lines.push(`Robot reviews: ${robotReviews.length} (latest: complete=${latest.evidence_complete ? "yes" : "no"}, convincing=${latest.evidence_convincing ? "yes" : "no"})`);
      }
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

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
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
      let robotReviewNote = "";
      const refreshedTask = store.get(params.taskId);
      if (!refreshedTask) return textResult(`Task #${params.taskId} not found after evidence update`);
      try {
        const { review, command } = await runAutomaticRobotReview(refreshedTask, signal);
        store.update(params.taskId, {
          pending_approval: review.accepted,
          metadata: appendRobotReviewMetadata(refreshedTask, review),
        });
        robotReviewNote =
          `\n\n### Automatic robot review\n` +
          `Reviewer: ${command}\n` +
          `Accepted: ${review.accepted ? "yes" : "no"}\n` +
          `Evidence complete: ${review.evidence_complete ? "yes" : "no"}\n` +
          `Evidence convincing: ${review.evidence_convincing ? "yes" : "no"}\n` +
          `${review.observations.map(o => `- ${o}`).join("\n")}`;
        if (review.missing_evidence.length > 0) {
          robotReviewNote += `\nMissing evidence:\n${review.missing_evidence.map(item => `- ${item}`).join("\n")}`;
        }
        if (!review.accepted) {
          robotReviewNote += `\nResult: human sign-off has been held back until the evidence is strengthened and reviewed again.`;
        }
      } catch (err: any) {
        store.update(params.taskId, { pending_approval: false });
        robotReviewNote =
          `\n\n### Automatic robot review\n` +
          `Reviewer failed: ${err.message}\n` +
          `Human sign-off is blocked until the reviewer stage succeeds.`;
      }
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
        robotReviewNote +
        `\n\n---\n` +
        `Task #${task.id} is now ${store.get(task.id)?.pending_approval ? `pending human sign-off via \`/lgtm ${task.id}\`` : "not yet ready for human sign-off"}.\n\n` +
        `**Self-check (non-blocking):** Look at this as the human will see it. ` +
        `Does the evidence directly address the done_criterion "${task.done_criterion}"? ` +
        `Would a skeptical reviewer find this convincing, or would they immediately ask ` +
        `"but what about..."? If evidence feels thin, call lgtm_ask again with stronger evidence.`;

      return textResult(result);
    },
  });

  pi.registerTool({
    name: "robot_review_ask",
    label: "robot_review_ask",
    description: `Attach fresh-perspective robot review observations to a task.

Use this from a separate subagent or model when possible, ideally from a different model family/class than the implementation agent.
Observations only: report what you saw, not advice or editorial. Structured gate fields record whether the evidence is complete and convincing enough to advance.

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
      evidence_complete: Type.Boolean({ description: "Whether the supplied evidence covers the claimed done criterion." }),
      evidence_convincing: Type.Boolean({ description: "Whether the supplied evidence would convince a skeptical reviewer." }),
      accepted: Type.Optional(Type.Boolean({ description: "Overall review decision. Defaults to evidence_complete && evidence_convincing." })),
      missing_evidence: Type.Optional(Type.Array(Type.String(), { description: "Concrete missing checks, artifacts, or observations needed before human sign-off." })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task #${params.taskId} not found`));
      if (task.status === "completed") return Promise.resolve(textResult(`Task #${params.taskId} already completed`));

      store.update(params.taskId, {
        pending_approval: params.evidence_complete && params.evidence_convincing ? task.pending_approval : false,
        metadata: {
          ...appendRobotReviewMetadata(task, {
            reviewer: params.reviewer,
            scope: params.scope,
            observations: params.observations,
            blind_spots: params.blind_spots,
            accepted: params.accepted ?? (params.evidence_complete && params.evidence_convincing),
            evidence_complete: params.evidence_complete,
            evidence_convincing: params.evidence_convincing,
            missing_evidence: params.missing_evidence ?? [],
            submitted_at: new Date().toISOString(),
            mode: "manual",
          }),
        },
      });
      widget.update();

      const result =
        `## Robot review attached to task #${task.id}: ${task.subject}\n` +
        `Iteration: ${getRobotReviews(store.get(params.taskId)!).length}\n` +
        `Reviewer: ${params.reviewer}\n` +
        `Scope: ${params.scope}\n\n` +
        `Accepted: ${(params.accepted ?? (params.evidence_complete && params.evidence_convincing)) ? "yes" : "no"}\n` +
        `Evidence complete: ${params.evidence_complete ? "yes" : "no"}\n` +
        `Evidence convincing: ${params.evidence_convincing ? "yes" : "no"}\n\n` +
        `### Observations\n${params.observations.map(o => `- ${o}`).join("\n")}\n\n` +
        `${(params.missing_evidence?.length ?? 0) > 0 ? `### Missing evidence\n${(params.missing_evidence ?? []).map(item => `- ${item}`).join("\n")}\n\n` : ""}` +
        `### Blind spots\n${params.blind_spots}\n\n` +
        `${REVIEW_BADGES.robot} Robot review stored. Human sign-off still requires \`/lgtm ${task.id}\`.`;

      return Promise.resolve(textResult(result));
    },
  });

  pi.registerTool({
    name: "robot_review_run",
    label: "robot_review_run",
    description: `Run the configured automatic robot reviewer against the current task evidence.

Runs the same Pi-native reviewer stage used automatically by \`lgtm_ask\`.

This appends a new robot-review iteration. If the reviewer marks evidence incomplete or unconvincing, pending human sign-off is cleared until stronger evidence is submitted and reviewed again.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to review" }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return textResult(`Task #${params.taskId} not found`);
      if (!task.metadata?.lgtm_evidence) {
        return textResult(`Task #${params.taskId} has no stored evidence yet. Call lgtm_ask first.`);
      }

      const { review, command } = await runAutomaticRobotReview(task, signal);
      store.update(params.taskId, {
        pending_approval: review.accepted ? task.pending_approval : false,
        metadata: appendRobotReviewMetadata(task, review),
      });
      widget.update();

      return textResult(
        `## Automatic robot review for task #${task.id}: ${task.subject}\n` +
        `Reviewer command: ${command}\n` +
        `Iteration: ${getRobotReviews(store.get(params.taskId)!).length}\n` +
        `Accepted: ${review.accepted ? "yes" : "no"}\n` +
        `Evidence complete: ${review.evidence_complete ? "yes" : "no"}\n` +
        `Evidence convincing: ${review.evidence_convincing ? "yes" : "no"}\n\n` +
        `### Observations\n${review.observations.map(o => `- ${o}`).join("\n")}\n\n` +
        `${review.missing_evidence.length > 0 ? `### Missing evidence\n${review.missing_evidence.map(item => `- ${item}`).join("\n")}\n\n` : ""}` +
        `### Blind spots\n${review.blind_spots}`,
      );
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
        const robotReviews = getRobotReviews(task);
        if (robotReviews.length > 0) {
          const latest = robotReviews[robotReviews.length - 1];
          const parts = [`\n\nRobot reviews: ${robotReviews.length}`];
          parts.push(formatRobotReview(latest));
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
    if (getRobotReviews(task).length > 0 && !latestRobotReviewPasses(task)) {
      ctx.ui.notify(`Task #${taskId} is blocked by the latest robot review. Strengthen evidence and rerun review first.`, "error");
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
    const robotReviews = getRobotReviews(task);
    if (robotReviews.length > 0) {
      evidenceParts.push(
        `Robot reviews (${robotReviews.length} total):\n${robotReviews.map(formatRobotReview).join("\n\n")}`,
      );
      if (!latestRobotReviewPasses(task)) {
        evidenceParts.push("Latest robot review says the evidence is not yet complete/convincing.");
      }
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
