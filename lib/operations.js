import { api, identity, usage, TickError } from './api.js';
import { assertTimerTask, saveTimer } from './timers.js';

const id = (description) => ({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description });
const text = (description, maxLength = 1000) => ({ type: 'string', maxLength, description });
const bool = (description) => ({ type: 'boolean', description });
const date = { type: 'string', format: 'date', description: 'Calendar date in YYYY-MM-DD format.' };
const page = id('Page number, starting at 1. Paginated lists contain up to 100 records per page.');
const project_id = id('Tick project ID.');
const client_id = id('Tick client ID.');
const task_id = id('Tick task ID.');
const entry_id = id('Tick time entry ID.');
const timer_id = id('Tick timer ID.');
const user_id = id('Tick user ID. Account permissions apply.');
const notes = text('Time entry or timer notes.');
const duration = {
  ...text('Duration such as 45m, 1h30m, or decimal hours such as 1.5.', 24),
  pattern: '^(?:[0-9]+(?:\\.[0-9]+)?h?|[0-9]+m|[0-9]+h[0-9]+m)$',
};
const include_budget = bool('Include recorded hours and remaining budget across all users and dates.');
const state = (...values) => ({ type: 'string', enum: values, description: 'Defaults to open.' });
const filters = {
  project_id,
  task_id,
  billable: bool('Select billable or nonbillable work.'),
  billed: bool('Select billed or unbilled entries.'),
};
const commands = [];
function add(name, command, description, properties, required, run, writeScope = null, positional = [], constraints = {}) {
  commands.push({
    name,
    command,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false, ...constraints },
    positional,
    run,
    writeScope,
    annotations: {
      readOnlyHint: !writeScope,
      destructiveHint: Boolean(writeScope) && name !== 'log_time',
      idempotentHint: !writeScope,
      openWorldHint: name === 'create_user',
    },
  });
}
export function hours(s) {
  const match = /^(\d+)h(\d+)m$/.exec(s);
  const n = match
    ? Number(match[1]) + Number(match[2]) / 60
    : s.endsWith('m')
      ? Number(s.slice(0, -1)) / 60
      : Number(s.replace(/h$/, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 24)
    usage('Duration must be greater than zero and at most 24 hours.');
  return n;
}
const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
function detail(resource, key) {
  return (ctx, args) => ctx.get(`${resource}/${args[key]}`);
}
function budget(resource, key) {
  return async (ctx, args) => {
    const item = await ctx.get(`${resource}/${args[key]}`);
    const { id, name, budget, total_hours } = item;
    if (total_hours == null || !Object.hasOwn(item, 'budget'))
      throw new TickError('invalid_response', 'Budget data was missing from Tick’s response.');
    return {
      id,
      name,
      budget_hours: budget == null ? null : Number(budget),
      total_hours: Number(total_hours),
      budget_remaining:
        budget == null ? null : Math.round((Number(budget) - Number(total_hours)) * 1000) / 1000,
    };
  };
}
function collection(resource, args) {
  return args.state && args.state !== 'open' ? `${resource}/${args.state}` : resource;
}
add(
  'get_account',
  'account',
  'Show the selected subscription and identifiable current user.',
  {},
  [],
  async (ctx) => {
    const user = await identity(ctx.account, ctx.get);
    return {
      subscription_id: ctx.account.subscriptionId,
      user_id: user?.id ?? null,
      user_name: user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : null,
    };
  }
);
add('list_users', 'users list', 'List people visible to this Tick role.', {}, [], (ctx) => ctx.get('users'));
add(
  'list_clients',
  'clients list',
  'List one page of clients visible in the subscription.',
  { state: state('open', 'closed', 'all'), page },
  [],
  (ctx, args) => ctx.get(collection('clients', args), { query: pick(args, ['page']) })
);
add(
  'get_client',
  'clients get',
  'Get a client and its project summary.',
  { client_id },
  ['client_id'],
  detail('clients', 'client_id'),
  null,
  ['client_id']
);
add(
  'list_projects',
  'projects list',
  'List one page of projects and optional account-wide budget balances.',
  { state: state('open', 'closed'), client_id, user_id, include_budget, page },
  [],
  (ctx, args) =>
    ctx.get(collection('projects', args), {
      query: pick(args, ['client_id', 'user_id', 'include_budget', 'page']),
    })
);
add(
  'get_project',
  'projects get',
  'Get a project, its recorded hours and task summary.',
  { project_id },
  ['project_id'],
  detail('projects', 'project_id'),
  null,
  ['project_id']
);
add(
  'get_project_budget',
  'projects budget',
  'Return a project budget, all recorded hours and hours remaining. A null balance means no budget.',
  { project_id },
  ['project_id'],
  budget('projects', 'project_id'),
  null,
  ['project_id']
);
add(
  'list_tasks',
  'tasks list',
  'List one page of tasks with optional project, assigned user and budget filters.',
  { state: state('open', 'closed'), project_id, user_id, include_budget, page },
  [],
  (ctx, args) =>
    ctx.get(collection('tasks', args), {
      query: pick(args, ['project_id', 'user_id', 'include_budget', 'page']),
    })
);
add(
  'get_recent_tasks',
  'tasks recent',
  'List up to 15 suggested tasks with client and project names, sorted for display.',
  { include_budget },
  [],
  (ctx, args) => ctx.get('tasks/recent', { query: args })
);
add(
  'search_tasks',
  'tasks search',
  'Find open tasks by part of their name. Follow next_page to continue searching; choose a task by ID before logging.',
  { query: { ...text('Case-insensitive substring of the task name.', 200), minLength: 1 }, project_id, page },
  ['query'],
  async (ctx, args) => {
    let current = args.page ?? 1;
    const matches = [];
    for (let i = 0; i < 5; i++, current++) {
      const tasks = await ctx.get('tasks', { query: { project_id: args.project_id, page: current } });
      for (const task of tasks)
        if (task.name.toLowerCase().includes(args.query.toLowerCase()))
          matches.push(pick(task, ['id', 'name', 'project_id']));
      if (tasks.length < 100) return { matches, next_page: null };
    }
    return { matches, next_page: current };
  },
  null,
  ['query']
);
add(
  'get_task',
  'tasks get',
  'Get a task and its project and entry summaries.',
  { task_id },
  ['task_id'],
  detail('tasks', 'task_id'),
  null,
  ['task_id']
);
add(
  'get_task_budget',
  'tasks budget',
  'Return a task budget, all recorded hours and hours remaining. Negative means over budget.',
  { task_id },
  ['task_id'],
  budget('tasks', 'task_id'),
  null,
  ['task_id']
);
const name = { ...text('Name.', 255), minLength: 1 };
const budgetHours = { type: 'number', minimum: 0, description: 'Budget in hours.' };
const workFields = {
  name,
  budget: budgetHours,
  billable: bool('Whether time on this resource is billable.'),
  date_closed: { ...date, description: 'Date to close this resource (YYYY-MM-DD).' },
};
const userFields = {
  first_name: { ...name, description: 'First name.' },
  last_name: { ...name, description: 'Last name.' },
  timezone: { ...name, description: 'Tick time zone.' },
  admin: bool('Grant or remove the administrator role in this subscription.'),
  billable_rate: { type: 'number', minimum: 0, maximum: 21474836.47, description: 'Hourly billable rate in this subscription.' },
};
const selectorFields = {
  client: { ...name, description: 'Exact client name.' },
  owner: { ...name, maxLength: 511, description: 'Project owner’s full name, email address, or me.' },
  project: { ...name, description: 'Exact project name. Use client or client_id to qualify it.' },
};
function validLookupMatch(match, kind, clientId) {
  if (!Number.isSafeInteger(match?.id) || match.id < 1 || typeof match.name !== 'string') return false;
  if (kind === 'owner') return typeof match.email === 'string';
  if (kind === 'project') return Number.isSafeInteger(match.client_id) && match.client_id > 0 &&
    typeof match.client_name === 'string' && (clientId === undefined || match.client_id === clientId);
  return true;
}
async function lookup(ctx, kind, name, clientId) {
  const matches = await ctx.get('management/lookup', { query: { kind, name, client_id: clientId } });
  if (!Array.isArray(matches) || !matches.every((match) => validLookupMatch(match, kind, clientId)))
    throw new TickError('invalid_response', 'Tick returned invalid management lookup results.');
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new TickError('not_found', `No ${kind} matches "${name}" in this subscription.`);
  const labels = matches.map((m) => {
    if (kind === 'project') return `${m.name} (project ${m.id}, client ${m.client_name} #${m.client_id})`;
    if (kind === 'owner') return `${m.email} (owner ${m.id})`;
    return `${m.name} (client ${m.id})`;
  });
  const hint = { project: 'Use --client or --project-id.', owner: 'Use an email or --owner-id.', client: 'Use --client-id.' };
  const limit = matches.length === 11 ? ' Showing the first 11 matches.' : '';
  throw new TickError('ambiguous_match', `Multiple matches for "${name}".${limit} ${labels.join(', ')}. ${hint[kind]}`, { matches });
}
async function resolveSelectors(ctx, args) {
  const { client, project, owner, ...ids } = args;
  const named = [client, project, owner].some((value) => value !== undefined);
  if (ctx.account.userId && (named || !ctx.dryRun)) await ownUser(ctx);
  if (client !== undefined) ids.client_id = await lookup(ctx, 'client', client);
  if (project !== undefined) {
    ids.project_id = await lookup(ctx, 'project', project, ids.client_id);
    delete ids.client_id;
  }
  if (owner !== undefined) ids.owner_id = await lookup(ctx, 'owner', owner);
  return ids;
}
function resourceWrites(resource, fields, required, descriptions, createOnly = {}) {
  const key = resource + '_id';
  const collection = resource + 's';
  for (const action of ['create', 'update']) {
    const update = action === 'update';
    const properties = update ? { [key]: id('Tick ' + resource + ' ID.'), ...fields } : { ...fields, ...createOnly };
    const mandatory = new Set(update ? [key] : required);
    if (resource === 'task') properties.client_id = client_id;
    const groups = [];
    for (const [kind, selector] of Object.entries(selectorFields)) {
      const idKey = kind + '_id';
      if (!Object.hasOwn(properties, idKey)) continue;
      properties[kind] = selector;
      if (mandatory.delete(idKey)) groups.push({ oneOf: [{ required: [idKey] }, { required: [kind] }] });
      else groups.push({ not: { required: [idKey, kind] } });
    }
    const constraints = {};
    if (groups.length) constraints.allOf = groups;
    if (resource === 'task') constraints.dependentRequired = { client: ['project'], client_id: ['project'] };
    add(
      action + '_' + resource, collection + ' ' + action, descriptions[action], properties,
      [...mandatory],
      async (ctx, args) => {
        if (update && !Object.keys(args).some((k) => {
          if (args.project !== undefined && (k === 'client' || k === 'client_id')) return false;
          return Object.hasOwn(fields, k) || Object.hasOwn(fields, k + '_id');
        })) usage('Supply at least one field to update.');
        const resolved = await resolveSelectors(ctx, args);
        if (!update) return ctx.write(collection, 'POST', { [resource]: resolved });
        const changes = pick(resolved, Object.keys(fields));
        return ctx.write(collection + '/' + resolved[key], 'PUT', { [resource]: changes });
      },
      'account:write', update ? [key] : [], constraints
    );
  }
}
resourceWrites('user', userFields, ['first_name', 'last_name', 'email'], {
  create: 'Create a user and send an email invitation to this subscription.',
  update: 'Update a membership. Names and time zone can change only for users exclusive to this subscription.',
}, { email: { ...name, description: 'Email address for the invitation.' } });
resourceWrites('client', { name, archive: bool('Whether to archive the client.') }, ['name'], {
  create: 'Create a client in this subscription.',
  update: 'Update a client in this subscription.',
});
resourceWrites('project', {
  ...workFields, client_id, owner_id: id('User ID of the project owner.'),
  recurring: bool('Whether the project recurs monthly.'),
}, ['name', 'client_id', 'owner_id'], {
  create: 'Create a project and assign all subscription users.',
  update: 'Update a project. With a named project target, client or client_id qualifies the project name. Use a project ID to change its client.',
});
resourceWrites('task', { ...workFields, project_id }, ['name', 'project_id'], {
  create: 'Create a task on a project.',
  update: 'Update a task in this subscription.',
});
add(
  'get_my_week',
  'week',
  'Review my current Monday–Sunday week in the subscription time zone. Return recorded entries and totals by date.',
  filters,
  [],
  async (ctx, args) => {
    const entries = await ctx.get('entries/this_week', { query: args });
    const totals = new Map();
    for (const entry of entries)
      totals.set(entry.date, (totals.get(entry.date) ?? 0) + Math.round(Number(entry.hours) * 10000));
    const days = [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, sum]) => ({ date, hours: sum / 10000 }));
    return { total_hours: [...totals.values()].reduce((a, b) => a + b, 0) / 10000, days, entries };
  }
);
add(
  'list_entries',
  'entries list',
  'List one page of visible entries. Use an inclusive date range or a modification timestamp with timezone.',
  {
    start_date: date,
    end_date: date,
    updated_at: { type: 'string', format: 'date-time' },
    ...filters,
    user_id,
    page,
  },
  [],
  (ctx, args) => {
    if (args.updated_at ? args.start_date || args.end_date : !(args.start_date && args.end_date))
      usage('Supply start_date and end_date together, or updated_at alone.');
    if (args.start_date > args.end_date) usage('start_date must precede or equal end_date.');
    return ctx.get('entries', { query: args });
  }
);
add(
  'summarize_time',
  'report',
  'Total recorded hours across all matching entry pages for the inclusive date range. Members see their own time; admins can filter team time by user. Groups by day by default.',
  {
    start_date: date,
    end_date: date,
    ...filters,
    user_id,
    group_by: {
      type: 'string',
      enum: ['day', 'task', 'user'],
      description: 'Group by calendar date, task ID or user ID.',
    },
  },
  ['start_date', 'end_date'],
  async (ctx, args) => {
    const { group_by = 'day', ...query } = args;
    if (args.start_date > args.end_date) usage('start_date must precede or equal end_date.');
    const field = { day: 'date', task: 'task_id', user: 'user_id' }[group_by];
    const groups = new Map();
    const seen = new Set();
    let total = 0;
    for (let page = 1; ; page++) {
      const entries = await ctx.get('entries', { query: { ...query, page } });
      if (seen.size + entries.length > 5000) {
        throw new TickError(
          'report_too_large',
          'The report exceeds 5,000 entries. Narrow its date range or filters.'
        );
      }
      for (const entry of entries) {
        const key = entry[field];
        const units = Math.round(Number(entry.hours) * 10000);
        if (entry.id == null || key == null || entry.hours == null || !Number.isFinite(units))
          throw new TickError('invalid_response', 'Tick returned an incomplete entry for this report.');
        if (seen.has(String(entry.id)))
          throw new TickError(
            'report_changed',
            'The result set changed during pagination. Run the report again.'
          );
        seen.add(String(entry.id));
        const group = groups.get(key) ?? { units: 0, count: 0 };
        group.units += units;
        group.count++;
        groups.set(key, group);
        total += units;
      }
      if (entries.length < 100) break;
    }
    return {
      start_date: query.start_date,
      end_date: query.end_date,
      group_by,
      entry_count: seen.size,
      total_hours: total / 10000,
      groups: [...groups]
        .sort(([a], [b]) => String(a).localeCompare(String(b), 'en', { numeric: true }))
        .map(([key, g]) => ({ [field]: key, hours: g.units / 10000, entry_count: g.count })),
    };
  }
);
add(
  'get_entry',
  'entries get',
  'Get an entry and its task.',
  { entry_id },
  ['entry_id'],
  detail('entries', 'entry_id'),
  null,
  ['entry_id']
);
export async function ownUser(ctx) {
  const user = await identity(ctx.account, ctx.get);
  if (!user)
    throw new TickError(
      'identity_required',
      'Tick cannot identify your user from this token. Use a saved account from tick login --email, with token environment overrides unset.'
    );
  return Number(user.id);
}
async function checkTask(ctx, taskId) {
  if (taskId !== undefined) await ctx.get(`tasks/${taskId}`);
}
function entryFields(args) {
  const fields = pick(args, ['date', 'notes', 'task_id']);
  if (args.duration !== undefined) fields.hours = hours(args.duration);
  return fields;
}
add(
  'log_time',
  'log',
  'Record time on a task for the configured user. An omitted date uses Tick’s current date. Verify the result before retrying.',
  { task_id, duration, date, notes },
  ['task_id', 'duration'],
  async (ctx, args) => {
    const entry = entryFields(args);
    if (!ctx.dryRun) {
      entry.user_id = await ownUser(ctx);
      await checkTask(ctx, args.task_id);
    }
    return ctx.write('entries', 'POST', { entry });
  },
  'time:write',
  ['duration']
);
add(
  'update_entry',
  'entries update',
  'Change your own unbilled time entry by ID.',
  { entry_id, duration, date, notes, task_id },
  ['entry_id'],
  async (ctx, args) => {
    const entry = entryFields(args);
    if (!Object.keys(entry).length) usage('Supply at least one of duration, date, notes or task_id.');
    if (!ctx.dryRun) {
      const record = await ctx.get(`entries/${args.entry_id}`);
      if (Number(record.user_id) !== (await ownUser(ctx)))
        throw new TickError('forbidden', 'This entry belongs to another Tick user.');
      if (record.locked || record.billed)
        throw new TickError('forbidden', 'This entry is billed and locked.');
      await checkTask(ctx, args.task_id);
    }
    return ctx.write(`entries/${args.entry_id}`, 'PUT', { entry });
  },
  'time:write',
  ['entry_id']
);
add(
  'list_timers',
  'timers list',
  'List running and paused timers for this user and subscription.',
  {},
  [],
  (ctx) => ctx.get('timers')
);
add(
  'get_timer',
  'timers get',
  'Get one of your timers.',
  { timer_id },
  ['timer_id'],
  detail('timers', 'timer_id'),
  null,
  ['timer_id']
);
add(
  'start_timer',
  'timers start',
  'Create a running timer on a task. Tick pauses your other running timer in this account.',
  { task_id, notes },
  ['task_id'],
  async (ctx, args) => {
    if (!ctx.dryRun) await assertTimerTask(ctx, args.task_id, await ownUser(ctx));
    return ctx.write('timers', 'POST', { timer: args });
  },
  'time:write',
  ['task_id']
);
add(
  'update_timer',
  'timers update',
  'Change the task or notes of one of your timers.',
  { timer_id, task_id, notes },
  ['timer_id'],
  async (ctx, args) => {
    const timer = pick(args, ['task_id', 'notes']);
    if (!Object.keys(timer).length) usage('Supply task_id, notes or both.');
    if (!ctx.dryRun && args.task_id !== undefined)
      await assertTimerTask(ctx, args.task_id, await ownUser(ctx));
    return ctx.write(`timers/${args.timer_id}`, 'PUT', { timer });
  },
  'time:write',
  ['timer_id']
);
for (const [name, verb, description] of [
  ['pause', 'pause', 'Pause your timer and retain accumulated time.'],
  ['resume', 'start', 'Resume your paused timer. Tick pauses your other running timer in this account.'],
]) {
  add(
    `${name}_timer`,
    `timers ${name}`,
    description,
    { timer_id },
    ['timer_id'],
    async (ctx, args) => {
      if (!ctx.dryRun) {
        const timer = await ctx.get(`timers/${args.timer_id}`);
        if ((verb === 'start') === Boolean(timer.last_started_at)) return timer;
        if (verb === 'start') await assertTimerTask(ctx, Number(timer.task_id), await ownUser(ctx));
      }
      return ctx.write(`timers/${args.timer_id}/${verb}`, 'PUT');
    },
    'time:write',
    ['timer_id']
  );
}
add(
  'save_timer',
  'timers save',
  'Convert your timer into a time entry for today and remove the timer. Check for the saved entry before retrying.',
  { timer_id },
  ['timer_id'],
  (ctx, args) => saveTimer(ctx, args.timer_id),
  'time:write',
  ['timer_id']
);

