// <cwd>/.pi/tasks-config.json — persists extension settings across sessions

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface TasksConfig {
	taskScope?: "memory" | "session" | "project"; // default: "session"
	autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete"; // default: "never"
	reminderInterval?: number; // turns without task tool use before reminder. default: 4
	clearDelayTurns?: number; // how many turns completed tasks linger. default: 4
}

const CONFIG_PATH = join(process.cwd(), ".pi", "tasks-config.json");

export function loadTasksConfig(): TasksConfig {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	} catch {
		return {};
	}
}
