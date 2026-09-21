import {describe, expect, it} from 'vitest';
import {PropertyError, RESERVED_KEYS, parseProperties, parsePropertyValue, propertyMessage} from '../src/properties';
import {parseRegionShape, relationOf} from '../src/graph';

describe('property value contract', () => {
 it('keeps every value a companion note can hold', () => {
  const value = {title: 'x', count: 2, ok: true, empty: null, tags: ['a', 'b'], nested: {deep: [1, null]}};
  expect(parseProperties(value)).toEqual(value);
 });

 it('rejects what a JSON copy used to change silently', () => {
  // Storage cloned before validating, so a Date arrived as a string and an undefined
  // arrived as a missing key. Both are now refused where the owner can still fix them.
  expect(() => parsePropertyValue(new Date('2026-09-20'))).toThrow('as text');
  expect(() => parsePropertyValue(undefined)).toThrow('Give this property a value');
  expect(() => parsePropertyValue(Number.NaN)).toThrow('finite');
  expect(() => parsePropertyValue(() => 1)).toThrow('cannot hold a function');
 });

 it('names the field inside a nested value', () => {
  try { parseProperties({sources: [{url: 'ok'}, {url: undefined}]}); expect.unreachable(); }
  catch (error) {
   expect(error).toBeInstanceOf(PropertyError);
   expect((error as PropertyError).where).toBe('sources / 2 / url');
   expect(propertyMessage(error)).toContain('sources / 2 / url');
  }
 });

 it('refuses unsafe, reserved, blank and repeated names', () => {
  expect(() => parseProperties({meta: {constructor: 'x'}})).toThrow('constructor');
  expect(() => parseProperties({'': 'x'})).toThrow('Enter a property name');
  for (const key of RESERVED_KEYS) expect(() => parseProperties({[key]: 'x'}, [...RESERVED_KEYS])).toThrow('reserved');
  expect(() => parseProperties({image: 'x'})).not.toThrow();
 });
});

describe('region shape contract', () => {
 const rect = {type: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4};

 it('parses a rectangle and a polygon, dropping anything else on the object', () => {
  expect(parseRegionShape(rect)).toEqual(rect);
  expect(parseRegionShape({...rect, radius: 5})).toEqual(rect);
  const polygon = {type: 'polygon', points: [{x: 0, y: 0}, {x: 1, y: 0}, {x: .5, y: 1}]};
  expect(parseRegionShape({...polygon, points: polygon.points.map(p => ({...p, z: 9}))})).toEqual(polygon);
 });

 it('names the field rather than reporting an invalid record', () => {
  expect(() => parseRegionShape({...rect, type: 'circle'})).toThrow('rectangle or a polygon');
  expect(() => parseRegionShape({...rect, width: '0.2'})).toThrow('Enter a number for width');
  expect(() => parseRegionShape({...rect, width: 0})).toThrow('above 0');
  expect(() => parseRegionShape({...rect, x: 0.9, width: 0.5})).toThrow('inside the image');
  expect(() => parseRegionShape({type: 'polygon', points: [{x: 0, y: 0}, {x: 1, y: 1}]})).toThrow('three polygon corners');
  expect(() => parseRegionShape({type: 'polygon', points: [{x: 0, y: 0}, {x: 2, y: 0}, {x: 0, y: 1}]})).toThrow('corner 2');
  expect(() => parseRegionShape(null)).toThrow('needs a shape');
 });
});

describe('connection relation', () => {
 it('is one definition for storage, filtering and the label', () => {
  expect(relationOf({relation: 'resembles'})).toBe('resembles');
  for (const bad of [{relation: 42}, {relation: ''}, {relation: '  '}, {relation: null}, {}, null, ['relation']]) {
   expect(relationOf(bad)).toBeNull();
  }
 });
});
