#!/usr/bin/env node
import { spawn, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function compile(projectRoot = root) {
  let compiler,
    cancelled = false;
  const result = (async () => {
    const directory = await mkdtemp(join(projectRoot, ".saunagent-build-"));
    let output = "";
    try {
      if (cancelled) throw new Error("Build cancelled.");
      const code = await new Promise((resolve, reject) => {
        compiler = spawn(
          process.execPath,
          [
            join(projectRoot, "node_modules/typescript/bin/tsc"),
            "--outDir",
            directory,
            "--noEmitOnError",
          ],
          {
            cwd: projectRoot,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const collect = (chunk) => {
          output = (output + chunk.toString()).slice(-20000);
        };
        compiler.stdout.on("data", collect);
        compiler.stderr.on("data", collect);
        compiler.once("error", reject);
        compiler.once("exit", (code) => resolve(code));
      });
      if (code !== 0) throw new Error(output.trim() || "Build interrupted.");
      return directory;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  })();
  return {
    result,
    cancel: () => {
      cancelled = true;
      compiler?.kill("SIGTERM");
    },
  };
}

export function worker(
  directory,
  args,
  onReady = () => {},
  notice = "",
  projectRoot = root,
) {
  const child = fork(join(directory, "cli.js"), args, {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  let next,
    building,
    ready = false,
    interrupted = false;
  const forward = (signal) => {
    interrupted = true;
    child.kill(signal);
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const send = (value) => {
    if (child.connected) child.send(value, () => {});
  };
  child.on("message", async (message) => {
    if (message?.type === "ready") {
      ready = true;
      await onReady();
      if (notice) send({ type: "launcher-notice", text: notice });
    }
    if (message?.type !== "reload" || building || next) return;
    building = compile(projectRoot);
    try {
      next = await building.result;
      if (child.exitCode !== null || child.signalCode !== null) {
        await rm(next, { recursive: true, force: true });
        next = undefined;
        return;
      }
      send({ type: "reload-result", success: true });
    } catch (error) {
      send({ type: "reload-result", success: false, error: String(error) });
    } finally {
      building = undefined;
    }
  });
  return new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(String(error));
    });
    child.once("exit", async (code, signal) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      const pending = building;
      if (pending) {
        pending.cancel();
        await pending.result.catch(() => {});
      }
      if (code !== 75 && next) {
        await rm(next, { recursive: true, force: true });
        next = undefined;
      }
      resolve({ code: code ?? (signal ? 1 : 0), next, ready, interrupted });
    });
  });
}

export async function main(args = process.argv.slice(2), projectRoot = root) {
  console.log("Building saunagent…");
  let current = await compile(projectRoot).result,
    previous;
  let notice = "";
  try {
    while (true) {
      const result = await worker(
        current,
        args,
        async () => {
          if (previous) {
            const old = previous;
            previous = undefined;
            await rm(old, { recursive: true, force: true });
          }
        },
        notice,
        projectRoot,
      );
      notice = "";
      if (result.interrupted) {
        if (result.next)
          await rm(result.next, { recursive: true, force: true });
        process.exitCode = result.code;
        break;
      }
      if (result.code === 75 && result.next) {
        previous = current;
        current = result.next;
        notice =
          "New version loaded. Tasks remain paused; use /resume to continue.";
        continue;
      }
      if (!result.ready && result.code !== 0 && previous) {
        await rm(current, { recursive: true, force: true });
        current = previous;
        previous = undefined;
        notice =
          "The new version failed to start. Restored the previous version. Fix the issue and use /reload again.";
        continue;
      }
      process.exitCode = result.code;
      break;
    }
  } finally {
    await rm(current, { recursive: true, force: true });
    if (previous) await rm(previous, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Startup build failed: ${String(error)}`);
    process.exitCode = 1;
  });
}
