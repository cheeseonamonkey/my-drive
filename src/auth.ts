const FLOW_KEY = 'repodrive.oauth.flow';
const MAX_AGE_MS = 10 * 60 * 1000;

export const oauthConfig = {
  clientId: import.meta.env.VITE_GITHUB_CLIENT_ID?.trim() || '',
  exchangeUrl: import.meta.env.VITE_GITHUB_OAUTH_EXCHANGE_URL?.trim() || '',
};

export const oauthEnabled = Boolean(oauthConfig.clientId && oauthConfig.exchangeUrl);

interface AuthFlow {
  state: string;
  verifier: string;
  repository: string;
  createdAt: number;
}

export function callbackUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).href;
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function authorizationUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  for (const [name, value] of Object.entries({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })) url.searchParams.set(name, value);
  return url.href;
}

export async function beginGitHubLogin(repository: string): Promise<void> {
  if (!oauthEnabled) throw new Error('GitHub sign-in is not configured.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const flow: AuthFlow = { state, verifier, repository, createdAt: Date.now() };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
  window.location.assign(authorizationUrl(oauthConfig.clientId, callbackUrl(), state, challenge));
}

export interface OAuthReturn {
  token: string;
  repository: string;
}

let returnPromise: Promise<OAuthReturn | null> | undefined;

export function completeGitHubLogin(): Promise<OAuthReturn | null> {
  returnPromise ??= processReturn();
  return returnPromise;
}

async function processReturn(): Promise<OAuthReturn | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  if (!code && !error) return null;

  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);

  const saved = sessionStorage.getItem(FLOW_KEY);
  sessionStorage.removeItem(FLOW_KEY);
  if (error) throw new Error('GitHub sign-in was cancelled or denied.');
  if (!oauthEnabled || !saved) throw new Error('GitHub sign-in session was not found. Try again.');

  let flow: AuthFlow;
  try { flow = JSON.parse(saved) as AuthFlow; }
  catch { throw new Error('GitHub sign-in session was invalid. Try again.'); }
  if (!flow.state || state !== flow.state || !flow.verifier ||
      Date.now() - flow.createdAt > MAX_AGE_MS || flow.createdAt > Date.now()) {
    throw new Error('GitHub sign-in expired or failed verification. Try again.');
  }

  const response = await fetch(oauthConfig.exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    body: JSON.stringify({ code, verifier: flow.verifier }),
  });
  const data = await response.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error || 'Could not complete GitHub sign-in.');
  }
  return { token: data.access_token, repository: flow.repository };
}
