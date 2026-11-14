/**
 * Optional encrypted-block store for RepoDrive.
 * The browser encrypts blocks. This Worker sees only opaque IDs and ciphertext.
 * GitHub owner verification exchanges a PAT for a short-lived signed session.
 */
export interface Env {
  BLOCKS: {
    get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
    head(key: string): Promise<{ size: number } | null>;
    put(key: string, body: Uint8Array): Promise<unknown>;
  };
  SITE_URL: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  SESSION_SECRET: string;
}

const MAX_BLOCK_BYTES = 8 * 1024 * 1024 + 28;
const SESSION_MS = 30 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function respond(status: number, message: string, headers: HeadersInit): Response {
  return new Response(message, {
    status, headers: { ...headers, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}

function encode64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decode64(data: string): Uint8Array {
  if (!/^[\w-]+$/.test(data)) throw new Error('Invalid session');
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)),
    (char) => char.charCodeAt(0));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']);
}

async function createSession(secret: string, owner: string): Promise<string> {
  const payload = encode64(encoder.encode(JSON.stringify({ sub: owner, exp: Date.now() + SESSION_MS })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return payload + '.' + encode64(new Uint8Array(signature));
}

async function validSession(secret: string, bearer: string, owner: string): Promise<boolean> {
  try {
    const parts = bearer.split('.');
    if (parts.length !== 2 || parts[0].length > 300 || parts[1].length > 100) return false;
    const valid = await crypto.subtle.verify('HMAC', await signingKey(secret),
      decode64(parts[1]), encoder.encode(parts[0]));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(decode64(parts[0]))) as { sub?: string; exp?: number };
    return payload.sub === owner && typeof payload.exp === 'number' &&
      payload.exp > Date.now() && payload.exp <= Date.now() + SESSION_MS;
  } catch { return false; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let site: URL;
    try {
      site = new URL(env.SITE_URL);
      if (site.protocol !== 'https:' || !env.GITHUB_OWNER || !/^[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPO || '') ||
        env.SESSION_SECRET?.length < 32 || !env.BLOCKS) {
        throw new Error();
      }
    } catch { return respond(503, 'Storage Worker is not configured.', {}); }

    if (request.headers.get('Origin') !== site.origin) return respond(403, 'Origin not allowed.', {});
    const cors = {
      'Access-Control-Allow-Origin': site.origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, PUT, HEAD, POST, OPTIONS',
      'Access-Control-Max-Age': '3600',
      Vary: 'Origin',
      'Cache-Control': 'no-store',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname;
    const auth = request.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ') || auth.length > 1200) {
      return respond(401, 'Authorization required.', cors);
    }

    if (path === '/session' && request.method === 'POST') {
      const ghToken = auth.slice(7);
      if (!/^[A-Za-z0-9_.-]{10,1000}$/.test(ghToken)) {
        return respond(401, 'Invalid GitHub token.', cors);
      }
      try {
        const result = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: auth,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'RepoDrive-Storage',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (!result.ok) return respond(401, 'GitHub authorization failed.', cors);
        const user = await result.json() as { login?: string };
        if (user.login?.toLowerCase() !== env.GITHUB_OWNER.toLowerCase()) {
          return respond(403, 'Access denied.', cors);
        }
        const repo = await fetch('https://api.github.com/repos/' +
          encodeURIComponent(env.GITHUB_OWNER) + '/' + encodeURIComponent(env.GITHUB_REPO), {
          headers: {
            Authorization: auth,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'RepoDrive-Storage',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (!repo.ok || !(await repo.json() as { permissions?: { push?: boolean } }).permissions?.push) {
          return respond(403, 'Repository write permission required.', cors);
        }
        const ticket = await createSession(env.SESSION_SECRET, env.GITHUB_OWNER.toLowerCase());
        return new Response(JSON.stringify({ token: ticket, expiresIn: SESSION_MS / 1000 }), {
          status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch { return respond(502, 'GitHub authentication unavailable.', cors); }
    }

    const match = /^\/blocks\/([^/]+)$/.exec(path);
    if (!match || !ID.test(match[1]) || !['GET', 'PUT', 'HEAD'].includes(request.method)) {
      return respond(404, 'Not found.', cors);
    }
    if (!await validSession(env.SESSION_SECRET, auth.slice(7), env.GITHUB_OWNER.toLowerCase())) {
      return respond(401, 'Storage session expired.', cors);
    }

    const key = 'blocks/' + match[1].toLowerCase();
    if (request.method === 'HEAD') {
      return new Response(null, { status: await env.BLOCKS.head(key) ? 200 : 404, headers: cors });
    }
    if (request.method === 'GET') {
      const existing = await env.BLOCKS.get(key);
      if (!existing) return respond(404, 'Not found.', cors);
      return new Response(existing.body, {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': String(existing.size) },
      });
    }

    const length = request.headers.get('Content-Length');
    if (!request.body || (length != null && (!Number.isSafeInteger(Number(length)) ||
      Number(length) < 28 || Number(length) > MAX_BLOCK_BYTES))) {
      return respond(413, 'Invalid encrypted block size.', cors);
    }
    if (await env.BLOCKS.head(key)) return new Response(null, { status: 204, headers: cors });
    // Browsers and proxies may omit Content-Length. Cap bytes while reading regardless.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of request.body as ReadableStream<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_BLOCK_BYTES) return respond(413, 'Encrypted block exceeds limit.', cors);
      chunks.push(chunk);
    }
    if (total < 28) return respond(413, 'Invalid encrypted block size.', cors);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    await env.BLOCKS.put(key, bytes);
    return new Response(null, { status: 201, headers: cors });
  },
};
