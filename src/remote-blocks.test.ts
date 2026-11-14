import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteBlockStore } from './remote-blocks';

const ID = '9a14cfa7-7eb3-4b84-b48a-9ebc8bb74f4f';

afterEach(() => { vi.unstubAllGlobals(); });

describe('large-file transport', () => {
  it('reuses a short-lived session for multiple block requests', async () => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      if (String(url).endsWith('/session')) {
        expect((options.headers as Record<string, string>).Authorization).toBe('Bearer github-token');
        return Response.json({ token: 'signed-session', expiresIn: 1800 });
      }
      expect((options.headers as Record<string, string>).Authorization).toBe('Bearer signed-session');
      if (options.method === 'HEAD') return new Response(null, { status: 404 });
      if (options.method === 'PUT') return new Response(null, { status: 201 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const store = new RemoteBlockStore('https://worker.example/', 'github-token');

    expect(await store.exists(ID)).toBe(false);
    await store.upload(ID, new Uint8Array([4, 5]));
    expect(await store.download(ID)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://worker.example/session',
      'https://worker.example/blocks/' + ID,
      'https://worker.example/blocks/' + ID,
      'https://worker.example/blocks/' + ID,
    ]);
  });

  it('renews the session once after expiration and rejects invalid endpoints', async () => {
    let session = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).endsWith('/session')) return Response.json({ token: 'session-' + ++session, expiresIn: 1800 });
      return new Response(null, { status: session === 1 ? 401 : 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const store = new RemoteBlockStore('https://worker.example/', 'github-token');
    expect(await store.exists(ID)).toBe(true);
    expect(session).toBe(2);
    expect(() => new RemoteBlockStore('http://insecure.example/', 'token')).toThrow('HTTPS');
  });
});
