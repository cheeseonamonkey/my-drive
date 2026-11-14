/**
 * Offer a saved vault credential through supporting browsers.
 * The native password form handles other password managers.
 * This application never persists the password itself.
 */
export function offerToSaveVaultPassword(repository: string, password: string): void {
  type PasswordCtor = new (value: { id: string; password: string; name: string }) => Credential;
  const PasswordCredentialClass = (window as Window & { PasswordCredential?: PasswordCtor }).PasswordCredential;
  if (!PasswordCredentialClass || !navigator.credentials?.store) return;

  try {
    const credential = new PasswordCredentialClass({
      id: repository,
      name: 'My Drive vault',
      password,
    });
    void navigator.credentials.store(credential).catch(() => {
      // Declining the optional prompt does not affect encryption or unlocking.
    });
  } catch {
    // Some browsers/extensions limit the API; native form autofill still works.
  }
}
