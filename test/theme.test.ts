import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionNameStyle, taskStatusColor, ui } from "../src/theme.js";

test("session names are always accented and bold, with an additional selection highlight", () => {
  assert.deepEqual(sessionNameStyle(), {
    color: ui.accent,
    bold: true,
    inverse: false,
  });
  assert.deepEqual(sessionNameStyle(true), {
    color: ui.accent,
    bold: true,
    inverse: true,
  });
});

test("neutral everyday states; semantic color reserved for attention", () => {
  for (const status of ["queued", "working", "paused", "idle", "completed"]) {
    assert.equal(taskStatusColor(status), undefined);
  }
  assert.equal(taskStatusColor("waiting"), ui.warning);
  assert.equal(taskStatusColor("failed"), ui.error);
  assert.notEqual(ui.accent, ui.warning);
  assert.notEqual(ui.accent, ui.error);
});
