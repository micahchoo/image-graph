import {describe, expect, it} from 'vitest';
import {inferPropertyType, validateProperties} from '../src/property-builder';

describe('property builder value model', () => {
 it('infers metadata types without flattening arrays or nested objects', () => {
  expect(inferPropertyType(null)).toBe('null');
  expect(inferPropertyType(['one', 2, true])).toBe('list');
  expect(inferPropertyType({nested: {count: 2}})).toBe('object');
  expect(inferPropertyType(2)).toBe('number');
  expect(inferPropertyType(false)).toBe('boolean');
 });
 it('allows arbitrary nested values but rejects unsafe and reserved keys', () => {
  expect(() => validateProperties({tags: ['one', 'two'], meta: {constructor: 'x'}})).toThrow('constructor');
  expect(() => validateProperties({title: 'x'}, ['title'])).toThrow('reserved');
  expect(() => validateProperties({'': 'x'})).toThrow('property name');
  expect(() => validateProperties({ok: {nested: [1, null, true]}})).not.toThrow();
 });
});
