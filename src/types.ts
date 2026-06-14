/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
	id: string;
	subject: string;
	description: string;
	done_criterion: string; // required: what "done" looks like
	parentId?: string; // no parent = top-level goal, requires proof claim to complete
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
