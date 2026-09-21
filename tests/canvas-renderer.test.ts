import {describe, expect, it, vi} from 'vitest';

vi.mock('obsidian', () => ({}));

import {CanvasRenderer, type FrameState, type Palette} from '../src/canvas-renderer';
import {GraphScene} from '../src/scene';
import {imageSelection} from '../src/selection';
import {recordingContext} from './fake-canvas';
import type {EdgeRecord, GraphSnapshot, ImageRecord, RegionRecord, RegionShape} from '../src/types';

const image = (id: string, x = 0, y = 0, width = 200, height = 200): ImageRecord => ({id, path: `${id}.png`, x, y, width, height});
const region = (id: string, imageId: string, origin?: string): RegionRecord =>
 ({id, imageId, label: 'Region', shape: {type: 'rect', x: .2, y: .2, width: .4, height: .4} as RegionShape, properties: {}, ...(origin ? {origin} : {})});
const edge = (id: string, source: string, target: string): EdgeRecord =>
 ({id, source: {imageId: source}, target: {imageId: target}, direction: 'forward', properties: {relation: 'resembles'}});

const PALETTE: Palette = {
 bg: '#bg', card: '#card', fg: '#fg', accent: '#accent',
 picked: '#picked', region: '#region', regionHover: '#hover', missing: '#missing',
};

/** No canvas in the runner, so the renderer is judged on the calls it makes. */
const build = (snapshot: Partial<GraphSnapshot>, over: Partial<FrameState> = {}) => {
 const full: GraphSnapshot = {images: [], regions: [], edges: [], ...snapshot};
 const scene = new GraphScene({getSnapshot: () => full});
 scene.refresh();
 // The mosaic cache makes a detached canvas through the window, as Obsidian requires.
 const offscreen = () => ({width: 0, height: 0, getContext: () => recordingContext().ctx});
 const doc = {defaultView: {createEl: offscreen}} as unknown as Document;
 const assets = {thumbnail: () => null, overviewThumbnail: () => null};
 const renderer = new CanvasRenderer(doc, assets, () => undefined);
 const state: FrameState = {
  camera: {x: 0, y: 0, scale: 1}, width: 800, height: 600, ratio: 1,
  palette: PALETTE, mode: 'select', hovered: null, hoveredEdge: null,
  dragKind: null, marquee: null, draft: null, zooming: false, highlight: new Set(),
  ...over,
 };
 const recorded = recordingContext();
 const result = renderer.paint(recorded.ctx, scene, state);
 return {scene, renderer, calls: recorded.calls, result, snapshot: full};
};

describe('a frame', () => {
 it('clears to the theme background and reports what the viewport held', () => {
  const {calls, result} = build({images: [image('a'), image('b', 400)]});
  expect(calls).toContain('fillStyle="#bg"');
  expect(calls.some(call => call.startsWith('fillRect(0,0,800,600)'))).toBe(true);
  expect(result.visible).toBe(2);
 });

 it('draws nothing but the background for an empty vault', () => {
  const {result} = build({});
  expect(result.visible).toBe(0);
 });

 it('gives a picture a card, and a missing one the error colour', () => {
  const {calls} = build({images: [image('a'), {...image('b', 400), missing: true}]});
  expect(calls).toContain('fillStyle="#card"');
  expect(calls).toContain('fillStyle="#missing"');
 });
});

describe('what is selected and hovered', () => {
 it('rings the selection in the picked colour', () => {
  const {scene, calls} = build({images: [image('a')]});
  void scene;
  expect(calls).not.toContain('strokeStyle="#picked"');

  const again = build({images: [image('a')]});
  again.scene.setSelection(imageSelection(['a']));
  const recorded = recordingContext();
  again.renderer.paint(recorded.ctx, again.scene, {
   camera: {x: 0, y: 0, scale: 1}, width: 800, height: 600, ratio: 1, palette: PALETTE,
   mode: 'select', hovered: null, hoveredEdge: null, dragKind: null, marquee: null,
   draft: null, zooming: false, highlight: new Set(),
  });
  expect(recorded.calls).toContain('strokeStyle="#picked"');
 });

 it('rings what the pointer rests on in the accent colour, faintly', () => {
  const {calls} = build({images: [image('a')]}, {hovered: {imageId: 'a'}});
  expect(calls).toContain('strokeStyle="#accent"');
  expect(calls).toContain('globalAlpha=0.55');
 });
});

