// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import App from './App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('file manager', () => {
  it('connects, lists files, and exposes file details', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/repos/test/files')) {
        return Response.json({ full_name: 'test/files', private: true, default_branch: 'main' });
      }
      if (url.includes('/contents?ref=main')) {
        return Response.json([
          { name: 'docs', path: 'docs', type: 'dir', sha: 'folder-sha', size: 0 },
          { name: 'notes.md', path: 'notes.md', type: 'file', sha: 'abcde12345', size: 12 },
        ]);
      }
      if (url.includes('/contents/notes.md?ref=main')) return new Response('hello');
      throw new Error('Unexpected request: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('yourname/private-files'), { target: { value: 'test/files' } });
    fireEvent.change(screen.getByPlaceholderText('github_pat_…'), { target: { value: 'test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /Open drive/i }));
    await screen.findByText('notes.md');
    expect(screen.getByText('1 files · 1 folders · 12 B in this folder')).toBeTruthy();
    fireEvent.click(screen.getByText('notes.md'));
    await screen.findByText('Location');
    expect(screen.getByText('abcde12345')).toBeTruthy();
    expect(screen.getByRole('link', { name: /File history/i }).getAttribute('href')).toContain('/commits/main/notes.md');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it('disconnects without retaining a manual token', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/repos/test/files')) {
        return Response.json({ full_name: 'test/files', private: true, default_branch: 'main' });
      }
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('yourname/private-files'), { target: { value: 'test/files' } });
    fireEvent.change(screen.getByPlaceholderText('github_pat_…'), { target: { value: 'test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /Open drive/i }));
    await screen.findByText(/test\/files/);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/i }));
    expect((screen.getByPlaceholderText('github_pat_…') as HTMLInputElement).value).toBe('');
  });
});
