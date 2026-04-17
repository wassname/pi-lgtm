# Robot Review Lane

## Goal
Add a separate review artifact for fresh-perspective subagent review without weakening the existing human `/lgtm` sign-off gate.

## Scope
In: task schema, task tool UX, widget/task badges, README/tests, Pi-native robot-review harness hardening.
Out: provider routing or third-party subagent package integration.

## Requirements
- R1: Tasks can store a robot review separately from human sign-off evidence. Done means: a task can contain both `lgtm_ask` evidence and robot observations without conflict.
- R2: Robot review is observational only. Done means: the tool schema and help text ask for observations, not recommendations or editorial.
- R3: UI exposes review lanes distinctly. Done means: task list/widget/details show tool/robot/human review badges.
- R4: Human `/lgtm` remains the only completion path. Done means: no robot review path can complete tasks.
- R5: Automatic Pi robot review must be operationally robust. Done means: the child reviewer has a bounded timeout, uses a deterministic Pi invocation, and reports infra failures clearly enough to diagnose without hanging the main tool call.
- R6: The subprocess harness is covered by focused tests. Done means: there are tests for invocation selection, timeout/abort behavior, and assistant-output parsing.

## Tasks
- [x] T1 (R1, R2, R3, R4): Add robot-review storage and tool.
  - steps: update task typing helpers, register `robot_review_ask`, thread robot review metadata through task views
  - verify: `npm test -- --runInBand`
  - UAT: "when a task has lgtm evidence and robot observations, I observe both badges and `/lgtm` still controls completion"
- [x] T2 (R3): Update README and examples.
  - steps: document badges and robot review workflow
  - verify: `rg -n "robot_review_ask|🤖|🛠" README.md`
  - UAT: "when I read the README, I observe a distinct robot review lane"
- [x] T3 (R5): Harden the Pi-native robot-review subprocess runner.
  - steps: add timeout handling, replace fragile self-reinvocation logic with deterministic command resolution, improve failure messages
  - verify: `npx vitest run test/robot-review-runner.test.ts`
  - UAT: "when the child reviewer hangs or pi is not resolvable, lgtm_ask returns a bounded failure instead of hanging forever"
- [x] T4 (R6): Add focused harness tests.
  - steps: extract/mock subprocess runner boundaries and cover timeout, parse, and command resolution behavior
  - verify: `npx vitest run test/robot-review-runner.test.ts test/robot-review.test.ts`
  - UAT: "when I run the focused tests, I observe the subprocess path itself is covered"

## Context
- Existing schema uses `pending_approval` as the human sign-off gate.
- Current UI already appends `👀` for pending human sign-off; extend rather than replace the completion rule.

## Log
- The least disruptive model is additive metadata plus badge rendering, not replacing the task lifecycle.
- The repo's full Vitest suite already has drift unrelated to this feature, so focused verification is needed to isolate new behavior.
- A Pi-native reviewer stage matches the official subagent example better than ACP/external CLIs, but it makes harness reliability part of the approval path and therefore needs explicit timeout and invocation hardening.
- A deterministic `pi` command plus an explicit timeout is simpler and more portable than trying to reconstruct the current host entrypoint from `process.argv`.

## TODO
- Optional future work: add an orchestrated cross-model reviewer via `external-review` or ACP.

## Errors
| Task | Error | Resolution |
|------|-------|------------|
| T1 | `npm test` failed with 17 pre-existing assertions unrelated to robot review | Verified with `npm run lint`, `npm run typecheck`, and focused `npx vitest run test/review-badges.test.ts` instead |
| T3 | `process.argv[1]`-based self-reinvocation was fragile in extension-hosted contexts | Replaced with `PI_LGTM_PI_BIN` override or plain `pi`, then added focused runner tests |
