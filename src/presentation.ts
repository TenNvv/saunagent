import type { RoomMessage, RoomState } from './types.js';

export const clean = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export function presentMessage(message: RoomMessage, state: RoomState, showIds = false) {
  const sender = message.sender === 'user' ? 'You' : message.sender === 'supervisor' ? 'Supervisor' : message.sender === 'system' ? 'System' : state.tasks.find(task => task.id === message.sender)?.name ?? 'Task';
  const reply = message.replyTo ? state.messages.find(original => original.id === message.replyTo) : undefined;
  const quote = reply ? clean(reply.text).replace(/\s+/g, ' ').slice(0, 36) : '';
  const pending = state.routes.some(route => route.messageId === message.id && route.status !== 'done');
  const header = `${showIds ? `[${message.id}] ` : ''}${clean(sender)}${message.replyTo ? showIds ? ` ↩ ${message.replyTo}` : quote ? ` ↩ “${quote}”` : ' ↩ Reply' : ''}${pending ? ' · Pending routing' : ''}`;
  let text = message.text;
  if (!showIds && message.sender === 'supervisor') {
    text = text.replace(/^(→ @.+) \[[a-f0-9]{8}\]$/m, '$1')
      .replace(/\n使用 \/route [a-f0-9]{8}[^\n]*/g, '\nReply directly in the room.')
      .replace(/用 \/route [a-f0-9]{8}[^\n]*重试。/g, 'Use /reroute to retry.');
  }
  return { header, text };
}

/** Selection changes the visible conversation only, never the stored room history. */
export function conversationMessages(state: RoomState, taskId?: string): RoomMessage[] {
  return taskId ? state.messages.filter(message => message.taskId === taskId || message.sender === taskId) : state.messages;
}
