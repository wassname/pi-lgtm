# LGTM friction fixes

## Goal
Fix the subset of reported LGTM-tool friction that seems clearly worth it now.

First batch done: make auto-review parse failures less opaque, let an accepted manual robot review reopen the human gate, show a compact current gate status, and make stored evidence easier to read during `/lgtm` review.

Second batch: add structured command/artifact metadata, expose completion/review state more explicitly, and track superseded evidence iterations so stale claims stop polluting current review.

## Scope
In: parser/error handling for automatic robot review, manual review gate semantics, gate-status rendering, `/lgtm` evidence formatting, structured command/artifact metadata, evidence supersession/iterations, completion/review state summaries, focused tests, README updates.
Out: full schema/tool-calling reviewer redesign, giant workflow/state-machine rewrite, attachment upload plumbing beyond local path+hash metadata.

## Requirements
- R1: Automatic robot review failures are diagnosable. Done means: parse errors include raw-output context and tolerate common wrapper noise around the JSON object. VERIFY: `npm test -- test/robot-review-runner.test.ts` shows parser fallback tests passing. If silent failure remained, the new malformed-output tests would still throw opaque errors.
- R2: Accepted manual robot review can reopen human sign-off after a failed auto review. Done means: storing an accepted manual review can set `pending_approval=true` when LGTM evidence exists. VERIFY: focused test covers this transition. If broken, the task would stay blocked after accepted manual review.
- R3: Task details expose current gate status in one short line. Done means: a helper summarizes states like ready, blocked on rejected review, or blocked on reviewer failure. VERIFY: focused tests assert representative summaries. If broken, TaskGet output would still require reading raw metadata to infer gate state.
- R4: `/lgtm` review output is easier to scan. Done means: evidence and falsification output are rendered in explicit markdown sections/code fences instead of one flat blob. VERIFY: source shows sectioned formatter used by `/lgtm`. If broken, the old unstructured evidence block remains.
- R5: LGTM submissions can store first-class command/artifact metadata. Done means: `lgtm_ask` accepts structured commands and artifact paths, stores hashes for artifacts, and renders them in human-facing task views. VERIFY: focused tests assert artifact hashing/formatting and metadata retention. If broken, TaskGet or `/lgtm` cannot show the structured records.
- R6: Human-facing state is explicit, not inferred from raw booleans. Done means: TaskGet exposes completion mode plus a compact review-state line such as `reviewer_failed_to_run` or `superseded`. VERIFY: focused tests assert representative state strings. If broken, the output still requires reading metadata internals.
- R7: Old evidence can be superseded cleanly. Done means: there is an explicit supersede path and repeated `lgtm_ask` calls archive prior evidence into history with reasons, rather than overwriting silently. VERIFY: focused tests cover history growth and direct-completion staying blocked after supersede. If broken, stale evidence disappears or the agent can bypass `/lgtm` after superseding.

## Tasks
- [x] T1 (R1): Harden robot-review JSON extraction and error messages.
  - steps: add parser helpers; tolerate fenced/extra prose around a JSON object inside markers; include output snippet on failure
  - verify: `npm test -- test/robot-review-runner.test.ts`
  - success: parser tests pass, including noisy-marker cases
  - likely_fail: fallback never runs because markers are missing or parsing still uses raw `JSON.parse`
  - sneaky_fail: fallback grabs the wrong braces and accepts junk; targeted tests catch nested/noisy cases
  - UAT: "when robot review returns markers plus noise, I observe it still parses or at least shows the raw failure context"
- [x] T2 (R2,R3,R4): Fix gate semantics and human-facing formatting.
  - steps: add gate-status helper; use it in TaskGet and lgtm_ask result; let accepted manual review set pending approval when evidence exists; format `/lgtm` evidence sections
  - verify: `npm test -- test/robot-review.test.ts test/task-store.test.ts`
  - success: manual-review gating tests pass and task summaries expose gate status
  - likely_fail: accepted manual review still preserves old false gate state
  - sneaky_fail: gate summary says ready while latest review actually failed; summary tests catch mismatches
  - UAT: "when I inspect a task after review, I observe one clear gate-status line and readable evidence sections"
