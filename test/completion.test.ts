import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commandCandidates,
  completeCommand,
  slashCommands,
} from "../src/completion.js";

test("slash prefixes list commands and unique matches add a space", () => {
  assert.deepEqual(commandCandidates("/", 1), slashCommands);
  assert.deepEqual(commandCandidates("/hel", 4), ["/help"]);
  const result = completeCommand("/hel", 4)!;
  assert.equal(result.draft, "/help ");
  assert.equal(result.cursor, 6);
  assert.equal(completeCommand(result.draft, result.cursor), undefined);
});

test("Tab cycles ambiguous matches and Shift+Tab reverses", () => {
  const first = completeCommand("/re", 3)!;
  assert.equal(first.draft, "/reply");
  const next = completeCommand(first.draft, first.cursor, first)!;
  assert.equal(next.draft, "/reroute");
  const back = completeCommand(next.draft, next.cursor, next, true)!;
  assert.equal(back.draft, first.draft);
  const last = completeCommand(first.draft, first.cursor, first, true)!;
  assert.equal(last.draft, "/reload");
  assert.equal(
    completeCommand(last.draft, last.cursor, last)!.draft,
    first.draft,
  );
});

test("completes only the first token and preserves arguments verbatim", () => {
  const result = completeCommand("/hel  原文\n保留", 4)!;
  assert.equal(result.draft, "/help  原文\n保留");
  assert.equal(result.cursor, 5);
  assert.equal(completeCommand("/help", 3)!.draft, "/help ");
  for (const draft of [
    "",
    "hello",
    " /hel",
    "@task /hel",
    "/help text",
    "/home/user",
    "/unknown",
    "/model supervisor openai/test",
  ]) {
    assert.equal(completeCommand(draft, draft.length), undefined, draft);
  }
  assert.equal(completeCommand("/help", 0), undefined);
});

test("editing the draft discards the previous cycle", () => {
  const previous = completeCommand("/re", 3)!;
  assert.equal(completeCommand("/ret", 4, previous)!.draft, "/retry ");
  assert.ok(slashCommands.includes("/quit!"));
  assert.ok(slashCommands.includes("/q"));
  assert.ok(slashCommands.includes("/models"));
});

test("highlighted acceptance preserves arguments and never sends", async () => {
  const { acceptCommand, candidateWindow, commandDescriptions } =
    await import("../src/completion.js");
  assert.deepEqual(acceptCommand("/re", "/resume"), {
    draft: "/resume ",
    cursor: 8,
  });
  assert.deepEqual(acceptCommand("/re  all\n原文", "/resume"), {
    draft: "/resume  all\n原文",
    cursor: 7,
  });
  assert.deepEqual(
    candidateWindow(slashCommands, 0).items,
    slashCommands.slice(0, 5),
  );
  const last = candidateWindow(slashCommands, slashCommands.length - 1);
  assert.equal(last.items.length, 5);
  assert.equal(last.items.at(-1), slashCommands.at(-1));
  assert.ok(slashCommands.every((name) => commandDescriptions[name]));
});

test("built-in command help and completion descriptions use English", async () => {
  const { help } = await import("../src/commands.js");
  const { commandDescriptions } = await import("../src/completion.js");
  assert.doesNotMatch(help, /\p{Script=Han}/u);
  for (const description of Object.values(commandDescriptions)) {
    assert.doesNotMatch(description, /\p{Script=Han}/u);
  }
});
