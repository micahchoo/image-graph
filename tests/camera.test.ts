import {describe, expect, it, vi} from 'vitest';

vi.mock('obsidian', () => ({}));

import {
 MAX_SCALE, MIN_SCALE, boxAround, fitBox, scrollBy, scrollIntoView,
 spansViewport, toScreen, toWorld, viewportRect, wheelGesture, zoomAt,
} from '../src/camera';
import type {Camera, Rect} from '../src/types';

const at = (x: number, y: number, scale: number): Camera => ({x, y, scale});
const rect = (x: number, y: number, width: number, height: number): Rect => ({x, y, width, height});
const VIEW = {width: 800, height: 600};

describe('screen and world', () => {
 it('are inverses of one another', () => {
  const camera = at(-120, 40, .35);
  const world = toWorld(camera, 317, 208);
  const screen = toScreen(camera, world);
  expect(screen.x).toBeCloseTo(317, 9);
  expect(screen.y).toBeCloseTo(208, 9);
 });

 it('report the world the viewport covers', () => {
  // Negating a zero origin yields -0; it compares equal to 0 everywhere this rectangle goes.
  const origin = viewportRect(at(0, 0, 1), 800, 600);
  expect([origin.x, origin.y, origin.width, origin.height]).toEqual([-0, -0, 800, 600]);
  expect(viewportRect(at(-100, -50, 2), 800, 600)).toEqual({x: 50, y: 25, width: 400, height: 300});
 });
});

describe('zoomAt', () => {
 it('leaves whatever is under the point exactly where it is', () => {
  // The whole contract: point at something, zoom, and it must not slide.
  const camera = at(-340, 120, .8), pointer = {x: 613, y: 91};
  const before = toWorld(camera, pointer.x, pointer.y);
  for (const factor of [1.25, 1 / 1.25, 4, .1]) {
   const after = toWorld(zoomAt(camera, factor, pointer), pointer.x, pointer.y);
   expect(after.x).toBeCloseTo(before.x, 6);
   expect(after.y).toBeCloseTo(before.y, 6);
  }
 });

 it('stops at the limits rather than drifting past them', () => {
  const pointer = {x: 400, y: 300};
  expect(zoomAt(at(0, 0, 1), 1e6, pointer).scale).toBe(MAX_SCALE);
  expect(zoomAt(at(0, 0, 1), 1e-6, pointer).scale).toBe(MIN_SCALE);
 });

 it('holds the point still even when it clamps', () => {
  const camera = at(-90, 33, 7), pointer = {x: 210, y: 480};
  const before = toWorld(camera, pointer.x, pointer.y);
  const after = toWorld(zoomAt(camera, 100, pointer), pointer.x, pointer.y);
  expect(after.x).toBeCloseTo(before.x, 6);
  expect(after.y).toBeCloseTo(before.y, 6);
 });

 it('does not change the camera it was given', () => {
  const camera = at(5, 6, 1);
  zoomAt(camera, 2, {x: 0, y: 0});
  expect(camera).toEqual({x: 5, y: 6, scale: 1});
 });
});

describe('scrollBy', () => {
 it('moves the view and keeps the scale', () => {
  expect(scrollBy(at(10, 20, .5), 30, -5)).toEqual({x: -20, y: 25, scale: .5});
 });
});

describe('fitBox', () => {
 const options = {padX: 80, padY: 150, margin: 100, bottomInset: 35};

 it('centres the box across, and lifts it clear of the bottom chrome', () => {
  const box = rect(-200, -100, 400, 200);
  const camera = fitBox(box, VIEW, options);
  const centre = toScreen(camera, {x: 0, y: 0});
  expect(centre.x).toBeCloseTo(VIEW.width / 2, 9);
  expect(centre.y).toBeCloseTo((VIEW.height - 35) / 2, 9);
 });

 it('shows the whole box, with the margin to spare', () => {
  const box = rect(40, 900, 3000, 1500);
  const camera = fitBox(box, VIEW, options);
  const topLeft = toScreen(camera, {x: box.x, y: box.y});
  const bottomRight = toScreen(camera, {x: box.x + box.width, y: box.y + box.height});
  expect(topLeft.x).toBeGreaterThanOrEqual(0);
  expect(topLeft.y).toBeGreaterThanOrEqual(0);
  expect(bottomRight.x).toBeLessThanOrEqual(VIEW.width);
  expect(bottomRight.y).toBeLessThanOrEqual(VIEW.height);
 });

 it('will not zoom past the fit limit for one small picture', () => {
  expect(fitBox(rect(0, 0, 4, 3), VIEW, options).scale).toBe(2);
  expect(fitBox(rect(0, 0, 4, 3), VIEW, {...options, maxScale: 1.2}).scale).toBe(1.2);
 });

 it('survives a box with no area', () => {
  const camera = fitBox(rect(10, 10, 0, 0), VIEW, options);
  expect(Number.isFinite(camera.scale)).toBe(true);
  expect(Number.isFinite(camera.x)).toBe(true);
  expect(camera.scale).toBeGreaterThan(0);
 });

 it('answers the embed the same way it answers the workspace', () => {
  // The two used to be separate copies of this arithmetic. They are now one call with
  // different padding, which is what the difference between them always was.
  const embed = fitBox(rect(0, 0, 500, 300), {width: 640, height: 360}, {padX: 56, padY: 74, bottomInset: 18, minScale: .02, maxScale: 1.2});
  expect(embed.scale).toBeCloseTo(Math.min(1.2, Math.min((640 - 56) / 500, (360 - 74) / 300)), 9);
 });
});

