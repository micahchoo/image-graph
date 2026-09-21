import {describe, expect, it, vi} from 'vitest';

vi.mock('obsidian', () => ({}));

import {GraphScene} from '../src/scene';
import {Exploration} from '../src/exploration';
import {imageSelection} from '../src/selection';
import type {Camera, EdgeRecord, GraphSnapshot, ImageRecord, Point, RegionRecord, RegionShape} from '../src/types';

const image = (id: string, x = 0, y = 0, width = 100, height = 100): ImageRecord => ({id, path: `${id}.png`, x, y, width, height});
const region = (id: string, imageId: string, shape: RegionShape, label = 'Region'): RegionRecord => ({id, imageId, label, shape, properties: {}});
const edge = (id: string, source: string, target: string, relation = 'related'): EdgeRecord =>
 ({id, source: {imageId: source}, target: {imageId: target}, direction: 'forward', properties: {relation}});
const CAMERA: Camera = {x: 0, y: 0, scale: 1};

/** The scene takes two methods. That is the whole of what it needs from the plugin. */
function sceneOf(snapshot: Partial<GraphSnapshot>) {
 const full: GraphSnapshot = {images: [], regions: [], edges: [], ...snapshot};
 const host = {getSnapshot: () => full};
 const scene = new GraphScene(host);
 scene.refresh();
 return {scene, snapshot: full};
}

describe('reading the graph', () => {
 it('indexes images, regions and the regions of each image', () => {
  const {scene} = sceneOf({
   images: [image('a'), image('b', 200)],
   regions: [region('r1', 'a', {type: 'rect', x: 0, y: 0, width: .5, height: .5}), region('r2', 'a', {type: 'rect', x: .5, y: .5, width: .4, height: .4})],
  });
  expect([...scene.images.keys()]).toEqual(['a', 'b']);
  expect(scene.regionsOf('a').map(r => r.id)).toEqual(['r1', 'r2']);
  expect(scene.regionsOf('b')).toEqual([]);
 });

 it('lays the whole vault out from the records, as copies a drag cannot write through', () => {
  const {scene, snapshot} = sceneOf({images: [image('a', 40, 80)]});
  scene.place('a', 400, 800, snapshot.images[0]);
  expect(scene.positions.get('a')).toMatchObject({x: 400, y: 800});
  expect(snapshot.images[0]).toMatchObject({x: 40, y: 80});
 });

 it('names a picture after its file, without the extension', () => {
  const {scene} = sceneOf({images: [{...image('a'), path: 'Photos/Harbour at dusk.png'}]});
  expect(scene.caption('a')).toBe('Harbour at dusk');
 });
});

describe('what is shown', () => {
 const built = () => sceneOf({
  images: [image('a'), image('b', 200), image('far', 9000)],
  edges: [edge('ab', 'a', 'b')],
 });

 it('is the whole vault until an exploration replaces it', () => {
  const {scene, snapshot} = built();
  expect(scene.shownIds()).toEqual(['a', 'b', 'far']);
  expect(scene.shownEdges().map(e => e.id)).toEqual(['ab']);
  scene.exploration = Exploration.fromImages(snapshot, ['a'], CAMERA);
  scene.rebuildExploration();
  expect([...scene.shownIds()].sort()).toEqual(['a', 'b']);
  expect(scene.positions.has('far')).toBe(false);
 });

 it('reuses the spatial index until the layout actually changes', () => {
  const {scene} = built();
  const first = scene.spatial();
  expect(scene.spatial()).toBe(first);
  scene.moved();
  expect(scene.spatial()).not.toBe(first);
 });
});

