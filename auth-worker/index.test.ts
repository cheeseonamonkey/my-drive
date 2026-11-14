import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { Env } from './index';

const env: Env = {
  GITHUB_CLIENT_ID: 'Iv1.test',
  GITHUB_CLIENT_SECRET: 'secret',
  SITE_URL: 'https://someone.github.io/drive/',
};
const origin = 'https://someone.github.io';
const verifier = 'x'.repeat(43);
const request = (body: unknown, from = origin) => new Request('https://worker.example/exchange', {
  method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
afterEach(() => vi.unstubAllGlobals());

describe('OAuth exchange Worker', () => {
  it('rejects untrusted origins without contacting GitHub', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await worker.fetch(request({ code: 'code', verifier }, 'https://attacker.example'), env);
    expect(response.status).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid verifier', async () => {
    const response = await worker.fetch(request({ code: 'code', verifier: 'weak' }), env);
    expect(response.status).toBe(400);
  });

  it('exchanges codes without exposing the client secret to the browser', async () => {
    const github = vi.fn(async (_url: string, init?: RequestInit) => {
      const posted = JSON.parse(init!.body as string);
      expect(posted.client_secret).toBe(env.GITHUB_CLIENT_SECRET);
      expect(posted.code_verifier).toBe(verifier);
      expect(posted.redirect_uri).toBe(env.SITE_URL);
      return Response.json({ access_token: 'github-token' });
    });
    vi.stubGlobal('fetch', github);
    const response = await worker.fetch(request({ code: 'code', verifier }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: 'github-token' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(github).toHaveBeenCalledOnce();
  });
});
