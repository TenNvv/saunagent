import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../src/store.js";
import { Room } from "../src/room.js";
import { PiEngine, taskSessionPath } from "../src/pi.js";
import { command } from "../src/commands.js";

test("clear commits SQLite memory, preserves old transcript, resets session and restores after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "saunagent-memory-"));
  let store = new RoomStore(dir);
  let engine = new PiEngine(store, true);
  let room = new Room(store, engine);
  try {
    await assert.rejects(command(room, "/clear"), /Select a task/);
    const task = room.createTask("历史总结");
    await room.send("保留历史目标", task.id);
    await room.waitForIdle();
    const result = await command(room, "/clear", task.id);
    assert.equal(result.selected, undefined);
    assert.equal(task.archived, true);
    assert.notEqual(task.status, "completed");
    assert.match(task.memorySummary!, /保留历史目标/);
    assert.equal(store.memory.list(task.id).length, 1);
    assert.ok(existsSync(taskSessionPath(dir, task.id)));
    await room.clear(task.id);
    assert.equal(store.memory.list().length, 1);
    await room.stop();
    store.release();
    store = new RoomStore(dir);
    engine = new PiEngine(store, true);
    room = new Room(store, engine);
    assert.equal(store.memory.list().length, 1);
    const restored = room.task(task.id);
    await room.send("新的指令", task.id);
    await room.waitForIdle();
    assert.equal(restored.archived, false);
    assert.match(restored.summary, /retained 1 user inputs/);
    assert.ok(
      existsSync(taskSessionPath(dir, task.id, restored.memorySession)),
    );
    await command(room, "/memory");
    assert.match(room.state.messages.at(-1)!.text, /保留历史目标/);
    await room.stop();
  } finally {
    await engine.close(true);
    store.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear skips pending work, and summary failure never archives or resets history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "saunagent-memory-"));
  const store = new RoomStore(dir);
  const engine = new PiEngine(store, true);
  const room = new Room(store, engine);
  try {
    const task = room.createTask("安全清理");
    store.message("user", "待处理", { taskId: task.id });
    task.status = "waiting";
    await assert.rejects(room.clear(task.id), /Only idle tasks/);
    await room.clear("all");
    assert.equal(store.memory.list().length, 0);
    task.status = "idle";
    engine.summarize = async () => {
      throw new Error("summary failed");
    };
    await assert.rejects(room.clear(task.id), /summary failed/);
    assert.equal(task.archived, false);
    assert.equal(task.memorySession, undefined);
    assert.equal(store.memory.list().length, 0);
    engine.summarize = async () => "";
    await assert.rejects(room.clear(task.id), /summary is empty/);
    assert.equal(task.archived, false);
  } finally {
    await engine.close(true);
    store.release();
    rmSync(dir, { recursive: true, force: true });
  }
});
