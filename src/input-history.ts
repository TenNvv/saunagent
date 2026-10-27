import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HistoryDraft {
  draft: string;
  cursor: number;
}

/** Submitted input, oldest first. Pass room.store.directory to the constructor. */
export class InputHistory {
  private readonly path: string;
  private items: string[] = [];
  private index: number | undefined;
  private savedDraft: HistoryDraft | undefined;

  constructor(private readonly directory: string) {
    this.path = join(directory, 'input-history.json');
    try {
      const stored: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (Array.isArray(stored)) {
        for (const text of stored) {
          if (typeof text === 'string' && text.trim() && this.items.at(-1) !== text) this.items.push(text);
        }
        this.items = this.items.slice(-100);
      }
    } catch {
      // Missing, unreadable and malformed history must not prevent room startup.
    }
  }

  get entries(): readonly string[] { return [...this.items]; }

  add(text: string): void {
    this.resetNavigation();
    if (!text.trim() || this.items.at(-1) === text) return;
    const entries = [...this.items, text].slice(-100);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // A fresh exclusive file ensures 0600 even if an older history was public.
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(entries, null, 2) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      this.items = entries;
      const directoryFd = openSync(this.directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally { rmSync(temporary, { force: true }); }
  }

  navigate(direction: -1 | 1, draft: string, cursor: number): HistoryDraft {
    if (!this.items.length) return { draft, cursor };
    if (this.index === undefined) {
      if (direction === 1) return { draft, cursor };
      this.savedDraft = { draft, cursor };
      this.index = this.items.length;
    }
    this.index = Math.max(0, this.index + direction);
    if (this.index >= this.items.length) {
      const restored = this.savedDraft!;
      this.resetNavigation();
      return restored;
    }
    const recalled = this.items[this.index]!;
    return { draft: recalled, cursor: recalled.length };
  }

  resetNavigation(): void {
    this.index = undefined;
    this.savedDraft = undefined;
  }
}
