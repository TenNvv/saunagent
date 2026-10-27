import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "./memory.js";
import type { Config, RoomMessage, RoomState } from "./types.js";

export const id = () => randomUUID().slice(0, 8);
export const now = () => new Date().toISOString();
export const defaults: Config = {
  model: { provider: "openai", modelId: "gpt-6-sol" },
  supervisorModel: { provider: "openai", modelId: "gpt-6-sol" },
  providers: {},
  maxTasks: 3,
  maxSubagents: 4,
  projects: [],
  instructions: "",
  skills: [],
};

function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export class RoomStore {
  readonly directory: string;
  state: RoomState;
  config: Config;
  private lock: string;
  memory!: MemoryStore;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lock = join(this.directory, "room.lock");
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Invalid room.lock; inspect it before removing.");
      try {
        process.kill(pid, 0);
        throw new Error(`Room already open in process ${pid}.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        rmSync(this.lock);
      }
    }
    const lockFd = openSync(this.lock, "wx", 0o600);
    try {
      writeFileSync(lockFd, String(process.pid));
    } finally {
      closeSync(lockFd);
    }
    try {
      const configPath = join(this.directory, "config.json");
      const configured = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf8"))
        : {};
      this.config = {
        ...defaults,
        ...configured,
        model: { ...defaults.model, ...configured.model },
        supervisorModel: {
          ...(configured.model ?? defaults.model),
          ...configured.supervisorModel,
        },
      };
      if (
        !Number.isInteger(this.config.maxTasks) ||
        this.config.maxTasks < 1 ||
        !Number.isInteger(this.config.maxSubagents) ||
        this.config.maxSubagents < 1 ||
        !Array.isArray(this.config.projects) ||
        !Array.isArray(this.config.skills)
      )
        throw new Error("Invalid config.json.");
      this.config.projects = this.config.projects.map((project) => ({
        ...project,
        cwd: realpathSync(project.cwd),
      }));
      if (!existsSync(configPath)) atomicJson(configPath, this.config);
      const roomPath = join(this.directory, "room.json");
      this.state = existsSync(roomPath)
        ? JSON.parse(readFileSync(roomPath, "utf8"))
        : {
            version: 1,
            tasks: [],
            messages: [],
            deliveries: [],
            routes: [],
            corrections: [],
          };
      if (this.state.version !== 1)
        throw new Error("Unsupported room version.");
      for (const task of this.state.tasks) {
        if (task.status === "working" || task.status === "queued")
          task.status = "paused";
      }
      for (const delivery of this.state.deliveries) {
        if (delivery.status === "running") delivery.status = "queued";
      }
      this.memory = new MemoryStore(this.directory);
      this.save();
    } catch (error) {
      this.release();
      throw error;
    }
  }
  save() {
    atomicJson(join(this.directory, "room.json"), this.state);
  }
  saveConfig() {
    atomicJson(join(this.directory, "config.json"), this.config);
  }
  message(sender: string, text: string, extra: Partial<RoomMessage> = {}) {
    const message: RoomMessage = {
      id: id(),
      at: now(),
      sender,
      text,
      ...extra,
    };
    this.state.messages.push(message);
    return message;
  }
  release() {
    this.memory?.close();
    rmSync(this.lock, { force: true });
  }
}
