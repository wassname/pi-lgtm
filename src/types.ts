/**
 * types.ts — Type definitions for the task management system.
 *
 * Three kinds of items, all stored as Task:
 * - Goal: has done_criterion + failure_mode. Completes via TaskComplete with evidence.
 * - Subtask: has parentId. Just subject. Completes via TaskUpdate.
 * - Task: no parentId, no done_criterion. Plain checklist item. Completes via TaskUpdate.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
	id: string;
	subject: string;
	description?: string;
	done_criterion?: string;
	failure_mode?: string;
	parentId?: string;
	status: TaskStatus;
	progress_label?: string;
	metadata: Record<string, any>;
	blocks: string[];
	blockedBy: string[];
	createdAt: number;
	updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
	nextId: number;
	tasks: Task[];
}
