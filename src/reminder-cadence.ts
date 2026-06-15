/**
 * reminder-cadence.ts — Pure cadence logic for system-reminder injection.
 *
 * When the agent hasn't used task tools for N turns, inject a reminder
 * to keep working toward active goals. Ported from pi-tasks.
 */

export interface CadenceState {
	currentTurn: number;
	lastTaskToolUseTurn: number;
	reminderInjectedThisCycle: boolean;
	reminderDue: boolean;
}

export interface CadenceConfig {
	reminderInterval: number;
	taskToolNames: ReadonlySet<string>;
}

export function createCadenceState(): CadenceState {
	return {
		currentTurn: 0,
		lastTaskToolUseTurn: 0,
		reminderInjectedThisCycle: false,
		reminderDue: false,
	};
}

export function resetCadenceState(state: CadenceState): void {
	state.currentTurn = 0;
	state.lastTaskToolUseTurn = 0;
	state.reminderInjectedThisCycle = false;
	state.reminderDue = false;
}

export function onTurnStart(state: CadenceState): void {
	state.currentTurn++;
}

export function evaluateToolResult(
	state: CadenceState,
	toolName: string,
	hasTasks: boolean,
	config: CadenceConfig,
): void {
	if (config.taskToolNames.has(toolName)) {
		state.lastTaskToolUseTurn = state.currentTurn;
		state.reminderInjectedThisCycle = false;
		state.reminderDue = false;
		return;
	}

	if (state.currentTurn - state.lastTaskToolUseTurn < config.reminderInterval) return;
	if (state.reminderInjectedThisCycle) return;
	if (!hasTasks) return;

	state.reminderDue = true;
}

export function drainReminderForContext(state: CadenceState): boolean {
	if (!state.reminderDue) return false;
	state.reminderDue = false;
	state.reminderInjectedThisCycle = true;
	state.lastTaskToolUseTurn = state.currentTurn;
	return true;
}