describe('selection', () => {
 const built = () => sceneOf({
  images: [image('a'), image('b', 200)],
  regions: [region('r1', 'a', {type: 'rect', x: 0, y: 0, width: .5, height: .5})],
  edges: [edge('ab', 'a', 'b')],
 });

 it('selects an image, a region and a connection, and reports each as its own kind', () => {
  const {scene} = built();
  scene.select({endpoint: {imageId: 'a'}});
  expect([...scene.selectedImages]).toEqual(['a']);
  scene.select({endpoint: {imageId: 'a', regionId: 'r1'}});
  expect(scene.selectedRegion).toBe('r1');
  // A region rings its own image, so the ring and the panel cannot disagree.
  expect([...scene.selectedImages]).toEqual(['a']);
  scene.select({edge: edge('ab', 'a', 'b')});
  expect(scene.selectedEdge).toBe('ab');
  expect([...scene.selectedImages]).toEqual([]);
 });

 it('extends with shift and takes an image back out', () => {
  const {scene} = built();
  scene.select({endpoint: {imageId: 'a'}});
  scene.select({endpoint: {imageId: 'b'}}, true);
  expect([...scene.selectedImages].sort()).toEqual(['a', 'b']);
  scene.select({endpoint: {imageId: 'b'}}, true);
  expect([...scene.selectedImages]).toEqual(['a']);
 });

 it('drops a selection whose image the vault no longer holds', () => {
  const host = {getSnapshot: () => current};
  let current: GraphSnapshot = {images: [image('a'), image('b', 200)], regions: [], edges: []};
  const scene = new GraphScene(host);
  scene.refresh();
  scene.setSelection(imageSelection(['a', 'b']));
  current = {images: [image('b', 200)], regions: [], edges: []};
  scene.refresh();
  expect([...scene.selectedImages]).toEqual(['b']);
 });

 it('hands the selection back as something a menu can act on', () => {
  const {scene} = built();
  scene.select({endpoint: {imageId: 'a', regionId: 'r1'}});
  expect(scene.selectionHit()).toEqual({endpoint: {imageId: 'a', regionId: 'r1'}});
  scene.select(null);
  expect(scene.selectionHit()).toBeNull();
 });
});

describe('what is under a point', () => {
 const built = () => sceneOf({
  images: [image('a'), image('b', 200)],
  regions: [region('r1', 'a', {type: 'rect', x: .1, y: .1, width: .3, height: .3})],
 });

 it('finds the picture, and the region when the point is inside one', () => {
  const {scene} = built();
  expect(scene.endpointAt({x: 80, y: 80})).toEqual({imageId: 'a'});
  expect(scene.endpointAt({x: 25, y: 25})).toEqual({imageId: 'a', regionId: 'r1'});
  expect(scene.endpointAt({x: 150, y: 50})).toBeNull();
 });
});

describe('a connection is hit where it was drawn', () => {
 // The defect this guards: a routed line leaves its own chord by a whole image, so measuring
 // the chord answered for empty canvas beside the line and refused the line itself.
 const built = () => {
  const {scene, snapshot} = sceneOf({
   images: [image('a'), image('b', 1000), image('wall', 400, 0, 200, 100)],
   edges: [edge('ab', 'a', 'b')],
  });
  const a: Point = {x: 100, y: 50}, b: Point = {x: 1000, y: 50};
  const ends = () => ({source: a, target: b});
  return {scene, snapshot, a, b, ends};
 };

 it('routes around an image that stands between the two ends', () => {
  const {scene, snapshot, a, b} = built();
  const path = scene.route(snapshot.edges[0], a, b);
  expect(path.length).toBeGreaterThan(2);
  expect(path.some(point => point.y !== 50)).toBe(true);
 });

 it('selects the connection where the path actually runs, and not without routing', () => {
  const {scene, snapshot, a, b, ends} = built();
  const path = scene.route(snapshot.edges[0], a, b);
  // The vertex that left the chord. An earlier one still sits on it, which is the whole
  // reason a chord measurement looked right in the easy cases.
  const bend = path.reduce((far, point) => Math.abs(point.y - 50) > Math.abs(far.y - 50) ? point : far, path[0]);
  expect(Math.abs(bend.y - 50)).toBeGreaterThan(20);
  expect(scene.endpointAt(bend)).toBeNull();

  scene.setRouting(true);
  expect(scene.hit(bend, 1, ends)).toEqual({edge: snapshot.edges[0]});

  // The same point measured against the straight chord is nowhere near it.
  scene.setRouting(false);
  expect(scene.hit(bend, 1, ends)).toBeNull();
 });

 it('still selects a straight connection along its chord', () => {
  const {scene} = sceneOf({images: [image('a'), image('b', 1000)], edges: [edge('ab', 'a', 'b')]});
  const ends = () => ({source: {x: 100, y: 50}, target: {x: 1000, y: 50}});
  expect(scene.hit({x: 550, y: 52}, 1, ends)).toMatchObject({edge: {id: 'ab'}});
  expect(scene.hit({x: 550, y: 200}, 1, ends)).toBeNull();
 });

 it('forgets its routes when the layout moves, so it cannot measure a stale one', () => {
  const {scene, snapshot, a, b} = built();
  const first = scene.route(snapshot.edges[0], a, b);
  expect(scene.route(snapshot.edges[0], a, b)).toBe(first);
  scene.moved();
  scene.spatial();
  expect(scene.route(snapshot.edges[0], a, b)).not.toBe(first);
 });
});

