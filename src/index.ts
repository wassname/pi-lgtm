/**
 * pi-lgtm — Task tracking with structured human sign-off for pi coding agent.
 *
 * Two-tier model:
 *   - Tasks: agent self-manages. Trivial bookkeeping completes via TaskUpdate.
 *   - LGTMs: significant claims. lgtm_ask submits evidence, robot review gates,
 *     human /lgtm completes.
 *
 * Tools:
 *   TaskCreate       — Create a task with done_criterion
 *   TaskList         — List tasks grouped by status
 *   TaskGet          — Get full task details
 *   TaskUpdate       — Update task fields/status (gated for tasks with lgtm evidence)
 *   lgtm_ask         — Present evidence + failure modes for human sign-off
 *   robot_review_ask — Attach observational review from a fresh-perspective agent
 *   robot_review_run — Re-run the automatic robot reviewer
 *
 * Commands:
 *   /tasks            — Interactive task management menu
 *   /lgtm <id...>     — Human signs off on one or more tasks
 *   /lgtm *           — Sign off all tasks awaiting human review with passing robot review
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AutoClearManager } from "./auto-clear.js";
import { type DisplayStatus, getDisplayStatus, getReviewBadges } from "./review-badges.js";
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
export const DEFAULT_ROBOT_REVIEW_TIMEOUT_MS = 120_000;

type CommandResult = { stdout: string; stderr: string; exitCode: number | null };

export function getPiInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const configured = env.PI_LGTM_PI_BIN?.trim();
  return { command: configured || "pi", args };
}

export function getRobotReviewTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PI_LGTM_ROBOT_REVIEW_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ROBOT_REVIEW_TIMEOUT_MS;
}

/**
 * Pick a reviewer model from a different provider than the current one.
 * Prefers cheap/fast models suitable for review tasks.
 * Returns undefined if no alternate provider is available (falls back to same model).
 */
export function pickAlternateReviewerModel(currentProviderId?: string): string | undefined {
  // Ordered by: cheap, fast, good enough for structured review
  const providerModels: Record<string, string> = {
    anthropic: "anthropic/claude-haiku-4-5",
    "github-copilot": "github-copilot/gemini-3-flash-preview",
    openrouter: "openrouter/google/gemini-2.5-flash",
  };
  const providers = Object.keys(providerModels);
  const current = currentProviderId ?? "";

  // Try a different provider first
  for (const p of providers) {
    if (p !== current) return providerModels[p];
  }
  // All same? Just return the first non-current
  return providers.length > 0 ? providerModels[providers[0]] : undefined;
}

function getAssistantTextFromPiEvent(event: any): string | undefined {
  if (event?.type !== "message_end" || event.message?.role !== "assistant" || !Array.isArray(event.message.content)) {
    return undefined;
  }
  const text = event.message.content.find((part: any) => part?.type === "text")?.text;
  return typeof text === "string" ? text : undefined;
}

export function extractFinalAssistantTextFromPiJsonl(output: string): string {
  let buffer = "";
  let finalAssistantText = "";
  const lines = output.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    buffer = line;
    try {
      const text = getAssistantTextFromPiEvent(JSON.parse(line));
      if (text) finalAssistantText = text;
      buffer = "";
    } catch {
      // ignore malformed line noise from the child process
    }
  }
  if (buffer.trim()) {
    try {
      const text = getAssistantTextFromPiEvent(JSON.parse(buffer));
      if (text) finalAssistantText = text;
    } catch {
      // ignore malformed trailing line
    }
  }
  return finalAssistantText;
}

