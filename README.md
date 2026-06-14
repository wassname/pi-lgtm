# @wassname/pi-lgtm

Original ask:
> I would like a task list where
> 1) the top level tasks are goals and proof.
> 2) A create_goal that makes the agent think about "what are the most likely, subtle, failure modes and what cheap and easy to review evidence can distinguish between them and goal success".
> 3) A submit_proof form where a subagent provides independant sanity check of on the evidence before completing
> 4) - wassname

Help your agent track goals and aim for human sign off.

A [pi](https://pi.dev) extension that adds structured human sign-off to task tracking. Fork of [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) with a minimal LGTM layer.

The core idea: agents cannot mark tasks complete themselves. They must call `lgtm_ask` with auditable evidence and explicit failure-mode analysis, then a human signs off via `/lgtm <id>`.

Tasks can also carry a separate fresh-perspective robot review from a subagent or other model family. Robot reviews can iterate: if the latest review says the evidence is incomplete or unconvincing, human sign-off is held back until the agent strengthens the evidence and reruns review.

## Install

```bash
pi install npm:@wassname2/pi-lgtm
```

Or for development:

```bash
pi -e ./src/index.ts
```

![example](media/screenshot.png)
![alt text](img/README-1776381151332-image.png)

## What is different from pi-tasks

| pi-tasks | pi-lgtm |
|---|---|
| Agent calls `TaskUpdate { status: "completed" }` | Blocked -- throws error |
| No evidence required | `lgtm_ask` requires evidence, 2 failure modes, falsification test |
| Tasks complete immediately | Agent sets `pending_approval`, human runs `/lgtm <id>` |
| No done criterion | `done_criterion` required on create: falsifiable observation |

Stripped: `TaskExecute`, `TaskOutput`, `TaskStop`, `process-tracker.ts`, subagent RPC, settings menu.

## Widget

```
● 3 tasks (1 done, 1 in progress, 1 open)
  ✔ #1 Design schema
  ✳ #2 Implementing cache layer… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ◻ #3 Load test 🛠 🤖 👀
```

Badges:

- `🛠` tool evidence attached via `lgtm_ask`
- `🤖` one or more robot review iterations attached
- `👀` pending human sign-off via `/lgtm`

## Tools

### `TaskCreate`

```
subject, description, done_criterion (required), progress_label (optional)
```

`done_criterion` must be a falsifiable observation: what you expect to see AND what you would see if it is wrong. Example: `"All 92 tests pass. If wrong: type errors in build or failures in task-store.test.ts."`

### `TaskList`

Lists all tasks. `👀` indicates pending sign-off.

### `TaskGet`

Full task details including `done_criterion`, approval state, `completion mode`, `review state`, a one-line gate status such as `ready for human sign-off via /lgtm 5` or `blocked: automatic robot review failed: ...`, and evidence-iteration history.

### `TaskUpdate`

Update status (`pending | in_progress | deleted`), subject, description, done_criterion, dependencies. Cannot set `completed` -- use `/lgtm`.

### `lgtm_ask`

The epistemic gate. Required fields:

| Field | Description |
|---|---|
| `taskId` | Task to submit |
| `evidence` | Exact command run + output, commit hash, config/seeds, file paths. "I ran X and got Y" not "I wrote X". |
| `failure_likely` | Most likely way this is wrong despite evidence |
| `failure_sneaky` | Perverse/silent failure that looks like success superficially |
| `falsification_test` | What you ran and what you got, so both you and the human can sanity-check it. Why that result could not occur if a failure mode were real. |
| `verification_hints` | Where to look and what to check. These still force the agent to think, but weak hints are advisory rather than a hard block when the verbatim evidence already proves the claim. Core evidence still has to pass on its own. |
| `remaining_uncertainty` | What is NOT tested, deferred edge cases, known limitations |
| `commands` | Optional structured command records: `{ cmd, exit_code, stdout_path?, stderr_path? }` |
| `evidence_paths` / `falsification_paths` | Optional local artifact paths. Stored as absolute path + sha256 + byte size |
| `supersede_reason` | Optional reason when this replaces older evidence on the same task |

After calling this, the task shows `👀` and is only completable via `/lgtm <id>`. Evidence is stored on the task so the human can review it hours later without scrolling back. Re-submitting evidence archives the prior package into superseded history instead of silently overwriting it.

The tool result includes a non-blocking self-check prompt asking whether the evidence directly addresses the `done_criterion` and whether a skeptical reviewer would find it convincing.

`lgtm_ask` always runs the robot-review stage immediately after storing evidence. A robot review that rejects the evidence clears `pending_approval` until the evidence is strengthened and reviewed again. Weak verification hints are advisory if the core verbatim evidence already proves the done criterion. A reviewer crash, auth failure, timeout, or malformed output is recorded as a warning and leaves human sign-off open.

### `lgtm_supersede`

Explicitly retire the current evidence package without completing the task.

Use this when the claim changed or the prior evidence is stale. The tool archives the current evidence, current robot reviews, and reviewer-failure context into history with your reason, then closes the human gate until new evidence is submitted.

### `robot_review_ask`

Attach a fresh-perspective robot review to a task.

Required fields:

| Field | Description |
|---|---|
| `taskId` | Task to annotate |
| `reviewer` | Model/provider/family/class used for the review |
| `scope` | What the reviewer inspected |
| `observations` | Concrete observations only. No advice, verdicts, or editorial |
| `blind_spots` | What the reviewer did not inspect or could not verify |
| `accepted` | Overall accept/reject decision for whether the task is ready to advance |
| `evidence_complete` | Whether the supplied evidence actually covers the done criterion |
| `evidence_convincing` | Whether the supplied evidence would convince a skeptical reviewer |
| `missing_evidence` | Concrete missing checks or artifacts needed before human sign-off |

Use this from a separate subagent or other model when possible. Reviews append as iterations; the latest one is what gates human sign-off. If stored LGTM evidence already exists, an accepted manual review reopens the human sign-off gate.

### `robot_review_run`

Run the automatic robot reviewer against the current task evidence using the current session model.

Default reviewer stage:

```bash
pi --mode json -p --no-session --no-tools --no-extensions --model <current-session-model>
```

This appends a new robot-review iteration. The reviewer returns an explicit `accepted` boolean as well as detailed observations, blind spots, and missing evidence. If the latest robot review rejects the evidence, `/lgtm` is blocked until stronger evidence is submitted and reviewed again. If the reviewer process fails to run or returns malformed output, the failure is recorded but human sign-off stays open.

## Commands

### `/lgtm <id>`

Human-only sign-off. Shows stored evidence, falsification output, failure modes, review status, and remaining uncertainty in structured sections for review, then asks for confirmation. Without `<id>`, shows a list of pending-approval tasks.

### `/tasks`

Interactive menu: view tasks, create task, clear completed/all.

## Task lifecycle

```
pending -> in_progress -> (lgtm_ask)
                       -> current evidence iteration N
                       -> robot review iteration(s) on current evidence 🤖
                       -> pending_approval 👀   if latest robot review passes, or reviewer infra fails
                       -> reviewer_rejected
                       -> lgtm_supersede or newer lgtm_ask -> superseded history + fresh current evidence
                       -> (/lgtm) -> completed
                       -> deleted
```

## Storage

Controlled by `taskScope` in `.pi/tasks-config.json`:

| Mode | File | Behaviour |
|---|---|---|
| `memory` | none | In-memory, lost on session end |
| `session` (default) | `.pi/tasks/tasks-<sessionId>.json` | Per-session, survives resume |
| `project` | `.pi/tasks/tasks.json` | Shared across all sessions |

Override via env:

```bash
PI_TASKS=off          # in-memory (CI)
PI_TASKS=sprint-1     # named shared list at ~/.pi/tasks/sprint-1.json
PI_TASKS=/abs/path    # explicit path
PI_TASKS_DEBUG=1      # trace to stderr
```

## Architecture

```
src/
├── index.ts        # 8 tools + /tasks + /lgtm commands + widget + event handlers
├── review-badges.ts # Review badge helpers for tool/robot/human lanes
├── robot-review.ts # Robot review iteration storage + compatibility helpers
├── types.ts        # Task, TaskStatus types
├── task-store.ts   # File-backed store with CRUD, locking, complete() method
├── auto-clear.ts   # Turn-based auto-clearing of completed tasks
├── tasks-config.ts # Config persistence -> .pi/tasks-config.json
└── ui/
    └── task-widget.ts  # Widget with status icons, spinner, 👀 indicator
```

## Development

```bash
npm install
npm run typecheck
npm test            # 92 tests
npm run build
```

## License

MIT -- based on [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) (MIT)
