import {App, TFile} from 'obsidian';
import type {PixelSize} from './dimensions';
import {readImageSize} from './dimensions';
import type {ImageRecord} from './types';
import type {JobHandle, Jobs} from './jobs';

const ROOT = '_Image Graph/Thumbnails', FILE = `${ROOT}/sizes.json`, BATCH = 250;
/** width, height, mtime, byte size. A width of 0 records a format the header reader cannot read. */
type Entry = [number, number, number, number];

/**
 * Every original's proportions, read once from its header and remembered.
 *
 * The whole-vault grid gives each picture a width of its own, which it cannot do until it
 * knows the picture's shape. The file has to be read to learn it — Obsidian's vault has no
 * ranged read — so this runs two at a time in the background and writes what it learns to
 * `sizes.json`, keyed by path and checked against the file's mtime and length. A vault is
 * read through once; after that a session costs one small JSON file.
 */
export class SizeIndex {
 private known = new Map<string, Entry>();
 private queue: ImageRecord[] = [];
 private queued = new Set<string>();
 private pending = new Map<string, PixelSize>();
 private running = 0;
 private started = false;
 private disposed = false;
 private images: ImageRecord[] = [];
 private write: Promise<void> = Promise.resolve();
 private timer: number | undefined;
 private job: JobHandle | undefined;
 private measured = 0;
 constructor(private app: App, private doc: Document, private report: (sizes: ReadonlyMap<string, PixelSize>) => void, private jobs?: Jobs) {
  void this.start();
 }

 private async start(): Promise<void> {
  this.known = await this.read();
  if (this.disposed) return;
  this.started = true;
  this.republish();
  this.sync(this.images);
 }

 private async read(): Promise<Map<string, Entry>> {
  try {
   const file = this.app.vault.getAbstractFileByPath(FILE);
   if (!(file instanceof TFile)) return new Map();
   const value: unknown = JSON.parse(await this.app.vault.read(file));
   if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('sizes' in value) || !value.sizes || typeof value.sizes !== 'object') return new Map();
   const entries = new Map<string, Entry>();
   for (const [path, entry] of Object.entries(value.sizes as Record<string, unknown>)) {
    if (Array.isArray(entry) && entry.length === 4 && entry.every(item => typeof item === 'number' && Number.isFinite(item))) entries.set(path, entry as Entry);
   }
   return entries;
  } catch { return new Map(); /* An unreadable cache is rebuilt, never a reason to fail. */ }
 }

 /** Queue whatever is new or has changed on disk. Cheap to call on every catalog change. */
 sync(images: ImageRecord[]): void {
  if (this.disposed) return;
  this.images = images;
  if (!this.started) return;
  for (const image of images) {
   if (image.missing || this.queued.has(image.path)) continue;
   const file = this.app.vault.getAbstractFileByPath(image.path);
   if (!(file instanceof TFile)) continue;
   const entry = this.known.get(image.path);
   if (entry && entry[2] === file.stat.mtime && entry[3] === file.stat.size) continue;
   this.queued.add(image.path); this.queue.push(image);
  }
  this.pump();
 }

 /** One job for the whole pass, not one per file: `sync` tops the queue up as images arrive. */
 private track(): void {
  if (!this.jobs) return;
  if (!this.queue.length && !this.running) { this.job?.finish(); this.job = undefined; this.measured = 0; return; }
  if (!this.job) { this.job = this.jobs.start('Reading image sizes', this.queue.length + this.running); this.measured = 0; }
  this.job.step(this.measured, this.measured + this.queue.length + this.running);
 }

 private pump(): void {
  if (this.jobs && (this.job || this.queue.length || this.running)) this.track();
  if (this.job?.signal.aborted) { this.queue = []; this.queued.clear(); this.flush(); this.job.finish(); this.job = undefined; return; }
  while (!this.disposed && this.running < 2 && this.queue.length) {
   const image = this.queue.shift()!;
   this.running++;
   void this.measure(image).finally(() => { this.running--; this.measured++; if (!this.queue.length && !this.running) this.flush(); this.pump(); });
  }
 }

 private async measure(image: ImageRecord): Promise<void> {
  try {
   const file = this.app.vault.getAbstractFileByPath(image.path);
   if (!(file instanceof TFile)) return;
   const size = readImageSize(await this.app.vault.readBinary(file));
   if (this.disposed) return;
   this.known.set(image.path, [size?.width ?? 0, size?.height ?? 0, file.stat.mtime, file.stat.size]);
   if (size) this.pending.set(image.path, size);
   if (this.pending.size >= BATCH) this.flush(); else this.schedule();
  } catch { /* An unreadable original keeps its square cell; the catalog already shows it. */ }
  finally { this.queued.delete(image.path); await new Promise<void>(resolve => this.doc.defaultView?.setTimeout(resolve, 0)); }
 }

 /**
  * Re-apply every size already read. `GraphStore.load()` rebuilds the catalog from the shards,
  * and an image nobody has persisted comes back square, because the grid is derived and the
  * proportions are remembered here rather than there. Measured against the running plugin on
  * 2026-09-21: a single image move rewrote a data shard, which reloads the store, and eleven
  * pictures went back to square cells.
  */
 republish(): void { if (!this.disposed && this.started) this.publish(this.known); }

 /** Report in batches, so a vault of 20,000 costs a layout pass per 250 rather than per file. */
 private schedule(): void {
  if (this.disposed || this.timer !== undefined) return;
  this.timer = this.doc.defaultView?.setTimeout(() => { this.timer = undefined; this.flush(); }, 500);
 }
 private flush(): void {
  if (this.disposed || !this.pending.size) return;
  const batch = this.pending; this.pending = new Map();
  this.publish(batch);
  this.save();
 }

 private publish(entries: ReadonlyMap<string, Entry | PixelSize>): void {
  const sizes = new Map<string, PixelSize>();
  for (const [path, entry] of entries) {
   const [width, height] = Array.isArray(entry) ? entry : [entry.width, entry.height];
   if (width > 0 && height > 0) sizes.set(path, {width, height});
  }
  if (sizes.size) this.report(sizes);
 }

 private save(): void {
  const text = JSON.stringify({version: 1, sizes: Object.fromEntries(this.known)});
  this.write = this.write.then(async () => {
   if (this.disposed) return;
   for (const path of ['_Image Graph', ROOT]) if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
   const file = this.app.vault.getAbstractFileByPath(FILE);
   if (file instanceof TFile) await this.app.vault.modify(file, text); else await this.app.vault.create(FILE, text);
  }).catch((error: unknown) => console.warn('Image Graph image sizes:', error));
 }

 dispose(): void { this.disposed = true; if (this.timer !== undefined) this.doc.defaultView?.clearTimeout(this.timer); this.queue = []; this.queued.clear(); this.pending.clear(); this.images = []; }
 get stats() { return {known: this.known.size, queued: this.queue.length, reading: this.running}; }
}