export async function runRobotReviewCommand(
  invocation: { command: string; args: string[] },
  signal?: AbortSignal,
  timeoutMs = getRobotReviewTimeoutMs(),
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`Robot reviewer timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    child.stdout.on("data", (data) => stdoutChunks.push(data));
    child.stderr.on("data", (data) => stderrChunks.push(data));
    child.on("error", (err) => {
      clearTimeout(killTimer);
      finish(() => reject(err));
    });
    const onAbort = () => {
      clearTimeout(killTimer);
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (exitCode) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        finish(() => reject(new Error("aborted")));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      finish(() => resolve({
        stdout: extractFinalAssistantTextFromPiJsonl(stdout) || stdout,
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode,
      }));
    });
  });
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
  ];
  if (review.rubric) {
    const rubricLines = Object.entries(review.rubric).map(([key, val]) =>
      `  ${val.pass ? "PASS" : "FAIL"} ${key}: ${val.reason}`
    );
    parts.push(`Rubric:\n${rubricLines.join("\n")}`);
  }
  parts.push(
    `**Accepted: ${review.accepted ? "yes" : "no"}**`,
    `**Evidence complete: ${review.evidence_complete ? "yes" : "no"}**`,
    `**Evidence convincing: ${review.evidence_convincing ? "yes" : "no"}**`,
    `Observations:\n- ${review.observations.join("\n- ")}`,
  );
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
    "You are a VALIDATION reviewer, not a flaw-finder. Your job is to sanity-check that the evidence addresses the done criterion.",
    "Your role: validate and sanity-check. Comment and suggest, but the gate is only the rubric below.",
    "",
    "## Critical: Evidence must be verbatim",
    "",
    "Evidence should contain literal output — verbatim command output, exact log lines, markdown block quotes, table rows, URLs — not summaries or interpretations. If the evidence only says 'it worked' or 'returned 5 results' without showing the actual output, flag it under verification_hints_actionable or evidence_covers_done_criterion.",
    "A human must be able to verify the claim from the evidence alone, without re-running anything. Summaries are not evidence. Literal output is evidence.",
    "",
    "## Rubric (rate each item pass/fail)",
    "",
    "1. evidence_covers_done_criterion: Does the evidence directly address the stated done criterion? Evidence must be verbatim (literal output, not 'it worked').",
    "2. falsification_test_runnable: Is the falsification test concrete enough that someone could run it and get a yes/no result? Must include actual output, not just 'ran X and it worked'.",
    "3. failure_modes_addressed: Are the failure_likely and failure_sneaky plausibly the top failure modes? (Not: are there OTHER failure modes?)",
    "4. verification_hints_actionable: Can a human follow the verification hints to check the claim without re-running experiments? Hints must reference specific content (line ranges, output snippets, URLs), not bare paths or counts.",
    "",
    "Set evidence_complete=true only if items 1 and 2 pass.",
    "Set evidence_convincing=true only if items 1, 2, AND 4 pass.",
    "Set accepted=true only if ALL rubric items pass.",
    "",
    "Observations: report what you see, not what might be missing. Comments and suggestions go in observations.",
    "missing_evidence: ONLY items from the rubric that failed. Do NOT add new dimensions.",
    "",
    "Return exactly one JSON object between the markers ROBOT_REVIEW_JSON_START and ROBOT_REVIEW_JSON_END.",
    "JSON schema (reasoning before booleans — think first, then judge):",
    '{"reviewer":"string","scope":"string","rubric":{"evidence_covers_done_criterion":{"reason":"...","pass":true},"falsification_test_runnable":{"reason":"...","pass":true},"failure_modes_addressed":{"reason":"...","pass":true},"verification_hints_actionable":{"reason":"...","pass":true}},"observations":["string"],"blind_spots":"string","missing_evidence":["string"],"evidence_complete":true,"evidence_convincing":true,"accepted":true}',
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
    '{"reviewer":"...","scope":"...","rubric":{...},"observations":["..."],"blind_spots":"...","missing_evidence":["..."],"evidence_complete":true,"evidence_convincing":true,"accepted":true}',
    "ROBOT_REVIEW_JSON_END",
  ].join("\n");
}

async function runAutomaticRobotReview(
  task: any,
  signal?: AbortSignal,
  currentProviderId?: string,
): Promise<{ review: Omit<RobotReviewRecord, "iteration">; command: string }> {
  const prompt = buildRobotReviewPrompt(task);
  const args = ["--mode", "json", "-p", "--no-session", "--no-tools", "--no-extensions"];
  const reviewerModel = process.env.PI_LGTM_ROBOT_REVIEW_MODEL?.trim() || pickAlternateReviewerModel(currentProviderId);
  if (reviewerModel) args.push("--model", reviewerModel);
  args.push(prompt);
  const invocation = getPiInvocation(args);
  const timeoutMs = getRobotReviewTimeoutMs();
  const commandLabel = `${invocation.command} ${invocation.args.slice(0, reviewerModel ? 6 : 4).join(" ")}`;
  const result = await runRobotReviewCommand(invocation, signal, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`Robot reviewer failed (${result.exitCode ?? "?"}): ${(result.stderr || result.stdout).trim()}`);
  }
  const parsed = extractRobotReviewJson(result.stdout);
  const observations = Array.isArray(parsed.observations) ? parsed.observations.filter((item): item is string => typeof item === "string") : [];
  if (observations.length === 0) throw new Error("Robot reviewer returned no observations.");
  const rawMissing: string[] = Array.isArray(parsed.missing_evidence)
    ? parsed.missing_evidence.filter((item): item is string => typeof item === "string")
    : [];
  const missing_evidence = rawMissing;
  // Extract rubric with per-item reasoning
  let rubric: Record<string, { reason: string; pass: boolean }> | undefined;
  if (parsed.rubric && typeof parsed.rubric === "object") {
    const r: Record<string, { reason: string; pass: boolean }> = {};
    for (const [key, val] of Object.entries(parsed.rubric as Record<string, unknown>)) {
      if (val && typeof val === "object" && "reason" in (val as any) && "pass" in (val as any)) {
        const v = val as { reason: unknown; pass: unknown };
        r[key] = { reason: typeof v.reason === "string" ? v.reason : "", pass: v.pass === true };
      }
    }
    if (Object.keys(r).length > 0) rubric = r;
  }
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
      rubric,
    },
  };
}

const SYSTEM_REMINDER = `<system-reminder>
Task tools haven't been used recently. Check the task list and keep it accurate:
- Mark tasks in_progress when you start them (TaskUpdate status=in_progress).
- Complete trivial subtasks directly: TaskUpdate(status=completed). Drop irrelevant ones with status=deleted.
- For significant claims with uncertainty (a feature, an experiment result, run-until-X), call lgtm_ask with evidence — that triggers robot review and a human /lgtm gate.
A stale list is worse than no list. Ignore this reminder if not applicable. Never mention it to the user.
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
  let currentProvider: string | undefined;

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn++;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    const model = ctx.model;
    if (model) currentProvider = (model as any).providerId ?? (model as any).provider;
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
    description: `Create a task with a clear done_criterion.

## Two tiers

- **Tasks**: agent-managed. Trivial bookkeeping (e.g. "monitor pueue 30") can be completed directly via TaskUpdate(status=completed). Subtasks lead up to verification.
- **LGTMs**: for significant claims with uncertainty (implement a feature, run-until-X). Call lgtm_ask with evidence — that triggers robot review and routes completion through /lgtm.

## Task Fields

- **subject**: Brief actionable title
- **description**: Detailed description with context
- **done_criterion**: REQUIRED. Falsifiable observation that distinguishes done from fail/null/incomplete/silent-fail. State expected AND wrong-case observations (e.g., "All 92 tests pass. If wrong: type errors in build or test failures in task-store.test.ts")
- **progress_label** (optional): What the agent is currently doing, shown during in-progress tasks`,
    promptGuidelines: [
      "Use TaskCreate for complex tasks. Include a specific done_criterion.",
      "Mark tasks in_progress before starting. Complete trivial tasks via TaskUpdate; call lgtm_ask for significant claims, then human /lgtm.",
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
    description: `List all tasks grouped by status. Pipeline stages: [🛠🤖👀] = evidence→review→signoff (·=pending).`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      const renderTask = (task: typeof tasks[number]) => {
        let line = `  #${task.id} ${task.subject} ${getReviewBadges(task)}`;
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
        }
        return line;
      };

      const buckets: { label: string; status: DisplayStatus }[] = [
        { label: "Active", status: "in_progress" },
        { label: "Awaiting sign-off", status: "awaiting_signoff" },
        { label: "Pending", status: "pending" },
        { label: "Completed", status: "completed" },
      ];

      const sections: string[] = [];
      for (const { label, status } of buckets) {
        const inBucket = tasks
          .filter(t => getDisplayStatus(t) === status)
          .sort((a, b) => Number(a.id) - Number(b.id));
        if (inBucket.length === 0) continue;
        sections.push(`${label}:\n${inBucket.map(renderTask).join("\n")}`);
      }

      return Promise.resolve(textResult(sections.join("\n\n")));
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
      const robotReviews = getRobotReviews(task);
      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status} ${getReviewBadges(task)}${task.pending_approval && task.status !== "completed" ? " (pending human sign-off)" : ""}`,
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
    description: `Update task fields or status.

