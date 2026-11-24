import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('../bin/tick.js', import.meta.url));
const tty = 'data:text/javascript,' + encodeURIComponent(
  'for (const stream of [process.stdin, process.stdout, process.stderr]) stream.isTTY = true;'
);

async function fixture(t, { oldServer = false, taskCount = 102, holdSearch } = {}) {
  const calls = [];
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: i + 1, name: 'Review', client_name: 'Acme', project_name: 'Beta',
  }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/^\/42\/api\/v2\//, '').replace(/\.json$/, '');
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path, query: url.searchParams, body: body && JSON.parse(body) });
    if (path === 'tasks/search' && holdSearch) return holdSearch();
    let data;
    if (path === 'me') data = { id: 7 };
    if (path === 'users') data = [{ id: 7 }];
    if (path === 'tasks/recent' && url.searchParams.get('user_id') === '7') {
      data = [
        { id: 2, name: 'Track', project_id: 90, project_name: 'Alpha', client_name: 'A\n\x1bB' },
        { id: 3, name: 'Closed', project_id: 90, date_closed: '2026-08-01' },
      ];
    }
    if (path === 'tasks/search' && !oldServer && url.searchParams.get('q')?.toLowerCase() === 'review') {
      const start = (Number(url.searchParams.get('page')) - 1) * 100;
      data = tasks.slice(start, start + 100);
    }
    if (/^tasks\/\d+$/.test(path)) data = { id: Number(path.slice(6)) };
    if (path === 'entries' && req.method === 'POST') data = { ...JSON.parse(body).entry, id: 55 };
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = {
    TICK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    TICK_SUBSCRIPTION_ID: '42', TICK_API_TOKEN: 'fixture',
  };
  async function run(args, input = '', interactive = true) {
    const child = spawn(process.execPath, [...(interactive ? ['--import', tty] : []), binary, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    const done = once(child, 'close');
    if (typeof input === 'function') await input(child.stdin);
    else child.stdin.end(input);
    const [code] = await done;
    return { code, stdout: stripVTControlCharacters(stdout), stderr };
  }
  return { calls, run };
}

test('interactive log searches assigned pages, disambiguates duplicate tasks, and posts the selected ID', async t => {
  const { calls, run } = await fixture(t);
  const { code, stderr } = await run(['log', '45m', '--notes', 'Check'], '99\nrVIeW' + '\x1b[D'.repeat(4) + 'e\n' + '/more\n'.repeat(7) + '2\n');
  assert.equal(code, 0, stderr);
  assert.match(stderr, /1\. A  B \/ Alpha \/ Track \(#2\)/);
  assert.doesNotMatch(stderr, /Closed/);
  assert.match(stderr, /Choose a number from the list/);
  assert.match(stderr, /15\. Acme \/ Beta \/ Review \(#15\)/);
  assert.match(stderr, /2\. Acme \/ Beta \/ Review \(#102\)/);
  assert.deepEqual(calls.filter(c => c.path === 'tasks/search').map(c => c.query.get('page')), ['1', '2']);
  assert.deepEqual(calls.filter(c => c.path.startsWith('projects')).map(c => c.path), []);
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.body), [
    { entry: { task_id: 102, hours: 0.75, notes: 'Check', user_id: 7 } },
  ]);
});

test('Enter, EOF, Ctrl-D, Ctrl-C, and interactive dry-run leave entries untouched', async t => {
  const { calls, run } = await fixture(t);
  for (const answer of ['\n', '', '\x04', '\x03']) {
    const result = await run(['log', '45m'], answer);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Cancelled/);
  }
  const dry = await run(['log', '45m', '--dry-run'], '1\n');
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /dry_run: true/);
  assert.match(dry.stdout, /task_id: 2/);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('Ctrl-C cancels a search while its response is pending', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers();
  const { calls, run } = await fixture(t, { holdSearch: started.resolve });
  const result = await run(['log', '45m'], async stdin => {
    stdin.write('Review\n');
    await started.promise;
    stdin.end('\x03');
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Cancelled/);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('invalid input and scripted log commands do not enter the picker', async t => {
  const { calls, run } = await fixture(t);
  for (const result of [
    await run(['log', '45m'], '', false),
    await run(['log', '45m', '--json']),
    await run(['call', 'log_time'], '{"duration":"45m"}', false),
  ]) {
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Missing required input: task_id/);
  }
  for (const args of [['0m'], ['25h'], ['45m', '--date', '2026-02-30']]) {
    assert.equal((await run(['log', ...args])).code, 2);
  }
  assert.deepEqual(calls, []);
});

test('older servers preserve the recent menu after a search', async t => {
  const { calls, run } = await fixture(t, { oldServer: true });
  const result = await run(['log', '1h'], 'Review\n1\n');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /tick tasks search <name>/);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body.entry.task_id), [2]);
});

test('an empty continuation preserves the last numbered choices', async t => {
  const { calls, run } = await fixture(t, { taskCount: 100 });
  const result = await run(['log', '45m'], 'review\n' + '/more\n'.repeat(7) + '10\n');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /No more results\./);
  assert.doesNotMatch(result.stderr, /No tasks found/);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body.entry.task_id), [100]);
});