export const operations = commands;
export const catalog = () =>
  commands.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations,
  }));
export function validate(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) usage('Tool input must be a JSON object.');
  for (const key of schema.required) if (!Object.hasOwn(args, key)) usage(`Missing required input: ${key}.`);
  for (const rule of schema.allOf ?? []) {
    const keys = rule.not?.required ?? rule.oneOf.map((branch) => branch.required[0]);
    const count = keys.filter((key) => Object.hasOwn(args, key)).length;
    if (count > 1 || (rule.oneOf && !count)) usage(`Specify ${rule.oneOf ? 'exactly' : 'at most'} one of ${keys.join(' and ')}.`);
  }
  for (const [key, dependencies] of Object.entries(schema.dependentRequired ?? {})) {
    if (Object.hasOwn(args, key) && !dependencies.every((k) => Object.hasOwn(args, k)))
      usage(`${key} requires ${dependencies.join(', ')}.`);
  }
  for (const [key, v] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) usage(`Unknown input: ${key}.`);
    const p = schema.properties[key];
    if (
      p.type === 'integer' ? !Number.isSafeInteger(v) || v < p.minimum || v > p.maximum : typeof v !== p.type
    )
      usage(`Invalid ${key}: expected ${p.type}.`);
    if (p.type === 'number' && (!Number.isFinite(v) || v < p.minimum))
      usage(`${key} must be a finite number of at least ${p.minimum}.`);
    if (p.type === 'number' && p.maximum !== undefined && v > p.maximum)
      usage(`${key} must be at most ${p.maximum}.`);
    if (p.enum && !p.enum.includes(v)) usage(`${key} must be one of ${p.enum.join(', ')}.`);
    if (p.type === 'string') {
      const length = Object.hasOwn(selectorFields, key) ? Array.from(v).length : v.length;
      if (length > (p.maxLength ?? Infinity) || length < (p.minLength ?? 0))
        usage(`Invalid length for ${key}.`);
      if (p.pattern && !new RegExp(p.pattern).test(v)) usage(`Invalid ${key}. ${p.description}`);
      if (p.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !validCalendarDate(v)))
        usage(`${key} must be a valid YYYY-MM-DD date.`);
      if (
        p.format === 'date-time' &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) ||
          !validCalendarDate(v.slice(0, 10)) ||
          Number.isNaN(Date.parse(v)))
      )
        usage(`${key} must be an ISO timestamp with a time zone.`);
    }
  }
}
function validCalendarDate(date) {
  const parsed = new Date(date + 'T00:00:00Z');
  return !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === date;
}
export function requireWriteAccess(account, scope) {
  if (account.authType !== 'oauth' || account.scope.split(' ').includes(scope)) return;
  if (scope === 'account:write')
    throw new TickError('insufficient_scope', 'Run tick login --allow-admin to authorize account changes.');
  throw new TickError('insufficient_scope', 'Run tick login --allow-writes to authorize time changes.');
}

export function execute(operation, args, account, dryRun = false) {
  validate(operation.inputSchema, args);
  if (dryRun && operation.annotations.readOnlyHint) usage('--dry-run applies to writes only.');
  if (!operation.annotations.readOnlyHint && !dryRun) requireWriteAccess(account, operation.writeScope);
  const get = api(account);
  const write = async (path, method, body) => {
    if (dryRun) {
      return {
        dry_run: true,
        method,
        path: `/${account.subscriptionId}/api/v2/${path}.json`,
        ...(body && { body }),
      };
    }
    return get(path, { method, body });
  };
  return operation.run({ account, get, write, dryRun }, args);
}
