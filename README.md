# RepoDrive

A minimal, mobile-first file manager for a GitHub repository. React, TypeScript, Tailwind CSS, Vite, and GitHub Pages. No server needed for file operations.

Browse folders, search by filename, filter categories, sort by name/type/size, use list or grid view, drag in files or upload from the picker, preview images/text, view file details and history, download, rename or delete, and create or remove empty folders. Every write becomes a commit.

## Getting started

1. Click **Use this template** to create a **public** repository for the website.
2. Create a **separate private repository** for your files. Initialize it with a README so it has a default branch.
3. In the website repository, open **Settings → Pages** and choose **GitHub Actions** as the build/deployment source.
4. The included workflow deploys the frontend on pushes to `main`. Your site will be at `https://YOURNAME.github.io/YOUR-REPO/`.
5. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) restricted to the **storage repository**, with **Contents: Read and write**. Open the site and enter `owner/storage-repo` and the token.

The Pages site is public; your storage repo can be private. **Never** commit a token, add it to Pages build variables, or put private files in the website repository. Tokens are kept only in the running page's memory, and a refresh disconnects you.

## Optional GitHub browser sign-in

Instead of entering a personal access token, RepoDrive can offer **Continue with GitHub** using a GitHub App and a tiny Cloudflare Worker to exchange OAuth authorization codes. GitHub Pages cannot access existing GitHub login cookies or keep an OAuth client secret.

This mode requires your own GitHub App and a Worker deployment; **it is not active out of the box**. Manual tokens continue to work without it.

1. [Register a GitHub App](https://github.com/settings/apps/new). Set the **Homepage URL** to your Pages URL and the **Callback URL** to that exact URL including the trailing slash (for example, `https://YOURNAME.github.io/YOUR-REPO/`). Configure repository permission **Contents: Read and write**, and restrict installations to selected repositories. The app needs to be installed on the private storage repository.
2. Copy `auth-worker/wrangler.example.jsonc` to `auth-worker/wrangler.jsonc`, fill in your GitHub App **client ID** and the exact Pages callback URL. From `auth-worker/`, run `npx wrangler deploy` and then `npx wrangler secret put GITHUB_CLIENT_SECRET`. Never commit the secret.
3. In the Pages repository's **Settings → Secrets and variables → Actions → Variables**, add:
   - `VITE_GITHUB_CLIENT_ID`: the GitHub App client ID (**not** its secret).
   - `VITE_GITHUB_OAUTH_EXCHANGE_URL`: the deployed Worker endpoint ending in `/exchange`.
4. Re-run the Pages workflow. The login button will now appear. GitHub handles authentication; the Worker exchanges the code using PKCE. The resulting GitHub user token stays in browser memory until refresh or disconnect. Disconnecting does not revoke the app's authorization in GitHub.

The Worker validates browser request origins and accepts only the configured site. It is not a general-purpose authentication gateway. The SPA checks OAuth state and PKCE, clears temporary authorization data after use, and removes the callback code from the address bar. This is an OAuth integration, **not** password-based encryption: whoever has permission to the storage repository in GitHub can still access its contents.

For custom deployment domains, update the callback URL in both the GitHub App and the Worker. If you change the Worker URL, update the Actions variable and redeploy Pages.

## Develop

Requires Node.js 22+.

```sh
npm ci
npm run dev
npm run check   # tests, TypeScript, production build
```

The Pages workflow sets the correct Vite base path from the repository name. Local builds use `/`.

## Deliberate limits

- Uploads and renames are limited to **10 MiB** per file. This protects repo size and browser memory; it is not an API hard limit.
- GitHub's Contents API lists **at most 1,000 entries per directory**. Search filters the current directory; it is not a global index.
- Folder creation uses a hidden `.gitkeep` marker. Only empty folders created by this app can be removed.
- Renaming writes the new file and then deletes the old file. These are **two commits, not an atomic move**; if deletion fails, both files may remain.
- Git history retains deleted or replaced binary data. This is good for small documents/configuration, **not** large media, high-frequency backups, or a replacement for proper object storage.
- GitHub OAuth requires optional Worker setup. No multiuser sharing, synchronization, trash, or automatic offsite backup.
- Private files and access tokens are handled in the browser. Use only on devices you trust; a malicious browser extension or injected script could access the session. The app does not store a token in cookies, localStorage, or sessionStorage.

If you need shared access, persistent login, or large files, add a proper authentication backend and object storage rather than extending the personal-token approach.

## License

MIT.
