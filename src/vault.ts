import { Entry, GitHubDrive, GitHubError, MAX_UPLOAD_BYTES } from './github';
import {
  BLOCK_BYTES, blockAAD, createHeader, deriveKey, fromBase64, parseHeader,
  randomId, seal, sealManifest, toBase64, unseal, unsealManifest, VaultHeader,
} from './vault-crypto';
import { validName } from './file';

export const VAULT_FILE = '.vault/state.json';
export const PUBLIC_FOLDER = 'Public files';
const PUBLIC_PREFIX = 'public-files';
const encoder = new TextEncoder();

interface EncryptedRecord {
  path: string;
  id: string;
  type: 'file' | 'dir';
  size: number;
  blocks: string[];
}

interface VaultIndex {
  version: 1;
  entries: EncryptedRecord[];
}

interface PersistedState {
  header: VaultHeader;
  encryptedIndex: string;
}

function ensureIndex(value: VaultIndex): VaultIndex {
  if (!value || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 100000) {
    throw new Error('Unsupported or damaged encrypted index.');
  }
  const seen = new Set<string>();
  for (const item of value.entries) {
    if (!item || typeof item.path !== 'string' ||
      item.path.split('/').some((part) => !validName(part)) ||
      item.path === PUBLIC_FOLDER || item.path.startsWith(PUBLIC_FOLDER + '/') ||
      typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id) ||
      (item.type !== 'file' && item.type !== 'dir') ||
      !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_UPLOAD_BYTES ||
      !Array.isArray(item.blocks) || item.blocks.length > Math.ceil(MAX_UPLOAD_BYTES / BLOCK_BYTES) ||
      item.blocks.some((block) => typeof block !== 'string' || !/^[a-f0-9-]{36}$/.test(block)) ||
      (item.type === 'dir' && (item.blocks.length || item.size)) ||
      seen.has(item.path)) {
      throw new Error('Damaged encrypted filesystem index.');
    }
    seen.add(item.path);
  }
  return value;
}

function publicPath(path: string): string | null {
  if (path === PUBLIC_FOLDER) return PUBLIC_PREFIX;
  if (path.startsWith(PUBLIC_FOLDER + '/')) return PUBLIC_PREFIX + path.slice(PUBLIC_FOLDER.length);
  return null;
}

function virtualPublicPath(path: string): string {
  return PUBLIC_FOLDER + path.slice(PUBLIC_PREFIX.length);
}

export class VaultDrive {
  private constructor(
    private readonly github: GitHubDrive,
    private readonly branch: string,
    private readonly key: CryptoKey,
    private readonly header: VaultHeader,
    private sha: string,
    private index: VaultIndex,
  ) {}

  static async exists(github: GitHubDrive, branch: string): Promise<boolean> {
    return Boolean(await github.stat(VAULT_FILE, branch));
  }

  static async create(github: GitHubDrive, branch: string, password: string): Promise<VaultDrive> {
    if (await this.exists(github, branch)) throw new Error('A vault already exists in this repository.');
    const header = createHeader();
    const key = await deriveKey(password, header);
    const index: VaultIndex = { version: 1, entries: [] };
    const encryptedIndex = toBase64(await sealManifest(key, index));
    const contents: PersistedState = { header, encryptedIndex };
    const sha = await github.write(VAULT_FILE, encoder.encode(JSON.stringify(contents)));
    if (!sha) throw new Error('Vault was written, but GitHub did not return its version. Reconnect to unlock it.');
    return new VaultDrive(github, branch, key, header, sha, index);
  }

  static async unlock(github: GitHubDrive, branch: string, password: string): Promise<VaultDrive> {
    const stat = await github.stat(VAULT_FILE, branch);
    if (!stat) throw new Error('No encrypted vault found. Create it first.');
    const bytes = await github.read(VAULT_FILE, branch);
    let state: PersistedState;
    try { state = JSON.parse(await bytes.text()) as PersistedState; }
    catch { throw new Error('Vault state is not valid JSON.'); }
    const header = parseHeader(state.header ? JSON.stringify(state.header) : '');
    if (typeof state.encryptedIndex !== 'string') throw new Error('Vault index is missing.');
    const key = await deriveKey(password, header);
    const index = ensureIndex(await unsealManifest<VaultIndex>(key, fromBase64(state.encryptedIndex)));
    return new VaultDrive(github, branch, key, header, stat.sha, index);
  }

  private record(path: string): EncryptedRecord | undefined {
    return this.index.entries.find((entry) => entry.path === path);
  }

  private async persist(entries: EncryptedRecord[]): Promise<void> {
    const index: VaultIndex = { version: 1, entries };
    const encryptedIndex = toBase64(await sealManifest(this.key, index));
    const contents: PersistedState = { header: this.header, encryptedIndex };
    const sha = await this.github.write(VAULT_FILE, encoder.encode(JSON.stringify(contents)), this.sha);
    if (!sha) throw new Error('Vault changes were written, but their GitHub version is unavailable. Reconnect.');
    this.index = index;
    this.sha = sha;
  }

  private async cleanup(blocks: string[]): Promise<void> {
    const failures: string[] = [];
    for (const id of blocks) {
      const path = `.vault/blocks/${id}.bin`;
      try {
        const entry = await this.github.stat(path, this.branch);
        if (entry) await this.github.delete(path, entry.sha);
      } catch { failures.push(id); }
    }
    if (failures.length) {
      throw new Error(`Vault updated, but ${failures.length} obsolete encrypted blocks remain in the repository. They can be cleaned up later.`);
    }
  }

