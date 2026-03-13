# pi-chonky-tasks

A [pi](https://pi.dev) extension that brings **Claude Code-style task tracking and coordination** to pi. Track multi-step work with structured tasks, dependency management, and a persistent visual widget.

> **Status:** Early release.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/tintinweb/pi-tasks/raw/master/media/screenshot.png" />

https://github.com/user-attachments/assets/86b09bd1-6882-4b0c-be20-ea866dd44b6a



## Features

- **7 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute` — matching Claude Code's exact tool specs and descriptions
- **Persistent widget** — live task list above the editor with `✔`/`◼`/`◻` status icons, strikethrough for completed tasks, star spinner (`✳✽`) for active tasks with elapsed time and token counts
- **System-reminder injection** — periodic `<system-reminder>` nudges appended to tool results when task tools haven't been used recently (matches Claude Code's behavior)
- **Task state persistence** — current task state injected into system prompt on every agent loop, surviving context compaction
- **Prompt guidelines** — system prompt guidelines nudge the LLM to use task tools for complex work
- **Dependency management** — bidirectional `blocks`/`blockedBy` relationships with warnings for cycles, self-deps, and dangling references
- **Shared task lists** — multiple pi sessions can share a file-backed task list for agent team coordination
- **File locking** — concurrent access is safe when multiple sessions share a task list
- **Background process tracking** — track spawned processes with output buffering, blocking wait, and graceful stop
- **Subagent integration** — tasks with `agentType` can be executed as subagents via `TaskExecute` (requires [pi-chonky-subagents](https://github.com/tintinweb/pi-subagents)). Auto-cascade mode flows through the task DAG automatically when enabled.

## Install

```bash
pi install npm:@tintinweb/pi-tasks
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Widget

The extension renders a persistent widget above the editor:

```
● 4 tasks (1 done, 1 in progress, 2 open)
  ✔ Design the flux capacitor
  ✳ Acquiring plutonium… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ◻ Install flux capacitor in DeLorean › blocked by #1
  ◻ Test time travel at 88 mph › blocked by #2, #3
```

| Icon | Meaning |
|------|---------|
| `✔` | Completed (strikethrough + dim) |
| `◼` | In-progress (not actively executing) |
| `◻` | Pending |
| `✳`/`✽` | Animated star spinner — actively executing task (shows `activeForm` text, elapsed time, token counts) |

## Tools

### `TaskCreate`

Create a structured task. Used proactively for complex multi-step work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner (e.g., "Running tests") |
| `agentType` | string | no | Agent type for subagent execution (e.g., `"general-purpose"`, `"Explore"`) |
| `metadata` | object | no | Arbitrary key-value pairs |

```
→ Task #1 created successfully: Fix authentication bug
```

### `TaskList`

List all tasks with status, owner, and blocked-by info.

```
#1 [pending] Fix authentication bug
#2 [in_progress] Write unit tests (agent-1)
#3 [pending] Update docs [blocked by #1, #2]
```

Sort order: pending first, then in-progress, then completed (each group by ID).

### `TaskGet`

Get full details for a specific task.

```
Task #2: Write unit tests
Status: in_progress
Owner: agent-1
Description: Add tests for the auth module
Blocked by: #1
Blocks: #3
```

Shows owner (if set) and ALL dependency edges (including completed blockers) — raw data.

### `TaskUpdate`

Update task fields, status, metadata, and dependencies.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Agent name |
| `metadata` | object | Shallow merge (null values delete keys) |
| `addBlocks` | string[] | Task IDs this task blocks |
| `addBlockedBy` | string[] | Task IDs that block this task |

```
→ Updated task #1 status
→ Updated task #2 owner, status
→ Updated task #3 blocks
→ Updated task #3 blocks (warning: cycle: #3 and #1 block each other)
→ Updated task #1 deleted
```

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addBlocks: ["3"]` on task 1 also adds `blockedBy: ["1"]` to task 3.

### `TaskOutput`

Retrieve output from a background task process.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — | Task ID (required) |
| `block` | boolean | `true` | Wait for completion |
| `timeout` | number | `30000` | Max wait time in ms (max 600000) |

### `TaskStop`

Stop a running background task process. Sends SIGTERM, waits 5 seconds, then SIGKILL.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Task ID to stop |

### `TaskExecute`

Execute one or more tasks as background subagents. Requires [pi-chonky-subagents](https://github.com/tintinweb/pi-subagents).

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_ids` | string[] | Task IDs to execute (required) |
| `additional_context` | string | Extra context appended to each agent's prompt |
| `model` | string | Model override (e.g., `"sonnet"`, `"haiku"`) |
| `max_turns` | number | Max turns per agent |

Tasks must be `pending`, have `agentType` set, and all `blockedBy` dependencies `completed`. Each task spawns as an independent background subagent.

With **auto-cascade** enabled (via `/tasks` → Settings), completed tasks automatically trigger execution of their unblocked dependents — flowing through the DAG like a build system.

## Task Lifecycle

```
pending → in_progress → completed
                      → deleted (permanently removed)
```

Tasks are created as `pending`. Mark `in_progress` before starting work, `completed` when done. `deleted` removes entirely — IDs never reset.

## Dependency Management

- **Bidirectional edges:** `addBlocks`/`addBlockedBy` maintain both sides automatically
- **Dependency warnings:** cycles, self-dependencies, and references to non-existent tasks are stored but produce warnings in the tool response
- **Display-time filtering:** `TaskList` only shows non-completed blockers in `[blocked by ...]`
- **Raw data preserved:** `TaskGet` shows ALL edges, including completed blockers
- **Cleanup on deletion:** removing a task cleans up all edges pointing to it

## Shared Task Lists

Set `PI_TASK_LIST_ID` to enable file-backed storage for agent team coordination:

```bash
PI_TASK_LIST_ID=my-project pi
```

Tasks persist at `~/.pi/tasks/my-project.json`. Multiple sessions sharing the same ID read/write the same list with file locking (`.lock` files with stale-lock detection).

Without the env var, tasks are session-scoped (in-memory only).

## `/tasks` Command

Interactive menu:

```
Tasks
├─ View all tasks (4)
├─ Create task
├─ Settings
└─ Clear completed (1)
```

- **View all tasks** — select a task to see details and take actions (start, complete, delete)
- **Create task** — input prompts for subject and description
- **Settings** — toggle auto-cascade (auto-execute unblocked agent tasks on completion)
- **Clear completed** — remove all completed tasks

## Architecture

```
src/
├── index.ts            # Extension entry: 7 tools + /tasks command + widget + subagent integration
├── types.ts            # Task, TaskStatus, BackgroundProcess, SubagentBridge types
├── task-store.ts       # File-backed store with CRUD, dependencies, locking
├── process-tracker.ts  # Background process output buffering and stop
└── ui/
    └── task-widget.ts  # Persistent widget with status icons and spinner
```

## Future Work

- **Background Bash auto-task creation** — Claude Code auto-creates tasks when `Bash` runs with `run_in_background: true`. Pi's bash tool currently lacks a `run_in_background` parameter (only `command` + `timeout`), so there's nothing to hook into. Once pi adds background execution support to its bash tool, we can use the `tool_call` event to detect it and auto-create tasks via `TaskStore`/`ProcessTracker`.

## Development

```bash
npm install
npm run typecheck   # TypeScript validation
npm test            # Run unit tests (27 tests)
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
