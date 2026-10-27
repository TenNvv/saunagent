import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { RoomStore } from '../src/store.js';
import { Room } from '../src/room.js';
import { PiEngine, demoModels } from '../src/pi.js';

test('real Pi Durable + SQLite: routing, context continuity, and reopen without executing work', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-pi-'));
  let store = new RoomStore(directory);
  let engine = new PiEngine(store, true);
  let room = new Room(store, engine);
  try {
    await room.send('检查播放器启动');
    await room.waitForIdle();
    const task = room.state.tasks[0]!;
    assert.ok(existsSync(join(directory, `${task.id}.sqlite`)));
    assert.match(task.summary, /retained 1 user inputs/);
    await room.send('继续看初始化路径', task.id); await room.waitForIdle();
    assert.match(task.summary, /retained 2 user inputs/);
    await room.stop(); store.release();
    store = new RoomStore(directory); engine = new PiEngine(store, true); room = new Room(store, engine);
    assert.equal(room.state.tasks[0]!.summary, task.summary);
    await room.send('继续第三轮', task.id); await room.waitForIdle();
    assert.match(room.state.tasks[0]!.summary, /retained 3 user inputs/);
    await room.stop();
  } finally { await engine.close(true); store.release(); rmSync(directory, { recursive: true, force: true }); }
});

test('pause/reopen reattaches an unfinished submission with the original request ID', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-recovery-'));
  let store = new RoomStore(directory); let engine = new PiEngine(store, true); let room = new Room(store, engine);
  try {
    const task = room.createTask('Recovery');
    await room.send('原文不能丢失', task.id);
    await delay(70); await room.stop(); store.release();
    store = new RoomStore(directory); engine = new PiEngine(store, true); room = new Room(store, engine);
    const count = room.state.messages.length;
    await delay(100);
    assert.equal(room.state.messages.length, count);
    assert.ok(room.state.deliveries.some(d => d.status === 'queued'));
    room.resume(task.id); await room.waitForIdle();
    assert.equal(room.state.messages.filter(m => m.sender === task.id).length, 1);
    await room.stop();
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, `${task.id}.sqlite`)), { models: demoModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT);
    const transcript = await root.context(BACKGROUND_CONTEXT);
    assert.equal(transcript.messages.filter(m => m.role === 'user' && m.content === '原文不能丢失').length, 1);
    await harness.close(BACKGROUND_CONTEXT);
  } finally { await engine.close(true); store.release(); rmSync(directory, { recursive: true, force: true }); }
});

test('graceful exit waits for the current tool and does not start the next tool', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-tools-'));
  const store = new RoomStore(directory);
  const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 0.3; printf first > first.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('bash', { command: 'printf second > second.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  store.config.model = { provider: 'faux', modelId: 'faux-1' };
  const engine = new PiEngine(store, false, models); const room = new Room(store, engine);
  let started = false;
  engine.log = (_id, text) => { if (text.startsWith('bash ')) started = true; };
  try {
    const task = room.createTask('Tools'); task.cwd = directory;
    await room.send('run both tools', task.id);
    for (let i = 0; i < 200 && !started; i++) await delay(10);
    assert.ok(started, 'first tool started');
    await room.stop();
    assert.ok(existsSync(join(directory, 'first.txt')));
    assert.equal(existsSync(join(directory, 'second.txt')), false);
    assert.equal(room.state.deliveries[0]!.status, 'queued');
    // After close, inspect the actual stored transcript without starting the scheduler.
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, `${task.id}.sqlite`)), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT);
    const transcript = await root.context(BACKGROUND_CONTEXT);
    assert.equal(transcript.messages.filter(m => m.role === 'user' && m.content === 'run both tools').length, 1);
    assert.ok(transcript.messages.some(m => m.role === 'toolResult'));
    await harness.close(BACKGROUND_CONTEXT);
  } finally { await engine.close(true); store.release(); rmSync(directory, { recursive: true, force: true }); }
});

