import { afterAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { GitHubDrive, MAX_UPLOAD_BYTES, Entry } from './github';
import { PUBLIC_FOLDER, VaultDrive, VAULT_FILE } from './vault';
import { BLOCK_BYTES } from './vault-crypto';
import { RemoteBlockStore, REMOTE_BLOCK_BYTES } from './remote-blocks';

const oldCrypto = globalThis.crypto;
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const pending = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => pending.get(key) || null,
    setItem: (key: string, value: string) => { pending.set(key, value); },
    removeItem: (key: string) => { pending.delete(key); },
  },
});
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
afterAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: oldCrypto, configurable: true });
  if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

class MemoryGithub {
  files = new Map<string, { bytes: Uint8Array; sha: string }>();
  seq = 0;
  loseManifestResponse = false;
  async stat(path: string): Promise<Entry | null> {
    const file = this.files.get(path);
    return file ? { name: path.split('/').at(-1)!, path, type: 'file', size: file.bytes.length, sha: file.sha } : null;
  }
  async write(path: string, bytes: Uint8Array, expected?: string) {
    const previous = this.files.get(path);
    if ((previous && previous.sha !== expected) || (!previous && expected)) throw new Error('Concurrent write conflict');
    const sha = String(++this.seq);
    this.files.set(path, { bytes: new Uint8Array(bytes), sha });
    if (path === VAULT_FILE && expected && this.loseManifestResponse) {
      this.loseManifestResponse = false;
      throw new Error('Network lost after GitHub committed the index.');
    }
    return sha;
  }
  async read(path: string): Promise<Blob> {
    const file = this.files.get(path);
    if (!file) throw new Error('File not found.');
    return new Blob([new Uint8Array(file.bytes)]);
  }
  async delete(path: string, sha: string): Promise<void> {
    if (this.files.get(path)?.sha !== sha) throw new Error('Concurrent delete conflict');
    this.files.delete(path);
  }
  async list(path: string): Promise<Entry[]> {
    const children = [...this.files.keys()].filter((file) =>
      file.startsWith(path + '/') && !file.slice(path.length + 1).includes('/')
    );
    if (!children.length) throw new Error('Not Found (HTTP 404)');
    return Promise.all(children.map(async (file) => (await this.stat(file))!));
  }
  async deleteEmptyFolder(path: string): Promise<void> {
    const stat = await this.stat(path + '/.gitkeep');
    if (!stat) throw new Error('Folder missing');
    await this.delete(stat.path, stat.sha);
  }
}

const asApi = (memory: MemoryGithub) => memory as unknown as GitHubDrive;

