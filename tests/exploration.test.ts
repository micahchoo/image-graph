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
 it('toggles an ordinary image and refuses the anchor', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.togglePin('b'); expect([...ex.pinned]).toEqual(['b']);
  ex.togglePin('b'); expect([...ex.pinned]).toEqual([]);
  ex.togglePin('a'); expect([...ex.pinned]).toEqual([]);
  expect(ex.isRoot('a')).toBe(true);
  expect(ex.isAnchor('a')).toBe(true);
  expect(ex.isRoot('b')).toBe(false);
 });

 it('pins where a drag placed an image, never the anchor', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.pin('b'); ex.pin('b'); ex.pin('a');
  expect([...ex.pinned]).toEqual(['b']);
 });

 it('lets every starting picture of a selection be pinned, because none is the anchor', () => {
  // The point of exploring a selection is a smaller space to arrange and draw in, and an
  // image that cannot be moved cannot be arranged.
  const ex = Exploration.fromImages(chain, ['a', 'c'], CAMERA)!;
  expect(ex.isRoot('a') && ex.isRoot('c')).toBe(true);
  expect(ex.isAnchor('a') || ex.isAnchor('c')).toBe(false);
  ex.pin('a'); ex.togglePin('c');
  expect([...ex.pinned].sort()).toEqual(['a', 'c']);
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
 const moved = (before: Map<string, {x: number; y: number}>, after: Map<string, {x: number; y: number}>) =>
  [...after].filter(([id, r]) => { const was = before.get(id); return was && (was.x !== r.x || was.y !== r.y); }).map(([id]) => id);
 const copy = (positions: Map<string, {x: number; y: number}>) => new Map([...positions].map(([id, r]) => [id, {x: r.x, y: r.y}]));

 it('holds every placed image when the vault changes, and places only the newcomer', () => {
  // Drawing a connection while exploring notifies the view, which rebuilds. That is no reason
  // to move anything the owner can see. Measured before this, 2026-09-21: every image of a
  // rootless neighbourhood moved ~320px on every rebuild, whether or not anything had changed.
  for (const roots of [['a'], ['a', 'c']]) {
   const ex = Exploration.fromImages(chain, roots, CAMERA)!;
   ex.setDepth(3); ex.rebuild(chain);
   const before = copy(ex.positions);
   ex.rebuild(chain);
   expect(moved(before, ex.positions), roots.join()).toEqual([]);
   const grown = snapshotOf(['a', 'b', 'c', 'd', 'e'], [...chain.edges, edge('be', 'b', 'e')]);
   ex.rebuild(grown);
   expect(moved(before, ex.positions), roots.join()).toEqual([]);
   expect(ex.positions.has('e')).toBe(true);
  }
 });

 it('lets unpinned images settle again after the question changes, and holds pinned ones', () => {
  const ex = Exploration.fromImages(chain, ['a'], CAMERA)!;
  ex.setDepth(3); ex.rebuild(chain);
  ex.positions.set('c', {...ex.positions.get('c')!, x: 5000, y: 5000});
  ex.positions.set('d', {...ex.positions.get('d')!, x: -5000, y: -5000});
  ex.pin('d');
  const before = copy(ex.positions);
  ex.setDepth(2); ex.rebuild(chain);
  const settled = moved(before, ex.positions);
  expect(settled).toContain('c');
  expect(settled).not.toContain('d');
  expect(settled).not.toContain('a');
  // The question was answered; the next rebuild is for the vault and holds everything.
  const after = copy(ex.positions);
  ex.rebuild(chain);
  expect(moved(after, ex.positions)).toEqual([]);
 });

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

describe('paths', () => {
 it('traces from whichever starting picture reached the image, and nothing for a root', () => {
  const ex = Exploration.fromImages(chain, ['a', 'd'], CAMERA)!;
  ex.setDepth(1); ex.rebuild(chain);
  expect(ex.pathTo('b').map(step => step.edge.id)).toEqual(['ab']);
  expect(ex.pathTo('c').map(step => step.edge.id)).toEqual(['cd']);
  expect(ex.pathTo('a')).toEqual([]);
  expect(ex.pathTo('ghost')).toEqual([]);
  expect(Exploration.fromRelation(chain, 'related', CAMERA)!.pathTo('b')).toEqual([]);
 });

 it('a relation has nothing to expand', () => {
  const ex = Exploration.fromRelation(chain, 'related', CAMERA)!;
  ex.expand('a');
  expect([...ex.expanded]).toEqual([]);
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

 it('counts the starting pictures too', () => {
  const every = wide.images.map(image => image.id);
  const ex = Exploration.fromImages(wide, every, CAMERA)!;
  expect(ex.roots.length).toBe(EXPLORE_LIMIT);
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