Two-tier model:
- Trivial bookkeeping tasks (e.g. "monitor pueue 30") can be marked completed directly here.
- Tasks that called lgtm_ask are gated: completion requires /lgtm <id>. Strengthen evidence and re-run lgtm_ask if the robot review rejected it.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        anyOf: [
          { type: "string", enum: ["pending", "in_progress", "completed"] },
          { type: "string", const: "deleted" },
        ],
        description: "New status. Setting completed is allowed for trivial tasks; tasks with lgtm evidence must complete via /lgtm.",
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
      } else if (fields.status === "completed") {
        widget.setActiveTask(taskId, false);
        autoClear.trackCompletion(taskId, currentTurn);
      } else if (fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
        warnings.push("Task deleted via agent tool. Use /tasks to confirm or undo. Deleting tasks without human sign-off is discouraged — tasks should be completed via /lgtm or explicitly dismissed by the user.");
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

## CRITICAL: Evidence must be verbatim

Do NOT summarize or interpret. Paste literal command output, exact log lines, markdown block quotes, table rows, URLs. 'I ran X and it worked' is not evidence — paste the actual output of X. A human must be able to verify from the evidence alone without re-running anything.

## Fields

- **evidence**: Verbatim auditable proof — literal output, not summaries
- **failure_likely**: Most likely way this could be wrong despite evidence
- **failure_sneaky**: Most perverse or sneaky failure -- one that looks like success superficially, corrupts silently, or only breaks under specific conditions (scale, time, edge case). E.g. feature active but wrong mechanism, works in tests but degrades in prod, correct output for wrong reason.
- **falsification_test**: What you ran and the literal output you got, with reasoning why that output disproves the failure mode
- **verification_hints**: Where to look and what to check, with specific content quoted (not bare paths or counts)
- **remaining_uncertainty**: What's NOT tested, known limitations, deferred edge cases`,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to submit for sign-off" }),
      evidence: Type.String({ description: "Verbatim auditable proof: literal command output, exact log lines, markdown block quotes, table rows, URLs. NOT summaries or interpretations. 'I ran X and got Y' is not evidence -- paste the actual output of X. A human must verify from this alone without re-running. (One short paragraph is fine; verbatim matters more than length.)" }),
      failure_likely: Type.String({ description: "Most likely way this could be wrong despite evidence. One short sentence preferred — pick the top one, not a list." }),
      failure_sneaky: Type.String({ description: "Most perverse failure: looks like success superficially, corrupts silently, or only breaks at scale/time/edge case. One short sentence preferred." }),
      falsification_test: Type.String({ description: "What you ran and the literal output you got. Include verbatim command + output, not 'it worked'. State why that output could not occur if a failure mode were real. Brevity is fine; the verbatim output is what counts." }),
      verification_hints: Type.Array(Type.String(), { description: "Where to look, with specific content quoted (not bare paths or counts). E.g. 'src/loss.py:45-60 shows grad_norm=0.001'. One or two short hints is enough." }),
      remaining_uncertainty: Type.String({ description: "What's NOT tested, known limitations, deferred edges. One short sentence preferred. If you can't articulate uncertainty, you haven't thought hard enough." }),
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
        const { review, command } = await runAutomaticRobotReview(refreshedTask, signal, currentProvider);
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
          (review.rubric
            ? `Rubric:\n${Object.entries(review.rubric).map(([k, v]) => `- ${v.pass ? "PASS" : "FAIL"} ${k}: ${v.reason}`).join("\n")}\n`
            : "") +
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
Your role is VALIDATION, not flaw-finding. Sanity-check that the evidence addresses the done criterion. Comment and suggest, but the gate is only the rubric items.
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
        `🤖 Robot review stored. Human sign-off still requires \`/lgtm ${task.id}\`.`;

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

      const { review, command } = await runAutomaticRobotReview(task, signal, currentProvider);
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
        (review.rubric
          ? `### Rubric\n${Object.entries(review.rubric).map(([k, v]) => `- ${v.pass ? "PASS" : "FAIL"} ${k}: ${v.reason}`).join("\n")}\n\n`
          : "") +
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
          return `${statusIcon(t)} #${t.id} [${t.status}] ${t.subject} ${getReviewBadges(t)}`;
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

        const pendingNote = task.pending_approval && task.status !== "completed" ? `\n👀 Pending /lgtm sign-off` : "";
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

    // Print evidence to the conversation so the user can review it there
    const m = task.metadata;
    const evidenceParts: string[] = [];
    if (m.lgtm_evidence) {
      evidenceParts.push(`**Evidence:**\n${m.lgtm_evidence}`);
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
    if (evidenceParts.length > 0) {
      ctx.ui.notify(evidenceParts.join("\n\n"), "info");
    }
    const confirm = await ctx.ui.select(
      `Sign off #${taskId}: ${task.subject}\nDone: ${task.done_criterion}`,
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
    description: "Sign off on tasks — /lgtm <id> [<id> ...] or /lgtm * to sign off all pending",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (trimmed === "*") {
        // Sign off all pending tasks at once
        const pending = store.list().filter(t => t.pending_approval && t.status !== "completed" && latestRobotReviewPasses(t));
        if (pending.length === 0) {
          ctx.ui.notify("No tasks pending sign-off with passing robot review.", "info");
          return;
        }
        const choice = await ctx.ui.select(
          `Sign off ALL ${pending.length} pending tasks?`,
          pending.map(t => `#${t.id} ${t.subject}`).concat(["← Cancel"]),
        );
        if (!choice || choice === "← Cancel") return;
        for (const t of pending) {
          try {
            store.complete(t.id);
            autoClear.trackCompletion(t.id, currentTurn);
            widget.setActiveTask(t.id, false);
          } catch (err: any) {
            ctx.ui.notify(`Failed to sign off #${t.id}: ${err.message}`, "error");
          }
        }
        widget.update();
        ctx.ui.notify(`Signed off ${pending.length} tasks. ✓`, "info");
        return;
      }
      if (!trimmed) {
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
      // Accept one or more whitespace-separated IDs (also tolerate `#1` and commas).
      const ids = trimmed.split(/[\s,]+/).map(t => t.replace(/^#/, "")).filter(Boolean);
      if (ids.length === 1) {
        await signOff(ids[0], ctx);
        return;
      }
      const results: string[] = [];
      for (const id of ids) {
        const before = store.get(id);
        await signOff(id, ctx);
        const after = store.get(id);
        if (after?.status === "completed" && before?.status !== "completed") {
          results.push(`✓ #${id}`);
        } else {
          results.push(`✗ #${id}`);
        }
      }
      ctx.ui.notify(`Batch sign-off: ${results.join(", ")}`, "info");
    },
  });
}
