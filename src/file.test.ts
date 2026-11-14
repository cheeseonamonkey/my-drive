import { describe, expect, it } from 'vitest';
import { category, entriesBy, readableSize, typeLabel, validName } from './file';
import type { Entry } from './github';

const entry = (name: string, size = 0, type: Entry['type'] = 'file'): Entry =>
  ({ name, path: name, sha: 'test', size, type });

describe('file presentation', () => {
  it('recognizes file categories and hides folders from categories', () => {
    expect(category(entry('photo.JPG'))).toBe('images');
    expect(category(entry('draft.md'))).toBe('documents');
    expect(category(entry('index.tsx'))).toBe('code');
    expect(category(entry('archive.zip'))).toBe('other');
    expect(category(entry('images', 0, 'dir'))).toBe('folder');
  });

  it('sorts folders first and files by selected column', () => {
    const files = [entry('a.txt', 20), entry('z.txt', 50), entry('folder', 0, 'dir')];
    expect(entriesBy(files, 'size').map((f) => f.name)).toEqual(['folder', 'z.txt', 'a.txt']);
    expect(entriesBy(files, 'name').map((f) => f.name)).toEqual(['folder', 'a.txt', 'z.txt']);
    expect(files[0].name).toBe('a.txt');
  });

  it('displays file type and sizes', () => {
    expect(typeLabel(entry('worker.kt'))).toBe('Kotlin');
    expect(readableSize(1024)).toBe('1.0 KiB');
  });

  it('rejects invalid names', () => {
    expect(validName('ok file.txt')).toBe(true);
    expect(validName('..')).toBe(false);
    expect(validName('a/b')).toBe(false);
  });
});
