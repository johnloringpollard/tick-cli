import { readFile, mkdir, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { refresh, revoke, discardGrant } from './oauth.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const defaultOrigin = 'https://www.tickspot.com';
const directory = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tick');
export class TickError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function usage(message) {
  throw new TickError('invalid_input', message);
}
export function positiveId(value, name) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    usage(`${name} must be a positive integer.`);
  return Number(value);
}
export function origin(value = defaultOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    usage('TICK_BASE_URL must be an absolute origin.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    usage('TICK_BASE_URL must be an HTTPS origin, or HTTP on loopback.');
  }
  return url.origin;
}
async function saved() {
  const path = join(directory(), 'account.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e instanceof SyntaxError)
      throw new TickError(
        'configuration',
        `Invalid JSON in ${path}. Move that file aside locally, disconnect the previous CLI approval in Tick’s Connected apps, then run tick login.`
      );
    throw new TickError(
      'configuration',
      `Cannot read ${path}. Check its file type and permissions, then retry.`
    );
  }
}
export async function loadAccount() {
  const env = process.env;
  const base = origin(env.TICK_BASE_URL);
  // Keep each credential paired with the exact origin and subscription that supplied it.
  if (env.TICK_API_TOKEN || env.TICK_SUBSCRIPTION_ID || env.TICK_USER_ID) {
    if (!env.TICK_API_TOKEN || !env.TICK_SUBSCRIPTION_ID)
      throw new TickError('configuration', 'Set TICK_API_TOKEN and TICK_SUBSCRIPTION_ID together.');
    return {
      origin: base,
      token: env.TICK_API_TOKEN,
      subscriptionId: positiveId(env.TICK_SUBSCRIPTION_ID, 'TICK_SUBSCRIPTION_ID'),
      userId: env.TICK_USER_ID ? positiveId(env.TICK_USER_ID, 'TICK_USER_ID') : undefined,
    };
  }
  const profile = await saved();
  if (!profile || !profile.token)
    throw new TickError('configuration', 'Run tick login or set TICK_API_TOKEN and TICK_SUBSCRIPTION_ID.');
  const savedOrigin = origin(profile.origin);
  if (env.TICK_BASE_URL && base !== savedOrigin)
    throw new TickError(
      'configuration',
      'Saved credentials belong to a different API origin. Sign in to this origin first.'
    );
  return {
    ...profile,
    origin: savedOrigin,
    subscriptionId: positiveId(profile.subscriptionId, 'subscription id'),
  };
}
export function sessionBinding(account) {
  const fields = [
    account.origin,
    account.subscriptionId,
    account.userId ?? null,
    account.verifiedEmail ?? null,
    ...(account.authType === 'oauth'
      ? ['oauth', account.connectionId, account.scope, account.sessionId]
      : [account.token]),
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
export async function accountForCall(expectedBinding) {
  if (expectedBinding === undefined) return loadAccount();
  const changed = () =>
    new TickError(
      'session_changed',
      'The selected Tick account or its credentials changed. Restart the MCP server to use the new session.'
    );
  let account;
  try {
    account = await loadAccount();
  } catch {
    throw changed();
  }
  if (expectedBinding !== sessionBinding(account)) throw changed();
  return account;
}
async function withProfileLock(action) {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const path = join(directory(), 'account.lock');
  const deadline = Date.now() + 35_000;
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline)
        throw new TickError(
          'configuration',
          'Tick credentials are busy. If no Tick command is running, remove the stale account.lock directory.',
          { lock_directory: path }
        );
      await sleep(100);
    }
  }
  try {
    return await action();
  } finally {
    await rmdir(path);
  }
}
export async function saveAccount(account) {
  let installed = false;
  try {
    await withProfileLock(async () => {
      const previous = await saved();
      await writeAccount(account, async () => {
        if (previous?.authType !== 'oauth') return;
        if (previous.origin !== account.origin)
          throw new TickError(
            'configuration',
            'Log out of the previous Tick origin before switching origins.'
          );
        await revoke(previous);
      });
      installed = true;
    });
  } catch (error) {
    if (!installed && account.authType === 'oauth') await discardGrant(account, error);
    throw error;
  }
}
async function writeAccount(account, beforeInstall) {
  const temp = join(directory(), `.account-${randomUUID()}`);
  try {
    await writeFile(temp, JSON.stringify(account), { flag: 'wx', mode: 0o600 });
    if (beforeInstall) await beforeInstall();
    await rename(temp, join(directory(), 'account.json'));
  } finally {
    await unlink(temp).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
export async function forgetAccount() {
  return withProfileLock(async () => {
    const profile = await saved();
    if (!profile) return false;
    if (profile.authType === 'oauth') {
      const base = origin(profile.origin);
      if (process.env.TICK_BASE_URL && origin(process.env.TICK_BASE_URL) !== base)
        throw new TickError('configuration', 'Saved credentials belong to a different API origin.');
      await revoke({ ...profile, origin: base });
    }
    await unlink(join(directory(), 'account.json'));
    return profile.authType === 'oauth';
  });
}
async function freshOAuth(account) {
  const readSession = async () => {
    const current = await saved();
    if (!current || sessionBinding(current) !== sessionBinding(account))
      throw new TickError('session_changed', 'The Tick login changed. Restart the command.');
    return current;
  };
  const usable = (profile) => profile.expiresAt > Date.now() + (profile.refreshToken ? 30_000 : 0);
  const current = await readSession();
  if (usable(current)) return current;
  return withProfileLock(async () => {
    const latest = await readSession();
    if (usable(latest)) return latest;
    const updated = await refresh(latest);
    await writeAccount(updated);
    return updated;
  });
}
export async function request(url, authorization, method = 'GET', body, signal) {
  const timeout = AbortSignal.timeout(30_000);
  let response;
  const headers = {
    'User-Agent': 'Tick CLI (support@tickspot.com)',
    Accept: 'application/json',
    Authorization: authorization,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    const guidance =
      method === 'GET'
        ? 'Check the connection and API origin.'
        : 'Check Tick for the change before retrying.';
    throw new TickError('network_error', `No response from Tick. ${guidance}`);
  }
  if (!response.ok) {
    const details = { status: response.status };
    if (response.headers.has('retry-after')) details.retry_after = response.headers.get('retry-after');
    const hints = {
      400: 'Check the supplied fields and date filters.',
      401: 'Check the token, subscription and Tick role.',
      403: 'Your Tick role cannot perform this action.',
      404: 'The resource was not found in this account.',
      422: 'Tick could not validate the provided fields.',
      429: 'Wait for Retry-After before sending another request.',
    };
    throw new TickError(
      'api_error',
      `Tick returned HTTP ${response.status}. ${hints[response.status] || (method === 'GET' ? 'Check the service and try again.' : 'Check Tick for the change before retrying.')}`,
      details
    );
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new TickError(
      'invalid_response',
      method === 'GET'
        ? 'Tick returned an invalid JSON response.'
        : 'The response was unreadable. Check Tick for the change before retrying.'
    );
  }
}
export function api(account, signal) {
  return async (path, { query = {}, method = 'GET', body } = {}) => {
    const url = new URL(`/${account.subscriptionId}/api/v2/${path}.json`, account.origin);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    if (account.authType === 'oauth') {
      const current = await freshOAuth(account);
      return request(url, 'Bearer ' + current.token, method, body, signal);
    }
    return request(url, `Token token=${account.token}`, method, body, signal);
  };
}
export async function identity(account, get) {
  let user;
  try {
    user = await get('me');
    if (!Number.isSafeInteger(user?.id) || user.id < 1)
      throw new TickError('invalid_response', 'Tick returned an invalid current user.');
  } catch (error) {
    if (!(error instanceof TickError && error.code === 'api_error' && error.details.status === 404))
      throw error;
    user = await legacyIdentity(account, get);
  }
  if (user && account.userId && account.userId !== Number(user.id))
    throw new TickError('configuration', 'The configured user ID does not match the signed-in Tick user.');
  return user;
}

async function legacyIdentity(account, get) {
  const users = await get('users');
  if (account.authType === 'oauth')
    return users.find((user) => Number(user.id) === account.userId) ?? { id: account.userId };
  if (!account.verifiedEmail || account.userId) {
    if (users.length === 1) return users[0];
    const week = await get('entries/this_week');
    if (week.length) return users.find((u) => Number(u.id) === Number(week[0].user_id));
  }
  if (account.verifiedEmail) {
    const person = users.find((u) => u.email?.toLowerCase() === account.verifiedEmail);
    if (!person)
      throw new TickError(
        'configuration',
        'The signed-in user could not be verified. Sign in with your email again.'
      );
    return person;
  }
}