describe('boxAround', () => {
 it('holds the original box and puts the centre in the middle', () => {
  const box = rect(-300, -50, 400, 500), centre = {x: 0, y: 0};
  const around = boxAround(centre, box);
  expect(around.x + around.width / 2).toBeCloseTo(centre.x, 9);
  expect(around.y + around.height / 2).toBeCloseTo(centre.y, 9);
  expect(around.x).toBeLessThanOrEqual(box.x);
  expect(around.y).toBeLessThanOrEqual(box.y);
  expect(around.x + around.width).toBeGreaterThanOrEqual(box.x + box.width);
  expect(around.y + around.height).toBeGreaterThanOrEqual(box.y + box.height);
 });

 it('is the box itself when the box is already centred', () => {
  expect(boxAround({x: 0, y: 0}, rect(-10, -20, 20, 40))).toEqual({x: -10, y: -20, width: 20, height: 40});
 });
});

describe('scrollIntoView', () => {
 const camera = at(0, 0, 1);

 it('returns the very same camera when nothing has to move', () => {
  expect(scrollIntoView(camera, rect(100, 100, 50, 50), VIEW)).toBe(camera);
 });

 it('scrolls the least that brings a rectangle in, and keeps the zoom', () => {
  const moved = scrollIntoView(camera, rect(-30, 0, 50, 50), VIEW, 48);
  expect(moved.scale).toBe(camera.scale);
  expect(moved.x + -30).toBeCloseTo(48, 9);
 });

 it('clears the taller bottom chrome', () => {
  const moved = scrollIntoView(camera, rect(0, 590, 50, 50), VIEW, 48, 88);
  const bottom = moved.y + 640;
  expect(bottom).toBeCloseTo(VIEW.height - 88, 9);
 });
});

describe('wheelGesture', () => {
 it('scrolls plainly and zooms under ctrl or the command key', () => {
  expect(wheelGesture({deltaX: 3, deltaY: 9}, 600)).toEqual({kind: 'scroll', dx: 3, dy: 9});
  expect(wheelGesture({deltaX: 0, deltaY: -10, ctrlKey: true}, 600).kind).toBe('zoom');
  expect(wheelGesture({deltaX: 0, deltaY: -10, metaKey: true}, 600).kind).toBe('zoom');
 });

 it('zooms in when the wheel goes up and out when it goes down', () => {
  const into = wheelGesture({deltaX: 0, deltaY: -10, ctrlKey: true}, 600);
  const outOf = wheelGesture({deltaX: 0, deltaY: 10, ctrlKey: true}, 600);
  expect(into).toMatchObject({kind: 'zoom', into: true});
  expect(outOf).toMatchObject({kind: 'zoom', into: false});
  if (into.kind === 'zoom' && outOf.kind === 'zoom') {
   expect(into.factor).toBeGreaterThan(1);
   expect(outOf.factor).toBeLessThan(1);
  }
 });

 it('normalises lines and pages, because Firefox does not report pixels', () => {
  expect(wheelGesture({deltaX: 0, deltaY: 3, deltaMode: 1}, 600)).toEqual({kind: 'scroll', dx: 0, dy: 48});
  expect(wheelGesture({deltaX: 0, deltaY: 1, deltaMode: 2}, 600)).toEqual({kind: 'scroll', dx: 0, dy: 600});
 });

 it('pans a one-axis wheel sideways under shift, and leaves a trackpad alone', () => {
  expect(wheelGesture({deltaX: 0, deltaY: 20, shiftKey: true}, 600)).toEqual({kind: 'scroll', dx: 20, dy: 0});
  expect(wheelGesture({deltaX: 7, deltaY: 20, shiftKey: true}, 600)).toEqual({kind: 'scroll', dx: 7, dy: 20});
 });
});

describe('spansViewport', () => {
 const camera = at(0, 0, 1);

 it('admits a connection whose two ends straddle the viewport', () => {
  expect(spansViewport(rect(-500, 300, 10, 10), rect(1200, 300, 10, 10), camera, VIEW.width, VIEW.height)).toBe(true);
 });

 it('refuses one wholly off screen, and admits it once the margin reaches', () => {
  const a = rect(-400, -400, 10, 10), b = rect(-300, -300, 10, 10);
  expect(spansViewport(a, b, camera, VIEW.width, VIEW.height)).toBe(false);
  expect(spansViewport(a, b, camera, VIEW.width, VIEW.height, 400)).toBe(true);
 });

 it('follows the scale', () => {
  const a = rect(5000, 5000, 10, 10), b = rect(5200, 5200, 10, 10);
  expect(spansViewport(a, b, camera, VIEW.width, VIEW.height)).toBe(false);
  expect(spansViewport(a, b, at(0, 0, .05), VIEW.width, VIEW.height)).toBe(true);
 });
});
