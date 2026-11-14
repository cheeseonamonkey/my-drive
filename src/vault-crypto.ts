import { argon2id } from 'hash-wasm';

export interface VaultHeader {
  format: 'repodrive-vault';
  version: 1;
  salt: string;
  kdf: { algorithm: 'argon2id'; iterations: 3; memoryKiB: 32768; parallelism: 1 };
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });
const MANIFEST_AAD = te.encode('repodrive:manifest:v1');
const BLOCK_AAD_PREFIX = 'repodrive:block:v1:';
export const BLOCK_BYTES = 1024 * 1024;

export function randomId(): string {
  return crypto.randomUUID();
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(out);
}

export function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid encrypted data encoding.');
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function createHeader(): VaultHeader {
  return {
    format: 'repodrive-vault',
    version: 1,
    salt: toBase64(crypto.getRandomValues(new Uint8Array(16))),
    kdf: { algorithm: 'argon2id', iterations: 3, memoryKiB: 32768, parallelism: 1 },
  };
}

export function parseHeader(text: string): VaultHeader {
  let value: VaultHeader;
  try { value = JSON.parse(text) as VaultHeader; }
  catch { throw new Error('Vault header is not valid JSON.'); }
  if (value?.format !== 'repodrive-vault' || value.version !== 1 ||
    value.kdf?.algorithm !== 'argon2id' ||
    value.kdf?.iterations !== 3 || value.kdf.memoryKiB !== 32768 || value.kdf.parallelism !== 1 ||
    fromBase64(value.salt).length !== 16) {
    throw new Error('Unsupported or damaged vault header.');
  }
  return value;
}

export async function deriveKey(password: string, header: VaultHeader): Promise<CryptoKey> {
  if (!password) throw new Error('Password is required.');
  const raw = await argon2id({
    password, salt: fromBase64(header.salt), iterations: header.kdf.iterations,
    memorySize: header.kdf.memoryKiB, parallelism: header.kdf.parallelism,
    hashLength: 32, outputType: 'binary',
  });
  try {
    return await crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally { raw.fill(0); }
}

export async function seal(key: CryptoKey, bytes: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: new Uint8Array(aad), tagLength: 128,
  }, key, new Uint8Array(bytes)));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  return packed;
}

export async function unseal(key: CryptoKey, packed: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (packed.length < 28) throw new Error('Encrypted data is incomplete.');
  try {
    const decrypted = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: packed.slice(0, 12), additionalData: new Uint8Array(aad), tagLength: 128,
    }, key, packed.slice(12));
    return new Uint8Array(decrypted);
  } catch { throw new Error('Wrong password or encrypted data was modified.'); }
}

export async function sealManifest(key: CryptoKey, value: unknown): Promise<Uint8Array> {
  return seal(key, te.encode(JSON.stringify(value)), MANIFEST_AAD);
}

export async function unsealManifest<T>(key: CryptoKey, bytes: Uint8Array): Promise<T> {
  const raw = await unseal(key, bytes, MANIFEST_AAD);
  try { return JSON.parse(td.decode(raw)) as T; }
  catch { throw new Error('Vault index is damaged.'); }
  finally { raw.fill(0); }
}

export function blockAAD(id: string): Uint8Array {
  return te.encode(BLOCK_AAD_PREFIX + id);
}
