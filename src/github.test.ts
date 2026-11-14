import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64, encodePath, GitHubDrive, MAX_UPLOAD_BYTES } from './github';

afterEach(() => vi.unstubAllGlobals());

describe('GitHub API adapter', () => {
  it('encodes path segments, preserving folder boundaries', () => {
    expect(encodePath('notes/a #1.txt')).toBe('notes/a%20%231.txt');
  });

  it('encodes binary bytes and utf-8 safely', () => {
    expect(encodeBase64(new Uint8Array([0, 255, 128]))).toBe('AP+A');
    expect(encodeBase64(new TextEncoder().encode('café'))).toBe('Y2Fmw6k=');
  });

  it('includes the existing blob SHA for a replacement', async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new GitHubDrive('test-token', 'user/store');
    await api.write('notes/a.txt', new TextEncoder().encode('test'), 'old-sha');
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/repos/user/store/contents/notes/a.txt');
    const body = JSON.parse(options.body as string);
    expect(body).toMatchObject({ sha: 'old-sha', content: 'dGVzdA==' });
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('rejects oversized uploads before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const api = new GitHubDrive('token', 'user/store');
    await expect(api.write('large', new Uint8Array(MAX_UPLOAD_BYTES + 1))).rejects.toThrow('10 MiB');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