describe('encrypted filesystem (integration)', () => {
  it('creates encrypted state with no plaintext filenames, roundtrips across unlocks and rejects incorrect passwords', async () => {
    const memory = new MemoryGithub();
    const api = asApi(memory);
    const password = 'a long unique secret passphrase 2026';
    expect(await VaultDrive.exists(api, 'main')).toBe(false);
    const drive = await VaultDrive.create(api, 'main', password);
    expect(await VaultDrive.exists(api, 'main')).toBe(true);
    await drive.write('private/.gitkeep', new Uint8Array());
    await drive.write('private/very sensitive note.txt', new TextEncoder().encode('top secret text'));
    const raw = new TextDecoder().decode(memory.files.get(VAULT_FILE)!.bytes);
    expect(raw).not.toContain('very sensitive note.txt');
    expect(raw).not.toContain('top secret text');
    expect(raw).not.toContain(password);
    expect(raw).toContain('argon2id');

    const listed = await drive.list('private', 'main');
    expect(listed.map((item) => item.name)).toEqual(['very sensitive note.txt']);
    expect(await (await drive.read('private/very sensitive note.txt', 'main')).text()).toBe('top secret text');
    await expect(VaultDrive.unlock(api, 'main', 'wrong password')).rejects.toThrow('Wrong password');
    const reopened = await VaultDrive.unlock(api, 'main', password);
    expect(await (await reopened.read('private/very sensitive note.txt', 'main')).text()).toBe('top secret text');

    const file = (await reopened.list('private', 'main'))[0];
    await reopened.delete(file.path, file.sha);
    expect(await reopened.list('private', 'main')).toEqual([]);
    await reopened.deleteEmptyFolder('private', 'main');
    expect((await reopened.list('', 'main')).map((entry) => entry.name)).toEqual([PUBLIC_FOLDER]);
  });

  it('encrypts files into individually authenticated blocks and resists modification', async () => {
    const memory = new MemoryGithub();
    const drive = await VaultDrive.create(asApi(memory), 'main', 'another unique secret password');
    const original = new Uint8Array(BLOCK_BYTES + 3);
    for (let i = 0; i < original.length; i++) original[i] = i % 251;
    await drive.write('chunked.bin', original);
    const blocks = [...memory.files.keys()].filter((key) => key.startsWith('.vault/blocks/'));
    expect(blocks).toHaveLength(2);
    expect(new Uint8Array(await (await drive.read('chunked.bin', 'main')).arrayBuffer())).toEqual(original);

    const block = memory.files.get(blocks[0])!;
    block.bytes[15] ^= 0x01;
    await expect(drive.read('chunked.bin', 'main')).rejects.toThrow('modified');
  });

  it('isolates intentionally public files and detects concurrent manifest updates', async () => {
    const memory = new MemoryGithub();
    const api = asApi(memory);
    const password = 'a different long secret passphrase';
    const first = await VaultDrive.create(api, 'main', password);
    const second = await VaultDrive.unlock(api, 'main', password);
    await first.write(PUBLIC_FOLDER + '/hello.txt', new TextEncoder().encode('public content'));
    expect(new TextDecoder().decode(memory.files.get('public-files/hello.txt')!.bytes)).toBe('public content');
    expect((await first.list('', 'main')).some((entry) => entry.path === PUBLIC_FOLDER)).toBe(true);
    await first.write('document.md', new TextEncoder().encode('private'));
    await expect(second.write('other.md', new TextEncoder().encode('other'))).rejects.toThrow('conflict');
    await expect((await VaultDrive.unlock(api, 'main', password)).list('', 'main')).resolves.toBeDefined();
  });

  it('rejects files above the size limit', async () => {
    const memory = new MemoryGithub();
    const drive = await VaultDrive.create(asApi(memory), 'main', 'yet another unique secure password');
    await expect(drive.write('too-big.bin', new Uint8Array(MAX_UPLOAD_BYTES + 1))).rejects.toThrow('10 MiB');
  });
});

class MemoryRemote {
  blobs = new Map<string, Uint8Array>();
  calls = 0;
  failCall = 0;
  async exists(id: string) { return this.blobs.has(id); }
  async upload(id: string, encrypted: Uint8Array) {
    if (++this.calls === this.failCall) throw new Error('Network disconnected.');
    this.blobs.set(id, new Uint8Array(encrypted));
  }
  async download(id: string) {
    const block = this.blobs.get(id);
    if (!block) throw new Error('Missing encrypted R2 block.');
    return new Uint8Array(block);
  }
}

