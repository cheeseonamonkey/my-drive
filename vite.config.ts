import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const exchangeUrl = process.env.VITE_GITHUB_OAUTH_EXCHANGE_URL;
const exchangeOrigin = exchangeUrl ? new URL(exchangeUrl).origin : '';
const storageUrl = process.env.VITE_BLOCK_WORKER_URL;
const storageOrigin = storageUrl ? new URL(storageUrl).origin : '';

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'oauth-connect-csp',
    transformIndexHtml: (html) => html.replace('__OAUTH_CONNECT_ORIGIN__', [exchangeOrigin, storageOrigin].filter(Boolean).join(' ')),
  }],
  base: process.env.GITHUB_PAGES && repoName ? `/${repoName}/` : '/',
});
