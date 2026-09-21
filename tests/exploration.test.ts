import {describe, expect, it} from 'vitest';

import {EXPLORE_LIMIT, Exploration} from '../src/exploration';
import type {Camera, EdgeRecord, GraphSnapshot, ImageRecord} from '../src/types';

const image = (id: string): ImageRecord => ({id, path: `${id}.png`, x: 0, y: 0, width: 100, height: 80});
const edge = (id: string, source: string, target: string, relation = 'related'): EdgeRecord =>
 ({id, source: {imageId: source}, target: {imageId: target}, direction: 'forward', properties: {relation}});
const snapshotOf = (ids: string[], edges: EdgeRecord[]): GraphSnapshot => ({images: ids.map(image), regions: [], edges});
const CAMERA: Camera = {x: 3, y: 5, scale: .5};

/** a — b — c — d, one hop apart along the chain. */
const chain = snapshotOf(['a', 'b', 'c', 'd'], [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd')]);

describe('entering an exploration', () => {
 it('drops ids the vault does not hold, and refuses when none is left', () => {
  expect(Exploration.fromImages(chain, ['a', 'ghost'], CAMERA)?.roots).toEqual(['a']);
  expect(Exploration.fromImages(chain, ['ghost'], CAMERA)).toBeNull();
  expect(Exploration.fromImages(chain, [], CAMERA)).toBeNull();
 });

 it('starts one hop out and keeps the camera it was asked to hold', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  expect(ex.depth).toBe(1);
  expect(ex.graph.ids).toEqual(['a', 'b']);
  expect(ex.savedCamera).toEqual(CAMERA);
 });

 it('refuses a relation that joins nothing, and an empty name', () => {
  expect(Exploration.fromRelation(chain, 'unheard of', CAMERA)).toBeNull();
  expect(Exploration.fromRelation(chain, '', CAMERA)).toBeNull();
  expect(Exploration.fromRelation(chain, 'related', CAMERA)?.roots).toEqual([]);
 });
});

describe('the anchor', () => {
 it('is the one starting picture, and nothing when there are two or none', () => {
  expect(Exploration.fromImages(chain, ['a'], CAMERA)!.anchor).toBe('a');
  expect(Exploration.fromImages(chain, ['a', 'b'], CAMERA)!.anchor).toBeNull();
  expect(Exploration.fromRelation(chain, 'related', CAMERA)!.anchor).toBeNull();
 });

 it('counts hops for a neighbourhood and not for a relation', () => {
  expect(Exploration.fromImages(chain, ['a'], CAMERA)!.countsHops).toBe(true);
  expect(Exploration.fromRelation(chain, 'related', CAMERA)!.countsHops).toBe(false);
 });
});

describe('depth', () => {
 it('reaches further and stays between one and three hops', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.setDepth(2); ex.rebuild(chain);
  expect(ex.graph.ids).toEqual(['a', 'b', 'c']);
  for (const [asked, held] of [[0, 1], [-4, 1], [9, 3], [2.7, 2], [Number.NaN, 1]] as const) {
   ex.setDepth(asked); expect(ex.depth).toBe(held);
  }
 });

 it('forgets what was expanded under the old depth', () => {
  // Otherwise two hops would show more than three did: the expansions answered a question
  // that is no longer being asked.
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.expand('b'); ex.rebuild(chain);
  expect(ex.graph.ids).toEqual(['a', 'b', 'c']);
  ex.setDepth(1);
  expect([...ex.expanded]).toEqual([]);
  ex.rebuild(chain);
  expect(ex.graph.ids).toEqual(['a', 'b']);
 });
});

describe('pinning', () => {
 it('toggles an ordinary image and refuses a starting picture', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.togglePin('b'); expect([...ex.pinned]).toEqual(['b']);
  ex.togglePin('b'); expect([...ex.pinned]).toEqual([]);
  ex.togglePin('a'); expect([...ex.pinned]).toEqual([]);
  expect(ex.isRoot('a')).toBe(true);
  expect(ex.isRoot('b')).toBe(false);
 });

 it('pins where a drag placed an image, never a starting picture', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.pin('b'); ex.pin('b'); ex.pin('a');
  expect([...ex.pinned]).toEqual(['b']);
 });

 it('leaves a pinned image where it was put', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.setDepth(3); ex.rebuild(chain);
  ex.positions.set('d', {...ex.positions.get('d')!, x: 4321, y: -765});
  ex.pin('d');
  ex.rebuild(chain);
  expect(ex.positions.get('d')).toMatchObject({x: 4321, y: -765});
 });

 it('holds the anchor still across a rebuild', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.rebuild(chain);
  const was = {...ex.positions.get('a')!};
  ex.setDepth(3); ex.rebuild(chain);
  expect(ex.positions.get('a')).toMatchObject({x: was.x, y: was.y});
 });
});

describe('rebuilding', () => {
 it('lays out every image the graph holds', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.setDepth(3); ex.rebuild(chain);
  expect([...ex.positions.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
 });

 it('follows the vault: a connection made since it opened is there after a rebuild', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  const grown = snapshotOf(['a', 'b', 'c', 'd', 'e'], [...chain.edges, edge('ae', 'a', 'e')]);
  ex.rebuild(grown);
  expect(ex.graph.ids).toEqual(['a', 'b', 'e']);
 });

 it('dims with the filter and never traverses by it', () => {
  // The filter is presentation. A filtered traversal would drop the context that makes a
  // dimmed connection mean anything.
  const mixed = snapshotOf(['a', 'b', 'c'], [edge('ab', 'a', 'b', 'echoes'), edge('bc', 'b', 'c', 'resembles')]);
  const ex = Exploration.fromImages(mixed, ['a'], CAMERA)!;
  ex.setDepth(2); ex.filter = 'echoes'; ex.rebuild(mixed);
  expect(ex.graph.ids).toEqual(['a', 'b', 'c']);
 });

 it('stays a relation across a rebuild, hops or no hops', () => {
  const ex = Exploration.fromRelation(chain, 'related', CAMERA)!;
  ex.setDepth(3); ex.rebuild(chain);
  expect(ex.relation).toBe('related');
  expect(ex.graph.ids.sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(ex.graph.parents.size).toBe(0);
 });
});

describe('the cap', () => {
 const wide = snapshotOf(
  ['root', ...Array.from({length: 400}, (_, n) => `n${n}`)],
  Array.from({length: 400}, (_, n) => edge(`e${n}`, 'root', `n${n}`)),
 );

 it('is one number, and a capped neighbourhood says so', () => {
  const ex = Exploration.fromImages(wide, ['root'], CAMERA)!;
  expect(ex.graph.ids.length).toBe(EXPLORE_LIMIT);
  expect(ex.graph.capped).toBe(true);
 });

 it('holds after a rebuild and for a relation too', () => {
  const ex = Exploration.fromImages(wide, ['root'], CAMERA)!;
  ex.setDepth(3); ex.rebuild(wide);
  expect(ex.graph.ids.length).toBe(EXPLORE_LIMIT);
  expect(Exploration.fromRelation(wide, 'related', CAMERA)!.graph.ids.length).toBe(EXPLORE_LIMIT);
 });
});
