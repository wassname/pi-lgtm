/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Task, TaskStatus, TaskStoreData } from "./types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 5s max

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) { unlinkSync(lockPath); continue; }
        } catch { /* ignore */ }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;
  private nextId = 1;
  private tasks = new Map<string, Task>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data: TaskStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const t of data.tasks) this.tasks.set(t.id, t);
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    if (!this.filePath) return;
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify({ nextId: this.nextId, tasks: Array.from(this.tasks.values()) }, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try { this.load(); const result = fn(); this.save(); return result; }
    finally { releaseLock(this.lockPath); }
  }

  create(subject: string, description: string, done_criterion: string, progress_label?: string, metadata?: Record<string, any>): Task {
    return this.withLock(() => {
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject, description, done_criterion,
        pending_approval: false,
        status: "pending",
        progress_label,
        metadata: metadata ?? {},
        blocks: [], blockedBy: [],
        createdAt: now, updatedAt: now,
      };
      this.tasks.set(task.id, task);
      return task;
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  list(): Task[] {
    if (this.filePath) this.load();
    return Array.from(this.tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  update(id: string, fields: {
    status?: Exclude<TaskStatus, "completed"> | "deleted";
    subject?: string;
    description?: string;
    done_criterion?: string;
    pending_approval?: boolean;
    progress_label?: string;
    metadata?: Record<string, any>;
    add_blocks?: string[];
    add_blocked_by?: string[];
  }): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [], warnings: [] };

      const changedFields: string[] = [];
      const warnings: string[] = [];

      if ((fields.status as string) === "completed") {
        throw new Error(`Use /lgtm ${id} to complete tasks. Call lgtm_ask first to submit evidence.`);
      }

      if (fields.status === "deleted") {
        this.tasks.delete(id);
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => bid !== id);
          t.blockedBy = t.blockedBy.filter(bid => bid !== id);
        }
        return { task: undefined, changedFields: ["deleted"], warnings: [] };
      }

      if (fields.status !== undefined) { task.status = fields.status as TaskStatus; changedFields.push("status"); }
      if (fields.subject !== undefined) { task.subject = fields.subject; changedFields.push("subject"); }
      if (fields.description !== undefined) { task.description = fields.description; changedFields.push("description"); }
      if (fields.done_criterion !== undefined) { task.done_criterion = fields.done_criterion; changedFields.push("done_criterion"); }
      if (fields.pending_approval !== undefined) { task.pending_approval = fields.pending_approval; changedFields.push("pending_approval"); }
      if (fields.progress_label !== undefined) { task.progress_label = fields.progress_label; changedFields.push("progress_label"); }

      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) delete task.metadata[key];
          else task.metadata[key] = value;
        }
        changedFields.push("metadata");
      }

      if (fields.add_blocks?.length) {
        for (const targetId of fields.add_blocks) {
          if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
          const target = this.tasks.get(targetId);
          if (target && !target.blockedBy.includes(id)) { target.blockedBy.push(id); target.updatedAt = Date.now(); }
          if (targetId === id) warnings.push(`#${id} blocks itself`);
          else if (!target) warnings.push(`#${targetId} does not exist`);
          else if (target.blocks.includes(id)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
        }
        changedFields.push("blocks");
      }

      if (fields.add_blocked_by?.length) {
        for (const targetId of fields.add_blocked_by) {
          if (!task.blockedBy.includes(targetId)) task.blockedBy.push(targetId);
          const target = this.tasks.get(targetId);
          if (target && !target.blocks.includes(id)) { target.blocks.push(id); target.updatedAt = Date.now(); }
          if (targetId === id) warnings.push(`#${id} blocks itself`);
          else if (!target) warnings.push(`#${targetId} does not exist`);
          else if (task.blocks.includes(targetId)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
        }
        changedFields.push("blockedBy");
      }

      task.updatedAt = Date.now();
      return { task, changedFields, warnings };
    });
  }

  /** Complete a task. Called only by /lgtm -- requires pending_approval=true. */
  complete(id: string): Task {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task) throw new Error(`Task #${id} not found`);
      if (task.status === "completed") throw new Error(`Task #${id} already completed`);
      if (!task.pending_approval) throw new Error(`Task #${id} not ready. Agent must call lgtm_ask first.`);
      task.status = "completed";
      task.updatedAt = Date.now();
      return task;
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
      this.tasks.delete(id);
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => bid !== id);
        t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      }
      return true;
    });
  }

  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.tasks.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }

  clearCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === "completed") { this.tasks.delete(id); count++; }
      }
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => validIds.has(bid));
          t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
        }
      }
      return count;
    });
  }
}
