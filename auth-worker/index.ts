/**
 * Minimal GitHub App OAuth code exchange for RepoDrive.
 * The Worker never stores tokens or accepts requests from other browser origins.
 */
export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SITE_URL: string;
}

function json(body: object, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let site: URL;
    try {
      site = new URL(env.SITE_URL);
      if (site.protocol !== 'https:' || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return json({ error: 'OAuth Worker is not configured.' }, 503, {});
      }
    } catch { return json({ error: 'OAuth Worker is not configured.' }, 503, {}); }

    const origin = request.headers.get('Origin');
    const headers = {
      'Access-Control-Allow-Origin': site.origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    if (origin !== site.origin) return json({ error: 'Origin not allowed.' }, 403, { Vary: 'Origin' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/exchange') {
      return json({ error: 'Not found.' }, 404, headers);
    }
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
      return json({ error: 'Expected JSON.' }, 415, headers);
    }
    if (Number(request.headers.get('Content-Length') || '0') > 4096) {
      return json({ error: 'Request too large.' }, 413, headers);
    }

    let payload: { code?: string; verifier?: string };
    try {
      const body = await request.text();
      if (body.length > 4096) return json({ error: 'Request too large.' }, 413, headers);
      payload = JSON.parse(body) as typeof payload;
    } catch { return json({ error: 'Invalid JSON.' }, 400, headers); }

    if (!payload || typeof payload.code !== 'string' || payload.code.length < 1 || payload.code.length > 400 ||
      typeof payload.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(payload.verifier)) {
      return json({ error: 'Invalid authorization code or PKCE verifier.' }, 400, headers);
    }

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: payload.code,
        code_verifier: payload.verifier,
        redirect_uri: site.href,
      }),
    });
    if (!response.ok) return json({ error: 'GitHub authorization unavailable.' }, 502, headers);
    const data = await response.json() as { access_token?: string; error?: string };
    if (!data.access_token) return json({ error: 'GitHub declined this authorization.' }, 401, headers);
    return json({ access_token: data.access_token }, 200, headers);
  },
};
