import {describe, expect, it} from 'vitest';

import {neighborhood, neighborhoodFrom, relationNames, relationNeighborhood, tracePath} from '../src/traversal';
import type {EdgeRecord, ImageRecord} from '../src/types';

const image = (id: string): ImageRecord => ({id, path: `${id}.png`, x: 0, y: 0, width: 100, height: 80});
const edge = (id: string, source: string, target: string, relation = 'related'): EdgeRecord => ({id, source: {imageId: source}, target: {imageId: target}, direction: 'forward', properties: {relation}});

describe('image graph traversal', () => {
 it('traverses across regions without following arrow direction and keeps shortest parents', () => {
  const snapshot = {images: ['a', 'b', 'c', 'd'].map(image), edges: [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('cd', 'c', 'd'), edge('bd', 'b', 'd')]};
  const result = neighborhood(snapshot, 'a', 3, new Set());
  expect(result.ids).toEqual(['a', 'b', 'c', 'd']);
  expect(result.distances.get('d')).toBe(2);
  expect(tracePath('a', 'd', result).map((step) => step.edge.id)).toEqual(['ab', 'bd']);
 });

 it('selectively expands a frontier node and reports a cap', () => {
  const snapshot = {images: ['a', 'b', 'c'].map(image), edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')]};
  expect(neighborhood(snapshot, 'a', 1, new Set()).ids).toEqual(['a', 'b']);
  const expanded = neighborhood(snapshot, 'a', 1, new Set(['b']), 2);
  expect(expanded.ids).toEqual(['a', 'b']);
  expect(expanded.capped).toBe(true);
 });

 it('traces a path back to whichever starting image reached the target', () => {
  const snapshot = {images: ['a', 'b', 'c', 'd'].map(image), edges: [edge('ab', 'a', 'b'), edge('cd', 'c', 'd')]};
  const result = neighborhoodFrom(snapshot, ['a', 'c'], 1, new Set());
  expect(tracePath(null, 'd', result).map((step) => step.from)).toEqual(['c']);
  expect(tracePath('a', 'd', result)).toEqual([]);
  expect(tracePath(null, 'a', result)).toEqual([]);
 });

 it('caps the starting images along with the rest', () => {
  const snapshot = {images: ['a', 'b', 'c', 'd'].map(image), edges: [edge('ab', 'a', 'b'), edge('cd', 'c', 'd')]};
  const result = neighborhoodFrom(snapshot, ['a', 'c', 'd'], 1, new Set(), 2);
  expect(result.ids).toEqual(['a', 'c']);
  expect(result.capped).toBe(true);
 });

 it('ignores dangling edges and keeps every relation', () => {
  const result = neighborhood({images: ['a', 'b'].map(image), edges: [edge('ok', 'a', 'b', 'keep'), edge('bad', 'a', 'missing', 'keep'), edge('other', 'a', 'b', 'skip')]}, 'a', 2, new Set());
  expect(result.ids).toEqual(['a', 'b']);
  expect(result.edges.map((item) => item.id)).toEqual(['ok', 'other']);
 });
});
