import type { Entry } from './github';

export type FileCategory = 'all' | 'images' | 'documents' | 'code';
export type FileSort = 'name' | 'size' | 'type';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']);
const DOCUMENT = new Set(['txt', 'md', 'markdown', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'csv', 'xls', 'xlsx', 'ppt', 'pptx']);
const CODE = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'sh', 'java', 'kt', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'toml', 'ini', 'html', 'css', 'scss', 'sql', 'log']);
export const PREVIEW_TEXT = new Set([...DOCUMENT, ...CODE].filter((ext) => !['pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)));
export const PREVIEW_IMAGES = new Set([...IMAGE].filter((ext) => ext !== 'svg'));

export function extension(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

export function category(item: Entry): Exclude<FileCategory, 'all'> | 'folder' | 'other' {
  if (item.type === 'dir') return 'folder';
  const ext = extension(item.name);
  if (IMAGE.has(ext)) return 'images';
  if (DOCUMENT.has(ext)) return 'documents';
  if (CODE.has(ext)) return 'code';
  return 'other';
}

export function typeLabel(item: Entry): string {
  if (item.type === 'dir') return 'Folder';
  const labels: Record<string, string> = {
    md: 'Markdown', txt: 'Text', json: 'JSON', jsonl: 'JSON Lines',
    pdf: 'PDF', docx: 'Word document', xlsx: 'Spreadsheet',
    png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', svg: 'Vector image',
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', kt: 'Kotlin', zip: 'ZIP archive', tar: 'TAR archive',
  };
  const ext = extension(item.name);
  return labels[ext] || (ext ? ext.toUpperCase() + ' file' : 'File');
}

export function readableSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / 1024 ** 2).toFixed(1) + ' MiB';
}

export function entriesBy(items: Entry[], sort: FileSort): Entry[] {
  return [...items].sort((a, b) =>
    Number(b.type === 'dir') - Number(a.type === 'dir') ||
    (sort === 'size' ? b.size - a.size : sort === 'type' ? typeLabel(a).localeCompare(typeLabel(b)) : 0) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

export function validName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[\\/\x00-\x1f]/.test(name);
}
