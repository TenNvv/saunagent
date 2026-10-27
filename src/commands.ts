import type { Room } from './room.js';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

export const help = `Tab completes slash commands (repeat to cycle, Shift+Tab reverses); Ctrl+T switches tasks/input (Tab does not change focus)
Slash suggestions: ↑↓ Select · Enter Accept (without sending) · Esc Close
Input ↑↓ History (moves cursor first in multiline input); task list ↑↓ Select and view conversation · Esc Back/Pause · PgUp/PgDn Scroll
Alt+Enter or Ctrl+J Newline · Enter Send · Ctrl+D Task details · Ctrl+C Clear input · /quit Exit
@taskID text                       Send directly to a task
/new name [--project project]      Create and select a task
/reply messageID text              Reply to a message
/steer taskID text                 Steer current work
/route messageID taskID            Assign or correct routing
/reroute [messageID]               Retry supervisor routing
/resume [taskID|all]               Resume manually (default: all)
/pause [taskID|all]                Pause after active tools finish
/retry taskID                      Retry failed input
/complete taskID                   Mark complete after user acceptance
/clear [taskID|all]                Summarize to SQLite memory and archive (default: selected task)
/memory [taskID]                   View saved history summaries
/archive taskID · /unarchive taskID Archive/restore a task
/projects                         List projects
/project add name path            Register a project (path may contain spaces)
/model default|supervisor|taskID provider/modelId
/model or /models                 View effective models, protocols and endpoints
/reload                           Save tasks, rebuild and load new code
/project                          View current directory and available projects
/help · /quit · /quit!             Help / Graceful exit / Force exit`;

export async function command(room: Room, input: string, selected?: string): Promise<{ selected?: string; quit?: boolean; force?: boolean; reload?: boolean }> {
  // Absolute directory paths are user input, not slash commands.
  const firstToken = input.trim().split(/\s+/)[0] ?? '';
  let directory = false;
  if (isAbsolute(input.trim())) { try { directory = statSync(input.trim()).isDirectory(); } catch { /* May be a command. */ } }
  if (!input.startsWith('/') || directory || (isAbsolute(firstToken) && (firstToken.slice(1).includes('/') || firstToken === '/'))) {
    const mention = input.match(/^@([^\s]+)\s+([\s\S]+)$/);
    await room.send(mention ? mention[2]! : input, mention ? mention[1]! : selected);
    return { selected };
  }
  const match = input.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)!;
  const name = match[1]!;
  const rest = match[2]?.trim() ?? '';
  const parts = rest.split(/\s+/);
  const first = parts[0] ?? '';
  const tail = rest.slice(first.length).trimStart();
  switch (name) {
    case 'q': case 'quit': case 'quit!': return { quit: true, force: name === 'quit!' };
    case 'reload': return { reload: true, selected };
    case 'help': room.store.message('system', help); break;
    case 'new': {
      const [taskName, project] = rest.split(/\s+--project\s+/);
      return { selected: room.createTask(taskName ?? '', project).id };
    }
    case 'reply': await room.send(tail, undefined, first); break;
    case 'steer': await room.send(tail, first, undefined, 'steer'); break;
    case 'route': await room.assign(first, tail); break;
    case 'reroute': await room.reroute(first); break;
    case 'resume': room.resume(rest || 'all'); break;
    case 'pause': await room.pause(rest || 'all'); break;
    case 'retry': room.retry(rest); break;
    case 'clear': {
      const selector = rest || selected;
      if (!selector) throw new Error('Select a task, or use /clear taskID or /clear all.');
      await room.clear(selector);
      if (selected && room.task(selected).archived) selected = undefined;
      break;
    }
    case 'memory': {
      const memories = room.store.memory.list(rest ? room.task(rest).id : undefined);
      room.store.message('system', memories.length ? memories.map(m => `@${m.taskName} · ${m.createdAt} · ${m.messageCount} messages\n${m.summary}`).join('\n\n') : 'No saved history summaries.');
      break;
    }
    case 'complete': {
      const task = room.task(rest);
      if (task.status === 'working' || task.status === 'queued') throw new Error('Pause the task before marking it complete.');
      task.status = 'completed'; room.store.message('system', `Accepted @${task.name}.`, { taskId: task.id }); break;
    }
    case 'archive': case 'unarchive': {
      const task = room.task(rest);
      if (name === 'archive' && (task.status === 'working' || task.status === 'queued')) throw new Error('Pause the task before archiving.');
      task.archived = name === 'archive';
      if (task.archived && selected === task.id) selected = undefined;
      break;
    }
    case 'projects': room.store.message('system', `Current directory: ${room.cwd}\n${room.projects.map(p => `${p.name}: ${p.cwd}`).join('\n')}`); break;
    case 'project': {
      if (!rest) { room.store.message('system', `Current directory: ${room.cwd}\n${room.projects.map(p => `${p.name}: ${p.cwd}`).join('\n')}`); break; }
      const project = rest.match(/^add\s+(\S+)\s+([\s\S]+)$/);
      if (!project) throw new Error('Usage: /project add name absolute-path');
      room.addProject(project[1]!, project[2]!.replace(/^(["'])(.*)\1$/, '$2'));
      room.store.message('system', `Added project ${project[1]}.`); break;
    }
    case 'models': case 'model': {
      if (!rest) {
        room.store.message('system', room.engine.describeModels ? await room.engine.describeModels() :
          `Default: ${room.store.config.model.provider}/${room.store.config.model.modelId}\nSupervisor: ${room.store.config.supervisorModel.provider}/${room.store.config.supervisorModel.modelId}`);
        break;
      }
      const separator = tail.indexOf('/');
      if (separator < 1 || separator === tail.length - 1) throw new Error('Usage: /model default|supervisor|taskID provider/modelId');
      const model = { provider: tail.slice(0, separator), modelId: tail.slice(separator + 1) };
      if (first === 'default') room.store.config.model = model;
      else if (first === 'supervisor') room.store.config.supervisorModel = model;
      else {
        const task = room.task(first);
        if (task.status === 'working') throw new Error('Pause the task before switching models.');
        task.model = model;
      }
      room.store.saveConfig(); room.store.message('system', `Set ${first} → ${tail}.`); break;
    }
    default: throw new Error(`Unknown command: /${name}. Use /help.`);
  }
  room.changed();
  return { selected };
}
