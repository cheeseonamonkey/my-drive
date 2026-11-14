export interface RepoDetails {
  full_name: string;
  default_branch: string;
  private: boolean;
}

export interface Entry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export class GitHubDrive {
  private readonly base: string;

  constructor(private readonly token: string, repository: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
      throw new Error('Enter a repository as owner/name.');
    }
    this.base = `/repos/${repository}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`https://api.github.com${this.base}${path}`, {
      ...init,
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(`${error.message || 'GitHub request failed'} (HTTP ${response.status})`);
    }
    return response;
  }

  async details(): Promise<RepoDetails> {
    const response = await this.request('');
    return response.json() as Promise<RepoDetails>;
  }

  async list(path: string, branch: string): Promise<Entry[]> {
    const suffix = path ? `/${encodePath(path)}` : '';
    const response = await this.request(`/contents${suffix}?ref=${encodeURIComponent(branch)}`);
    const entries = await response.json() as Entry[] | Entry;
    if (!Array.isArray(entries)) throw new Error('This path is not a folder.');
    return entries
      .filter((item) => item.name !== '.gitkeep')
      .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async deleteEmptyFolder(path: string, branch: string): Promise<void> {
    const response = await this.request(`/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    const files = await response.json() as Entry[];
    if (!Array.isArray(files) || files.length !== 1 || files[0].name !== '.gitkeep') {
      throw new Error('Only empty folders created by RepoDrive can be removed.');
    }
    await this.delete(files[0].path, files[0].sha);
  }

  async read(path: string, branch: string): Promise<Blob> {
    const response = await this.request(
      `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
      { headers: { Accept: 'application/vnd.github.raw+json' } },
    );
    return response.blob();
  }

  async write(path: string, bytes: Uint8Array, sha?: string): Promise<void> {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('Files must be under 10 MiB.');
    await this.request(`/contents/${encodePath(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `${sha ? 'Update' : 'Add'} ${path}`,
        content: encodeBase64(bytes),
        ...(sha ? { sha } : {}),
      }),
    });
  }

  async delete(path: string, sha: string): Promise<void> {
    await this.request(`/contents/${encodePath(path)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Delete ${path}`, sha }),
    });
  }
}
