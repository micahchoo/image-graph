import {describe, expect, it, vi} from 'vitest';

vi.mock('obsidian', () => ({}));

import {EXPORTS_ROOT, THUMBNAILS_ROOT, ensureFolder} from '../src/folders';
import type {App} from 'obsidian';

/**
 * Obsidian's vault refuses `createFolder` on a path that already exists, and it is async.
 * Every fake in this suite before now simply set the key, so no test could see the race the
 * real one has. This one refuses, like the real one.
 */
class Vault {
 readonly made: string[] = [];
 constructor(private readonly onCreate?: (path: string) => void) {}
 getAbstractFileByPath(path: string) { return this.made.includes(path) ? {path} : null; }
 async createFolder(path: string) {
  await Promise.resolve();
  this.onCreate?.(path);
  if (this.made.includes(path)) throw new Error(`Folder already exists: ${path}`);
  this.made.push(path);
 }
}
const appWith = (vault: Vault) => ({vault} as unknown as App);

describe('ensureFolder', () => {
 it('makes every missing parent, in order', async () => {
  const vault = new Vault();
  await ensureFolder(appWith(vault), '_Image Graph/Thumbnails');
  expect(vault.made).toEqual(['_Image Graph', '_Image Graph/Thumbnails']);
 });

 it('makes nothing that is already there', async () => {
  const vault = new Vault();
  await ensureFolder(appWith(vault), THUMBNAILS_ROOT);
  await ensureFolder(appWith(vault), THUMBNAILS_ROOT);
  expect(vault.made).toEqual(['_Image Graph', '_Image Graph/Thumbnails']);
 });

 it('lets every one of four concurrent callers through, and makes each folder once', async () => {
  // The atlas and the size index both build Thumbnails, both start from onload, and both
  // swallow what they catch. Before this, the loser silently failed to save its cache.
  const vault = new Vault();
  const app = appWith(vault);
  const settled = await Promise.allSettled([
   ensureFolder(app, THUMBNAILS_ROOT), ensureFolder(app, THUMBNAILS_ROOT),
   ensureFolder(app, EXPORTS_ROOT), ensureFolder(app, THUMBNAILS_ROOT),
  ]);
  expect(settled.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  expect([...vault.made].sort()).toEqual(['_Image Graph', '_Image Graph/Exports', '_Image Graph/Thumbnails']);
 });

 it('still reports a failure that is not a lost race', async () => {
  const broken = {vault: {getAbstractFileByPath: () => null, createFolder: () => Promise.reject(new Error('read-only vault'))}} as unknown as App;
  await expect(ensureFolder(broken, '_Image Graph')).rejects.toThrow('read-only vault');
 });

 it('ignores empty path segments rather than making a folder called nothing', async () => {
  const vault = new Vault();
  await ensureFolder(appWith(vault), '/_Image Graph//Exports/');
  expect(vault.made).toEqual(['_Image Graph', '_Image Graph/Exports']);
 });

 it('names the two folders the caches and the exporter share', () => {
  expect(THUMBNAILS_ROOT).toBe('_Image Graph/Thumbnails');
  expect(EXPORTS_ROOT).toBe('_Image Graph/Exports');
 });
});
