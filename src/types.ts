export type ModelChoice = { provider: string; modelId: string };
export type CustomProvider = {
  baseUrl: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  apiKeyEnv?: string;
  models?: string[];
  contextWindow?: number;
  maxTokens?: number;
};
export type Project = {
  name: string;
  cwd: string;
  instructions?: string;
  skills?: string[];
};
export type Config = {
  model: ModelChoice;
  supervisorModel: ModelChoice;
  providers: Record<string, CustomProvider>;
  maxTasks: number;
  maxSubagents: number;
  projects: Project[];
  instructions: string;
  skills: string[];
};
export type TaskStatus =
  "queued" | "working" | "paused" | "idle" | "waiting" | "failed" | "completed";
export type Task = {
  id: string;
  name: string;
  cwd?: string;
  project?: string;
  model?: ModelChoice;
  memorySession?: string;
  memorySummary?: string;
  memoryMessageIds?: string[];
  status: TaskStatus;
  archived: boolean;
  summary: string;
  createdAt: string;
};
export type RoomMessage = {
  id: string;
  at: string;
  sender: "user" | "supervisor" | "system" | string;
  text: string;
  taskId?: string;
  replyTo?: string;
  answerKey?: string;
};
export type Workspace = { cwd: string; project: string };
export type Delivery = {
  id: string;
  messageId: string;
  taskId: string;
  mode: "followUp" | "steer";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  error?: string;
  context: { replyTo?: string; previousTaskId?: string };
};
export type RouteDecision =
  | {
      action: "existing";
      taskId: string;
      mode?: "steer" | "followUp";
      resolvesMessageIds?: string[];
    }
  | {
      action: "new";
      name: string;
      project?: string;
      resolvesMessageIds?: string[];
    }
  | { action: "clarify"; question: string };
export type RoomState = {
  version: 1;
  tasks: Task[];
  messages: RoomMessage[];
  deliveries: Delivery[];
  routes: {
    messageId: string;
    status: "pending" | "clarify" | "done";
    decision?: RouteDecision;
  }[];
  corrections: { messageId: string; from?: string; to: string; at: string }[];
};
export type RunResult = { text: string; answerKey: string };
export interface Engine {
  summarize?(task: Task, messages: RoomMessage[]): Promise<string>;
  describeModels?(): Promise<string>;
  route(
    message: RoomMessage,
    state: RoomState,
    config: Config,
    workspace?: Workspace,
  ): Promise<RouteDecision>;
  run(task: Task, message: RoomMessage, delivery: Delivery): Promise<RunResult>;
  pause(taskId: string, force?: boolean): Promise<void>;
  close(force?: boolean): Promise<void>;
}
