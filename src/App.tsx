import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowLeft, Check, ChevronDown, ChevronRight, Code2, Copy, ExternalLink,
  File, FileArchive, FileText, Folder, FolderPlus, GitBranch, Grid2X2, HardDrive,
  Image as ImageIcon, LayoutList, LockKeyhole, LogOut, Pencil, RefreshCw,
  Search, ShieldCheck, Trash2, Upload, X,
} from 'lucide-react';
import { encodePath, Entry, GitHubDrive, MAX_UPLOAD_BYTES, RepoDetails } from './github';
import { PUBLIC_FOLDER, VaultDrive } from './vault';
import { beginGitHubLogin, completeGitHubLogin, oauthEnabled } from './auth';
import {
  category, entriesBy, extension, FileCategory, FileSort, PREVIEW_IMAGES, PREVIEW_TEXT,
  readableSize, typeLabel, validName,
} from './file';

type Connection = { api: VaultDrive; repo: RepoDetails };
type Pending = { github: GitHubDrive; repo: RepoDetails; exists: boolean };
type Preview = { kind: 'loading' | 'text' | 'image' | 'other' | 'error'; value?: string };
type NameDialog = { type: 'folder' | 'rename'; item?: Entry };
type View = 'list' | 'grid';

const categoryFilters: { value: FileCategory; label: string }[] = [
  { value: 'all', label: 'All files' },
  { value: 'documents', label: 'Documents' },
  { value: 'images', label: 'Images' },
  { value: 'code', label: 'Code' },
];

function ItemIcon({ item, large = false }: { item: Entry; large?: boolean }) {
  const size = large ? 27 : 21;
  const kind = category(item);
  const icon = kind === 'folder' ? <Folder size={size} /> :
    kind === 'images' ? <ImageIcon size={size} /> :
    kind === 'documents' ? <FileText size={size} /> :
    kind === 'code' ? <Code2 size={size} /> :
    ['zip', 'tar', 'gz', '7z', 'rar'].includes(extension(item.name)) ? <FileArchive size={size} /> :
    <File size={size} />;
  return <span className={'flex shrink-0 items-center justify-center rounded-xl ' +
    (large ? 'size-12' : 'size-10') + (kind === 'folder' ? ' bg-[#f0ebf9] text-accent' : ' bg-[#f6f5f8] text-[#8d8799]')}>
    {icon}
  </span>;
}

