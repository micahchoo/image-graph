import {describe, expect, it} from 'vitest';
import {ANNOTATION_ORIGIN, annotationId, annotationRegionId, isForeignRegion, readAnnotationIndex} from '../src/annotations';

const rect = {type: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4};
const polygon = {type: 'polygon', points: [{x: 0, y: 0}, {x: 1, y: 0}, {x: 0.5, y: 1}]};
const region = (id: string, path: string, geometry: unknown, title = 'Detail', notePath: unknown = `Regions/${title.trim()}.md`) => ({id, title, notePath, source: {path}, geometry});
const index = (regions: unknown[]) => JSON.stringify({version: 1, regions, connections: []});
const catalog = new Map([['Photos/a.png', 'img-a'], ['Image Annotation/Media/abc.png', 'img-web']]);

describe('readAnnotationIndex', () => {
 it('reads rectangles and polygons as foreign regions on the catalogued image', () => {
  const result = readAnnotationIndex(index([region('r1', 'Photos/a.png', rect), region('r2', 'Image Annotation/Media/abc.png', polygon, '  Sky ')]), catalog);
  expect(result.regions).toEqual([
   {id: 'ia-r1', imageId: 'img-a', label: 'Detail', shape: rect, properties: {}, origin: ANNOTATION_ORIGIN},
   {id: 'ia-r2', imageId: 'img-web', label: 'Sky', shape: polygon, properties: {}, origin: ANNOTATION_ORIGIN},
  ]);
  expect(result.skipped).toEqual({missingImage: 0, invalid: 0});
  expect(result.regions.every(isForeignRegion)).toBe(true);
 });
 it('knows each region’s note, and skips a note path that is not a note', () => {
  const result = readAnnotationIndex(index([region('r1', 'Photos/a.png', rect, 'Eyes'), region('r2', 'Photos/a.png', rect, 'Lips', 42)]), catalog);
  expect(result.notes.get('ia-r1')).toBe('Regions/Eyes.md');
  expect(result.notes.has('ia-r2')).toBe(false);
  expect(result.regions.map(r => r.id)).toEqual(['ia-r1', 'ia-r2']);
 });
 it('reads an index without connections, which Image Annotation no longer needs', () => {
  expect(readAnnotationIndex(JSON.stringify({version: 1, regions: [region('r1', 'Photos/a.png', rect)]}), catalog).regions).toHaveLength(1);
 });
 it('skips a region whose image is not in the catalog and counts it', () => {
  const result = readAnnotationIndex(index([region('r1', 'Missing.png', rect), region('r2', 'Photos/a.png', rect)]), catalog);
  expect(result.regions.map(r => r.id)).toEqual(['ia-r2']);
  expect(result.skipped.missingImage).toBe(1);
 });
 it('skips one malformed record without losing the others', () => {
  const bad = [region('r1', 'Photos/a.png', {type: 'rect', x: 0, y: 0, width: 2, height: 1}), {id: 'r2'}, region('r3', 'Photos/a.png', {type: 'polygon', points: [{x: 0, y: 0}]}), region('r4', 'Photos/a.png', polygon)];
  const result = readAnnotationIndex(index(bad), catalog);
  expect(result.regions.map(r => r.id)).toEqual(['ia-r4']);
  expect(result.skipped.invalid).toBe(3);
 });
 it('refuses a file that is not an index, naming the file', () => {
  expect(() => readAnnotationIndex('{bad', catalog)).toThrow('Image Annotation/index.json');
  expect(() => readAnnotationIndex(JSON.stringify({version: 2, regions: [], connections: []}), catalog)).toThrow('Unsupported');
  expect(() => readAnnotationIndex(JSON.stringify({version: 1, regions: {}}), catalog)).toThrow('Unsupported');
 });
 it('gives a foreign region its own id space and reads it back', () => {
  expect(annotationRegionId('r1')).toBe('ia-r1');
  expect(annotationId('ia-r1')).toBe('r1');
  expect(annotationId('region-8f1c')).toBeNull();
  expect(isForeignRegion({origin: undefined})).toBe(false);
 });
 it('remembers where a web image came from, once per image', () => {
  const web = (id: string, extra: object) => ({...region(id, 'Image Annotation/Media/abc.png', rect), source: {path: 'Image Annotation/Media/abc.png', width: 1, height: 1, ...extra}});
  const result = readAnnotationIndex(index([web('r1', {originalUrl: 'https://x.test/a.png', articlePath: 'Clips/Essay.md'}), web('r2', {originalUrl: 'https://other.test/b.png'}), region('r3', 'Photos/a.png', rect)]), catalog);
  expect(result.sources.get('img-web')).toEqual({originalUrl: 'https://x.test/a.png', articlePath: 'Clips/Essay.md'});
  expect(result.sources.has('img-a')).toBe(false);
 });

});
