import {describe, expect, it, vi} from 'vitest';

vi.mock('obsidian', () => ({}));

import {ShardStore, parseShard, parseShardName, shardIndex, shardPath, validateRecord} from '../src/shards';
import type {App} from 'obsidian';
import type {EdgeRecord, ImageRecord} from '../src/types';

const image = (id: string): ImageRecord => ({id, path: `${id}.png`, x: 0, y: 0, width: 10, height: 10});
const edge = (id: string): EdgeRecord => ({id, source: {imageId: 'a'}, target: {imageId: 'b'}, direction: 'none', properties: {}});

/** A vault that behaves like Obsidian's for the handful of calls the shard layer makes. */
class Vault {
 files = new Map<string, {path: string; extension: string; stat: object; text: string}>();
 folders = new Set<string>();
 getFiles() { return [...this.files.values()]; }
 getAbstractFileByPath(path: string) { return this.files.get(path) ?? (this.folders.has(path) ? {path} : null); }
 async createFolder(path: string) { if (this.folders.has(path)) throw new Error('exists'); this.folders.add(path); }
 async read(file: {text: string}) { return file.text; }
 async create(path: string, text: string) {
  const file = {path, extension: 'json', stat: {}, text};
  this.files.set(path, file); return file;
 }
 async process(file: {text: string}, change: (current: string) => string) { file.text = change(file.text); }
}
const appWith = (vault: Vault) => ({vault} as unknown as App);
const shardsIn = (vault: Vault) => [...vault.files.keys()].sort();

describe('where a record lives', () => {
 it('is decided by the id alone, so nothing is ever renumbered', () => {
  expect(shardIndex('img-abc')).toBe(shardIndex('img-abc'));
  expect(shardIndex('img-abc')).toBeGreaterThanOrEqual(0);
  expect(shardIndex('img-abc')).toBeLessThan(64);
 });

 it('spreads ids over the shards rather than heaping them in one', () => {
  const used = new Set(Array.from({length: 500}, (_, n) => shardIndex(`img-${n}`)));
  expect(used.size).toBeGreaterThan(30);
 });

 it('names a file a reader can find its way back from', () => {
  const path = shardPath('regions', 10);
  expect(path).toBe('_Image Graph/Data/regions-0a.json');
  expect(parseShardName(path)).toEqual({kind: 'regions', index: 10});
 });

 it('does not mistake another file for one of ours', () => {
  expect(parseShardName('_Image Graph/Data/images-0a.json')).toEqual({kind: 'images', index: 10});
  expect(parseShardName('_Image Graph/Data/notes-0a.json')).toBeUndefined();
  expect(parseShardName('_Image Graph/Thumbnails/sizes.json')).toBeUndefined();
  expect(parseShardName('elsewhere/images-0a.json')).toBeUndefined();
 });
});

describe('reading a shard', () => {
 const good = JSON.stringify({version: 1, kind: 'images', records: [image('a')]});

 it('returns the records it holds', () => {
  expect(parseShard(good, 'images', 0)).toEqual([image('a')]);
 });

 it('names the file when it cannot be read, so the owner can find it', () => {
  expect(() => parseShard('{oh no', 'images', 3)).toThrow('_Image Graph/Data/images-03.json');
  expect(() => parseShard('{oh no', 'images', 3)).toThrow('Corrupt');
 });

 it('refuses a file that is not this version, this kind, or a list of records', () => {
  expect(() => parseShard(JSON.stringify({version: 2, kind: 'images', records: []}), 'images', 0)).toThrow('Invalid');
  expect(() => parseShard(JSON.stringify({version: 1, kind: 'edges', records: []}), 'images', 0)).toThrow('Invalid');
  expect(() => parseShard(JSON.stringify({version: 1, kind: 'images', records: {}}), 'images', 0)).toThrow('Invalid');
  expect(() => parseShard('null', 'images', 0)).toThrow('Invalid');
 });
});

