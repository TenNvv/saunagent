import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { App } from '../src/tui.js';
import { RoomStore } from '../src/store.js';
import { Room } from '../src/room.js';
import { InputHistory } from '../src/input-history.js';
import { clean } from '../src/presentation.js';
import type { Engine } from '../src/types.js';

test('TUI history recalls latest immediately; Ctrl+C clears, Esc cancels, /quit exits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-tui-'));
  const store = new RoomStore(directory);
  const history = new InputHistory(directory);
  history.add('OLDER_MARKER');
  const room = new Room(store, {
    route: async () => ({ action: 'clarify', question: 'Which task?' }),
  } as unknown as Engine, directory);
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: 100, rows: 30 });
  let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  let quits = 0;
  let pauses = 0;
  room.pause = async () => { pauses++; };
  const app = render(React.createElement(App, { room, demo: true, quit() { quits++; }, reload: async () => {}, ready() {} }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false, patchConsole: false, exitOnCtrlC: false,
  });
  const key = async (text: string) => { output = ''; stdin.write(text); await delay(80); return clean(output).replaceAll('▏', ''); };
  try {
    await delay(80);
    // Tab without candidates must not steal focus or swallow subsequent typing.
    await key('\t');
    await key('\x1b[Z'); // Shift+Tab
    assert.match(await key('LATEST_MARKER'), /room › LATEST_MARKER/);
    await key('\r');
    assert.equal(new InputHistory(directory).entries.at(-1), 'LATEST_MARKER');
    assert.match(await key('\x1b[A'), /room › LATEST_MARKER/);
    assert.match(await key('\x1b[A'), /room › OLDER_MARKER/);
    assert.match(await key('\x1b[B'), /room › LATEST_MARKER/);
    // Repeated restore of exactly the same text must repaint on the FIRST Up.
    for (let attempt = 0; attempt < 3; attempt++) {
      await key('\x03');
      assert.match(await key('\x1b[A'), /room › LATEST_MARKER/);
    }
    // Restoring past newest must return to the saved draft, not skip entries.
    await key('\x03');
    await key('未发送的草稿');
    assert.match(await key('\x1b[A'), /room › LATEST_MARKER/);
    assert.match(await key('\x1b[B'), /room › 未发送的草稿/);
    assert.match(await key('\x03'), /room ›\s*\n/);
    assert.equal(quits, 0);
    assert.equal(pauses, 0);
    assert.match(await key('\x1b[A'), /room › LATEST_MARKER/);
    await key('\x03');
    await key('/qu');
    assert.match(await key('\x1b'), /room › \/qu/);
    assert.match(await key('\x1b[A'), /room › LATEST_MARKER/);
    await key('\x03');
    await key('keep draft');
    await key('\x1b'); // pausing must not edit the draft
    assert.match(await key('!'), /room › keep draft!/);
    assert.equal(pauses, 1);
    await key('\x03');
    // Ctrl+T explicitly moves to sidebar; Tab must leave sidebar focus intact.
    await key('\x14');
    await key('\t');
    await key('IGNORED_IN_SIDEBAR');
    await key('\x14');
    assert.match(await key('/hel'), /room › \/hel/);
    assert.match(await key('\t'), /room › \/help/);
    await key('\x03');
    await key('/quit');
    await key('\r'); // accept the candidate only
    assert.equal(quits, 0);
    await key('\r');
    assert.equal(quits, 1);
  } finally {
    app.unmount(); app.cleanup(); store.release(); rmSync(directory, { recursive: true, force: true });
  }
});

for (const columns of [70, 100]) {
  test(`TUI aligns user messages right and agent messages left at ${columns} columns`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'saunagent-layout-'));
    const store = new RoomStore(directory);
    const room = new Room(store, {} as Engine, directory);
    store.message('user', 'USER_MARKER\n用户第二行');
    store.message('agent-id', 'AGENT_MARKER\n回复第二行');
    store.message('supervisor', 'SUPERVISOR_MARKER');
    store.message('system', 'SYSTEM_MARKER');
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = new PassThrough();
    Object.assign(stdout, { columns, rows: 30 });
    let output = '';
    stdout.on('data', chunk => { output += chunk.toString(); });
    const app = render(React.createElement(App, { room, demo: true, quit() {}, reload: async () => {}, ready() {} }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: false, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await delay(80);
      const lines = clean(output).split('\n');
      for (const marker of ['You', 'USER_MARKER', '用户第二行']) {
        const line = lines.find(line => line.includes(marker));
        assert.ok(line, `missing ${marker}`);
        assert.ok(line.endsWith(`${marker} │`), `user line should touch right padding: ${line}`);
      }
      for (const marker of ['Task', 'AGENT_MARKER', '回复第二行', 'SUPERVISOR_MARKER', 'SYSTEM_MARKER']) {
        const line = lines.find(line => line.includes(`│ ${marker}`));
        assert.ok(line, `agent/system line should start at left padding: ${marker}`);
      }
    } finally {
      app.unmount(); app.cleanup(); store.release(); rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('selecting an agent immediately shows only its conversation and resets details and scrolling', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-selection-'));
  const store = new RoomStore(directory);
  const room = new Room(store, {} as Engine, directory);
  const first = room.createTask('FIRST_AGENT');
  const second = room.createTask('SECOND_AGENT');
  store.message('user', 'FIRST_USER', { taskId: first.id });
  store.message(first.id, 'FIRST_REPLY', { taskId: first.id });
  store.message('user', 'SECOND_USER', { taskId: second.id });
  store.message(second.id, 'SECOND_REPLY', { taskId: second.id });
  store.message('system', 'GLOBAL_MESSAGE');
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: 100, rows: 30 });
  let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  const app = render(React.createElement(App, { room, demo: true, quit() {}, reload: async () => {}, ready() {} }), {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: false, patchConsole: false, exitOnCtrlC: false,
  });
  const key = async (text: string) => { output = ''; stdin.write(text); await delay(80); return clean(output); };
  try {
    await delay(80);
    assert.match(output, /GLOBAL_MESSAGE/);
    await key('\x14');
    let frame = await key('\x1b[B');
    assert.match(frame, /FIRST_AGENT · Conversation/);
    assert.match(frame, /FIRST_USER/);
    assert.match(frame, /FIRST_REPLY/);
    assert.doesNotMatch(frame, /SECOND_USER|SECOND_REPLY|GLOBAL_MESSAGE/);
    await key('\x1b[5~'); // page up should not leave a short conversation blank
    frame = await key('\x04');
    assert.match(frame, /Tools and execution log/);
    frame = await key('\x1b[B');
    assert.match(frame, /SECOND_AGENT · Conversation/);
    assert.match(frame, /SECOND_REPLY/);
    assert.doesNotMatch(frame, /FIRST_USER|FIRST_REPLY|Tools and execution log|Up /);
    await key('\r'); // returning to input keeps the conversation selected
    frame = await key('draft');
    assert.match(frame, /@SECOND_AGENT/);
    assert.match(frame, /SECOND_REPLY/);
    frame = await key('\x1b');
    assert.match(frame, /GLOBAL_MESSAGE/);
    assert.match(frame, /FIRST_REPLY/);
    assert.match(frame, /SECOND_REPLY/);
    assert.match(frame, /room › draft/);
    assert.equal(store.state.messages.length, 5);
  } finally {
    app.unmount(); app.cleanup(); store.release(); rmSync(directory, { recursive: true, force: true });
  }
});