describe('large uploads and recovery', () => {
  it('encrypts checkpoints, resumes after failure, streams downloads and renames with no data transfer', async () => {
    pending.clear();
    const github = new MemoryGithub();
    const remote = new MemoryRemote();
    const adapter = remote as unknown as RemoteBlockStore;
    const password = 'strong test password for a large vault';
    const vault = await VaultDrive.create(asApi(github), 'main', password, adapter);
    const bytes = new Uint8Array(10 * 1024 * 1024 + 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 223;
    const input = new File([bytes], 'private-data.bin', { lastModified: 12345 });

    remote.failCall = 2;
    await expect(vault.writeFile('private-data.bin', input)).rejects.toThrow('Network disconnected.');
    expect((await vault.list('', 'main')).map((item) => item.name)).toEqual([PUBLIC_FOLDER]);
    const checkpoint = await vault.pendingUpload();
    expect(checkpoint).toEqual({ path: 'private-data.bin', done: REMOTE_BLOCK_BYTES, total: input.size });
    expect([...pending.values()].join('')).not.toContain('private-data.bin');
    expect([...pending.values()].join('')).not.toContain(password);
    expect([...github.files.keys()].filter((key) => key.startsWith('.vault/blocks/'))).toHaveLength(0);

    const reopened = await VaultDrive.unlock(asApi(github), 'main', password, adapter);
    remote.failCall = 0;
    const resumed = new File([bytes], 'private-data.bin', { lastModified: 55555 });
    const progress: number[] = [];
    await reopened.writeFile('private-data.bin', resumed, undefined, ({ done }) => progress.push(done));
    expect(progress).toEqual([REMOTE_BLOCK_BYTES, resumed.size]);
    expect(remote.calls).toBe(3); // successful first part was not reuploaded
    expect(remote.blobs.size).toBe(2);
    expect(await reopened.pendingUpload()).toBeNull();
    expect(await reopened.list('', 'main')).toHaveLength(2);
    await expect(reopened.read('private-data.bin', 'main')).rejects.toThrow('streamed download');

    const downloaded: Uint8Array[] = [];
    await reopened.downloadTo('private-data.bin', async (chunk) => { downloaded.push(new Uint8Array(chunk)); });
    expect(downloaded.map((part) => part.length)).toEqual([REMOTE_BLOCK_BYTES, bytes.length - REMOTE_BLOCK_BYTES]);
    const combined = new Uint8Array(bytes.length);
    let offset = 0;
    for (const part of downloaded) { combined.set(part, offset); offset += part.length; }
    const hash = (data: Uint8Array) =>
      webcrypto.subtle.digest('SHA-256', new Uint8Array(data)).then((sum) => Buffer.from(sum).toString('hex'));
    expect(await hash(combined)).toBe(await hash(bytes));

    const record = (await reopened.list('', 'main')).find((item) => item.name === 'private-data.bin')!;
    await reopened.rename(record.path, 'renamed.bin', record.sha);
    expect(remote.blobs.size).toBe(2);
    expect((await reopened.list('', 'main')).some((item) => item.name === 'renamed.bin')).toBe(true);

    const renamed = (await reopened.list('', 'main')).find((item) => item.name === 'renamed.bin')!;
    await reopened.delete(renamed.path, renamed.sha);
    expect(remote.blobs.size).toBe(2); // History may still reference those blocks.
  }, 20_000);

  it('recognizes a completed upload even if the final commit acknowledgement is lost', async () => {
    pending.clear();
    const github = new MemoryGithub();
    const remote = new MemoryRemote();
    const api = asApi(github);
    const password = 'an example passphrase for final-commit recovery';
    const vault = await VaultDrive.create(api, 'main', password, remote as unknown as RemoteBlockStore);
    github.loseManifestResponse = true;
    const input = new File(['encrypted private data'], 'critical.txt');
    // Simulate a crash that prevented the final local checkpoint removal.
    const removeItem = localStorage.removeItem;
    localStorage.removeItem = () => {};
    try { await vault.writeFile('critical.txt', input); }
    finally { localStorage.removeItem = removeItem; }
    expect((await vault.list('', 'main')).some((entry) => entry.name === 'critical.txt')).toBe(true);
    expect(remote.blobs.size).toBe(1);
    expect(pending.size).toBe(1);
    // A future session recognizes the published blocks and clears the stale checkpoint.
    const reopened = await VaultDrive.unlock(api, 'main', password, remote as unknown as RemoteBlockStore);
    expect(await reopened.pendingUpload()).toBeNull();
    expect(pending.size).toBe(0);
  });

  it('reloads concurrent encrypted manifest changes without replacing them', async () => {
    pending.clear();
    const github = new MemoryGithub();
    const password = 'another test password for reloading';
    const first = await VaultDrive.create(asApi(github), 'main', password);
    const other = await VaultDrive.unlock(asApi(github), 'main', password);
    await first.write('new.txt', new TextEncoder().encode('new'));
    expect((await other.list('', 'main')).some((file) => file.name === 'new.txt')).toBe(false);
    await other.reload();
    expect((await other.list('', 'main')).some((file) => file.name === 'new.txt')).toBe(true);
  });
});
