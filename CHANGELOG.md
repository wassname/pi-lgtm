# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-12

### Added
- **`TaskExecute` tool** — execute tasks as background subagents via pi-chonky-subagents. Tasks with `agentType` metadata are spawned as independent agents; validates status, dependencies, and agent type before launching.
- **`agentType` parameter on `TaskCreate`** — opt-in field (e.g., `"general-purpose"`, `"Explore"`) that marks tasks for subagent execution.
- **Auto-cascade** — when enabled via `/tasks` → Settings, completed agent tasks automatically trigger execution of their unblocked dependents, flowing through the task DAG like a build system. Off by default.
- **Subagent completion listener** — listens to `subagents:completed` and `subagents:failed` events to automatically update task status. Failed tasks revert to `pending` with error stored in metadata.
- **READY tags in system prompt** — pending tasks with `agentType` and all dependencies completed are marked `[READY — use TaskExecute to start]` in the system prompt.
- **Agent ID in widget** — in-progress tasks backed by subagents show the agent ID (e.g., `✳ Writing tests (agent abc12)…`).
- **Settings menu** — `/tasks` → Settings → toggle "Auto-execute tasks with agents".
- **`SubagentBridge` type** — typed interface for the cross-extension Symbol.for bridge.

### Changed
- `pi-chonky-subagents` global registry now exposes `spawn()` and `getRecord()` in addition to `waitForAll()` and `hasRunning()`.
- `pi-chonky-subagents` emits lifecycle events on `pi.events`: `subagents:created`, `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:steered`.
- `AgentManager` accepts an optional `onStart` callback, fired when an agent transitions to running (including from queue).

## [0.1.0] - 2026-03-12

Initial release — Claude Code-style task tracking and coordination for pi.

### Added
- **6 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop` — matching Claude Code's exact tool specs, descriptions, and schemas.
- **System-reminder injection** — periodic `<system-reminder>` nudges appended to non-task tool results when tasks exist but task tools haven't been used for 4+ turns. Matches Claude Code's host-level reminder mechanism.
- **Prompt guidelines** — `promptGuidelines` on TaskCreate injects persistent guidance into the system prompt, nudging the LLM to use task tools for complex work.
- **Task state in system prompt** — `before_agent_start` event appends current task state to the system prompt on every agent loop, ensuring task awareness survives context compaction.
- **Persistent widget** — live task list above editor with `✔` (completed, strikethrough + dim), `◼` (in-progress), `◻` (pending), animated star spinner (`✳✽`) for active tasks with elapsed time and token counts (e.g., `✳ Running tests… (2m 49s · ↑ 4.1k ↓ 1.2k)`).
- **Multiple parallel active tasks** — widget supports multiple simultaneous spinners.
- **`/tasks` command** — interactive menu: view tasks with actions (start, complete, delete), create tasks, clear completed.
- **Bidirectional dependency management** — `addBlocks`/`addBlockedBy` maintain both sides automatically. Edges cleaned up on task deletion.
- **Dependency warnings** — cycles, self-dependencies, and dangling references produce warnings in TaskUpdate responses. Edges are still stored, matching Claude Code's permissive behavior.
- **File-backed shared storage** — set `PI_TASK_LIST_ID` env var for multi-session coordination at `~/.pi/tasks/<id>.json`. File locking with stale-lock detection prevents race conditions.
- **In-memory session-scoped mode** — default when no env var is set, zero disk I/O.
- **Background process tracker** — output buffering (stdout + stderr), waiter notification, graceful stop with timeout escalation (SIGTERM → 5s → SIGKILL).
- **78 unit tests** — task store CRUD, dependencies, warnings, file persistence; widget rendering, icons, spinners, token/duration formatting; process tracker lifecycle.

[0.2.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.2.0
[0.1.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.1.0
