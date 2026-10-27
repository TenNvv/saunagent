import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentMessage } from '../src/presentation.js';
import type { RoomState } from '../src/types.js';

test('normal room hides identifiers and quotes original text while diagnostics retain them', () => {
  const state: RoomState = { version: 1, tasks: [], deliveries: [], routes: [], corrections: [], messages: [
    { id: '189c2f69', sender: 'user', at: '', text: '查看当前目录的项目' },
    { id: '8af1475c', sender: 'supervisor', at: '', replyTo: '189c2f69', text: '→ @查看项目 [08d17f3a]' },
  ] };
  const normal = presentMessage(state.messages[1]!, state);
  assert.equal(normal.header, 'Supervisor ↩ “查看当前目录的项目”');
  assert.equal(normal.text, '→ @查看项目');
  const diagnostic = presentMessage(state.messages[1]!, state, true);
  assert.match(diagnostic.header, /8af1475c.*189c2f69/);
  assert.match(diagnostic.text, /08d17f3a/);
  state.messages[0]!.text = '日志里的 8af1475c 不要删除';
  assert.equal(presentMessage(state.messages[0]!, state).text, state.messages[0]!.text);
});