function formatError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function NameEditor({ title, value, onCancel, onSave }: {
  title: string;
  value: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(value);
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-[#201b2b]/35 p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <form className="surface w-full max-w-sm p-5 shadow-xl" onSubmit={(event) => {
        event.preventDefault();
        onSave(name.trim());
      }}>
        <h3 className="font-medium">{title}</h3>
        <label className="mt-4 block text-xs text-muted" htmlFor="new-name">Name</label>
        <input id="new-name" className="field mt-1.5" autoFocus value={name}
          onChange={(event) => setName(event.target.value)} />
        <div className="mt-5 flex justify-end gap-2">
          <button className="action action-outline" type="button" onClick={onCancel}>Cancel</button>
          <button className="action action-primary" type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [repository, setRepository] = useState(import.meta.env.VITE_DEFAULT_STORAGE_REPO || '');
  const [token, setToken] = useState('');
  const [oauthToken, setOauthToken] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [vaultPassword, setVaultPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [path, setPath] = useState('');
  const [items, setItems] = useState<Entry[]>([]);
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<FileCategory>('all');
  const [sort, setSort] = useState<FileSort>('name');
  const [view, setView] = useState<View>('list');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Entry | null>(null);
  const [preview, setPreview] = useState<Preview>({ kind: 'other' });
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const shown = useMemo(() => entriesBy(items.filter((item) =>
    item.name.toLowerCase().includes(filter.trim().toLowerCase()) &&
    (typeFilter === 'all' || category(item) === 'folder' || category(item) === typeFilter)
  ), sort), [items, filter, typeFilter, sort]);

  const fileCount = items.filter((item) => item.type !== 'dir').length;
  const folderCount = items.filter((item) => item.type === 'dir').length;
  const folderBytes = items.reduce((sum, item) => sum + (item.type === 'dir' ? 0 : item.size), 0);
  const segments = path ? path.split('/') : [];

  function refresh() { setVersion((value) => value + 1); }

  async function perform(label: string, job: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError('');
    try { await job(); }
    catch (reason) { setError(formatError(reason)); }
    finally { setBusy(''); }
  }

  useEffect(() => {
    if (!connection) return;
    let active = true;
    setLoading(true);
    setError('');
    setItems([]);
    connection.api.list(path, connection.repo.default_branch)
      .then((entries) => { if (active) setItems(entries); })
      .catch((reason: unknown) => { if (active) setError(formatError(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [connection, path, version]);

  useEffect(() => {
    if (!selected || !connection) return;
    setPreview({ kind: 'loading' });
    const ext = extension(selected.name);
    const isImage = PREVIEW_IMAGES.has(ext);
    const isText = PREVIEW_TEXT.has(ext);
    if (selected.size > MAX_UPLOAD_BYTES || (!isImage && !isText)) {
      setPreview({ kind: 'other' });
      return;
    }

    let active = true;
    let objectUrl: string | undefined;
    connection.api.read(selected.path, connection.repo.default_branch)
      .then(async (blob) => {
        if (!active) return;
        if (isImage) {
          objectUrl = URL.createObjectURL(blob);
          setPreview({ kind: 'image', value: objectUrl });
        } else {
          const content = await blob.text();
          if (active) setPreview({ kind: 'text', value: content.slice(0, 250_000) });
        }
      })
      .catch((reason: unknown) => { if (active) setPreview({ kind: 'error', value: formatError(reason) }); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [connection, selected]);

  useEffect(() => {
    if (!selected && !nameDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNameDialog(null);
        setSelected(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [selected, nameDialog]);

  async function connectUsing(secret: string, target: string) {
    await perform('Connecting…', async () => {
      const api = new GitHubDrive(secret.trim(), target.trim());
      const repo = await api.details();
      await api.list('', repo.default_branch);
      const exists = await VaultDrive.exists(api, repo.default_branch);
      setPending({ github: api, repo, exists });
      setToken('');
      setPath('');
    });
  }

  async function connect() {
    await connectUsing(oauthToken || token, repository);
  }

  useEffect(() => {
    let active = true;
    void completeGitHubLogin()
      .then((result) => {
        if (!active || !result) return;
        setOauthToken(result.token);
        setRepository(result.repository);
        if (result.repository) void connectUsing(result.token, result.repository);
      })
      .catch((reason: unknown) => { if (active) setError(formatError(reason)); });
    return () => { active = false; };
  }, []);

  async function unlockVault() {
    if (!pending) return;
    if (!pending.exists) {
      if (vaultPassword.length < 14) { setError('Use a password or passphrase of at least 14 characters.'); return; }
      if (vaultPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
      if (!acknowledged) { setError('Please acknowledge the recovery and Git history warnings.'); return; }
    }
    await perform(pending.exists ? 'Unlocking vault…' : 'Encrypting new vault…', async () => {
      const api = pending.exists
        ? await VaultDrive.unlock(pending.github, pending.repo.default_branch, vaultPassword)
        : await VaultDrive.create(pending.github, pending.repo.default_branch, vaultPassword);
      setConnection({ api, repo: pending.repo });
      setPending(null);
      setVaultPassword('');
      setConfirmPassword('');
      setAcknowledged(false);
      setPath('');
    });
  }

  function navigate(next: string) {
    setFilter('');
    setTypeFilter('all');
    setSelected(null);
    setPath(next);
  }

  function open(item: Entry) {
    if (item.type === 'dir') navigate(item.path);
    else if (item.type === 'file') { setCopied(false); setSelected(item); }
    else setError('Git submodules and symlinks cannot be opened in this file manager.');
  }

  function upload(files: File[]) {
    if (!connection || files.length === 0) return;
    const publicUpload = path === PUBLIC_FOLDER || path.startsWith(PUBLIC_FOLDER + '/');
    if (publicUpload && !window.confirm(
      'PUBLIC AND UNENCRYPTED: these files will be readable by anyone if the repository is public, and Git history may retain them forever. Continue?'
    )) return;
    void perform('Uploading…', async () => {
      try {
        for (const file of files) {
          if (!validName(file.name)) throw new Error('Invalid filename: ' + file.name);
          if (file.size > MAX_UPLOAD_BYTES) throw new Error(file.name + ' exceeds the 10 MiB limit.');
          const existing = items.find((item) => item.name === file.name);
          if (existing?.type === 'dir') throw new Error('A folder already uses the name ' + file.name);
          if (existing && !window.confirm('Replace ' + file.name + '?')) continue;
          await connection.api.write([path, file.name].filter(Boolean).join('/'),
            new Uint8Array(await file.arrayBuffer()), existing?.sha);
        }
      } finally { refresh(); }
    });
  }

  function onDragEnter(event: React.DragEvent) {
    if (!connection || busy || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave(event: React.DragEvent) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }

  function onDrop(event: React.DragEvent) {
    if (!connection || !dragging) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    const files = Array.from(event.dataTransfer.files);
    upload(files);
  }

  function saveName(name: string) {
    if (!connection || !nameDialog) return;
    if (!validName(name)) { setError('Choose a valid name (no slashes or control characters).'); return; }
    const target = nameDialog.item;
    if (target?.name === name) { setNameDialog(null); return; }
    if (items.some((item) => item.name === name)) { setError('That name already exists.'); return; }
    const kind = nameDialog.type;
    setNameDialog(null);
    if (kind === 'folder') {
      void perform('Creating…', async () => {
        await connection.api.write([path, name, '.gitkeep'].filter(Boolean).join('/'), new Uint8Array());
        refresh();
      });
    } else if (target) {
      if (target.size > MAX_UPLOAD_BYTES) { setError('Files over 10 MiB cannot be renamed.'); return; }
      void perform('Renaming…', async () => {
        const newPath = [path, name].filter(Boolean).join('/');
        const blob = await connection.api.read(target.path, connection.repo.default_branch);
        await connection.api.write(newPath, new Uint8Array(await blob.arrayBuffer()));
        try { await connection.api.delete(target.path, target.sha); }
        catch (reason) {
          refresh();
          throw new Error('New file created, but the original could not be deleted. Both may exist. ' + formatError(reason));
        }
        setSelected(null);
        refresh();
      });
    }
  }

  function remove(item: Entry) {
    if (!connection || !window.confirm('Delete ' + item.name + '? Git history will retain earlier versions.')) return;
    void perform('Deleting…', async () => {
      try { await connection.api.delete(item.path, item.sha); }
      finally { setSelected(null); refresh(); }
    });
  }

  function removeEmptyFolder() {
    if (!connection || !path || !window.confirm('Remove this empty folder?')) return;
    void perform('Deleting folder…', async () => {
      try {
        await connection.api.deleteEmptyFolder(path, connection.repo.default_branch);
        navigate(segments.slice(0, -1).join('/'));
      } finally { refresh(); }
    });
  }

  function download(item: Entry) {
    if (!connection) return;
    void perform('Downloading…', async () => {
      const blob = await connection.api.read(item.path, connection.repo.default_branch);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = item.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
  }

  async function copyPath(item: Entry) {
    try {
      await navigator.clipboard.writeText(item.path);
      setCopied(true);
    } catch { setError('Unable to copy path. Check clipboard permissions.'); }
  }

  function disconnect() {
    setPending(null);
    setVaultPassword('');
    setConfirmPassword('');
    setAcknowledged(false);
    setOauthToken('');
    setToken('');
    setConnection(null);
    setItems([]);
    setSelected(null);
    setError('');
    setPath('');
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-white/90">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-7">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-[11px] bg-[#3a3149] text-white"><HardDrive size={18} /></span>
            <span className="text-[15px] font-semibold tracking-tight">RepoDrive</span>
            <span className="hidden border-l border-line pl-3 text-xs text-muted sm:inline">Files, with a history.</span>
          </div>
          {connection ? (
            <div className="flex items-center gap-2">
              <span className="hidden items-center gap-1.5 rounded-full bg-[#f0f8f1] px-2.5 py-1.5 text-[11px] font-medium text-[#48744c] sm:inline-flex">
                <span className="size-1.5 rounded-full bg-[#68a16f]" /> Connected
              </span>
              <button className="action action-outline !min-h-9 !px-3" onClick={disconnect}><LogOut size={15} /> Disconnect</button>
            </div>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-muted"><LockKeyhole size={14} /> Encrypted by default</span>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-7 sm:pt-11">
        {!connection && pending ? (
          <section className="mx-auto max-w-[460px] pt-2 sm:pt-7">
            <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-[#ece6f7] text-accent">
              <LockKeyhole size={24} strokeWidth={1.7} />
            </div>
            <p className="mb-2 text-xs font-medium text-accent">{pending.exists ? 'Welcome back' : 'First-time setup'}</p>
            <h1 className="text-[27px] font-semibold tracking-tight">
              {pending.exists ? 'Unlock your encrypted drive.' : 'Create your encrypted vault.'}
            </h1>
            <p className="mt-2 text-[13px] leading-6 text-muted">
              {pending.exists
                ? 'Enter the vault password you created. Nothing is decrypted on GitHub.'
                : 'Your files and folder names will be encrypted locally before reaching GitHub.'}
            </p>
            {!pending.exists && (
              <div className="surface mt-6 p-5">
                <h2 className="mb-3 text-sm font-medium">How it works</h2>
                <ol className="space-y-3 text-xs leading-5 text-muted">
                  <li><strong className="mr-2 text-ink">1.</strong> Choose a long, unique password or passphrase.</li>
                  <li><strong className="mr-2 text-ink">2.</strong> The browser generates a random salt and derives an encryption key with Argon2id.</li>
                  <li><strong className="mr-2 text-ink">3.</strong> Upload into the encrypted drive. Only the separate <strong>Public files</strong> folder stays unencrypted.</li>
                </ol>
              </div>
            )}
            <form className="surface mt-4 space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void unlockVault(); }}>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium">{pending.exists ? 'Vault password' : 'New vault password'}</span>
                <input type="password" className="field" required autoComplete={pending.exists ? 'current-password' : 'new-password'}
                  value={vaultPassword} onChange={(event) => setVaultPassword(event.target.value)} placeholder="Enter a strong passphrase" />
              </label>
              {!pending.exists && (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium">Confirm password</span>
                  <input type="password" className="field" required autoComplete="new-password"
                    value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Enter the same passphrase again" />
                </label>
              )}
              {!pending.exists && (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-[#e7d8bb] bg-[#fffcf6] p-3.5">
                  <input type="checkbox" className="mt-1 accent-[#6b48b2]" checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)} />
                  <span className="text-[11px] leading-5 text-[#78634a]">
                    <strong>Git is forever-ish.</strong> Deleted files may persist in Git history.
                    I understand that public uploads are never encrypted, and losing my password
                    permanently loses access to encrypted files. There is no password reset.
                  </span>
                </label>
              )}
              <button type="submit" className="action action-primary !min-h-11 w-full" disabled={!!busy}>
                <LockKeyhole size={16} /> {busy || (pending.exists ? 'Unlock drive' : 'Create encrypted drive')}
              </button>
            </form>
            <p className="mt-4 text-center text-[11px] leading-5 text-muted">
              Passwords and encryption keys stay in the browser, never in GitHub secrets.
            </p>
            <button className="mx-auto mt-3 flex min-h-10 items-center gap-2 text-xs text-muted hover:text-ink"
              onClick={disconnect}><ArrowLeft size={14} /> Back to repository login</button>
          </section>
        ) : !connection ? (
          <section className="mx-auto max-w-[440px] pt-3 sm:pt-9">
            <span className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-[#ece6f7] text-accent">
              <Folder size={24} strokeWidth={1.7} />
            </span>
            <h1 className="text-[27px] font-semibold tracking-tight sm:text-[34px]">Your files, minus the fuss.</h1>
            <p className="mt-2.5 text-[13px] leading-6 text-muted">
              A small encrypted file manager backed by GitHub. Connect to a repository, then create or unlock your vault.
            </p>
            <div className="mt-5 rounded-xl border border-line bg-white px-4 py-3 text-xs leading-5 text-muted">
              <strong className="text-ink">First time?</strong> Connect to the repository hosting your personal drive.
              After GitHub login, you'll get step-by-step vault setup. No password needs to be sent to GitHub.
            </div>
            <form className="surface mt-7 space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium">Storage repository</span>
                <input className="field" placeholder="yourname/private-files" required value={repository}
                  onChange={(event) => setRepository(event.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              {oauthEnabled && !oauthToken && (
                <button type="button" className="action action-primary !min-h-11 w-full" disabled={!!busy}
                  onClick={() => { void beginGitHubLogin(repository.trim()).catch((reason: unknown) => setError(formatError(reason))); }}>
                  <GitBranch size={17} /> Continue with GitHub
                </button>
              )}
              {oauthToken && <div className="flex items-center gap-2 rounded-xl bg-[#f1f8f3] px-3 py-2.5 text-xs text-[#3e7650]">
                <Check size={16} /> Authorized with GitHub for this session
              </div>}
              {!oauthToken && (
                <div>
                  {oauthEnabled ? <details className="group">
                    <summary className="cursor-pointer text-xs text-muted">Use a personal access token instead</summary>
                    <label className="mt-3 block">
                      <span className="mb-1.5 block text-xs font-medium">Fine-grained GitHub token</span>
                      <input className="field" type="password" placeholder="github_pat_…" value={token}
                        onChange={(event) => setToken(event.target.value)} autoComplete="off" />
                    </label>
                  </details> : (
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium">Fine-grained GitHub token</span>
                      <input className="field" type="password" placeholder="github_pat_…" required value={token}
                        onChange={(event) => setToken(event.target.value)} autoComplete="off" />
                    </label>
                  )}
                </div>
              )}
              {(!oauthEnabled || oauthToken || token.trim()) && (
                <button className="action action-primary !min-h-11 w-full" type="submit" disabled={!!busy}>
                  <ShieldCheck size={16} /> {busy || 'Open drive'}
                </button>
              )}
              <p className="text-[11px] leading-5 text-muted">
                {oauthEnabled ? 'Authorize only the storage repositories you want RepoDrive to access. ' : ''}
                For manual tokens, grant <strong>Contents: read/write</strong> on just the storage repo.{' '}
                <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer"
                  className="font-medium text-accent underline underline-offset-2">Create a token</a>
              </p>
            </form>
            <p className="mt-5 text-center text-[11px] leading-5 text-muted">
              No tracking or saved credentials. Refreshing the tab disconnects you.
            </p>
          </section>
        ) : (
          <section onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={(event) => {
            if (dragging) event.preventDefault();
          }} onDrop={onDrop} className={'relative rounded-2xl transition ' + (dragging ? 'drop-target' : '')}>
            {dragging && <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-[#f6f1ff]/95">
              <div className="flex flex-col items-center gap-2 text-accent"><Upload size={30} /><span className="text-sm font-medium">Drop to upload here</span></div>
            </div>}
            {path === PUBLIC_FOLDER || path.startsWith(PUBLIC_FOLDER + '/') ? (
              <div className="mb-4 rounded-xl border border-[#e7d8bb] bg-[#fffcf6] px-4 py-3 text-xs leading-5 text-[#78634a]">
                <strong>Public and unencrypted.</strong> Everything uploaded here is readable if this repository is public,
                and deletion does not erase its Git history.
              </div>
            ) : (
              <div className="mb-4 flex items-center gap-1.5 text-[11px] text-[#4b7351]">
                <LockKeyhole size={13} /> Encrypted locally · Argon2id + AES-256-GCM
              </div>
            )}
            <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <a href={'https://github.com/' + connection.repo.full_name} target="_blank" rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 text-[11px] font-medium text-muted hover:text-accent">
                  <GitBranch size={13} /><span className="truncate">{connection.repo.full_name}</span><ExternalLink size={12} />
                </a>
                <h1 className="mt-2 truncate text-[26px] font-semibold tracking-tight sm:text-[31px]">
                  {path ? segments.at(-1) : 'My files'}
                </h1>
                <p className="mt-1.5 text-xs text-muted">
                  {fileCount} files · {folderCount} folders · {readableSize(folderBytes)} in this folder
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button className="action action-outline" disabled={!!busy} onClick={() => setNameDialog({ type: 'folder' })}>
                  <FolderPlus size={16} /><span className="hidden min-[370px]:inline">New folder</span>
                </button>
                <button className="action action-primary" disabled={!!busy} onClick={() => uploadRef.current?.click()}>
                  <Upload size={16} /> Upload
                </button>
                <input ref={uploadRef} type="file" multiple className="hidden" aria-label="Upload files"
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files || []);
                    event.currentTarget.value = '';
                    upload(files);
                  }} />
              </div>
            </div>

            {busy && <p role="status" aria-live="polite" className="mb-3 text-xs text-accent">{busy}</p>}

            <div className="surface overflow-hidden">
              <div className="flex min-h-13 flex-wrap items-center gap-1 border-b border-line px-3 py-2 sm:px-4">
                <button className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-accent hover:bg-paper"
                  onClick={() => navigate('')}><HardDrive size={14} /> Files</button>
                {segments.map((segment, index) => (
                  <div className="flex min-w-0 items-center" key={index}>
                    <ChevronRight size={13} className="shrink-0 text-muted" />
                    <button className="max-w-36 truncate rounded-lg px-2 py-2 text-xs hover:bg-paper sm:max-w-52"
                      onClick={() => navigate(segments.slice(0, index + 1).join('/'))}>{segment}</button>
                  </div>
                ))}
                <span className="ml-auto flex items-center gap-1.5 rounded-lg bg-[#f5f4f7] px-2.5 py-1.5 text-[10px] text-muted">
                  <GitBranch size={12} /><span className="max-w-20 truncate">{connection.repo.default_branch}</span>
                </span>
              </div>

              <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
                <div className="flex gap-2">
                  <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-line bg-paper px-3 sm:max-w-sm">
                    <Search size={16} className="shrink-0 text-muted" />
                    <input className="w-full min-w-0 bg-transparent text-xs outline-none" value={filter}
                      placeholder="Search this folder…" aria-label="Filter this folder" onChange={(event) => setFilter(event.target.value)} />
                    {filter && <button aria-label="Clear search" onClick={() => setFilter('')}><X size={15} className="text-muted" /></button>}
                  </label>
                  <button className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-line hover:bg-paper"
                    title="Refresh" aria-label="Refresh folder" disabled={!!busy} onClick={refresh}><RefreshCw size={16} /></button>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
                  <div className="flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto">
                    {categoryFilters.map((option) => (
                      <button key={option.value} className="pill" aria-pressed={typeFilter === option.value}
                        onClick={() => setTypeFilter(option.value)}>{option.label}</button>
                    ))}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <label className="relative flex items-center">
                      <span className="sr-only">Sort files</span>
                      <select className="min-h-9 appearance-none rounded-lg bg-white pl-2 pr-6 text-[11px] text-muted outline-none"
                        value={sort} onChange={(event) => setSort(event.target.value as FileSort)}>
                        <option value="name">Name</option>
                        <option value="type">Type</option>
                        <option value="size">Size</option>
                      </select>
                      <ChevronDown size={12} className="pointer-events-none absolute right-1.5 text-muted" />
                    </label>
                    <div className="mx-1 h-4 w-px bg-line" />
                    <button title="List view" aria-label="List view" aria-pressed={view === 'list'}
                      className="pill !flex !size-9 !items-center !justify-center !p-0" onClick={() => setView('list')}>
                      <LayoutList size={17} />
                    </button>
                    <button title="Grid view" aria-label="Grid view" aria-pressed={view === 'grid'}
                      className="pill !flex !size-9 !items-center !justify-center !p-0" onClick={() => setView('grid')}>
                      <Grid2X2 size={16} />
                    </button>
                  </div>
                </div>
              </div>

              {loading ? (
                <div className="py-18 text-center text-xs text-muted">Loading files…</div>
              ) : shown.length === 0 ? (
                <div className="px-5 py-17 text-center">
                  <Folder size={30} strokeWidth={1.5} className="mx-auto mb-3 text-[#ad9bcf]" />
                  <p className="text-sm font-medium">{items.length ? 'Nothing matches' : 'Nothing here yet'}</p>
                  <p className="mt-1.5 text-xs text-muted">{items.length ? 'Try a different filter.' : 'Upload something or create a folder.'}</p>
                  {!items.length && path && path !== PUBLIC_FOLDER && <button className="action action-outline mt-5" onClick={removeEmptyFolder} disabled={!!busy}>Remove empty folder</button>}
                </div>
              ) : view === 'list' ? (
                <div>
                  <div className="hidden grid-cols-[minmax(0,1fr)_minmax(100px,180px)_95px_24px] gap-3 border-b border-line bg-[#fbfafc] px-5 py-3 text-[10px] uppercase tracking-wider text-muted sm:grid">
                    <span>Name</span><span>Type</span><span className="text-right">Size</span><span />
                  </div>
                  <div className="divide-y divide-line">
                    {shown.map((item) => (
                      <button key={item.path} disabled={!!busy} onClick={() => open(item)}
                        className="grid min-h-17 w-full grid-cols-[minmax(0,1fr)_20px] items-center gap-3 px-3 py-2.5 text-left transition hover:bg-[#faf9fc] sm:grid-cols-[minmax(0,1fr)_minmax(100px,180px)_95px_24px] sm:px-5">
                        <span className="flex min-w-0 items-center gap-3">
                          <ItemIcon item={item} />
                          <span className="min-w-0">
                            <span className="block truncate text-[12px] font-medium">{item.name}</span>
                            <span className="mt-1 block text-[10px] text-muted sm:hidden">
                              {typeLabel(item)}{item.type === 'file' ? ' · ' + readableSize(item.size) : ''}
                            </span>
                          </span>
                        </span>
                        <span className="hidden truncate text-xs text-muted sm:block">{typeLabel(item)}</span>
                        <span className="hidden text-right text-xs tabular-nums text-muted sm:block">
                          {item.type === 'file' ? readableSize(item.size) : '—'}
                        </span>
                        <ChevronRight size={17} className="text-[#b0aab8]" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 border-t border-line p-3 sm:grid-cols-3 sm:p-5 lg:grid-cols-4">
                  {shown.map((item) => (
                    <button key={item.path} disabled={!!busy} onClick={() => open(item)}
                      className="flex min-h-38 min-w-0 flex-col items-start rounded-xl border border-line p-3.5 text-left hover:bg-[#faf9fc]">
                      <ItemIcon item={item} large />
                      <span className="mt-4 w-full truncate text-xs font-medium">{item.name}</span>
                      <span className="mt-1.5 w-full truncate text-[10px] text-muted">
                        {typeLabel(item)}{item.type === 'file' ? ' · ' + readableSize(item.size) : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {items.length >= 1000 && <p className="border-t border-line px-4 py-3 text-xs text-muted">
                GitHub only returns the first 1,000 entries per folder.
              </p>}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
              {path ? <button className="flex min-h-10 items-center gap-1.5 hover:text-ink"
                onClick={() => navigate(segments.slice(0, -1).join('/'))}><ArrowLeft size={14} /> Parent folder</button> :
                <span>{shown.length} items shown</span>}
              <span>Max upload 10 MiB · Git history persists</span>
            </div>
          </section>
        )}

        {error && <div role="alert" className="mt-5 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">
          <span className="break-words">{error}</span>
          <button className="shrink-0" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button>
        </div>}
      </main>

      {selected && connection && (
        <div className="fixed inset-0 z-40 flex justify-end bg-[#201b2b]/30" role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <section className="flex h-dvh w-full max-w-lg flex-col bg-white shadow-2xl" role="dialog" aria-modal="true"
            aria-label={'File details: ' + selected.name}>
            <header className="flex min-h-16 items-center gap-3 border-b border-line px-4 sm:px-6">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">File details</span>
              <button className="flex size-10 items-center justify-center rounded-lg hover:bg-paper" aria-label="Close details"
                onClick={() => setSelected(null)}><X size={19} /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto p-5 sm:p-6">
              <div className="mb-6 flex min-w-0 items-center gap-3">
                <ItemIcon item={selected} large />
                <div className="min-w-0">
                  <h2 className="break-all text-sm font-medium">{selected.name}</h2>
                  <p className="mt-1 text-xs text-muted">{typeLabel(selected)} · {readableSize(selected.size)}</p>
                </div>
              </div>

              <div className="min-h-24 overflow-auto rounded-xl border border-line bg-paper p-3">
                {preview.kind === 'loading' && <p className="py-10 text-center text-xs text-muted">Loading preview…</p>}
                {preview.kind === 'image' && <img src={preview.value} alt={selected.name}
                  className="mx-auto max-h-[42dvh] max-w-full rounded-lg object-contain" />}
                {preview.kind === 'text' && <pre className="max-h-[42dvh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">{preview.value}</pre>}
                {preview.kind === 'other' && <p className="py-10 text-center text-xs text-muted">No preview available. Download to open.</p>}
                {preview.kind === 'error' && <p className="py-10 text-center text-xs text-red-700">Preview failed: {preview.value}</p>}
              </div>

              <div className="mt-7 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Properties</h3>
                <button className="flex items-center gap-1 text-[11px] text-accent hover:underline" onClick={() => void copyPath(selected)}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy path'}
                </button>
              </div>
              <dl className="mt-3 divide-y divide-line border-t border-line text-xs">
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-3">
                  <dt className="text-muted">Location</dt><dd className="break-all">{selected.path}</dd>
                </div>
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-3">
                  <dt className="text-muted">Size</dt><dd>{readableSize(selected.size)} ({selected.size.toLocaleString()} bytes)</dd>
                </div>
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-3">
                  <dt className="text-muted">Version</dt><dd className="break-all font-mono text-[11px]">{selected.sha.slice(0, 12)}</dd>
                </div>
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-3">
                  <dt className="text-muted">Repository</dt><dd className="break-all">{connection.repo.full_name}</dd>
                </div>
              </dl>
              <a href={'https://github.com/' + connection.repo.full_name + '/commits/' +
                encodeURIComponent(connection.repo.default_branch) + '/' +
                encodePath(selected.path.startsWith(PUBLIC_FOLDER + '/')
                  ? 'public-files' + selected.path.slice(PUBLIC_FOLDER.length)
                  : '.vault/state.json')}
                target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-xs text-accent hover:underline">
                <GitBranch size={14} /> {selected.path.startsWith(PUBLIC_FOLDER + '/') ? 'Public file history' : 'Encrypted vault history'} <ExternalLink size={12} />
              </a>
            </div>
            {error && <p role="alert" className="border-t border-red-200 bg-red-50 px-5 py-3 text-xs text-red-900">{error}</p>}
            <div className="grid grid-cols-3 gap-2 border-t border-line bg-white p-4 sm:px-6">
              <button className="action action-outline !px-2" disabled={!!busy}
                onClick={() => setNameDialog({ type: 'rename', item: selected })}><Pencil size={15} /> Rename</button>
              <button className="action action-outline !px-2" disabled={!!busy} onClick={() => remove(selected)}>
                <Trash2 size={15} /> Delete
              </button>
              <button className="action action-primary !px-2" disabled={!!busy} onClick={() => download(selected)}>
                <ArrowDownToLine size={15} /> Download
              </button>
            </div>
          </section>
        </div>
      )}

      {nameDialog && (
        <NameEditor key={nameDialog.item?.path || 'new-folder'}
          title={nameDialog.type === 'folder' ? 'New folder' : 'Rename file'}
          value={nameDialog.item?.name || ''} onCancel={() => setNameDialog(null)} onSave={saveName} />
      )}
      <footer className="pb-7 text-center text-[11px] text-muted">Small files. Real history. Built on GitHub.</footer>
    </div>
  );
}
