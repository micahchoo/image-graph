import type {App} from 'obsidian';
import type {EdgeRecord, ImageRecord, RegionRecord} from './types';
import {parseRegionShape, relationOf} from './graph';
import {isRecord} from './properties';
import {DATA_ROOT, ensureFolder, isFile} from './folders';

export type Kind = 'images' | 'regions' | 'edges';
export type Stored = ImageRecord | RegionRecord | EdgeRecord;
/** Bump only for a change no reader of the old shape could survive. */
const VERSION = 1;
/** Records are spread over this many files per kind, by a hash of the id. */
const SHARDS = 64;

/**
 * How the graph is written to the vault, and nothing else.
 *
 * Records live in `_Image Graph/Data/<kind>-<hh>.json`, sharded by a hash of the record's id so
 * that saving one connection rewrites a sixty-fourth of the connections rather than all of them.
 * A shard is the unit of a write, and a write goes through `vault.process` — Obsidian's atomic
 * read-modify-write — so two writes landing on one shard merge instead of one losing.
 *
 * The id decides the file, so nothing here ever renumbers anything: a record keeps its shard for
 * as long as it keeps its id.
 *
 * This is the only place that knows the format. `GraphStore` above it deals in records and never
 * in paths, JSON or versions.
 */
export class ShardStore {
 constructor(private readonly app: App) {}

 /** Every record the vault holds, in one pass over the data folder. */
 async readAll(): Promise<{images: ImageRecord[]; regions: RegionRecord[]; edges: EdgeRecord[]}> {
  const out = {images: [] as ImageRecord[], regions: [] as RegionRecord[], edges: [] as EdgeRecord[]};
  for (const file of this.app.vault.getFiles()) {
   const named = parseShardName(file.path);
   if (!named) continue;
   for (const record of parseShard(await this.app.vault.read(file), named.kind, named.index)) {
    if (named.kind === 'images') out.images.push(record as ImageRecord);
    else if (named.kind === 'regions') out.regions.push(record as RegionRecord);
    else out.edges.push(record as EdgeRecord);
   }
  }
  return out;
 }

 /**
  * Write records, one rewrite per shard whatever the batch size.
  *
  * Still inside `process`, so a concurrent write to the same shard is merged rather than lost.
  * Records already in the shard under the same ids are replaced, not duplicated.
  */
 async write(kind: Kind, records: readonly Stored[]): Promise<void> {
  if (!records.length) return;
  await ensureFolder(this.app, DATA_ROOT);
  const batches = new Map<number, Stored[]>();
  for (const record of records) {
   const index = shardIndex(record.id), batch = batches.get(index);
   if (batch) batch.push(record); else batches.set(index, [record]);
  }
  for (const [index, batch] of batches) {
   const path = shardPath(kind, index), file = this.app.vault.getAbstractFileByPath(path);
   const replaced = new Set(batch.map(item => item.id));
   if (file && isFile(file)) {
    await this.app.vault.process(file, current =>
     serialise(kind, [...parseShard(current, kind, index).filter(item => !replaced.has(item.id)), ...batch]));
   } else if (file) throw new Error(`Storage shard is not a file: ${path}`);
   else await this.app.vault.create(path, serialise(kind, batch));
  }
 }

 /** Take one record out of its shard. A shard that does not exist has nothing to remove. */
 async remove(kind: Kind, id: string): Promise<void> {
  const index = shardIndex(id), path = shardPath(kind, index);
  const file = this.app.vault.getAbstractFileByPath(path);
  if (!file || !isFile(file)) return;
  await this.app.vault.process(file, current => serialise(kind, parseShard(current, kind, index).filter(item => item.id !== id)));
 }
}

const serialise = (kind: Kind, records: readonly Stored[]): string =>
 JSON.stringify({version: VERSION, kind, records}, null, 2) + '\n';

/** Which shard a record belongs to. A function of the id alone, so it never changes under one. */
export function shardIndex(id: string): number {
 let hash = 0;
 for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
 return (hash >>> 0) % SHARDS;
}

export function shardPath(kind: Kind, index: number): string {
 return `${DATA_ROOT}/${kind}-${index.toString(16).padStart(2, '0')}.json`;
}

/** The kind and index a data-folder path names, or nothing when it is not one of ours. */
export function parseShardName(path: string): {kind: Kind; index: number} | undefined {
 const match = path.match(new RegExp(`^${DATA_ROOT}/(images|regions|edges)-([0-9a-f]{2})\\.json$`));
 return match ? {kind: match[1] as Kind, index: Number.parseInt(match[2], 16)} : undefined;
}

/** Read one shard. A file that is not one refuses by name, so the owner can find it. */
export function parseShard(text: string, kind: Kind, index: number): Stored[] {
 let value: unknown;
 try { value = JSON.parse(text); } catch { throw new Error(`Corrupt Image Graph shard: ${shardPath(kind, index)}`); }
 if (!isRecord(value) || value.version !== VERSION || value.kind !== kind || !Array.isArray(value.records)) {
  throw new Error(`Invalid Image Graph shard: ${shardPath(kind, index)}`);
 }
 const records = value.records as Stored[];
 records.forEach(record => validateRecord(kind, record));
 return records;
}

/**
 * `strict` is for writes. A shard read from the vault is accepted more liberally, because one
 * hand-edited field should not stop a whole shard loading; the write path is where the rules bite.
 */
export function validateRecord(kind: Kind, record: unknown, strict = false): asserts record is Stored {
 if (!isRecord(record) || typeof record.id !== 'string' || !record.id) throw new Error(`Invalid ${kind} record`);
 if (kind === 'images' && (typeof record.path !== 'string' || !record.path || !finite(record.x) || !finite(record.y) || !finite(record.width) || record.width <= 0 || !finite(record.height) || record.height <= 0)) throw new Error('Invalid image record');
 if (kind === 'regions') {
  if (typeof record.imageId !== 'string' || !record.imageId) throw new Error('A region must belong to an image.');
  if (typeof record.label !== 'string') throw new Error('Give the region a label.');
  record.shape = parseRegionShape(record.shape);
 }
 if (kind === 'edges') {
  if (!validEndpoint(record.source) || !validEndpoint(record.target)) throw new Error('A connection needs a source and a target.');
  if (!['none', 'forward', 'reverse', 'both'].includes(record.direction as string)) throw new Error('Choose an arrow direction.');
  // A connection without a relation has simply not been described yet. One that carries an
  // unusable relation is corrupt, and the renderer used to hide that behind its own fallback.
  if (strict && isRecord(record.properties) && 'relation' in record.properties && !relationOf(record.properties)) {
   throw new Error('Describe the connection in relation, as text, for example “resembles”.');
  }
 }
}

function validEndpoint(value: unknown): boolean {
 return isRecord(value) && typeof value.imageId === 'string' && value.imageId.length > 0
  && (!('regionId' in value) || typeof value.regionId === 'string' && value.regionId.length > 0);
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
