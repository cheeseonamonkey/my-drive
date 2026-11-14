# My Drive

A personal, browser-encrypted file manager hosted by GitHub Pages. Built from my public [RepoDrive template](https://github.com/cheeseonamonkey/github-drive). *(you can make one too!)*

**The website and repository can be public. The vault's contents and filenames remain encrypted.** The only exception is the deliberately unencrypted **Public files** folder.

## Getting started

1. Open the [file manager](https://cheeseonamonkey.github.io/my-drive/).
2. Connect to the repository `cheeseonamonkey/my-drive` using a [fine-grained GitHub access token](https://github.com/settings/personal-access-tokens/new) with **Contents: Read and write** for this repository only. The token is kept in browser memory, never committed.
3. On the first login, the site shows setup instructions. Create a **strong, unique vault password** (14+ characters), confirm it, and acknowledge the Git history and password recovery warning.
4. Upload private files into the encrypted drive. Use the separate **Public files** folder only for material you deliberately want public.
5. On subsequent visits, use the same vault password to unlock. Your browser or password manager can offer to **save and autofill the vault password** (including on mobile). Saving is optional; the application does not persist it in localStorage, cookies, or the repository. Refreshing or disconnecting discards the live key and GitHub token from the app session.

The encryption salt and initial vault are created in your browser during first-time setup. Do not send your password through chat or commit it anywhere.

## Encryption architecture

- **Argon2id** derives a non-exportable AES-256-GCM key from the password and a random 128-bit salt (32 MiB memory, 3 iterations, parallelism 1).
- `.vault/state.json` holds public cryptographic parameters and an **authenticated, encrypted filesystem index** containing all private paths, filenames, file sizes, and opaque block references.
- Private files use individually authenticated AES-256-GCM blocks, with a fresh 96-bit nonce and block-specific authenticated context.
- Without R2, up to 10 MiB is stored in 1 MiB encrypted Git blocks under `.vault/blocks/`.
- With the optional R2 Worker, files up to 50 GiB use 8 MiB encrypted R2 blocks. **GitHub receives only the encrypted index**, not the block contents.
- The password and AES key are never sent to GitHub or the Worker. Changing a private file does not rewrite unrelated files.
- File uploads and folder edits require GitHub authorization. The password alone can decrypt data but cannot modify the repository.

**This is browser-side encryption, not a server-side permission system.** Anyone can inspect the public ciphertext and source code. GitHub can observe activity, commit times, approximate ciphertext sizes, and the number of blocks. Password strength matters: an attacker can try guessing the password offline against the public index. Encryption does not prevent rollback to an older valid encrypted snapshot.

## Optional large-file storage (Cloudflare R2)

**The Worker is implemented but not deployed or enabled by default.** The 10 MiB Git-backed path works without Cloudflare. Large-file storage requires your own Cloudflare account and private R2 bucket. The public [Cloudflare setup guide](https://developers.cloudflare.com/r2/get-started/cli/) covers prerequisites.

1. In a trusted terminal, authenticate to Cloudflare and create a private bucket:
   ```sh
   npx wrangler login
   npx wrangler r2 bucket create my-drive-blocks
   ```
2. In `storage-worker/`, copy `wrangler.example.jsonc` to `wrangler.jsonc`. Adjust bucket name, GitHub owner, and the exact Pages site URL if needed. The local config file is gitignored.
3. From `storage-worker/`, deploy and configure a **random Worker session-signing secret** (32+ characters):
   ```sh
   npx wrangler deploy
   npx wrangler secret put SESSION_SECRET
   ```
   Keep the R2 bucket private. Do not commit or print the secret.
4. In the `my-drive` GitHub repository → Settings → Secrets and variables → Actions → **Variables**, set `VITE_BLOCK_WORKER_URL` to the deployed Worker's HTTPS URL, **including a trailing slash**. This is a public endpoint, not a secret.
5. Re-run the Pages workflow. Once the new frontend is deployed, uploads inside the encrypted drive use R2. `Public files` still uses GitHub's 10 MiB path.

### Transfer behavior

- Uploads are sequential and use at most one **8 MiB plaintext slice** at a time, plus encryption/network buffers.
- After every chunk, the browser stores an **AES-GCM-encrypted checkpoint** (block IDs, per-chunk SHA-256 hashes, and the logical path) in local browser storage. **Neither the encryption password nor the key is saved by the app.**
- Transient HTTP/network errors retry with exponential backoff. The Worker issues 30-minute signed sessions after verifying the GitHub account owner, so GitHub is **not queried for every block**.
- Cancel, refresh, or network loss: reconnect and unlock in the **same browser**, reselect the same local file, and successful chunks are verified and reused. A partially uploaded file is **not visible** until the encrypted index is committed.
- Private-file rename only changes the encrypted index. Downloading large private files streams to disk where the browser supports the File System Access API (primarily Chromium desktop). On other browsers, in-memory downloads are limited to 64 MiB to avoid crashes.
- Encrypted R2 blocks are **retained after deletion** because historical Git commits can reference them. Orphaned blocks from interrupted or discarded transfers are not yet automatically garbage-collected, and R2 storage/operations may incur charges.
- **Back up the R2 bucket alongside the Git repository.** A Git clone alone cannot restore files whose blocks live in R2. The Worker signing secret only authorizes R2 access; it is **not** an additional vault-encryption factor.

## Public files

Files under `Public files` in the interface are stored unencrypted under `public-files/` in Git. The app warns and asks for confirmation before uploading there. **Do not place private files in this folder, even temporarily.**

## Git is forever-ish

Deleting a file does **not** guarantee erasing its contents from the repository's history, forks, clones, caches, or backups. This is especially important for unencrypted public files. Git is not a replacement for secure deletion or a traditional backup system.

Overwriting or deleting encrypted files may also leave obsolete encrypted blocks in Git history. Failed/interrupted uploads can leave orphan ciphertext blocks in the current tree. The current implementation doesn't provide automatic garbage collection for interrupted writes.

**Password loss is permanent data loss.** There is no password reset, no key escrow, and no GitHub Actions encryption secret. Store the password securely elsewhere and retain a separate backup of important files.

## Authentication and Pages

This repository inherits optional **GitHub App OAuth/PKCE** support from RepoDrive, with an optional Cloudflare Worker for secure code exchange. It is not configured by default. Until it is configured, use a fine-grained personal access token.

The Pages workflow builds React + TypeScript + Tailwind + Vite, runs the automated checks, and deploys to GitHub Pages. Commits touching only `.vault/**` or `public-files/**` are excluded from triggering a rebuild. The encrypted data is never included in the Pages artifact; only the app is deployed.

## Limits

- Without R2: 10 MiB encrypted or public files, with 1 MiB Git encryption blocks.
- With R2: 50 GiB maximum encrypted file size, 8 MiB blocks; public files remain capped at 10 MiB.
- 1,000 entries per folder via GitHub Contents API.
- Client-side filename search, not indexed global search.
- Concurrent manifest updates fail rather than silently overwrite each other; refresh or reconnect to reload.
- Private-file renames update the encrypted index atomically; public-file renames remain write-then-delete.
- Resume checkpoints require the same browser storage, vault password, and original local file selection.
- GitHub repositories are inefficient for large or frequently changing binary storage; use the R2 backend for those files.

## Development

Requires Node 22+.

```sh
npm ci
npm run check
npm run dev
```

The general-purpose reusable version remains at [github-drive](https://github.com/cheeseonamonkey/github-drive).
