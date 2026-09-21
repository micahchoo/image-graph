import {describe, expect, it, vi} from 'vitest';

vi.mock('obsidian', () => ({}));

import {DRAG_THRESHOLD, type DragInput, type Mode, type PressInput, dragBecomes, movedEnough, pinchFrom, pinchStep, pressIntent} from '../src/gestures';

const press = (over: Partial<PressInput> = {}): PressInput =>
 ({shift: false, space: false, button: 0, mode: 'select', onGrip: false, ...over});
const drag = (over: Partial<DragInput> = {}): DragInput =>
 ({marquee: false, forcePan: false, forceMove: false, over: 'image', mode: 'select', ...over});
const MODES: Mode[] = ['select', 'rect', 'polygon', 'connect', 'move'];

describe('movedEnough', () => {
 it('holds a press still inside the slack and releases it at the threshold', () => {
  const from = {x: 100, y: 100};
  expect(movedEnough(from, {x: 100, y: 100})).toBe(false);
  expect(movedEnough(from, {x: 100 + DRAG_THRESHOLD - .001, y: 100})).toBe(false);
  expect(movedEnough(from, {x: 100 + DRAG_THRESHOLD, y: 100})).toBe(true);
 });

 it('measures distance, not either axis alone', () => {
  const from = {x: 0, y: 0};
  // Neither axis reaches 6 on its own; together they pass it. hypot(4,4) is 5.66 and does not.
  expect(movedEnough(from, {x: 5, y: 0})).toBe(false);
  expect(movedEnough(from, {x: 0, y: -5})).toBe(false);
  expect(movedEnough(from, {x: 4, y: -4})).toBe(false);
  expect(movedEnough(from, {x: 5, y: -5})).toBe(true);
 });
});

describe('pressIntent', () => {
 it('arms the band on shift, in the two tools that can carry a selection', () => {
  expect(pressIntent(press({shift: true, mode: 'select'}))).toBe('marquee');
  // A selection a drag carries has to be makeable in the mode that carries it.
  expect(pressIntent(press({shift: true, mode: 'move'}))).toBe('marquee');
  for (const mode of ['rect', 'polygon', 'connect'] as Mode[]) {
   expect(pressIntent(press({shift: true, mode}))).toBe('plain');
  }
 });

 it('never arms the band while space pans, or on the middle button', () => {
  expect(pressIntent(press({shift: true, space: true}))).toBe('plain');
  expect(pressIntent(press({shift: true, button: 1}))).toBe('plain');
 });

 it('takes a grip when the press lands on one, and the band wins over a grip', () => {
  expect(pressIntent(press({onGrip: true}))).toBe('handle');
  expect(pressIntent(press({onGrip: true, shift: true}))).toBe('marquee');
  expect(pressIntent(press({onGrip: true, space: true}))).toBe('plain');
  expect(pressIntent(press({onGrip: true, button: 1}))).toBe('plain');
 });
});

describe('dragBecomes', () => {
 it('draws the band whatever else is true', () => {
  expect(dragBecomes(drag({marquee: true, forcePan: true, forceMove: true, over: null}))).toBe('marquee');
 });

 it('pans on empty canvas and on a connection, which cannot be dragged', () => {
  expect(dragBecomes(drag({over: null}))).toBe('pan');
  expect(dragBecomes(drag({over: 'edge'}))).toBe('pan');
  expect(dragBecomes(drag({over: 'edge', forceMove: true}))).toBe('pan');
 });

 it('pans from anywhere when space or the middle button is held', () => {
  for (const mode of MODES) expect(dragBecomes(drag({forcePan: true, forceMove: true, mode}))).toBe('pan');
 });

 it('draws a region in the Region tool', () => {
  expect(dragBecomes(drag({mode: 'rect'}))).toBe('region');
 });

 it('pans while connecting or drawing a polygon, so an off-screen target is reachable', () => {
  // This was a tracked gesture that did nothing at all.
  expect(dragBecomes(drag({mode: 'connect'}))).toBe('pan');
  expect(dragBecomes(drag({mode: 'polygon'}))).toBe('pan');
  expect(dragBecomes(drag({mode: 'connect', forceMove: true}))).toBe('pan');
 });

 it('carries the image only when Move or alt asks for it', () => {
  expect(dragBecomes(drag({mode: 'move', forceMove: true}))).toBe('image');
  expect(dragBecomes(drag({mode: 'select', forceMove: true}))).toBe('image');
  // A plain drag over a picture still pans: this canvas is a map before it is an editor.
  expect(dragBecomes(drag({mode: 'select', forceMove: false}))).toBe('pan');
 });

 it('always answers with something, for every combination', () => {
  // An unrecognised drag on a map must move the map, never do nothing.
  for (const mode of MODES) for (const over of ['image', 'edge', null] as const)
   for (const forcePan of [true, false]) for (const forceMove of [true, false]) for (const marquee of [true, false]) {
    expect(['marquee', 'pan', 'region', 'image']).toContain(dragBecomes({mode, over, forcePan, forceMove, marquee}));
   }
 });
});

describe('pinch', () => {
 it('reads a spread and a centre from two fingers', () => {
  expect(pinchFrom({x: 0, y: 0}, {x: 6, y: 8})).toEqual({distance: 10, center: {x: 3, y: 4}});
 });

 it('reports spreading apart as zooming in and closing as zooming out', () => {
  const start = pinchFrom({x: 0, y: 0}, {x: 100, y: 0});
  expect(pinchStep(start, {x: -50, y: 0}, {x: 150, y: 0}).factor).toBeCloseTo(2, 9);
  expect(pinchStep(start, {x: 25, y: 0}, {x: 75, y: 0}).factor).toBeCloseTo(.5, 9);
 });

 it('reports the slide as well as the spread, because fingers do both at once', () => {
  const start = pinchFrom({x: 0, y: 0}, {x: 100, y: 0});
  const step = pinchStep(start, {x: 40, y: 30}, {x: 140, y: 30});
  expect(step.factor).toBeCloseTo(1, 9);
  expect(step.dx).toBeCloseTo(40, 9);
  expect(step.dy).toBeCloseTo(30, 9);
 });

 it('reports no change rather than infinity when the fingers started together', () => {
  const degenerate = {distance: 0, center: {x: 0, y: 0}};
  const step = pinchStep(degenerate, {x: 0, y: 0}, {x: 0, y: 0});
  expect(Number.isFinite(step.factor)).toBe(true);
  expect(step.factor).toBe(0);
  expect(pinchStep(degenerate, {x: -5, y: 0}, {x: 5, y: 0}).factor).toBe(10);
 });

 it('hands back the pinch to measure the next step against', () => {
  const start = pinchFrom({x: 0, y: 0}, {x: 100, y: 0});
  const step = pinchStep(start, {x: 0, y: 0}, {x: 200, y: 0});
  expect(step.next).toEqual({distance: 200, center: {x: 100, y: 0}});
  expect(pinchStep(step.next, {x: 0, y: 0}, {x: 200, y: 0}).factor).toBe(1);
 });
});
