// Keep aliases as well as the command names accepted by commands.ts.
export const slashCommands = [
  "new",
  "reply",
  "steer",
  "route",
  "reroute",
  "resume",
  "pause",
  "retry",
  "clear",
  "memory",
  "complete",
  "archive",
  "unarchive",
  "projects",
  "project",
  "model",
  "models",
  "reload",
  "help",
  "q",
  "quit",
  "quit!",
].map((name) => `/${name}`);

export function commandCandidates(draft: string, cursor: number): string[] {
  const token = draft.match(/^\/[^\s]*/)?.[0];
  // Only complete the command token, never arguments, paths or message bodies.
  if (!token || cursor < 1 || cursor > token.length) return [];
  return slashCommands.filter((name) =>
    name.startsWith(draft.slice(0, cursor)),
  );
}

export interface Completion {
  draft: string;
  cursor: number;
  candidates: string[];
  index: number;
}

export function completeCommand(
  draft: string,
  cursor: number,
  previous?: Completion,
  reverse = false,
): Completion | undefined {
  const cycling = previous?.draft === draft && previous.cursor === cursor;
  const candidates = cycling
    ? previous.candidates
    : commandCandidates(draft, cursor);
  if (!candidates.length) return undefined;
  const index = cycling
    ? (previous.index + (reverse ? -1 : 1) + candidates.length) %
      candidates.length
    : reverse
      ? candidates.length - 1
      : 0;
  const token = draft.match(/^\/[^\s]*/)?.[0] ?? "";
  const suffix = draft.slice(token.length);
  const replacement = candidates[index]!;
  const space = candidates.length === 1 && !suffix ? " " : "";
  return {
    draft: replacement + space + suffix,
    cursor: replacement.length + space.length,
    candidates,
    index,
  };
}

export const commandDescriptions: Record<string, string> = {
  "/new": "Create a task",
  "/reply": "Reply to a message",
  "/steer": "Steer a task",
  "/route": "Assign or correct routing",
  "/reroute": "Retry supervisor routing",
  "/resume": "Resume paused tasks",
  "/pause": "Pause tasks",
  "/retry": "Retry failed input",
  "/complete": "Mark as accepted",
  "/clear": "Summarize to memory and archive",
  "/memory": "View SQLite history summaries",
  "/archive": "Archive a task",
  "/unarchive": "Unarchive a task",
  "/projects": "List projects",
  "/project": "View directory or add project",
  "/model": "View or switch models",
  "/models": "View model configuration",
  "/reload": "Save and reload code",
  "/help": "Help",
  "/q": "Quit",
  "/quit": "Quit",
  "/quit!": "Force quit",
};

/** Accept a highlighted item without sending it; preserve arguments exactly. */
export function acceptCommand(
  draft: string,
  name: string,
): { draft: string; cursor: number } {
  const token = draft.match(/^\/[^\s]*/)?.[0] ?? "";
  const suffix = draft.slice(token.length);
  return {
    draft: name + (suffix || " "),
    cursor: name.length + (suffix ? 0 : 1),
  };
}

export function candidateWindow(
  candidates: string[],
  index: number,
  limit = 5,
) {
  const start = Math.max(
    0,
    Math.min(index - Math.floor(limit / 2), candidates.length - limit),
  );
  return { start, items: candidates.slice(start, start + limit) };
}
