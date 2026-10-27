import { EventEmitter } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { id, now, RoomStore } from "./store.js";
import type {
  Delivery,
  Engine,
  Project,
  RoomMessage,
  RouteDecision,
  Task,
} from "./types.js";

export class Room extends EventEmitter {
  private running = new Map<string, Set<Promise<void>>>();
  private clearing = new Map<string, Promise<void>>();
  private enabled = new Set<string>();
  private routing: Promise<void> = Promise.resolve();
  private stopping = false;
  private routingCount = 0;
  private suspended = false;
  private reloadSnapshot?: {
    enabled: Set<string>;
    statuses: Map<string, Task["status"]>;
  };
  readonly cwd: string;
  private directories: Project[] = [];
  readonly logs = new Map<string, string[]>();
  constructor(
    readonly store: RoomStore,
    readonly engine: Engine,
    cwd = process.cwd(),
  ) {
    super();
    this.cwd = realpathSync(cwd);
    this.directoryProject(this.cwd);
  }
  get projects() {
    return [
      ...this.store.config.projects,
      ...this.directories.filter(
        (p) =>
          !this.store.config.projects.some(
            (existing) => existing.cwd === p.cwd,
          ),
      ),
    ];
  }
  get workspace() {
    return { cwd: this.cwd, project: this.directoryProject(this.cwd).name };
  }
  private directoryProject(cwd: string) {
    const existing = [...this.store.config.projects, ...this.directories].find(
      (project) => project.cwd === cwd,
    );
    if (existing) return existing;
    const base = basename(cwd) || "current";
    let name = base,
      suffix = 1;
    while (
      [...this.store.config.projects, ...this.directories].some(
        (project) => project.name === name,
      )
    )
      name = `${base}-${suffix++}`;
    const project = { name, cwd };
    this.directories.push(project);
    return project;
  }
  private directoryReference(text: string) {
    const value = text.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (
      value === "." ||
      /^(当前目录|当前工作目录|这里|current directory|cwd)[。.!！]?$/i.test(
        value,
      )
    )
      return this.directoryProject(this.cwd);
    if (!isAbsolute(value) && value !== ".." && !/^\.\.?\//.test(value))
      return undefined;
    try {
      const cwd = realpathSync(resolve(this.cwd, value));
      return statSync(cwd).isDirectory()
        ? this.directoryProject(cwd)
        : undefined;
    } catch {
      return undefined;
    }
  }
  get state() {
    return this.store.state;
  }
  changed() {
    this.store.save();
    this.emit("change");
  }
  log(taskId: string, text: string) {
    const lines = this.logs.get(taskId) ?? [];
    lines.push(text);
    if (lines.length > 300) lines.shift();
    this.logs.set(taskId, lines);
    this.emit("change");
  }
  task(selector: string) {
    const matches = this.state.tasks.filter(
      (t) => t.id === selector || t.name === selector,
    );
    if (matches.length !== 1)
      throw new Error(`Task not found or ambiguous: ${selector}`);
    return matches[0]!;
  }
  async send(
    text: string,
    target?: string,
    replyTo?: string,
    mode: Delivery["mode"] = "followUp",
  ) {
    if (this.stopping || this.suspended)
      throw new Error("Room is pausing or reloading.");
    if (!text.trim()) return;
    // Validate explicit references before adding a user message.
    const reply = replyTo
      ? this.state.messages.find((m) => m.id === replyTo)
      : undefined;
    if (replyTo && !reply) throw new Error(`Unknown message: ${replyTo}`);
    const explicit = target
      ? this.task(target)
      : reply?.taskId
        ? this.task(reply.taskId)
        : undefined;
    if (explicit && this.clearing.has(explicit.id))
      throw new Error(
        "Task history is being summarized. Please try again shortly.",
      );
    const directory = !explicit ? this.directoryReference(text) : undefined;
    const pending = this.state.routes.filter(
      (route) => route.status === "clarify",
    );
    const clarification =
      directory && !replyTo && pending.length === 1
        ? pending[0]!.messageId
        : undefined;
    const message = this.store.message("user", text, {
      replyTo: replyTo ?? clarification,
    });
    if (explicit) {
      this.deliver(message, explicit, mode);
      this.changed();
      this.pump();
      return;
    }
    this.state.routes.push({ messageId: message.id, status: "pending" });
    this.changed();
    await this.enqueueRoute(message);
  }
  private enqueueRoute(message: RoomMessage) {
    const operation = async () => {
      if (this.stopping) return;
      this.routingCount++;
      this.emit("change");
      try {
        const decision = await this.engine.route(
          message,
          this.state,
          { ...this.store.config, projects: this.projects },
          this.workspace,
        );
        if (!this.stopping) this.applyRoute(message, decision);
      } catch (error) {
        if (!this.stopping)
          this.store.message(
            "supervisor",
            `Routing failed: ${String(error)}\nUse /reroute to retry.`,
            { replyTo: message.id },
          );
      } finally {
        this.routingCount--;
        this.changed();
      }
    };
    this.routing = this.routing.then(operation, operation);
    return this.routing;
  }
  get isRouting() {
    return this.routingCount > 0;
  }
  applyRoute(message: RoomMessage, decision: RouteDecision) {
    const route = this.state.routes.find((r) => r.messageId === message.id)!;
    if (decision.action === "clarify") {
      route.status = "clarify";
      route.decision = decision;
      this.store.message(
        "supervisor",
        `${decision.question}\nReply directly in the room.`,
        { replyTo: message.id },
      );
      return;
    }
    const task =
      decision.action === "existing"
        ? this.task(decision.taskId)
        : this.createTask(decision.name, decision.project);
    const relatedIds = new Set(decision.resolvesMessageIds ?? []);
    if (
      message.replyTo &&
      this.state.routes.some(
        (r) => r.messageId === message.replyTo && r.status === "clarify",
      )
    )
      relatedIds.add(message.replyTo);
    const related = this.state.routes.filter(
      (r) => relatedIds.has(r.messageId) && r.status === "clarify",
    );
    for (const unresolved of related) {
      const original = this.state.messages.find(
        (m) => m.id === unresolved.messageId,
      )!;
      this.deliver(original, task, "followUp");
      unresolved.status = "done";
      unresolved.decision = decision;
    }
    this.deliver(
      message,
      task,
      related.length
        ? "steer"
        : decision.action === "existing"
          ? (decision.mode ?? "followUp")
          : "followUp",
    );
    route.status = "done";
    route.decision = decision;
    this.store.message("supervisor", `→ @${task.name}`, {
      taskId: task.id,
      replyTo: message.id,
    });
    this.changed();
    this.pump();
  }
  createTask(name: string, projectName?: string) {
    if (!name.trim() || name.length > 80 || /[\r\n]/.test(name))
      throw new Error("Task name must be 1–80 characters on one line.");
    const project = projectName
      ? this.projects.find((p) => p.name === projectName)
      : undefined;
    if (projectName && !project)
      throw new Error(`Unknown project: ${projectName}`);
    const task: Task = {
      id: id(),
      name,
      cwd: project?.cwd ?? this.cwd,
      project: project?.name,
      status: "idle",
      archived: false,
      summary: "",
      createdAt: now(),
    };
    this.state.tasks.push(task);
    this.changed();
    return task;
  }
  private deliver(message: RoomMessage, task: Task, mode: Delivery["mode"]) {
    if (this.clearing.has(task.id))
      throw new Error(
        "Task history is being summarized. Please try again shortly.",
      );
    if (
      this.state.deliveries.some(
        (d) =>
          d.messageId === message.id &&
          d.taskId === task.id &&
          d.status !== "cancelled",
      )
    )
      return;
    message.taskId = task.id;
    this.state.deliveries.push({
      id: id(),
      messageId: message.id,
      taskId: task.id,
      mode,
      status: "queued",
      context: { replyTo: message.replyTo },
    });
    task.archived = false;
    if (task.status !== "working") task.status = "queued";
    this.enabled.add(task.id);
  }
  async clear(selector: string) {
    if (this.stopping || this.suspended)
      throw new Error("Room is pausing or reloading.");
    const eligible = (task: Task) =>
      !this.running.has(task.id) &&
      !this.state.deliveries.some(
        (d) =>
          d.taskId === task.id &&
          ["queued", "running", "failed"].includes(d.status),
      ) &&
      !["working", "queued", "waiting", "failed"].includes(task.status);
    const tasks =
      selector === "all"
        ? this.state.tasks.filter((t) => !t.archived && eligible(t))
        : [this.task(selector)];
    for (const task of tasks) {
      if (!eligible(task))
        throw new Error(
          "Only idle tasks can be cleared. Resolve running tasks, pending replies, or unprocessed inputs first.",
        );
      if (this.clearing.has(task.id)) throw new Error("Task is being cleared.");
      const processed = new Set(task.memoryMessageIds ?? []);
      const messages = this.state.messages.filter(
        (m) =>
          m.taskId === task.id &&
          (m.sender === "user" || m.sender === task.id) &&
          !processed.has(m.id),
      );
      if (!messages.length) continue;
      if (!this.engine.summarize)
        throw new Error(
          "The current engine does not support history summaries.",
        );
      const operation = (async () => {
        const summary = await this.engine.summarize!(task, messages);
        if (this.stopping || this.suspended)
          throw new Error("Clearing cancelled; task history is preserved.");
        // Close the old Harness before switching sessions. Do not delete its SQLite.
        await this.engine.pause(task.id);
        this.store.memory.save(task, summary, messages);
        this.enabled.delete(task.id);
        task.memorySummary = summary;
        task.memoryMessageIds = [...processed, ...messages.map((m) => m.id)];
        task.memorySession = id();
        task.archived = true;
        this.logs.delete(task.id);
        this.store.message(
          "system",
          `History for @${task.name} was summarized into SQLite memory and the task was archived. Your next instruction will start a new session with the summary. Original history is preserved; the task has not been marked accepted.`,
          { taskId: task.id },
        );
        this.changed();
      })();
      this.clearing.set(task.id, operation);
      try {
        await operation;
      } finally {
        this.clearing.delete(task.id);
        this.emit("change");
      }
    }
  }
  async reroute(messageId: string) {
    messageId ||=
      this.state.routes.findLast((route) => route.status !== "done")
        ?.messageId ?? "";
    const message = this.state.messages.find(
      (m) => m.id === messageId && m.sender === "user",
    );
    if (!message) throw new Error("Unknown user message.");
    const route = this.state.routes.find((r) => r.messageId === messageId);
    if (!route || route.status === "done")
      throw new Error("Use /route to correct an already delivered message.");
    await this.enqueueRoute(message);
  }
  async assign(messageId: string, taskSelector: string) {
    const message = this.state.messages.find(
      (m) => m.id === messageId && m.sender === "user",
    );
    if (!message) throw new Error("Unknown user message.");
    const task = this.task(taskSelector);
    const previous = message.taskId;
    if (previous && previous !== task.id) {
      // Pause the original task before transferring; external effects remain visible in its transcript.
      await this.pause(previous, true);
      for (const d of this.state.deliveries.filter(
        (d) => d.messageId === message.id && d.taskId === previous,
      ))
        d.status = "cancelled";
      this.store.message(
        "system",
        `Stopped @${this.task(previous).name} from processing this message. Actions already taken remain in the task record; ask the original task to review them if they need to be undone.`,
        { replyTo: message.id, taskId: previous },
      );
    }
    this.state.corrections.push({
      messageId,
      from: previous,
      to: task.id,
      at: now(),
    });
    const route = this.state.routes.find((r) => r.messageId === message.id);
    if (route) route.status = "done";
    this.deliver(message, task, "followUp");
    this.changed();
    this.pump();
  }
  resume(selector = "all") {
    if (this.stopping || this.suspended) return;
    for (const task of selector === "all"
      ? this.state.tasks
      : [this.task(selector)]) {
      if (
        task.status === "completed" ||
        task.archived ||
        this.clearing.has(task.id)
      )
        continue;
      this.enabled.add(task.id);
      if (
        this.state.deliveries.some(
          (d) => d.taskId === task.id && d.status === "queued",
        )
      )
        task.status = "queued";
    }
    this.changed();
    this.pump();
  }
  async pause(selector: string, force = false) {
    const tasks = selector === "all" ? this.state.tasks : [this.task(selector)];
    for (const task of tasks) {
      this.enabled.delete(task.id);
      task.status = "paused";
    }
    this.changed();
    await Promise.all(tasks.map((t) => this.engine.pause(t.id, force)));
    // Join result handlers before allowing a reopen of the same SQLite file.
    await Promise.all(
      tasks.flatMap((t) => [...(this.running.get(t.id) ?? [])]),
    );
    for (const task of tasks) task.status = "paused";
    this.changed();
  }
  retry(selector: string) {
    const task = this.task(selector);
    for (const delivery of this.state.deliveries.filter(
      (d) => d.taskId === task.id && d.status === "failed",
    )) {
      // A failed durable submission is terminal: a fresh delivery/request ID is required.
      delivery.status = "cancelled";
      this.state.deliveries.push({
        ...delivery,
        id: id(),
        status: "queued",
        error: undefined,
      });
    }
    this.resume(task.id);
  }
  private pump() {
    if (this.stopping || this.suspended) return;
    const busyDirectories = new Set(
      this.state.tasks
        .filter((t) => this.running.has(t.id) && t.cwd)
        .map((t) => t.cwd),
    );
    for (const delivery of this.state.deliveries) {
      if (delivery.status !== "queued" || !this.enabled.has(delivery.taskId))
        continue;
      const task = this.task(delivery.taskId);
      const active = this.running.has(task.id);
      if (active && delivery.mode !== "steer") continue;
      if (
        !active &&
        (this.running.size >= this.store.config.maxTasks ||
          (task.cwd && busyDirectories.has(task.cwd)))
      )
        continue;
      if (task.cwd) busyDirectories.add(task.cwd);
      delivery.status = "running";
      task.status = "working";
      const message = this.state.messages.find(
        (m) => m.id === delivery.messageId,
      )!;
      const jobs = this.running.get(task.id) ?? new Set<Promise<void>>();
      this.running.set(task.id, jobs);
      // Persist intent before submitting to Durable. requestId bridges a crash between stores.
      this.changed();
      const job = Promise.resolve()
        .then(() => this.engine.run(task, message, delivery))
        .then((result) => {
          if (delivery.status === "cancelled") return;
          if (
            !this.state.messages.some((m) => m.answerKey === result.answerKey)
          ) {
            this.store.message(task.id, result.text, {
              taskId: task.id,
              replyTo: message.id,
              answerKey: result.answerKey,
            });
          }
          task.summary = result.text.slice(-1500);
          delivery.status = "done";
        })
        .catch((error) => {
          if (delivery.status === "cancelled") return;
          if (this.stopping || !this.enabled.has(task.id)) {
            delivery.status = "queued";
            return;
          }
          delivery.status = "failed";
          delivery.error = String(error);
          task.status = "failed";
          this.store.message(
            "system",
            `@${task.name} failed: ${String(error)}. Use /retry ${task.id} to retry.`,
            { taskId: task.id },
          );
        })
        .finally(() => {
          jobs.delete(job);
          if (jobs.size === 0) {
            this.running.delete(task.id);
            if (!this.enabled.has(task.id) || this.stopping)
              task.status = "paused";
            else if (
              task.status !== "failed" &&
              task.status !== "waiting" &&
              task.status !== "completed"
            )
              task.status = "idle";
          }
          this.changed();
          this.pump();
        });
      jobs.add(job);
    }
  }
  addProject(name: string, path: string) {
    if (this.store.config.projects.some((p) => p.name === name))
      throw new Error("Project already exists.");
    const cwd = realpathSync(resolve(this.cwd, path));
    if (!statSync(cwd).isDirectory())
      throw new Error("Project path must be a directory.");
    this.store.config.projects.push({ name, cwd });
    this.store.saveConfig();
    this.emit("change");
  }
  async prepareReload() {
    if (this.stopping || this.suspended)
      throw new Error("Already pausing or reloading.");
    if (this.clearing.size)
      throw new Error("History is being saved. Please reload shortly.");
    this.suspended = true;
    this.reloadSnapshot = {
      enabled: new Set(this.enabled),
      statuses: new Map(this.state.tasks.map((task) => [task.id, task.status])),
    };
    this.enabled.clear();
    const active = [...this.running.keys()];
    for (const task of this.state.tasks)
      if (task.status === "working" || task.status === "queued")
        task.status = "paused";
    this.changed();
    await Promise.all(active.map((id) => this.engine.pause(id)));
    await Promise.all([...this.running.values()].flatMap((jobs) => [...jobs]));
    this.changed();
  }
  cancelReload() {
    if (!this.reloadSnapshot || this.stopping) return;
    for (const id of this.reloadSnapshot.enabled) this.enabled.add(id);
    for (const task of this.state.tasks) {
      const before = this.reloadSnapshot.statuses.get(task.id);
      if (task.status === "paused" && before) {
        task.status =
          before === "working" || before === "queued"
            ? this.state.deliveries.some(
                (d) => d.taskId === task.id && d.status === "queued",
              )
              ? "queued"
              : "idle"
            : before;
      }
    }
    this.reloadSnapshot = undefined;
    this.suspended = false;
    this.changed();
    this.pump();
  }
  async stop(force = false) {
    this.stopping = true;
    this.emit("change");
    await Promise.allSettled([...this.clearing.values()]);
    await this.engine.close(force);
    await this.routing;
    await Promise.all([...this.running.values()].flatMap((jobs) => [...jobs]));
    for (const task of this.state.tasks)
      if (task.status === "working" || task.status === "queued")
        task.status = "paused";
    this.changed();
  }
  async waitForIdle() {
    await this.routing;
    while (this.running.size)
      await Promise.all(
        [...this.running.values()].flatMap((jobs) => [...jobs]),
      );
  }
}
