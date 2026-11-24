import { createHash } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TickError } from './api.js';

export async function assertTimerTask(ctx, taskId, ownUserId) {
  const unavailable = () =>
    new TickError('task_unavailable', 'Select an open task on an open project assigned to you.');
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw unavailable();
  const task = await ctx.get(`tasks/${taskId}`);
  if (task.date_closed || task.project?.date_closed || !task.project_id) throw unavailable();
  // A project can be visible to an administrator without being assigned to that administrator.
  for (let page = 1; ; page++) {
    const tasks = await ctx.get('tasks', {
      query: { project_id: task.project_id, user_id: ownUserId, page },
    });
    if (tasks.some((row) => Number(row.id) === taskId && Number(row.project_id) === Number(task.project_id)))
      return;
    if (tasks.length < 100) throw unavailable();
    if (page >= 100)
      throw new TickError(
        'task_lookup_limit',
        'Could not verify the task within 10,000 assigned tasks on this project.'
      );
  }
}

export async function saveTimer(ctx, timerId) {
  const write = () => ctx.write('entries/create_from_timer', 'POST', { timer_id: timerId });
  if (ctx.dryRun) return write();
  // Credentials and profiles can rotate while the remote timer stays the same.
  const key = createHash('sha256')
    .update(JSON.stringify([ctx.account.origin, ctx.account.subscriptionId, timerId]))
    .digest('hex');
  const directory = join(homedir(), '.tick', 'timer-saves');
  const lock = join(directory, key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new TickError(
      'timer_save_locked',
      `A save for timer ${timerId} is in progress or its outcome is unknown. Check your timesheet before clearing the lock.`,
      { lock_directory: lock }
    );
  }
  let keepLock = false;
  try {
    await ctx.get(`timers/${timerId}`);
    try {
      return await write();
    } catch (error) {
      // Only an explicit rejection proves that Tick did not commit the write.
      if (error.code === 'api_error' && [400, 401, 403, 404, 422, 429].includes(error.details.status))
        throw error;
      keepLock = true;
      throw new TickError(
        'timer_save_uncertain',
        `Tick did not confirm the save of timer ${timerId}. Check your timesheet before clearing the lock.`,
        { lock_directory: lock }
      );
    }
  } finally {
    if (!keepLock) await rmdir(lock);
  }
}
