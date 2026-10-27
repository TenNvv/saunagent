import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RoomMessage, Task } from './types.js';

export type Memory = { id: string; taskId: string; taskName: string; summary: string; createdAt: string; session: string; messageCount: number };

/** Immutable checkpoints: commit memory before changing the live room/session. */
export class MemoryStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(directory: string) {
    const path = join(directory, 'memory.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL, taskName TEXT NOT NULL,
      summary TEXT NOT NULL, createdAt TEXT NOT NULL, session TEXT NOT NULL,
      messageCount INTEGER NOT NULL, messages TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS memories_task ON memories(taskId, createdAt);`);
  }
  save(task: Task, summary: string, messages: RoomMessage[]): Memory {
    if (!summary.trim()) throw new Error('History summary is empty; the task was not cleared.');
    const memory: Memory = { id: randomUUID(), taskId: task.id, taskName: task.name,
      summary, createdAt: new Date().toISOString(), session: task.memorySession ?? '', messageCount: messages.length };
    this.db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      memory.id, memory.taskId, memory.taskName, summary, memory.createdAt, memory.session, messages.length, JSON.stringify(messages));
    return memory;
  }
  list(taskId?: string): Memory[] {
    const columns = 'id, taskId, taskName, summary, createdAt, session, messageCount';
    return (taskId ? this.db.prepare(`SELECT ${columns} FROM memories WHERE taskId = ? ORDER BY createdAt DESC`).all(taskId)
      : this.db.prepare(`SELECT ${columns} FROM memories ORDER BY createdAt DESC`).all()) as Memory[];
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