  private async publicList(path: string): Promise<Entry[]> {
    try {
      const entries = await this.github.list(path, this.branch);
      return entries.map((entry) => ({
        ...entry,
        path: virtualPublicPath(entry.path),
      }));
    } catch (error) {
      if (path === PUBLIC_PREFIX && error instanceof GitHubError && error.status === 404) return [];
      throw error;
    }
  }

  async list(path: string, branch: string): Promise<Entry[]> {
    if (branch !== this.branch) throw new Error('Different branch is not supported.');
    const remote = publicPath(path);
    if (remote) return this.publicList(remote);

    if (path && !this.record(path)) throw new Error('Folder not found.');
    const entries = this.index.entries.filter((item) => {
      if (path) return item.path.startsWith(path + '/') &&
        !item.path.slice(path.length + 1).includes('/');
      return !item.path.includes('/');
    }).map((item): Entry => ({
      name: item.path.split('/').at(-1)!,
      path: item.path,
      sha: item.id,
      size: item.size,
      type: item.type,
    }));
    if (!path) entries.push({
      name: PUBLIC_FOLDER, path: PUBLIC_FOLDER, sha: 'public', size: 0, type: 'dir',
    });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(path: string, branch: string): Promise<Blob> {
    if (branch !== this.branch) throw new Error('Different branch is not supported.');
    const remote = publicPath(path);
    if (remote) return this.github.read(remote, branch);
    const file = this.record(path);
    if (!file || file.type !== 'file') throw new Error('File not found.');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('File exceeds the local size limit.');

    const chunks: Uint8Array[] = [];
    let size = 0;
    for (const id of file.blocks) {
      const blob = await this.github.read(`.vault/blocks/${id}.bin`, branch);
      if (blob.size > BLOCK_BYTES + 28) throw new Error('Encrypted block exceeds size limit.');
      const cipher = new Uint8Array(await blob.arrayBuffer());
      const plaintext = await unseal(this.key, cipher, blockAAD(id));
      size += plaintext.length;
      if (size > MAX_UPLOAD_BYTES) throw new Error('Encrypted file is unexpectedly large.');
      chunks.push(plaintext);
    }
    if (size !== file.size) throw new Error('Encrypted file failed size verification.');
    return new Blob(chunks.map((chunk) => new Uint8Array(chunk)));
  }

  async write(path: string, bytes: Uint8Array, sha?: string): Promise<void> {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('Files must be under 10 MiB.');
    const remote = publicPath(path);
    if (remote) {
      if (remote === PUBLIC_PREFIX) throw new Error('Choose a file in Public files.');
      await this.github.write(remote, bytes, sha);
      return;
    }

    if (path === PUBLIC_FOLDER || path.startsWith(PUBLIC_FOLDER + '/')) throw new Error('Reserved folder.');
    if (path.split('/').some((part) => !validName(part))) throw new Error('Invalid file path.');
    if (path.endsWith('/.gitkeep')) {
      const folder = path.slice(0, -'/.gitkeep'.length);
      const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
      if (parent && this.record(parent)?.type !== 'dir') throw new Error('Parent folder not found.');
      if (!folder || this.record(folder)) throw new Error('Folder already exists.');
      await this.persist([...this.index.entries, { id: randomId(), path: folder, type: 'dir', size: 0, blocks: [] }]);
      return;
    }
    const folderPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (folderPath && this.record(folderPath)?.type !== 'dir') throw new Error('Parent folder not found.');

    const previous = this.record(path);
    if (previous?.type === 'dir' || (previous && sha !== previous.id) || (!previous && sha)) {
      throw new Error('File changed since you last opened the folder. Refresh before modifying it.');
    }
    const blocks: string[] = [];
    for (let start = 0; start < bytes.byteLength; start += BLOCK_BYTES) {
      const id = randomId();
      const ciphertext = await seal(this.key, bytes.slice(start, start + BLOCK_BYTES), blockAAD(id));
      await this.github.write(`.vault/blocks/${id}.bin`, ciphertext);
      blocks.push(id);
    }
    const next = this.index.entries.filter((item) => item.path !== path);
    next.push({ id: randomId(), path, type: 'file', size: bytes.length, blocks });
    await this.persist(next);
    if (previous) await this.cleanup(previous.blocks);
  }

  async delete(path: string, sha: string): Promise<void> {
    const remote = publicPath(path);
    if (remote) return this.github.delete(remote, sha);
    const entry = this.record(path);
    if (!entry || entry.id !== sha || entry.type !== 'file') throw new Error('File changed. Refresh before deleting.');
    await this.persist(this.index.entries.filter((item) => item.path !== path));
    await this.cleanup(entry.blocks);
  }

  async deleteEmptyFolder(path: string, branch: string): Promise<void> {
    const remote = publicPath(path);
    if (remote) {
      if (remote === PUBLIC_PREFIX) throw new Error('Public files is a permanent virtual folder.');
      return this.github.deleteEmptyFolder(remote, branch);
    }
    const folder = this.record(path);
    if (!folder || folder.type !== 'dir') throw new Error('Folder not found.');
    if (this.index.entries.some((entry) => entry.path.startsWith(path + '/'))) {
      throw new Error('Folder must be empty before deletion.');
    }
    await this.persist(this.index.entries.filter((entry) => entry.path !== path));
  }
}
