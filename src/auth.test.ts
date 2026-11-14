import { describe, expect, it } from 'vitest';
import { authorizationUrl, base64url } from './auth';

describe('OAuth PKCE helpers', () => {
  it('uses URL-safe base64 without padding', () => {
    expect(base64url(new Uint8Array([251, 255, 255]))).toBe('-___');
  });

  it('requests GitHub authorization using S256, a redirect and state', () => {
    const url = new URL(authorizationUrl('Iv1.client', 'https://example.com/repo/', 'random-state', 'challenge'));
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'Iv1.client',
      state: 'random-state',
      redirect_uri: 'https://example.com/repo/',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.has('scope')).toBe(false);
  });
});
