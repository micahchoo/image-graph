import {describe, expect, it, vi} from 'vitest';

vi.mock('obsidian', () => ({}));

import {isCatalogImage, nextCatalog, stableId} from '../src/catalog';
import {ROW_HEIGHT} from '../src/layout';
import type {ImageRecord} from '../src/types';

const held = (path: string, over: Partial<ImageRecord> = {}): ImageRecord =>
 ({id: stableId(path), path, x: 0, y: 0, width: 240, height: 240, ...over});

describe('which files are pictures', () => {
 it('takes every image outside the plugin folder', () => {
  expect(isCatalogImage('Photos/a.png')).toBe(true);
  expect(isCatalogImage('a.JPEG')).toBe(true);
  expect(isCatalogImage('Notes/a.md')).toBe(false);
 });

 it('takes only the extracted ones from inside it, never its caches', () => {
  expect(isCatalogImage('_Image Graph/Extracted/x.png')).toBe(true);
  expect(isCatalogImage('_Image Graph/Thumbnails/page-0.png')).toBe(false);
  expect(isCatalogImage('_Image Graph/Exports/image-graph.png')).toBe(false);
 });
});

describe('an id is a function of the path', () => {
 it('is the same every session, and different for different pictures', () => {
  expect(stableId('Photos/a.png')).toBe(stableId('Photos/a.png'));
  expect(stableId('Photos/a.png')).not.toBe(stableId('Photos/b.png'));
 });

 it('does not collide across a vault the size of the development one', () => {
  const ids = new Set(Array.from({length: 20000}, (_, n) => stableId(`Photos/${n}.png`)));
  expect(ids.size).toBe(20000);
 });
});

describe('the derived catalog', () => {
 it('gives every file a record, in rows of one height', () => {
  const catalog = nextCatalog(['a.png', 'b.png', 'c.png'], []);
  expect(catalog).toHaveLength(3);
  expect(catalog.every(image => image.height === ROW_HEIGHT)).toBe(true);
  expect(new Set(catalog.map(image => `${image.x},${image.y}`)).size).toBe(3);
 });

 it('keeps a record the owner placed exactly where they put it', () => {
  const pinned = held('a.png', {x: 4000, y: -320, pinned: true});
  const catalog = nextCatalog(['a.png', 'b.png'], [pinned]);
  expect(catalog.find(image => image.path === 'a.png')).toMatchObject({x: 4000, y: -320});
 });

 it('gives a placed picture no slot in the rows the others wrap into', () => {
  const loose = nextCatalog(['a.png', 'b.png'], []);
  const withPinned = nextCatalog(['a.png', 'b.png'], [held('a.png', {x: 9000, y: 9000, pinned: true})]);
  expect(withPinned.find(i => i.path === 'b.png')).toMatchObject({x: loose[0].x, y: loose[0].y});
 });

 it('marks a record whose file has gone rather than dropping it', () => {
  const catalog = nextCatalog(['b.png'], [held('a.png'), held('b.png')]);
  expect(catalog).toHaveLength(2);
  expect(catalog.find(image => image.path === 'a.png')?.missing).toBe(true);
  expect(catalog.find(image => image.path === 'b.png')?.missing).toBe(false);
 });

 it('un-marks one whose file came back', () => {
  const gone = nextCatalog([], [held('a.png')]);
  expect(gone[0].missing).toBe(true);
  expect(nextCatalog(['a.png'], gone)[0].missing).toBe(false);
 });

 it('keeps a record its id, its size and its properties across a rebuild', () => {
  const before = nextCatalog(['a.png'], [held('a.png', {width: 480, metadataPath: 'Notes/a.md'})]);
  expect(before[0]).toMatchObject({id: stableId('a.png'), width: 480, metadataPath: 'Notes/a.md'});
 });

 it('is empty for an empty vault, and does not invent anything', () => {
  expect(nextCatalog([], [])).toEqual([]);
 });
});
