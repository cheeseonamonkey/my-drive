import { afterEach, describe, expect, it, vi } from 'vitest';
import handler, { Env } from './index';

const site = 'https://cheeseonamonkey.github.io';
const uuid = '9a14cfa7-7eb3-4b84-b48a-9ebc8bb74f4f';
const secret = 'a-very-long-random-session-secret-for-testing';
const origin = { Origin: site };
const auth = { ...origin, Authorization: 'Bearer github_pat_valid_token_12345' };

function bucket(): Env['BLOCKS'] {
  const objects = new Map<string, Uint8Array>();
  return {
    async get(key) {
      const data = objects.get(key);
      return data ? {
        size: data.length,
        body: new Blob([new Uint8Array(data)]).stream() as ReadableStream<Uint8Array>,
      } : null;
    },
    async head(key) { const data = objects.get(key); return data ? { size: data.length } : null; },
    async put(key, bytes) {
      objects.set(key, new Uint8Array(bytes));
    },
  };
}

function setup() {
  const env: Env = {
    BLOCKS: bucket(),
    GITHUB_OWNER: 'cheeseonamonkey',
    GITHUB_REPO: 'my-drive',
    SESSION_SECRET: secret,
    SITE_URL: site + '/my-drive/',
  };
  const github = vi.fn(async (input: string) => Response.json(
    input.includes('/repos/') ? { permissions: { push: true } } : { login: 'cheeseonamonkey' }
  ));
  vi.stubGlobal('fetch', github);
  return { env, github };
}

function request(path: string, method: string, headers: Record<string, string>, body?: Uint8Array): Request {
  return new Request('https://worker.test' + path, {
    method,
    headers: { ...headers },
    body: body ? new Uint8Array(body) : undefined,
  });
}

async function ticket(env: Env): Promise<string> {
  const response = await handler.fetch(request('/session', 'POST', auth), env);
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('R2 storage worker', () => {
  it('does not authenticate or serve data to a different origin', async () => {
    const { env, github } = setup();
    const response = await handler.fetch(request('/session', 'POST',
      { ...auth, Origin: 'https://other-site.test' }), env);
    expect(response.status).toBe(403);
    expect(github).not.toHaveBeenCalled();
  });

  it('refuses a valid GitHub token from an unauthorized user', async () => {
    const { env } = setup();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ login: 'otheruser' })));
    expect((await handler.fetch(request('/session', 'POST', auth), env)).status).toBe(403);
  });

  it('denies owner tokens without write permission to the storage repository', async () => {
    const { env } = setup();
    vi.stubGlobal('fetch', vi.fn(async (input: string) => Response.json(
      input.includes('/repos/') ? { permissions: { push: false } } : { login: 'cheeseonamonkey' }
    )));
    expect((await handler.fetch(request('/session', 'POST', auth), env)).status).toBe(403);
  });

  it('stores only opaque encrypted bytes and authenticates requests with signed sessions', async () => {
    const { env, github } = setup();
    const token = await ticket(env);
    const headers = { ...origin, Authorization: 'Bearer ' + token };
    const bytes = new Uint8Array(50).fill(211);
    const first = await handler.fetch(request('/blocks/' + uuid, 'PUT', headers, bytes), env);
    expect(first.status).toBe(201);
    const repeated = await handler.fetch(request('/blocks/' + uuid, 'PUT', headers, bytes), env);
    expect(repeated.status).toBe(204);
    const read = await handler.fetch(request('/blocks/' + uuid, 'GET', headers), env);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    expect((await handler.fetch(request('/blocks/' + uuid, 'HEAD', headers), env)).status).toBe(200);
    expect(github).toHaveBeenCalledTimes(2);
  });

  it('rejects forged tickets and malformed IDs', async () => {
    const { env } = setup();
    const token = await ticket(env);
    expect((await handler.fetch(request('/blocks/' + uuid, 'GET', {
      ...origin, Authorization: 'Bearer ' + token.slice(0, -3) + 'abc',
    }), env)).status).toBe(401);
    expect((await handler.fetch(request('/blocks/../../../x', 'GET', {
      ...origin, Authorization: 'Bearer ' + token,
    }), env)).status).toBe(404);
  });

  it('enforces the maximum block size and preflight headers', async () => {
    const { env } = setup();
    const preflight = await handler.fetch(request('/blocks/' + uuid, 'OPTIONS', origin), env);
    expect(preflight.status).toBe(204);
    const token = await ticket(env);
    const headers = { ...origin, Authorization: 'Bearer ' + token };
    const oversized = request('/blocks/' + uuid, 'PUT', headers, new Uint8Array(20));
    expect((await handler.fetch(oversized, env)).status).toBe(413);
  });
});