describe('moving images', () => {
 it('snaps to the grid in the vault and is free while exploring', () => {
  const {scene, snapshot} = sceneOf({images: [image('a'), image('b', 200)], edges: [edge('ab', 'a', 'b')]});
  scene.place('a', 117, 143, snapshot.images[0]);
  expect(scene.positions.get('a')).toMatchObject({x: 120, y: 160});

  scene.exploration = Exploration.fromImages(snapshot, ['b'], CAMERA);
  scene.rebuildExploration();
  scene.place('a', 117, 143, snapshot.images[0]);
  expect(scene.positions.get('a')).toMatchObject({x: 117, y: 143});
  expect(scene.exploration!.pinned.has('a')).toBe(true);
 });

 it('keeps the rectangle its own size, because a drag carries a delta and not a size', () => {
  const {scene, snapshot} = sceneOf({images: [image('a', 0, 0, 240, 60)]});
  scene.place('a', 400, 400, snapshot.images[0]);
  expect(scene.positions.get('a')).toMatchObject({width: 240, height: 60});
 });

 it('carries the whole selection, and never a starting picture', () => {
  const {scene, snapshot} = sceneOf({images: [image('a'), image('b', 200), image('c', 400)], edges: [edge('ab', 'a', 'b')]});
  scene.setSelection(imageSelection(['a', 'b']));
  expect([...scene.movable('a').keys()].sort()).toEqual(['a', 'b']);
  expect([...scene.movable('c').keys()]).toEqual(['c']);

  scene.exploration = Exploration.fromImages(snapshot, ['a'], CAMERA);
  scene.rebuildExploration();
  scene.setSelection(imageSelection(['a', 'b']));
  expect([...scene.movable('a').keys()]).toEqual(['b']);
 });

 it('reads every moved rectangle before anything is written, and marks them placed', () => {
  const {scene, snapshot} = sceneOf({images: [image('a'), image('b', 200)]});
  scene.place('a', 400, 400, snapshot.images[0]);
  scene.place('b', 800, 400, snapshot.images[1]);
  const moved = scene.movedRecords(['a', 'b']);
  expect(moved).toHaveLength(2);
  expect(moved.every(record => record.pinned)).toBe(true);
  expect(moved.map(record => record.x)).toEqual([400, 800]);
 });

 it('bounds whatever is placed, and nothing when none of it is', () => {
  const {scene} = sceneOf({images: [image('a'), image('b', 200)]});
  expect(scene.bounds(['a', 'b'])).toEqual({x: 0, y: 0, width: 300, height: 100});
  expect(scene.bounds(['ghost'])).toBeNull();
 });
});

describe('describe', () => {
 it('names an endpoint, and its region when it has one', () => {
  const {scene} = sceneOf({
   images: [{...image('a'), path: 'Photos/Harbour.png'}],
   regions: [region('r1', 'a', {type: 'rect', x: 0, y: 0, width: .5, height: .5}, 'The mast')],
  });
  expect(scene.describe({imageId: 'a'})).toBe('Harbour.png');
  expect(scene.describe({imageId: 'a', regionId: 'r1'})).toBe('Harbour.png / The mast');
  expect(scene.describe({imageId: 'gone'})).toBe('Missing image');
 });
});
