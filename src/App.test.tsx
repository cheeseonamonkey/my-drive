// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import App from './App';
import { offerToSaveVaultPassword } from './browser-password';

vi.mock('./browser-password', () => ({ offerToSaveVaultPassword: vi.fn() }));

vi.mock('./vault', () => {
  class FakeVaultDrive {
    static async exists() { return false; }
    static async create() { return new FakeVaultDrive(); }
    async pendingUpload() { return null; }
    async list() {
      return [
        { name: 'Public files', path: 'Public files', type: 'dir', sha: 'public', size: 0 },
        { name: 'notes.md', path: 'notes.md', type: 'file', sha: 'abcde12345', size: 12 },
      ];
    }
    async read() { return new Blob(['hello']); }
  }
  return { VaultDrive: FakeVaultDrive, PUBLIC_FOLDER: 'Public files' };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubGithub() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/repos/test/files')) {
      return Response.json({ full_name: 'test/files', private: true, default_branch: 'main' });
    }
    if (url.includes('/contents?ref=main')) return Response.json([]);
    throw new Error('Unexpected request: ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function connectToSetup() {
  fireEvent.change(screen.getByPlaceholderText('yourname/private-files'), { target: { value: 'test/files' } });
  fireEvent.change(screen.getByPlaceholderText('github_pat_…'), { target: { value: 'test-token' } });
  fireEvent.click(screen.getByRole('button', { name: /Open drive/i }));
  await screen.findByText('Set up encrypted vault');
}

async function initializeVault() {
  fireEvent.change(screen.getByPlaceholderText('Enter a strong passphrase'), {
    target: { value: 'a secure example password' },
  });
  fireEvent.change(screen.getByPlaceholderText('Enter the same passphrase again'), {
    target: { value: 'a secure example password' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /Create encrypted drive/i }));
  await screen.findByText('notes.md');
}

describe('first-run encrypted file manager', () => {
  it('provides setup instructions and only reveals files after vault creation', async () => {
    const fetchMock = stubGithub();
    render(<App />);
    await connectToSetup();
    const passwordField = screen.getByPlaceholderText('Enter a strong passphrase');
    expect(passwordField.getAttribute('name')).toBe('password');
    expect(passwordField.getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByPlaceholderText('Enter the same passphrase again').getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByText(/Git history retains deleted files/)).toBeTruthy();
    expect(screen.queryByText('notes.md')).toBeNull();
    await initializeVault();
    expect(offerToSaveVaultPassword).toHaveBeenCalledWith('test/files', 'a secure example password');
    expect(screen.getByText('1 files · 1 folders · 12 B in this folder')).toBeTruthy();
    fireEvent.click(screen.getByText('notes.md'));
    await screen.findByText('Location');
    expect(screen.getByText('abcde12345')).toBeTruthy();
    const history = screen.getByRole('link', { name: /Encrypted vault history/i }).getAttribute('href')!;
    expect(history).toContain('/commits/main/.vault/state.json');
    expect(history).not.toContain('notes.md');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });


  it('accepts password manager autofill without a React input event', async () => {
    stubGithub();
    render(<App />);
    await connectToSetup();
    const input = screen.getByPlaceholderText('Enter a strong passphrase') as HTMLInputElement;
    const confirmation = screen.getByPlaceholderText('Enter the same passphrase again') as HTMLInputElement;
    // Native autofill can update DOM values without firing React's synthetic onChange.
    input.value = 'password provided by autofill';
    confirmation.value = input.value;
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Create encrypted drive/i }));
    await screen.findByText('notes.md');
    expect(offerToSaveVaultPassword).toHaveBeenCalledWith('test/files', 'password provided by autofill');
  });
  it('disconnects without retaining credentials', async () => {
    stubGithub();
    render(<App />);
    await connectToSetup();
    await initializeVault();
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/i }));
    await waitFor(() => expect(screen.getByPlaceholderText('github_pat_…')).toBeTruthy());
    expect((screen.getByPlaceholderText('github_pat_…') as HTMLInputElement).value).toBe('');
  });

  it('requires acknowledgement of permanent git history and password recovery risk', async () => {
    stubGithub();
    render(<App />);
    await connectToSetup();
    fireEvent.change(screen.getByPlaceholderText('Enter a strong passphrase'), {
      target: { value: 'a secure example password' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter the same passphrase again'), {
      target: { value: 'a secure example password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create encrypted drive/i }));
    await screen.findByText('Please acknowledge the recovery and Git history warnings.');
    expect(offerToSaveVaultPassword).not.toHaveBeenCalled();
    expect(screen.queryByText('notes.md')).toBeNull();
  });
});