test('internal subagent reads in inherited cwd and returns only to its parent', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-subagent-'));
  const store = new RoomStore(directory);
  const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
  writeFileSync(join(directory, 'fixture.txt'), 'subagent evidence');
  const requests: string[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('subagent', { name: 'reader', message: 'Read fixture.txt and report.' })], { stopReason: 'toolUse' }),
    request => {
      requests.push(JSON.stringify(request));
      return fauxAssistantMessage([fauxToolCall('read', { path: 'fixture.txt' })], { stopReason: 'toolUse' });
    },
    request => {
      const result = request.messages.findLast(m => m.role === 'toolResult');
      requests.push(JSON.stringify(result));
      return fauxAssistantMessage('Internal evidence verified.');
    },
    request => {
      const result = request.messages.findLast(m => m.role === 'toolResult');
      requests.push(JSON.stringify(result));
      return fauxAssistantMessage('Parent final result.');
    },
  ]);
  store.config.model = { provider: 'faux', modelId: 'faux-1' };
  const engine = new PiEngine(store, false, models); const room = new Room(store, engine);
  const trace: string[] = [];
  engine.log = (_id, text) => trace.push(text);
  try {
    const task = room.createTask('Parent'); task.cwd = directory;
    await room.send('Delegate a read.', task.id); await room.waitForIdle();
    assert.equal(room.state.tasks.length, 1);
    assert.equal(room.state.messages.filter(m => m.sender === task.id).length, 1, JSON.stringify({ messages: room.state.messages, trace }));
    assert.equal(task.summary, 'Parent final result.');
    const childRequest = JSON.parse(requests[0]!);
    const toolNames = childRequest.messages.flatMap((message: { toolsAdded?: { name: string }[] }) => message.toolsAdded ?? []).map((tool: { name: string }) => tool.name);
    assert.equal(toolNames.includes('subagent'), false);
    assert.equal(toolNames.includes('ask_user'), false);
    assert.equal(toolNames.includes('read'), true);
    assert.match(requests[1]!, /subagent evidence/);
    assert.match(requests[2]!, /Internal evidence verified/);
    await room.stop();
  } finally { await engine.close(true); store.release(); rmSync(directory, { recursive: true, force: true }); }
});

test('ask_user publishes the question and releases its task slot', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-question-'));
  const store = new RoomStore(directory);
  const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('ask_user', { question: 'Which project?' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Task B finished.'),
  ]);
  store.config.model = { provider: 'faux', modelId: 'faux-1' }; store.config.maxTasks = 1;
  const engine = new PiEngine(store, false, models); const room = new Room(store, engine);
  try {
    const a = room.createTask('A'), b = room.createTask('B');
    await room.send('A needs clarification', a.id); await room.send('B work', b.id);
    await room.waitForIdle();
    assert.equal(a.status, 'waiting');
    assert.equal(room.state.messages.find(m => m.sender === a.id)?.text, 'Which project?');
    assert.equal(b.summary, 'Task B finished.');
    await room.stop();
  } finally { await engine.close(true); store.release(); rmSync(directory, { recursive: true, force: true }); }
});

test('supervisor failures show the persisted provider error instead of a generic routing failure', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-route-error-'));
  const store = new RoomStore(directory);
  const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([], {
    stopReason: 'error', errorMessage: '401 Gateway authentication rejected',
  })));
  store.config.supervisorModel = { provider: 'faux', modelId: 'faux-1' };
  const engine = new PiEngine(store, false, models); const room = new Room(store, engine);
  try {
    await room.send('hello');
    const error = room.state.messages.find(message => message.sender === 'supervisor')!;
    assert.match(error.text, /model_error/);
    assert.match(error.text, /401 Gateway authentication rejected/);
    assert.equal(room.state.tasks.length, 0);
    assert.equal(room.state.routes[0]!.status, 'pending');
    await room.stop();
  } finally { await engine.close(true); store.release(); rmSync(directory, { recursive: true, force: true }); }
});

test('supervisor names a new agent by its goal while preserving original input and manual names', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'saunagent-naming-'));
  const store = new RoomStore(directory);
  const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
  const original = '能不能帮我检查播放器为什么启动失败？\n先看日志，不要改代码。';
  faux.setResponses([
    request => {
      const instructions = JSON.stringify(request);
      assert.match(instructions, /only the new task's display name may summarize its goal/);
      assert.match(instructions, /name the original goal rather than the clarification answer/);
      assert.match(instructions, /Do not copy conversational framing/);
      return fauxAssistantMessage(JSON.stringify({ action: 'new', name: '排查播放器启动失败' }));
    },
    request => {
      assert.ok(request.messages.some(message => message.role === 'user' && message.content === original));
      return fauxAssistantMessage('已检查日志。');
    },
  ]);
  store.config.model = store.config.supervisorModel = { provider: 'faux', modelId: 'faux-1' };
  const engine = new PiEngine(store, false, models); const room = new Room(store, engine);
  try {
    const manual = room.createTask('我的自定义名字');
    await room.send(original); await room.waitForIdle();
    const task = room.state.tasks.find(task => task.id !== manual.id)!;
    assert.equal(task.name, '排查播放器启动失败');
    assert.equal(room.state.messages.find(message => message.sender === 'user')!.text, original);
    assert.equal(manual.name, '我的自定义名字');
    await room.stop();
    assert.equal(JSON.parse(readFileSync(join(directory, 'room.json'), 'utf8')).tasks.find((saved: { id: string }) => saved.id === task.id).name, task.name);
  } finally { await engine.close(true); store.release(); rmSync(directory, { recursive: true, force: true }); }
});
