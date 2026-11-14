import { afterAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { GitHubDrive, MAX_UPLOAD_BYTES, Entry } from './github';
import { PUBLIC_FOLDER, VaultDrive, VAULT_FILE } from './vault';
import { BLOCK_BYTES } from './vault-crypto';

const oldCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
afterAll(() => Object.defineProperty(globalThis, 'crypto', { value: oldCrypto, configurable: true }));

class MemoryGithub {
  files = new Map<string, { bytes: Uint8Array; sha: string }>();
  seq = 0;
  async stat(path: string): Promise<Entry | null> {
    const file = this.files.get(path);
    return file ? { name: path.split('/').at(-1)!, path, type: 'file', size: file.bytes.length, sha: file.sha } : null;
  }
  async write(path: string, bytes: Uint8Array, expected?: string) {
    const previous = this.files.get(path);
    if ((previous && previous.sha !== expected) || (!previous && expected)) throw new Error('Concurrent write conflict');
    const sha = String(++this.seq);
    this.files.set(path, { bytes: new Uint8Array(bytes), sha });
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
