import { Entry, GitHubDrive, GitHubError, MAX_UPLOAD_BYTES } from './github';
import {
  BLOCK_BYTES, blockAAD, createHeader, deriveKey, fromBase64, parseHeader,
  randomId, seal, sealManifest, sealTransfer, toBase64, unseal, unsealManifest,
  unsealTransfer, VaultHeader,
} from './vault-crypto';
import { validName } from './file';
import { MAX_REMOTE_FILE_BYTES, REMOTE_BLOCK_BYTES, RemoteBlockStore } from './remote-blocks';

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
  storage?: 'r2';
}

interface VaultIndex {
  version: 1;
  entries: EncryptedRecord[];
}

interface UploadCheckpoint {
  version: 1;
  path: string;
  size: number;
  blocks: { id: string; hash: string; uploaded?: boolean }[];
}

export interface UploadProgress { done: number; total: number }

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
      !Number.isSafeInteger(item.size) || item.size < 0 ||
      (item.storage !== undefined && item.storage !== 'r2') ||
      item.size > (item.storage === 'r2' ? MAX_REMOTE_FILE_BYTES : MAX_UPLOAD_BYTES) ||
      !Array.isArray(item.blocks) ||
      item.blocks.length > Math.ceil((item.storage === 'r2' ? MAX_REMOTE_FILE_BYTES : MAX_UPLOAD_BYTES) /
        (item.storage === 'r2' ? REMOTE_BLOCK_BYTES : BLOCK_BYTES)) ||
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
    private readonly remote?: RemoteBlockStore,
  ) {}

  static async exists(github: GitHubDrive, branch: string): Promise<boolean> {
    return Boolean(await github.stat(VAULT_FILE, branch));
  }

  static async create(github: GitHubDrive, branch: string, password: string,
    remote?: RemoteBlockStore): Promise<VaultDrive> {
    if (await this.exists(github, branch)) throw new Error('A vault already exists in this repository.');
    const header = createHeader();
    const key = await deriveKey(password, header);
    const index: VaultIndex = { version: 1, entries: [] };
    const encryptedIndex = toBase64(await sealManifest(key, index));
    const contents: PersistedState = { header, encryptedIndex };
    const sha = await github.write(VAULT_FILE, encoder.encode(JSON.stringify(contents)));
    if (!sha) throw new Error('Vault was written, but GitHub did not return its version. Reconnect to unlock it.');
    return new VaultDrive(github, branch, key, header, sha, index, remote);
  }

  static async unlock(github: GitHubDrive, branch: string, password: string,
    remote?: RemoteBlockStore): Promise<VaultDrive> {
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
    return new VaultDrive(github, branch, key, header, stat.sha, index, remote);
  }

  async reload(): Promise<void> {
    const entry = await this.github.stat(VAULT_FILE, this.branch);
    if (!entry) throw new Error('Vault index was removed.');
    if (entry.sha === this.sha) return;
    const text = await (await this.github.read(VAULT_FILE, this.branch)).text();
    const state = JSON.parse(text) as PersistedState;
    // A different header indicates the vault was replaced, not just updated.
    if (JSON.stringify(parseHeader(JSON.stringify(state.header))) !== JSON.stringify(this.header)) {
      throw new Error('Vault encryption parameters changed. Disconnect and unlock again.');
    }
    const index = ensureIndex(await unsealManifest<VaultIndex>(this.key, fromBase64(state.encryptedIndex)));
    this.index = index;
    this.sha = entry.sha;
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

  private requireRemote(): RemoteBlockStore {
    if (!this.remote) throw new Error('Large-file storage is not configured. Set up the R2 Worker first.');
    return this.remote;
  }

  get maxUploadBytes(): number {
    return this.remote ? MAX_REMOTE_FILE_BYTES : MAX_UPLOAD_BYTES;
  }

  private get checkpointKey(): string {
    return 'repodrive.transfer.' + (this.github.repository || 'test');
  }

  private async readCheckpoint(): Promise<UploadCheckpoint | null> {
    if (typeof localStorage === 'undefined') return null;
    const saved = localStorage.getItem(this.checkpointKey);
    if (!saved) return null;
    try {
      const value = await unsealTransfer<UploadCheckpoint>(this.key, saved);
      if (value?.version !== 1 || typeof value.path !== 'string' ||
        !Number.isSafeInteger(value.size) || value.size < 0 ||
        value.size > MAX_REMOTE_FILE_BYTES ||
        !Array.isArray(value.blocks) || value.blocks.length > Math.ceil(value.size / REMOTE_BLOCK_BYTES) ||
        value.blocks.some((b) => !/^[a-f0-9-]{36}$/i.test(b.id) || !/^[a-f0-9]{64}$/i.test(b.hash))) {
        throw new Error('Invalid upload checkpoint.');
      }
      return value;
    } catch { return null; } // Stale checkpoints are not treated as vault corruption.
  }

  private async saveCheckpoint(value: UploadCheckpoint): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    const payload = await sealTransfer(this.key, value);
    try { localStorage.setItem(this.checkpointKey, payload); }
    catch { throw new Error('Browser storage is unavailable. Cannot guarantee resuming after refresh.'); }
  }

  private clearCheckpoint(): void {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(this.checkpointKey);
  }

  async pendingUpload(): Promise<{ path: string; done: number; total: number } | null> {
    const checkpoint = await this.readCheckpoint();
    return checkpoint ? {
      path: checkpoint.path,
      done: Math.min(checkpoint.size,
        checkpoint.blocks.filter((part) => part.uploaded).length * REMOTE_BLOCK_BYTES),
      total: checkpoint.size,
    } : null;
  }

  discardPendingUpload(): void { this.clearCheckpoint(); }

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

  private async decryptBlock(file: EncryptedRecord, id: string, signal?: AbortSignal): Promise<Uint8Array> {
    const cipher = file.storage === 'r2'
      ? await this.requireRemote().download(id, signal)
      : new Uint8Array(await (await this.github.read('.vault/blocks/' + id + '.bin', this.branch)).arrayBuffer());
    const max = (file.storage === 'r2' ? REMOTE_BLOCK_BYTES : BLOCK_BYTES) + 28;
    if (cipher.length > max) throw new Error('Encrypted block exceeds size limit.');
    return unseal(this.key, cipher, blockAAD(id));
  }

  async read(path: string, branch: string): Promise<Blob> {
    if (branch !== this.branch) throw new Error('Different branch is not supported.');
    const remote = publicPath(path);
    if (remote) return this.github.read(remote, branch);
    const file = this.record(path);
    if (!file || file.type !== 'file') throw new Error('File not found.');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('Use streamed download for files over 10 MiB.');

    const chunks: Uint8Array[] = [];
    let size = 0;
    for (const id of file.blocks) {
      const plaintext = await this.decryptBlock(file, id);
      size += plaintext.length;
      if (size > MAX_UPLOAD_BYTES) throw new Error('Encrypted file is unexpectedly large.');
      chunks.push(plaintext);
    }
    if (size !== file.size) throw new Error('Encrypted file failed size verification.');
    return new Blob(chunks.map((chunk) => new Uint8Array(chunk)));
  }

  /** Upload one bounded encrypted chunk at a time, with encrypted on-device checkpoints. */
  async writeFile(path: string, file: File, sha?: string,
    onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<void> {
    if (file.size > this.maxUploadBytes) {
      throw new Error(this.remote ? 'File exceeds 50 GiB limit.' : 'Configure R2 storage for files over 10 MiB.');
    }
    if (publicPath(path) || !this.remote) {
      await this.write(path, new Uint8Array(await file.arrayBuffer()), sha);
      onProgress?.({ done: file.size, total: file.size });
      return;
    }
    if (!path || path.split('/').some((part) => !validName(part))) throw new Error('Invalid file path.');
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (folder && this.record(folder)?.type !== 'dir') throw new Error('Parent folder not found.');
    const previous = this.record(path);
    if (previous?.type === 'dir' || (previous && sha !== previous.id) || (!previous && sha)) {
      throw new Error('File changed. Refresh the folder and retry.');
    }

    const existing = await this.readCheckpoint();
    if (existing && (existing.path !== path || existing.size !== file.size)) {
      throw new Error('Another upload is unfinished (' + existing.path +
        '). Select that file to resume, or discard its checkpoint first.');
    }
    const checkpoint: UploadCheckpoint = existing || {
      version: 1, path, size: file.size, blocks: [],
    };
    await this.saveCheckpoint(checkpoint);
    const remote = this.requireRemote();
    const count = Math.ceil(file.size / REMOTE_BLOCK_BYTES);
    for (let i = 0; i < count; i++) {
      signal?.throwIfAborted();
      const start = i * REMOTE_BLOCK_BYTES;
      const raw = new Uint8Array(await file.slice(start, start + REMOTE_BLOCK_BYTES).arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)),
        (n) => n.toString(16).padStart(2, '0')).join('');
      const saved = checkpoint.blocks[i];
      if (saved && saved.hash === digest && await remote.exists(saved.id, signal)) {
        if (!saved.uploaded) {
          saved.uploaded = true;
          await this.saveCheckpoint(checkpoint);
        }
        onProgress?.({ done: Math.min(file.size, (i + 1) * REMOTE_BLOCK_BYTES), total: file.size });
        continue;
      }
      if (saved && saved.hash !== digest) {
        throw new Error('The selected file changed since the interrupted upload. Discard the checkpoint before retrying.');
      }
      // Persist the chosen ID before the request. Lost acknowledgements can then be
      // recovered by HEAD without creating a second orphan object.
      const id = saved?.id || randomId();
      checkpoint.blocks[i] = { id, hash: digest, uploaded: false };
      await this.saveCheckpoint(checkpoint);
      const encrypted = await seal(this.key, raw, blockAAD(id));
      await remote.upload(id, encrypted, signal);
      checkpoint.blocks[i].uploaded = true;
      await this.saveCheckpoint(checkpoint);
      onProgress?.({ done: Math.min(file.size, (i + 1) * REMOTE_BLOCK_BYTES), total: file.size });
    }

    // Only publish the complete file. Interrupted uploads remain invisible in the vault index.
    const entries = this.index.entries.filter((item) => item.path !== path);
    entries.push({
      id: randomId(), path, type: 'file', size: file.size,
      blocks: checkpoint.blocks.map((part) => part.id), storage: 'r2',
    });
    await this.persist(entries);
    this.clearCheckpoint();
    if (previous && previous.storage !== 'r2') await this.cleanup(previous.blocks);
  }

  /** Stream a file to a writable destination without building a huge Blob in memory. */
  async downloadTo(path: string, write: (chunk: Uint8Array) => Promise<void>,
    onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<void> {
    const file = this.record(path);
    if (!file || file.type !== 'file') throw new Error('File not found.');
    let done = 0;
    for (const id of file.blocks) {
      signal?.throwIfAborted();
      const data = await this.decryptBlock(file, id, signal);
      done += data.byteLength;
      if (done > file.size) throw new Error('Encrypted file is unexpectedly large.');
      await write(data);
      onProgress?.({ done, total: file.size });
    }
    if (done !== file.size) throw new Error('Encrypted file failed size verification.');
  }

  /** Private renames update only the encrypted index; no data transfer. */
  async rename(path: string, nextPath: string, sha: string): Promise<void> {
    if (!validName(nextPath.split('/').at(-1) || '') || !nextPath || this.record(nextPath)) {
      throw new Error('Invalid or occupied destination.');
    }
    const oldRemote = publicPath(path);
    const newRemote = publicPath(nextPath);
    if (oldRemote || newRemote) {
      if (!oldRemote || !newRemote || oldRemote === PUBLIC_PREFIX || newRemote === PUBLIC_PREFIX) {
        throw new Error('Cannot move files between public and encrypted storage.');
      }
      const blob = await this.github.read(oldRemote, this.branch);
      if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Public file is too large to rename.');
      await this.github.write(newRemote, new Uint8Array(await blob.arrayBuffer()));
      await this.github.delete(oldRemote, sha);
      return;
    }
    const file = this.record(path);
    if (!file || file.type !== 'file' || file.id !== sha) throw new Error('File changed. Refresh before renaming.');
    const parent = nextPath.includes('/') ? nextPath.slice(0, nextPath.lastIndexOf('/')) : '';
    if (parent && this.record(parent)?.type !== 'dir') throw new Error('Destination folder not found.');
    await this.persist(this.index.entries.map((entry) => entry === file ?
      { ...file, path: nextPath, id: randomId() } : entry));
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
    // Retain R2 blocks: older Git history can still reference them.
    if (entry.storage !== 'r2') await this.cleanup(entry.blocks);
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
