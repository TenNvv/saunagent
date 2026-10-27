#!/usr/bin/env node
import React from "react";
import { resolve } from "node:path";
import { render } from "ink";
import { RoomStore } from "./store.js";
import { Room } from "./room.js";
import { PiEngine } from "./pi.js";
import { App } from "./tui.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`saunagent — a personal task room in your terminal

Usage: saunagent [--demo] [--state-dir PATH] [--models PATH] [--auth PATH]

--demo           Use a scripted local model; no API key, no coding tools executed.
--state-dir PATH Store room/config/task databases here (default: ./.saunagent).
--models PATH    Use a Pi models.json file (default: <state-dir>/models.json).
--auth PATH      Use a Pi auth.json file (default: <state-dir>/auth.json).

Requires Node.js >=22.19 (Node 24 recommended).
Configure providers/models/projects in <state-dir>/config.json.
Custom gateway: PROVIDER=openai OPENAI_BASE_URL=https://host/prefix/v1 MODEL=your-model.
OPENAI_API_TYPE defaults to openai-completions for custom OPENAI_BASE_URL.
Use OPENAI_API_KEY for gateway credentials; configure additional providers in config.json.
Run /help in the TUI for shortcuts and commands.`);
} else {
  const pathFlags = ["--state-dir", "--models", "--auth"];
  const unknown = args.filter(
    (arg, index) =>
      arg !== "--demo" &&
      !pathFlags.includes(arg) &&
      !pathFlags.includes(args[index - 1] ?? ""),
  );
  if (unknown.length)
    throw new Error(`Unknown arguments: ${unknown.join(" ")}`);
  const pathArgument = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1]!.startsWith("--"))
      throw new Error(`${flag} requires a path.`);
    return args[index + 1]!;
  };
  const statePath = pathArgument("--state-dir"),
    modelsPath = pathArgument("--models"),
    authPath = pathArgument("--auth");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "saunagent needs an interactive terminal. Use --help for usage.",
    );
  const store = new RoomStore(resolve(statePath ?? ".saunagent"));
  let engine: PiEngine;
  try {
    engine = new PiEngine(store, args.includes("--demo"), undefined, {
      modelsPath,
      authPath,
    });
    await engine.initialize();
  } catch (error) {
    store.release();
    throw error;
  }
  const room = new Room(store, engine);
  engine.log = (id, text) => room.log(id, text);
  engine.notify = () => room.changed();
  engine.progress = (taskId, text, key) => {
    if (!store.state.messages.some((message) => message.answerKey === key)) {
      store.message(taskId, text, { taskId, answerKey: key });
      room.changed();
    }
  };
  let exiting = false;
  let saved = false;
  let terminalError: unknown;
  let restart = false;
  let reloadPending:
    { resolve: () => void; reject: (error: Error) => void } | undefined;
  let app: ReturnType<typeof render>;
  const shutdown = async (force = false) => {
    if (exiting && !force) return;
    exiting = true;
    try {
      await room.stop(force);
      store.release();
      saved = true;
      app.unmount();
    } catch (error) {
      terminalError = error;
      app.unmount();
      process.exitCode = 1;
    }
  };
  const interrupt = () => {
    void shutdown(exiting);
  };
  const reload = async () => {
    if (!process.send)
      throw new Error("Launch with npm start to use /reload in the room.");
    if (reloadPending || exiting) return;
    try {
      await room.prepareReload();
    } catch (error) {
      room.cancelReload();
      throw error;
    }
    const result = new Promise<void>((resolve, reject) => {
      reloadPending = { resolve, reject };
    });
    process.send({ type: "reload" }, (error) => {
      if (error) reloadPending?.reject(error);
    });
    try {
      await result;
    } catch (error) {
      room.cancelReload();
      throw error;
    } finally {
      reloadPending = undefined;
    }
    restart = true;
    await shutdown(false);
    if (saved) process.exitCode = 75;
  };
  const launcherMessage = (message: unknown) => {
    const event = message as {
      type?: string;
      success?: boolean;
      error?: string;
      text?: string;
    };
    if (event?.type === "reload-result") {
      if (event.success) reloadPending?.resolve();
      else
        reloadPending?.reject(
          new Error(
            `Rebuild failed; continuing with the current version:\n${event.error ?? "Unknown build error"}`,
          ),
        );
    }
    if (event?.type === "launcher-notice" && event.text) {
      store.message("system", event.text);
      room.changed();
    }
  };
  process.on("message", launcherMessage);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  if (store.state.messages.length === 0) {
    store.message(
      "system",
      `Welcome to saunagent. Working directory: ${room.cwd}\nAsk to inspect or modify this project directly. Ctrl+T selects tasks, Alt+Enter adds a newline, /reload loads changes; /help lists commands.`,
    );
    store.save();
  }
  process.stdout.write("\x1b[?1049h");
  try {
    app = render(
      <App
        room={room}
        demo={args.includes("--demo")}
        reload={reload}
        quit={(force) => {
          void shutdown(force);
        }}
        ready={() => process.send?.({ type: "ready" })}
      />,
      { exitOnCtrlC: false, patchConsole: true },
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l");
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    process.off("message", launcherMessage);
    if (process.connected) process.disconnect();
  }
  if (saved)
    process.stdout.write(
      restart
        ? "Room saved. Loading the new version…\n"
        : "Room saved. All unfinished tasks are paused.\n",
    );
  if (terminalError)
    process.stderr.write(`Save/exit failed: ${String(terminalError)}\n`);
}
