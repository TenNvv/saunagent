import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { command } from "./commands.js";
import {
  acceptCommand,
  candidateWindow,
  commandDescriptions,
  commandCandidates,
  completeCommand,
  type Completion,
} from "./completion.js";
import { InputHistory } from "./input-history.js";
import type { Room } from "./room.js";
import { clean, conversationMessages, presentMessage } from "./presentation.js";
import { ui, taskStatusColor, sessionNameStyle } from "./theme.js";

const labels: Record<string, string> = {
  queued: "Queued",
  working: "Working",
  paused: "Paused",
  idle: "Turn finished",
  waiting: "Awaiting reply",
  failed: "Failed",
  completed: "Completed",
};
function linesOf(text: string, width: number) {
  const lines: string[] = [];
  for (const line of clean(text).split("\n")) {
    let current = "",
      columns = 0;
    for (const char of line) {
      const size = /[\u1100-\uffff]|\p{Extended_Pictographic}/u.test(char)
        ? 2
        : 1;
      if (columns + size > width && current) {
        lines.push(current);
        current = "";
        columns = 0;
      }
      current += char;
      columns += size;
    }
    lines.push(current);
  }
  return lines;
}

export function App({
  room,
  demo,
  quit,
  reload,
  ready,
}: {
  room: Room;
  demo: boolean;
  quit: (force: boolean) => void;
  reload: () => Promise<void>;
  ready: () => void;
}) {
  const { stdout } = useStdout();
  const [, refresh] = useState(0);
  const [size, setSize] = useState({
    width: stdout.columns || 100,
    height: stdout.rows || 30,
  });
  const [selected, setSelected] = useState<string>();
  const [sidebar, setSidebar] = useState(false);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [completion, setCompletion] = useState<Completion>();
  const [history] = useState(() => new InputHistory(room.store.directory));
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [details, setDetails] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [quitting, setQuitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [showIds, setShowIds] = useState(false);
  const tasks = room.state.tasks.filter((t) => !t.archived);
  const task = tasks.find((t) => t.id === selected);
  useEffect(() => {
    const change = () => refresh((value) => value + 1);
    const resize = () =>
      setSize({ width: stdout.columns || 100, height: stdout.rows || 30 });
    room.on("change", change);
    stdout.on("resize", resize);
    return () => {
      room.off("change", change);
      stdout.off("resize", resize);
    };
  }, [room, stdout]);
  const selectConversation = (id?: string) => {
    if (id !== selected) {
      setScroll(0);
      setDetails(false);
    }
    setSelected(id);
  };
  useEffect(() => {
    if (selected && !task) selectConversation(undefined);
  }, [selected, task]);
  const requestQuit = (force: boolean) => {
    setQuitting(true);
    quit(force);
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (quitting || reloading) return;
      setDraft("");
      setCursor(0);
      setCompletion(undefined);
      setCandidateIndex(0);
      setDismissed(false);
      history.resetNavigation();
      return;
    }
    if (quitting || reloading) return;
    if (key.ctrl && input === "g") {
      setShowIds((value) => !value);
      return;
    }
    if (key.ctrl && input === "t") {
      setCompletion(undefined);
      setSidebar((value) => !value);
      return;
    }
    const activeCandidates =
      !sidebar && !dismissed
        ? (completion?.candidates ?? commandCandidates(draft, cursor))
        : [];
    if (!sidebar && activeCandidates.length && (key.upArrow || key.downArrow)) {
      setCandidateIndex(
        (candidateIndex + (key.upArrow ? -1 : 1) + activeCandidates.length) %
          activeCandidates.length,
      );
      return;
    }
    if (!sidebar && activeCandidates.length && key.return && !key.meta) {
      const next = acceptCommand(
        draft,
        activeCandidates[candidateIndex] ?? activeCandidates[0]!,
      );
      setDraft(next.draft);
      setCursor(next.cursor);
      setCompletion(undefined);
      setDismissed(true);
      history.resetNavigation();
      return;
    }
    if (key.tab) {
      if (!sidebar) {
        const highlighted =
          !completion &&
          activeCandidates.length &&
          candidateIndex > 0 &&
          !key.shift
            ? {
                ...acceptCommand(draft, activeCandidates[candidateIndex]!),
                candidates: activeCandidates,
                index: candidateIndex,
              }
            : undefined;
        const next =
          highlighted ?? completeCommand(draft, cursor, completion, key.shift);
        if (next) {
          setDraft(next.draft);
          setCursor(next.cursor);
          setCompletion(next);
          setCandidateIndex(next.index);
          setDismissed(false);
          history.resetNavigation();
          return;
        }
      }
      setCompletion(undefined);
      return;
    }
    setCompletion(undefined);
    if (key.escape && activeCandidates.length) {
      setDismissed(true);
      return;
    }
    if (key.escape) {
      if (details) {
        setDetails(false);
        return;
      }
      if (sidebar || selected) {
        selectConversation(undefined);
        setSidebar(false);
        return;
      }
      void room.pause("all").catch((error) => {
        room.store.message("system", String(error));
        room.changed();
      });
      return;
    }
    if (key.ctrl && input === "d" && task) {
      setDetails((value) => !value);
      setScroll(0);
      return;
    }
    if (key.pageUp) {
      setScroll((value) => value + 8);
      return;
    }
    if (key.pageDown) {
      setScroll((value) => Math.max(0, value - 8));
      return;
    }
    if (sidebar) {
      const index = selected
        ? tasks.findIndex((t) => t.id === selected) + 1
        : 0;
      const next = key.upArrow
        ? Math.max(0, index - 1)
        : key.downArrow
          ? Math.min(tasks.length, index + 1)
          : index;
      selectConversation(next === 0 ? undefined : tasks[next - 1]?.id);
      if (key.return) setSidebar(false);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const before = draft.slice(0, cursor);
      const lineStart = before.lastIndexOf("\n") + 1;
      const column = cursor - lineStart;
      const lineEnd = draft.indexOf("\n", cursor);
      if (key.upArrow && lineStart > 0) {
        const previousStart = draft.lastIndexOf("\n", lineStart - 2) + 1;
        setCursor(Math.min(previousStart + column, lineStart - 1));
        return;
      }
      if (key.downArrow && lineEnd >= 0) {
        const nextEnd = draft.indexOf("\n", lineEnd + 1);
        setCursor(
          Math.min(lineEnd + 1 + column, nextEnd < 0 ? draft.length : nextEnd),
        );
        return;
      }
      const next = history.navigate(key.upArrow ? -1 : 1, draft, cursor);
      setDraft(next.draft);
      setCursor(next.cursor);
      setDismissed(true);
      return;
    }
    if (!key.leftArrow && !key.rightArrow) {
      history.resetNavigation();
      setCandidateIndex(0);
      setDismissed(false);
    }
    if ((key.meta && key.return) || (key.ctrl && input === "j")) {
      setDraft((value) => value.slice(0, cursor) + "\n" + value.slice(cursor));
      setCursor(cursor + 1);
      return;
    }
    if (key.return) {
      if (!draft.trim()) return;
      const text = draft;
      try {
        history.add(text);
      } catch {
        room.store.message(
          "system",
          "Could not save input history; your message will still be sent.",
        );
        room.changed();
      }
      setDraft("");
      setCursor(0);
      setScroll(0);
      void command(room, text, selected)
        .then((result) => {
          if (result.quit) requestQuit(result.force ?? false);
          else if (result.reload) {
            setReloading(true);
            void reload()
              .catch((error) => {
                room.store.message("system", String(error));
                room.changed();
              })
              .finally(() => setReloading(false));
          } else selectConversation(result.selected);
        })
        .catch((error) => {
          room.store.message("system", String(error));
          room.changed();
        });
      return;
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(draft.length, cursor + 1));
      return;
    }
    if (key.ctrl && input === "a") {
      setCursor(0);
      return;
    }
    if (key.ctrl && input === "e") {
      setCursor(draft.length);
      return;
    }
    if (key.ctrl && input === "u") {
      setDraft(draft.slice(cursor));
      setCursor(0);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor) {
        setDraft((value) => value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
      }
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      const value = clean(input.replace(/\r\n?/g, "\n"));
      setDraft(
        (previous) =>
          previous.slice(0, cursor) + value + previous.slice(cursor),
      );
      setCursor(cursor + value.length);
    }
  });
  useEffect(() => {
    ready();
  }, [ready]);
  const candidates =
    !sidebar && !quitting && !reloading && !dismissed
      ? (completion?.candidates ?? commandCandidates(draft, cursor))
      : [];
  const menuLimit = Math.max(1, Math.min(5, size.height - 12));
  const menu = candidateWindow(candidates, candidateIndex, menuLimit);
  const inputHeight = Math.min(6, Math.max(3, draft.split("\n").length + 2));
  const menuHeight = candidates.length
    ? menu.items.length + (candidates.length > menuLimit ? 1 : 0)
    : 0;
  const compact = size.width < 75;
  const leftWidth = compact ? 22 : 30;
  const rightWidth = Math.max(15, size.width - leftWidth - 5);
  const height = Math.max(1, size.height - inputHeight - menuHeight - 5);
  const transcript: {
    text: string;
    right?: boolean;
    color?: string;
    dim?: boolean;
    bold?: boolean;
  }[] = [];
  if (details && task) {
    transcript.push(
      ...linesOf(`@${task.name} [${task.id}]`, rightWidth).map((text) => ({
        text,
        ...sessionNameStyle(),
      })),
    );
    transcript.push(
      ...linesOf(
        `Project: ${task.project ?? "None"}\nDirectory: ${task.cwd ?? "Startup directory"}\n${task.summary}\n── Tools and execution log ──`,
        rightWidth,
      ).map((text) => ({ text })),
    );
    for (const line of room.logs.get(task.id) ?? [])
      transcript.push(
        ...linesOf(line, rightWidth).map((text) => ({ text, dim: true })),
      );
  } else {
    for (const message of conversationMessages(room.state, task?.id)) {
      const display = presentMessage(message, room.state, showIds);
      const right = message.sender === "user";
      const agent = room.state.tasks.some((item) => item.id === message.sender);
      transcript.push(
        ...linesOf(display.header, rightWidth).map((text) => ({
          text,
          right,
          color: right || agent ? ui.accent : undefined,
          bold: right || agent,
          dim: !right && !agent,
        })),
      );

      transcript.push(
        ...linesOf(display.text, rightWidth).map((text) => ({ text, right })),
      );
      transcript.push({ text: "" });
    }
  }
  const end = Math.max(
    height,
    transcript.length -
      Math.min(scroll, Math.max(0, transcript.length - height)),
  );
  const visible = transcript.slice(Math.max(0, end - height), end);
  return (
    <Box flexDirection="column" width={size.width} height={size.height}>
      <Box justifyContent="space-between">
        <Text bold> saunagent</Text>
        <Text dimColor>
          {demo ? "Demo mode · No tools executed" : "Pi Durable"}{" "}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Box
          width={leftWidth}
          borderStyle="single"
          borderColor={sidebar ? ui.accent : ui.border}
          flexDirection="column"
          paddingX={1}
          overflow="hidden"
        >
          <Text bold>
            Tasks{" "}
            {room.state.tasks.filter((t) => t.status === "working").length}/
            {room.store.config.maxTasks}
          </Text>
          <Text color={!selected ? ui.accent : undefined} bold={!selected}>
            {!selected ? "›" : " "} All · Auto-route
          </Text>
          <Text dimColor>
            {room.isRouting ? "Supervisor routing…" : "Supervisor · Ready"}
          </Text>
          {tasks
            .slice(-Math.max(1, Math.floor((size.height - 9) / 3)))
            .map((item) => (
              <Box key={item.id} flexDirection="column" marginTop={1}>
                <Text
                  {...sessionNameStyle(selected === item.id)}
                  wrap="truncate"
                >
                  {selected === item.id ? "›" : " "} {clean(item.name)}
                </Text>
                <Text
                  dimColor={!taskStatusColor(item.status)}
                  color={taskStatusColor(item.status)}
                >
                  {showIds ? `${item.id} · ` : ""}
                  {labels[item.status]}
                </Text>
              </Box>
            ))}
          <Text dimColor>
            {room.state.tasks.filter((t) => t.archived).length} archived
          </Text>
        </Box>
        <Box
          flexGrow={1}
          borderStyle="single"
          borderColor={ui.border}
          flexDirection="column"
          paddingX={1}
          overflow="hidden"
        >
          <Text bold>
            {details && task
              ? "Task details · Ctrl+D to return"
              : task
                ? `@${clean(task.name)} · Conversation`
                : `Room · ${clean(room.workspace.project)}`}
            {scroll ? ` · Up ${scroll}` : ""}
          </Text>
          {visible.map((line, index) => (
            <Box
              key={index}
              width="100%"
              height={1}
              flexShrink={0}
              justifyContent={line.right ? "flex-end" : "flex-start"}
            >
              <Text
                color={line.color}
                dimColor={line.dim}
                bold={line.bold}
                wrap="truncate"
              >
                {line.text || " "}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
      <Box
        flexShrink={0}
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderColor={
          quitting || reloading ? ui.warning : sidebar ? ui.border : ui.accent
        }
        paddingX={1}
        height={inputHeight}
        overflow="hidden"
      >
        {quitting || reloading ? (
          <Text color={ui.warning}>
            {reloading
              ? "Pausing tasks, building and reloading…"
              : "Pausing; waiting for active tools to finish before exiting…"}
          </Text>
        ) : (
          <Box flexGrow={1}>
            <Text color={ui.accent} bold={!!task}>
              {task ? `@${clean(task.name)}` : "room"} ›{" "}
            </Text>
            {/* A single text leaf avoids Ink retaining a stale nested text layout
              when history restores the exact input that was just submitted. */}
            <Text
              key={`${draft}:${cursor}`}
            >{`${clean(draft.slice(0, cursor))}▏${clean(draft.slice(cursor))}`}</Text>
          </Box>
        )}
      </Box>
      {candidates.length > 0 && (
        <Box flexDirection="column" flexShrink={0}>
          {menu.items.map((name, index) => (
            <Box key={name}>
              <Box width={Math.min(24, Math.floor(size.width / 2))}>
                <Text
                  color={
                    menu.start + index === candidateIndex
                      ? ui.accent
                      : undefined
                  }
                  bold={menu.start + index === candidateIndex}
                  wrap="truncate"
                >
                  {menu.start + index === candidateIndex ? "›" : " "} {name}
                </Text>
              </Box>
              <Text dimColor wrap="truncate">
                {commandDescriptions[name]}
              </Text>
            </Box>
          ))}
          {candidates.length > menuLimit && (
            <Text dimColor>
              {" "}
              ({candidateIndex + 1}/{candidates.length})
            </Text>
          )}
        </Box>
      )}
      <Text dimColor wrap="truncate">
        {candidates.length
          ? " ↑↓ Select · Enter Accept · Tab Cycle · Esc Close"
          : " ↑↓ History · Ctrl+T Tasks · Alt+Enter Newline · Ctrl+D Details · /help · Ctrl+C Clear · /quit Exit"}
      </Text>
    </Box>
  );
}
