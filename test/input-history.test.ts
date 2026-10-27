import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputHistory } from "../src/input-history.js";

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "saunagent-input-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    path: join(directory, "input-history.json"),
    history: new InputHistory(directory),
  };
}

test("persists original input, ignores blanks and deduplicates only consecutive entries", (t) => {
  const { directory, path, history } = setup(t);
  for (const text of ["", " \n", "first", "first", "  多行\n原文  ", "first"])
    history.add(text);
  const expected = ["first", "  多行\n原文  ", "first"];
  assert.deepEqual(history.entries, expected);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
  assert.deepEqual(new InputHistory(directory).entries, expected);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), ["input-history.json"]);
  const snapshot = history.entries as string[];
  snapshot.push("not saved");
  assert.deepEqual(history.entries, expected);
});

test("replaces an existing file atomically with private permissions", (t) => {
  const { path, history } = setup(t);
  writeFileSync(path, '["old"]');
  chmodSync(path, 0o644);
  const oldInode = statSync(path).ino;
  history.add("new");
  assert.notEqual(statSync(path).ino, oldInode);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), ["new"]);
});

test("retains the newest 100 entries on add and load", (t) => {
  const { directory, path, history } = setup(t);
  for (let i = 0; i < 105; i++) history.add(String(i));
  const expected = Array.from({ length: 100 }, (_, i) => String(i + 5));
  assert.deepEqual(history.entries, expected);
  assert.deepEqual(new InputHistory(directory).entries, expected);
  writeFileSync(
    path,
    JSON.stringify(Array.from({ length: 105 }, (_, i) => String(i))),
  );
  assert.deepEqual(new InputHistory(directory).entries, expected);
});

test("navigation saves the original draft and cursor, clamps oldest, and restores past newest", (t) => {
  const { history } = setup(t);
  history.add("one");
  history.add("second\nline");
  assert.deepEqual(history.navigate(1, "draft", 2), {
    draft: "draft",
    cursor: 2,
  });
  assert.deepEqual(history.navigate(-1, "draft", 2), {
    draft: "second\nline",
    cursor: 11,
  });
  assert.deepEqual(history.navigate(-1, "edited recalled text", 4), {
    draft: "one",
    cursor: 3,
  });
  assert.deepEqual(history.navigate(-1, "one", 0), { draft: "one", cursor: 3 });
  assert.deepEqual(history.navigate(1, "one", 3), {
    draft: "second\nline",
    cursor: 11,
  });
  assert.deepEqual(history.navigate(1, "second\nline", 11), {
    draft: "draft",
    cursor: 2,
  });
  history.navigate(-1, "new draft", 1);
  assert.deepEqual(history.navigate(1, "", 0), {
    draft: "new draft",
    cursor: 1,
  });
});

test("reset and add discard stale navigation, including duplicate submissions", (t) => {
  const { history } = setup(t);
  history.add("one");
  history.navigate(-1, "old draft", 3);
  history.resetNavigation();
  assert.deepEqual(history.navigate(1, "current draft", 4), {
    draft: "current draft",
    cursor: 4,
  });
  history.navigate(-1, "another draft", 2);
  history.add("one");
  assert.deepEqual(history.navigate(1, "", 0), { draft: "", cursor: 0 });
  history.navigate(-1, "fresh", 2);
  assert.deepEqual(history.navigate(1, "", 0), { draft: "fresh", cursor: 2 });
});

test("missing or corrupt history is harmless and valid strings are normalized", (t) => {
  const { directory, path, history } = setup(t);
  assert.deepEqual(history.entries, []);
  for (const direction of [-1, 1] as const) {
    assert.deepEqual(history.navigate(direction, "draft", 3), {
      draft: "draft",
      cursor: 3,
    });
  }
  for (const content of ["{bad json", "null", "{}", "42", '"text"']) {
    writeFileSync(path, content);
    assert.deepEqual(new InputHistory(directory).entries, []);
  }
  writeFileSync(
    path,
    JSON.stringify(["one", null, 3, "", " \n", "one", "two", "one"]),
  );
  assert.deepEqual(new InputHistory(directory).entries, ["one", "two", "one"]);
  writeFileSync(path, "{bad");
  const recovered = new InputHistory(directory);
  recovered.add("recovered");
  assert.deepEqual(new InputHistory(directory).entries, ["recovered"]);
});
