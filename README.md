# My Drive

A personal, browser-encrypted file manager hosted by GitHub Pages. Built from the public [RepoDrive template](https://github.com/cheeseonamonkey/github-drive).

**The website and repository can be public. The vault's contents and filenames remain encrypted.** The only exception is the deliberately unencrypted **Public files** folder.

## Getting started

1. Open the [file manager](https://cheeseonamonkey.github.io/my-drive/).
2. Connect to the repository `cheeseonamonkey/my-drive` using a [fine-grained GitHub access token](https://github.com/settings/personal-access-tokens/new) with **Contents: Read and write** for this repository only. The token is kept in browser memory, never committed.
3. On the first login, the site shows setup instructions. Create a **strong, unique vault password** (14+ characters), confirm it, and acknowledge the Git history and password recovery warning.
4. Upload private files into the encrypted drive. Use the separate **Public files** folder only for material you deliberately want public.
5. On subsequent visits, use the same vault password to unlock. Your browser or password manager can offer to **save and autofill the vault password** (including on mobile). Saving is optional; the application does not persist it in localStorage, cookies, or the repository. Refreshing or disconnecting discards the live key and GitHub token from the app session.

**No default password has been set.** The encryption salt and new vault are created in your browser the first time you complete setup. Do not send your password through chat or commit it anywhere.

## Encryption architecture

- **Argon2id** derives a non-exportable AES-256-GCM key from the password and a random 128-bit salt (32 MiB memory, 3 iterations, parallelism 1).
- `.vault/state.json` holds public cryptographic parameters and an **authenticated, encrypted filesystem index** containing all private paths, filenames, file sizes, and opaque block references.
- Each private file is split into independent blocks of up to 1 MiB, encrypted using AES-256-GCM with a fresh random 96-bit nonce and block-specific authenticated context.
- Ciphertext blocks are committed as `.vault/blocks/<random-id>.bin`. The password and encryption key are never committed or sent to GitHub.
- Changing one private file commits new encrypted blocks and a new encrypted index; it does **not** rewrite every other file.
- File uploads and folder edits require GitHub authorization. The password alone can decrypt data but cannot modify the repository.

**This is browser-side encryption, not a server-side permission system.** Anyone can inspect the public ciphertext and source code. GitHub can observe activity, commit times, approximate ciphertext sizes, and the number of blocks. Password strength matters: an attacker can try guessing the password offline against the public index. Encryption does not prevent rollback to an older valid encrypted snapshot.

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

- 10 MiB maximum plaintext file size, 1 MiB encryption blocks.
- 1,000 entries per folder via GitHub Contents API.
- Client-side filename search, not indexed global search.
- Concurrent manifest updates fail rather than silently overwrite each other; refresh or reconnect to reload.
- File moves are implemented as write-then-delete operations, not atomic renames.
- GitHub repositories are inefficient for large or frequently changing binary storage.

## Development

Requires Node 22+.

```sh
npm ci
npm run check
npm run dev
```

The general-purpose reusable version remains at [github-drive](https://github.com/cheeseonamonkey/github-drive).
