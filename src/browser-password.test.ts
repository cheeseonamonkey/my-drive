// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { offerToSaveVaultPassword } from './browser-password';

const oldPassword = Object.getOwnPropertyDescriptor(window, 'PasswordCredential');
const oldCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');

afterEach(() => {
  if (oldPassword) Object.defineProperty(window, 'PasswordCredential', oldPassword);
  else delete (window as Window & { PasswordCredential?: unknown }).PasswordCredential;
  if (oldCredentials) Object.defineProperty(navigator, 'credentials', oldCredentials);
  else Reflect.deleteProperty(navigator, 'credentials');
  vi.restoreAllMocks();
});

describe('browser password manager', () => {
  it('offers the vault password and repository identifier after authentication', async () => {
    const store = vi.fn().mockResolvedValue(undefined);
    const factory = vi.fn().mockImplementation(function (values) { return { values }; });
    Object.defineProperty(window, 'PasswordCredential', { configurable: true, value: factory });
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { store } });

    offerToSaveVaultPassword('cheeseonamonkey/my-drive', 'a long random vault password');

    expect(factory).toHaveBeenCalledWith({
      id: 'cheeseonamonkey/my-drive',
      name: 'My Drive vault',
      password: 'a long random vault password',
    });
    expect(store).toHaveBeenCalledWith(factory.mock.results[0].value);
  });

  it('silently leaves saving to native form autofill on unsupported browsers', () => {
    Object.defineProperty(window, 'PasswordCredential', { configurable: true, value: undefined });
    expect(() => offerToSaveVaultPassword('repo/test', 'password')).not.toThrow();
  });

  it('does not block vault access when the browser refuses to store credentials', async () => {
    const store = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    Object.defineProperty(window, 'PasswordCredential', {
      configurable: true,
      value: class { constructor(public input: unknown) {} },
    });
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { store } });
    expect(() => offerToSaveVaultPassword('repo/test', 'password')).not.toThrow();
    await Promise.resolve();
    expect(store).toHaveBeenCalledOnce();
  });
});