- [x] T3 (R1-R4): Update README for new semantics.
  - steps: mention accepted manual review reopening the gate, clearer TaskGet state, and structured `/lgtm` evidence display
  - verify: `rg -n "manual review|gate status|/lgtm" README.md`
  - success: README mentions the changed behavior
  - likely_fail: docs still imply only auto review can reopen approval
  - sneaky_fail: docs mention review generally but omit the new gate semantics
  - UAT: "when I read README, I can infer the new gate behavior without reading code"
- [x] T4 (R5,R6): Add structured command/artifact metadata and explicit review/completion state.
  - steps: extend `lgtm_ask` schema; hash artifact paths; add review-state and completion-mode helpers; render them in TaskGet and `/lgtm`
  - verify: `npm test -- test/review-badges.test.ts test/task-store.test.ts`
  - success: task details show completion mode, review state, commands, and artifact hashes
  - likely_fail: metadata is stored but never shown to the human
  - sneaky_fail: review state lies after supersede or reviewer failure; helper tests catch this
  - UAT: "when I inspect a reviewed task, I observe command/artifact records and one explicit review state"
- [x] T5 (R7): Add evidence history and supersede flow.
  - steps: archive current evidence before replacement; add explicit supersede tool/reason; keep direct completion blocked once a task enters LGTM mode
  - verify: `npm test -- test/task-store.test.ts test/robot-review.test.ts`
  - success: old evidence appears in history with reason and agent self-completion remains blocked
  - likely_fail: superseding clears current evidence and accidentally re-enables TaskUpdate(status=completed)
  - sneaky_fail: robot reviews from prior evidence leak into the new current evidence; focused tests catch iteration reset/history behavior
  - UAT: "when I replace or supersede evidence, I can still inspect the old claim and the new review starts fresh"
- [x] T6 (R5-R7): Update README for the second batch.
  - steps: document commands/artifacts, review/completion state, and supersede behavior
  - verify: `rg -n "commands|artifact|supersede|completion mode|review state" README.md`
  - success: README explains the new structured evidence workflow
  - likely_fail: docs mention artifacts but omit supersede semantics
  - sneaky_fail: docs imply a full reviewer-tool-calling redesign that does not exist
  - UAT: "when I read README, I understand how to attach artifacts and retire stale evidence"

## Context
- Keep fail-fast simplicity. Do not add a large state-machine rewrite.
- Preserve the human `/lgtm` override path.
- Manual review should not complete tasks, only reopen the human gate when it accepts existing evidence.

## Log
- 2026-06-07: User explicitly said not to fix everything, only the subset that makes sense. Chosen fixes are 1, 2, 10, plus `/lgtm` evidence readability because it is low-cost and directly reported.
- 2026-06-07: Implemented best-effort JSON extraction from noisy marker blocks, persisted automatic-review failure context in task metadata, reopened `pending_approval` when any accepted review validates stored evidence, added `Gate status:` summaries, and reformatted human review output into explicit sections/code fences.
- 2026-06-07: Verification passed with `npm test`, `npm run typecheck`, and `npm run lint`.
- 2026-06-07: Second batch added structured command/artifact metadata, explicit `completion mode` and `review state`, evidence history with supersede reasons, and a dedicated `lgtm_supersede` tool.
- 2026-06-07: Second-batch verification passed with `npm test -- test/review-badges.test.ts test/robot-review.test.ts test/task-store.test.ts`, then full `npm run lint && npm run typecheck && npm test`.

## TODO
- Full reviewer tool-calling/schema enforcement is still probably a separate refactor if parse brittleness returns.

## Errors
| Task | Error | Resolution |
|------|-------|------------|