describe('validateRecord', () => {
 it('insists every record has an id', () => {
  expect(() => validateRecord('images', {})).toThrow('Invalid images record');
  expect(() => validateRecord('edges', {id: ''})).toThrow('Invalid edges record');
 });

 it('insists an image has a path and a real rectangle', () => {
  expect(() => validateRecord('images', {...image('a'), width: 0})).toThrow('Invalid image record');
  expect(() => validateRecord('images', {...image('a'), x: Number.NaN})).toThrow('Invalid image record');
  expect(() => validateRecord('images', {...image('a'), path: ''})).toThrow('Invalid image record');
 });

 it('insists a region belongs to an image and carries a label', () => {
  const shape = {type: 'rect', x: 0, y: 0, width: .5, height: .5};
  expect(() => validateRecord('regions', {id: 'r', shape, label: 'x'})).toThrow('belong to an image');
  expect(() => validateRecord('regions', {id: 'r', imageId: 'a', shape})).toThrow('label');
  expect(() => validateRecord('regions', {id: 'r', imageId: 'a', label: 'x', shape})).not.toThrow();
 });

 it('insists a connection has two ends and an arrow direction', () => {
  expect(() => validateRecord('edges', {id: 'e', target: {imageId: 'b'}, direction: 'none'})).toThrow('source and a target');
  expect(() => validateRecord('edges', {...edge('e'), direction: 'sideways'})).toThrow('arrow direction');
 });

 it('bites harder on the way in than on the way out', () => {
  // One hand-edited field must not stop a whole shard loading; a write is where the rules bite.
  const corrupt = {...edge('e'), properties: {relation: '   '}};
  expect(() => validateRecord('edges', corrupt)).not.toThrow();
  expect(() => validateRecord('edges', corrupt, true)).toThrow('resembles');
 });
});

describe('ShardStore', () => {
 it('creates a shard for a record that has none', async () => {
  const vault = new Vault();
  await new ShardStore(appWith(vault)).write('images', [image('a')]);
  expect(shardsIn(vault)).toEqual([shardPath('images', shardIndex('a'))]);
  expect(vault.folders.has('_Image Graph/Data')).toBe(true);
 });

 it('merges into a shard that exists, replacing by id and keeping the rest', async () => {
  const vault = new Vault(), shards = new ShardStore(appWith(vault));
  await shards.write('images', [image('a')]);
  const path = shardPath('images', shardIndex('a'));
  await shards.write('images', [{...image('a'), x: 99}]);
  const held = parseShard(vault.files.get(path)!.text, 'images', shardIndex('a'));
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({id: 'a', x: 99});
 });

 it('writes one file per shard however many records are handed to it', async () => {
  const vault = new Vault();
  const records = Array.from({length: 40}, (_, n) => image(`img-${n}`));
  await new ShardStore(appWith(vault)).write('images', records);
  const expected = new Set(records.map(record => shardPath('images', shardIndex(record.id))));
  expect(shardsIn(vault)).toEqual([...expected].sort());
 });

 it('reads every record back, sorted into its kind', async () => {
  const vault = new Vault(), shards = new ShardStore(appWith(vault));
  await shards.write('images', [image('a'), image('b')]);
  await shards.write('edges', [edge('e')]);
  const all = await shards.readAll();
  expect(all.images.map(r => r.id).sort()).toEqual(['a', 'b']);
  expect(all.edges.map(r => r.id)).toEqual(['e']);
  expect(all.regions).toEqual([]);
 });

 it('takes one record out and leaves its neighbours in the shard', async () => {
  const vault = new Vault(), shards = new ShardStore(appWith(vault));
  // Two ids that land in the same file, so removal has something to leave behind.
  const ids = Array.from({length: 400}, (_, n) => `img-${n}`);
  const target = shardIndex(ids[0]);
  const together = ids.filter(id => shardIndex(id) === target).slice(0, 2);
  expect(together).toHaveLength(2);
  await shards.write('images', together.map(image));
  await shards.remove('images', together[0]);
  const held = parseShard(vault.files.get(shardPath('images', target))!.text, 'images', target);
  expect(held.map(record => record.id)).toEqual([together[1]]);
 });

 it('has nothing to remove from a shard that was never written', async () => {
  const vault = new Vault();
  await expect(new ShardStore(appWith(vault)).remove('images', 'ghost')).resolves.toBeUndefined();
  expect(shardsIn(vault)).toEqual([]);
 });

 it('writes nothing at all for an empty batch', async () => {
  const vault = new Vault();
  await new ShardStore(appWith(vault)).write('images', []);
  expect(shardsIn(vault)).toEqual([]);
  expect(vault.folders.size).toBe(0);
 });
});
