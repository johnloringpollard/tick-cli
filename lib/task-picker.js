import { createInterface } from 'node:readline';
import { api, positiveId, TickError } from './api.js';
import { ownUser } from './operations.js';

export const display = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

async function* search(get, term) {
  for (let page = 1; ; page++) {
    const tasks = await get('tasks/search', { query: { q: term, page } });
    for (let i = 0; i < tasks.length; i += 15) {
      const choices = tasks.slice(i, i + 15);
      if (tasks.length < 100 && i + 15 >= tasks.length) return choices;
      yield choices;
    }
    if (tasks.length < 100) return [];
  }
}

function showChoices(choices, output) {
  for (const [i, task] of choices.entries()) {
    const label = [task.client_name, task.project_name, task.name].map(display).join(' / ');
    output.write(`  ${i + 1}. ${label} (#${positiveId(task.id, 'task_id')})\n`);
  }
  if (!choices.length) output.write('No tasks found.\n');
}

export async function pickTask(account) {
  const cancel = new AbortController();
  const get = api(account, cancel.signal);
  const userId = await ownUser({ get, account });
  const suggestions = await get('tasks/recent', { query: { user_id: userId } });
  const recent = suggestions.filter(task => !task.date_closed);
  const output = process.stderr;
  output.write('Recent tasks\n');
  showChoices(recent, output);

  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  let closed = false;
  prompt.once('close', () => {
    closed = true;
  });
  prompt.on('SIGINT', () => {
    cancel.abort();
    prompt.close();
  });
  const lines = prompt[Symbol.asyncIterator]();
  let choices = recent;
  let results;
  try {
    for (;;) {
      const more = results ? ', /more for more results' : '';
      if (!closed) {
        prompt.setPrompt(`Choose a number or search by task name${more} (Enter to cancel): `);
        prompt.prompt();
      }
      const { value, done } = await lines.next();
      const answer = value?.trim();
      if (cancel.signal.aborted || done) {
        output.write('\n');
        return null;
      }
      if (!answer) return null;
      if (/^\d+$/.test(answer)) {
        const selected = choices[Number(answer) - 1];
        if (selected) return positiveId(selected.id, 'task_id');
        output.write('Choose a number from the list. Use /search <name> to search for a number.\n');
        continue;
      }
      if (answer === '/more' && !results) {
        output.write('No more results. Enter a task name to search.\n');
        continue;
      }
      if (answer !== '/more') results = search(get, answer.replace(/^\/search\s+/, ''));
      try {
        const next = await results.next();
        if (next.done) results = null;
        if (answer === '/more' && !next.value.length) {
          output.write('No more results.\n');
          continue;
        }
        choices = next.value;
      } catch (error) {
        if (cancel.signal.aborted) return null;
        if (!(error instanceof TickError) || error.details.status !== 404) throw error;
        output.write('This server does not support interactive task search. ' +
          'Use tick tasks search <name>, then tick log <duration> --task-id <id>.\nRecent tasks\n');
        results = null;
        choices = recent;
      }
      showChoices(choices, output);
    }
  } finally {
    prompt.close();
  }
}
