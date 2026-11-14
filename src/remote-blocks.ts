/** Opaque encrypted-block transport. The Worker never receives plaintext or encryption keys. */
export const REMOTE_BLOCK_BYTES = 8 * 1024 * 1024;
export const MAX_REMOTE_FILE_BYTES = 50 * 1024 ** 3;

function abortError(): DOMException {
  return new DOMException('Transfer cancelled.', 'AbortError');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class RemoteBlockStore {
  private readonly url: URL;
  private session?: Promise<{ token: string; expiresAt: number }>;

  constructor(endpoint: string, private readonly token: string) {
    this.url = new URL(endpoint);
    if (this.url.protocol !== 'https:') throw new Error('Storage Worker must use HTTPS.');
  }

  private async authorization(): Promise<string> {
    if (!this.session) {
      this.session = (async () => {
        const url = new URL('session', this.url.href.endsWith('/') ? this.url : this.url.href + '/');
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + this.token },
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw new Error('R2 storage authentication failed (HTTP ' + response.status + ').');
        const data = await response.json() as { token?: string; expiresIn?: number };
        if (!data.token || !Number.isFinite(data.expiresIn) || data.expiresIn! < 60) {
          throw new Error('R2 storage returned an invalid session.');
        }
        return { token: data.token, expiresAt: Date.now() + data.expiresIn! * 1000 - 30_000 };
      })().catch((error) => { this.session = undefined; throw error; });
    }
    const session = await this.session;
    if (session.expiresAt < Date.now()) {
      this.session = undefined;
      return this.authorization();
    }
    return session.token;
  }

  private async request(id: string, method: 'HEAD' | 'GET' | 'PUT', body?: Uint8Array, signal?: AbortSignal): Promise<Response> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid encrypted block ID.');
    const url = new URL('blocks/' + id, this.url.href.endsWith('/') ? this.url : this.url.href + '/');
    let renewed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      try {
        const session = await this.authorization();
        const response = await fetch(url, {
          method,
          body: body ? new Uint8Array(body) : undefined,
          signal,
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            Authorization: 'Bearer ' + session,
            ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
          },
        });
        if (response.status === 401 && !renewed) {
          renewed = true;
          this.session = undefined;
          continue;
        }
        if (response.ok || (method === 'HEAD' && response.status === 404)) return response;
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) {
          throw new Error('Storage Worker request failed (HTTP ' + response.status + ').');
        }
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (attempt === 4 || (error instanceof Error &&
          (error.message.startsWith('Storage Worker request failed') ||
           error.message.startsWith('R2 storage authentication failed')))) throw error;
      }
      await wait(Math.min(500 * 2 ** attempt, 8000), signal);
    }
    throw new Error('Storage Worker unavailable.');
  }

  async exists(id: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.request(id, 'HEAD', undefined, signal)).ok;
  }

  async upload(id: string, encrypted: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.request(id, 'PUT', encrypted, signal);
  }

  async download(id: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(id, 'GET', undefined, signal);
    const length = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(length) && length > REMOTE_BLOCK_BYTES + 28) {
      throw new Error('Encrypted block exceeds maximum size.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > REMOTE_BLOCK_BYTES + 28) throw new Error('Encrypted block exceeds maximum size.');
    return bytes;
  }
}