describe('regions', () => {
 it('outlines one of ours solid and a foreign one dashed', () => {
  const ours = build({images: [image('a')], regions: [region('r1', 'a')]});
  expect(ours.calls.some(call => call.startsWith('setLineDash(['))).toBe(false);

  const theirs = build({images: [image('a')], regions: [region('r2', 'a', 'image-annotation')]});
  expect(theirs.calls.some(call => call.startsWith('setLineDash(['))).toBe(true);
 });

 it('draws no region at all once the canvas is zoomed past legibility', () => {
  const {calls} = build({images: [image('a')], regions: [region('r1', 'a')]}, {camera: {x: 0, y: 0, scale: .01}});
  expect(calls).not.toContain('strokeStyle="#region"');
 });
});

describe('connections', () => {
 it('strokes every connection, and names only the relevant ones', () => {
  // Focus changes presentation only: every connection is still drawn, but a graph that
  // labelled all of them would be unreadable. A name appears when the line is pointed at.
  const quiet = build({images: [image('a'), image('b', 400)], edges: [edge('ab', 'a', 'b')]});
  expect(quiet.calls).toContain('strokeStyle="#accent"');
  expect(quiet.calls.some(call => call.startsWith('fillText("resembles"'))).toBe(false);

  const pointed = build({images: [image('a'), image('b', 400)], edges: [edge('ab', 'a', 'b')]}, {hoveredEdge: 'ab'});
  expect(pointed.calls.some(call => call.startsWith('fillText("resembles"'))).toBe(true);
  expect(pointed.calls).toContain('strokeStyle="#picked"');
 });

 it('stops routing while an image is being dragged, so a path cannot flicker per frame', () => {
  const dragging = build({images: [image('a'), image('b', 900), image('wall', 400)], edges: [edge('ab', 'a', 'b')]}, {dragKind: 'image'});
  expect(dragging.scene.routed).toBe(false);

  const settled = build({images: [image('a'), image('b', 900), image('wall', 400)], edges: [edge('ab', 'a', 'b')]});
  expect(settled.scene.routed).toBe(true);
 });

 it('draws no arrowhead or label when zoomed past legibility', () => {
  const {calls} = build({images: [image('a'), image('b', 400)], edges: [edge('ab', 'a', 'b')]}, {camera: {x: 0, y: 0, scale: .01}});
  expect(calls.some(call => call.startsWith('fillText('))).toBe(false);
 });
});

describe('work in progress', () => {
 it('draws the band a shift-drag is sweeping', () => {
  const {calls} = build({images: [image('a')]}, {
   dragKind: 'marquee', marquee: {start: {x: 10, y: 20}, last: {x: 110, y: 220}},
  });
  expect(calls).toContain('strokeRect(10,20,100,200)');
 });

 it('draws the rectangle a region drag has swept so far', () => {
  const {calls} = build({images: [image('a')]}, {
   draft: {kind: 'region', imageId: 'a', start: {x: 20, y: 20}, last: {x: 120, y: 120}},
  });
  expect(calls).toContain('rect(20,20,100,100)');
 });

 it('draws a polygon in progress with its first corner marked apart', () => {
  const {calls} = build({images: [image('a')]}, {
   draft: {kind: 'polygon', imageId: 'a', points: [{x: .1, y: .1}, {x: .5, y: .2}, {x: .3, y: .6}]},
  });
  expect(calls).toContain('fillStyle="#region"');
  expect(calls.filter(call => call.startsWith('arc(')).length).toBe(3);
 });

 it('draws the 40px grid in Move mode and never outside it', () => {
  const moving = build({images: [image('a')]}, {mode: 'move'});
  expect(moving.calls).toContain('globalAlpha=0.2');
  const selecting = build({images: [image('a')]}, {mode: 'select'});
  expect(selecting.calls).not.toContain('globalAlpha=0.2');
 });
});
