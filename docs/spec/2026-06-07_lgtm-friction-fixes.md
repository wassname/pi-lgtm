# LGTM friction fixes

## Goal
Fix the subset of reported LGTM-tool friction that seems clearly worth it now.

Specifically: make auto-review parse failures less opaque, let an accepted manual robot review reopen the human gate, show a compact current gate status, and make stored evidence easier to read during `/lgtm` review.

## Scope
In: parser/error handling for automatic robot review, manual review gate semantics, gate-status rendering, `/lgtm` evidence formatting, focused tests, README updates.
Out: evidence path attachments, supersede operations, schema redesign for commands/log artifacts, new completion-mode field, full state-machine overhaul.

## Requirements
- R1: Automatic robot review failures are diagnosable. Done means: parse errors include raw-output context and tolerate common wrapper noise around the JSON object. VERIFY: `npm test -- test/robot-review-runner.test.ts` shows parser fallback tests passing. If silent failure remained, the new malformed-output tests would still throw opaque errors.
- R2: Accepted manual robot review can reopen human sign-off after a failed auto review. Done means: storing an accepted manual review can set `pending_approval=true` when LGTM evidence exists. VERIFY: focused test covers this transition. If broken, the task would stay blocked after accepted manual review.
- R3: Task details expose current gate status in one short line. Done means: a helper summarizes states like ready, blocked on rejected review, or blocked on reviewer failure. VERIFY: focused tests assert representative summaries. If broken, TaskGet output would still require reading raw metadata to infer gate state.
- R4: `/lgtm` review output is easier to scan. Done means: evidence and falsification output are rendered in explicit markdown sections/code fences instead of one flat blob. VERIFY: source shows sectioned formatter used by `/lgtm`. If broken, the old unstructured evidence block remains.

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

## Context
- Keep fail-fast simplicity. Do not add a large state-machine rewrite.
- Preserve the human `/lgtm` override path.
- Manual review should not complete tasks, only reopen the human gate when it accepts existing evidence.

## Log
- 2026-06-07: User explicitly said not to fix everything, only the subset that makes sense. Chosen fixes are 1, 2, 10, plus `/lgtm` evidence readability because it is low-cost and directly reported.
- 2026-06-07: Implemented best-effort JSON extraction from noisy marker blocks, persisted automatic-review failure context in task metadata, reopened `pending_approval` when any accepted review validates stored evidence, added `Gate status:` summaries, and reformatted human review output into explicit sections/code fences.
- 2026-06-07: Verification passed with `npm test`, `npm run typecheck`, and `npm run lint`.

## TODO
- Evidence-path attachments may be worth adding later if pasted blobs remain too awkward.
- Superseded-evidence support probably wants explicit iteration objects, not another metadata flag.

## Errors
| Task | Error | Resolution |
|------|-------|------------|
