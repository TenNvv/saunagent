import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { RoomStore } from "../src/store.js";
import { Room } from "../src/room.js";
import { command } from "../src/commands.js";
import type {
  Config,
  Delivery,
  Engine,
  RoomMessage,
  RoomState,
  RunResult,
  Task,
  Workspace,
} from "../src/types.js";

class ControlledEngine implements Engine {
  calls: {
    task: Task;
    message: RoomMessage;
    delivery: Delivery;
    resolve: (value: RunResult) => void;
    reject: (reason: Error) => void;
  }[] = [];
  route = async (_message: RoomMessage, _state: RoomState) => ({
    action: "new" as const,
    name: "Auto task",
  });
  run(task: Task, message: RoomMessage, delivery: Delivery) {
    return new Promise<RunResult>((resolve, reject) =>
      this.calls.push({ task, message, delivery, resolve, reject }),
    );
  }
  finish(index: number, text = "finished", answerKey = `answer-${index}`) {
    this.calls[index]!.resolve({ text, answerKey });
  }
  async pause(taskId: string) {
    this.calls
      .filter((c) => c.task.id === taskId)
      .forEach((c) => c.reject(new Error("paused")));
  }
  async close() {
    this.calls.forEach((c) => c.reject(new Error("closed")));
  }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "saunagent-room-"));
  const store = new RoomStore(directory);
  const engine = new ControlledEngine();
  const room = new Room(store, engine, directory);
  return {
    directory,
    store,
    engine,
    room,
    cleanup: () => {
      store.release();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const tick = () => delay(15);

test("forwards exact text, bypasses supervisor for mentions and replies, deduplicates answers", async () => {
  const f = fixture();
  try {
    const task = f.room.createTask("Player");
    const original = "  检查播放器\n先分析，别改代码。  ";
    await f.room.send(original, task.id);
    await tick();
    assert.equal(f.engine.calls[0]!.message.text, original);
    assert.equal(f.room.state.routes.length, 0);
    f.engine.finish(0);
    await f.room.waitForIdle();
    const replyTo = f.room.state.messages.find((m) => m.sender === task.id)!.id;
    await f.room.send("继续", undefined, replyTo);
    await tick();
    assert.equal(f.engine.calls[1]!.task.id, task.id);
    assert.equal(f.engine.calls[1]!.delivery.context.replyTo, replyTo);
    f.engine.finish(1, "finished", "answer-0");
    await f.room.waitForIdle();
    assert.equal(
      f.room.state.messages.filter((m) => m.sender === task.id).length,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test("limits tasks to three, serializes shared directories, allows other directories concurrently", async () => {
  const f = fixture();
  try {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      f.room.createTask(`Task ${i}`),
    );
    tasks[0]!.cwd = "/shared";
    tasks[1]!.cwd = "/shared";
    tasks[2]!.cwd = "/other";
    tasks[3]!.cwd = "/third";
    tasks[4]!.cwd = "/fourth";
    for (const task of tasks) await f.room.send(task.name, task.id);
    await tick();
    assert.equal(f.engine.calls.length, 3);
    assert.deepEqual(
      f.engine.calls.map((c) => c.task.id),
      [tasks[0]!.id, tasks[2]!.id, tasks[3]!.id],
    );
    f.engine.finish(0);
    await tick();
    assert.equal(f.engine.calls[3]!.task.id, tasks[1]!.id);
    f.engine.finish(1);
    await tick();
    assert.equal(f.engine.calls[4]!.task.id, tasks[4]!.id);
    f.engine.calls.forEach((_, i) => f.engine.finish(i));
    await f.room.waitForIdle();
  } finally {
    f.cleanup();
  }
});

test("follow-up queues, steer reaches a busy task, and a single answer is displayed once", async () => {
  const f = fixture();
  try {
    const task = f.room.createTask("Player");
    await f.room.send("first", task.id);
    await f.room.send("afterwards", task.id);
    await f.room.send("先停修改，先分析", task.id, undefined, "steer");
    await tick();
    assert.equal(f.engine.calls.length, 2);
    assert.equal(f.engine.calls[1]!.delivery.mode, "steer");
    f.engine.finish(0, "combined", "same");
    f.engine.finish(1, "combined", "same");
    await tick();
    assert.equal(f.engine.calls.length, 3);
    assert.equal(f.engine.calls[2]!.message.text, "afterwards");
    f.engine.finish(2);
    await f.room.waitForIdle();
    assert.equal(
      f.room.state.messages.filter((m) => m.answerKey === "same").length,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test("ambiguous routing stays undelivered, then assigns original message explicitly", async () => {
  const f = fixture();
  try {
    const task = f.room.createTask("Report");
    f.engine.route = async () =>
      ({ action: "clarify", question: "Which task?" }) as never;
    await f.room.send("按第二个做");
    assert.equal(f.engine.calls.length, 0);
    const original = f.room.state.messages[0]!;
    await f.room.assign(original.id, task.id);
    await tick();
    assert.equal(f.engine.calls[0]!.message.text, "按第二个做");
    f.engine.finish(0);
    await f.room.waitForIdle();
  } finally {
    f.cleanup();
  }
});

test("exit/reopen preserves queue, pauses all pending tasks, and resumes only selected task", async () => {
  const f = fixture();
  let second: RoomStore | undefined;
  try {
    const a = f.room.createTask("A");
    const b = f.room.createTask("B");
    await f.room.send("A original", a.id);
    await f.room.send("B original", b.id);
    await tick();
    await f.room.stop();
    f.store.release();
    second = new RoomStore(f.directory);
    const engine = new ControlledEngine();
    const room = new Room(second, engine);
    await tick();
    assert.equal(engine.calls.length, 0);
    assert.ok(room.state.tasks.every((task) => task.status === "paused"));
    room.resume(a.id);
    await tick();
    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0]!.message.text, "A original");
    assert.equal(room.task(b.id).status, "paused");
    engine.finish(0);
    await room.waitForIdle();
    await room.stop();
  } finally {
    second?.release();
    f.cleanup();
  }
});

test("correction stops original task and logs transfer without rewriting text", async () => {
  const f = fixture();
  try {
    const a = f.room.createTask("A");
    const b = f.room.createTask("B");
    await f.room.send("原始要求", a.id);
    await tick();
    const message = f.room.state.messages.find((m) => m.sender === "user")!;
    await f.room.assign(message.id, b.id);
    await tick();
    assert.equal(f.room.task(a.id).status, "paused");
    assert.equal(f.engine.calls[1]!.message.text, "原始要求");
    assert.equal(f.room.state.corrections[0]!.from, a.id);
    assert.equal(f.room.state.deliveries[0]!.status, "cancelled");
    f.engine.finish(1);
    await f.room.waitForIdle();
  } finally {
    f.cleanup();
  }
});

test("room lock prevents competing processes; completion is explicit user action", async () => {
  const f = fixture();
  try {
    assert.throws(() => new RoomStore(f.directory), /already open/);
    const task = f.room.createTask("A");
    await f.room.send("work", task.id);
    await tick();
    await assert.rejects(command(f.room, `/complete ${task.id}`), /Pause/);
    f.engine.finish(0);
    await f.room.waitForIdle();
    assert.equal(task.status, "idle");
    await command(f.room, `/complete ${task.id}`);
    assert.equal(task.status, "completed");
  } finally {
    f.cleanup();
  }
});

test("current directory is available without registration and a clarification preserves the original goal", async () => {
  const f = fixture();
  try {
    const snapshots: {
      config: Config;
      workspace?: Workspace;
      message: RoomMessage;
    }[] = [];
    f.engine.route = async (
      message: RoomMessage,
      _state: RoomState,
      config: Config,
      workspace?: Workspace,
    ) => {
      snapshots.push({ config, workspace, message });
      return snapshots.length === 1
        ? ({ action: "clarify", question: "哪个目录？" } as never)
        : ({
            action: "new",
            name: "查看项目",
            project: workspace!.project,
          } as never);
    };
    await f.room.send("查看项目的结构，不做修改");
    const original = f.room.state.messages.find(
      (message) => message.sender === "user",
    )!;
    await f.room.send("当前目录");
    await tick();
    assert.equal(snapshots[1]!.workspace!.cwd, f.directory);
    assert.ok(
      snapshots[1]!.config.projects.some(
        (project) => project.cwd === f.directory,
      ),
    );
    assert.equal(snapshots[1]!.message.replyTo, original.id);
    assert.deepEqual(
      f.engine.calls.map((call) => call.message.text),
      ["查看项目的结构，不做修改", "当前目录"],
    );
    assert.ok(f.engine.calls.every((call) => call.task.cwd === f.directory));
    assert.ok(f.room.state.routes.every((route) => route.status === "done"));
    assert.equal(
      f.store.config.projects.length,
      0,
      "implicit workspace need not be manually registered",
    );
    f.engine.calls.forEach((_, index) => f.engine.finish(index));
    await f.room.waitForIdle();
  } finally {
    f.cleanup();
  }
});

test("absolute paths are input, /project works without arguments, and slash commands with model paths remain commands", async () => {
  const f = fixture();
  try {
    await command(f.room, "/project");
    assert.match(f.room.state.messages.at(-1)!.text, new RegExp(f.directory));
    await command(f.room, "/model default openai/test-model");
    assert.equal(f.store.config.model.modelId, "test-model");
    await command(f.room, f.directory);
    await tick();
    assert.equal(f.engine.calls[0]!.message.text, f.directory);
    f.engine.finish(0);
    await f.room.waitForIdle();
  } finally {
    f.cleanup();
  }
});

test("reload preparation saves pending work; failed build restores the old room without starting tasks during suspension", async () => {
  const f = fixture();
  try {
    const a = f.room.createTask("A"),
      b = f.room.createTask("B"),
      completed = f.room.createTask("Done");
    completed.status = "completed";
    await f.room.send("A original", a.id);
    await f.room.send("B original", b.id);
    await tick();
    assert.equal(f.engine.calls.length, 1, "same directory queues B");
    await f.room.prepareReload();
    assert.equal(completed.status, "completed");
    assert.equal(f.engine.calls.length, 1);
    await assert.rejects(f.room.send("must not start"), /reloading/);
    f.room.cancelReload();
    await tick();
    assert.equal(f.engine.calls[1]!.message.text, "A original");
    f.engine.finish(1);
    await tick();
    assert.equal(f.engine.calls[2]!.message.text, "B original");
    f.engine.finish(2);
    await f.room.waitForIdle();
  } finally {
    f.cleanup();
  }
});
