import {describe, expect, it} from 'vitest';

import {boundsOf, onScreen, overlaps} from '../src/geometry';
import type {Camera, Rect} from '../src/types';

const rect = (x: number, y: number, width = 10, height = 10): Rect => ({x, y, width, height});
const camera = (x: number, y: number, scale: number): Camera => ({x, y, scale});

describe('overlaps', () => {
 it('is true only where the two share area', () => {
  expect(overlaps(rect(0, 0), rect(5, 5))).toBe(true);
  expect(overlaps(rect(0, 0), rect(20, 0))).toBe(false);
  expect(overlaps(rect(0, 0), rect(0, 20))).toBe(false);
 });

 it('does not count a shared edge or corner', () => {
  // Two cells laid side by side in the grid are neighbours, not a collision.
  expect(overlaps(rect(0, 0), rect(10, 0))).toBe(false);
  expect(overlaps(rect(0, 0), rect(10, 10))).toBe(false);
 });

 it('is symmetric, and true for a rectangle wholly inside another', () => {
  const big = rect(0, 0, 100, 100), small = rect(40, 40, 5, 5);
  expect(overlaps(big, small)).toBe(true);
  expect(overlaps(small, big)).toBe(true);
 });
});

describe('onScreen', () => {
 const view = {width: 200, height: 100};

 it('admits what the window covers and refuses what is past each side', () => {
  const at = camera(0, 0, 1);
  expect(onScreen(rect(0, 0), at, view.width, view.height)).toBe(true);
  expect(onScreen(rect(-30, 0), at, view.width, view.height)).toBe(false);
  expect(onScreen(rect(0, -30), at, view.width, view.height)).toBe(false);
  expect(onScreen(rect(210, 0), at, view.width, view.height)).toBe(false);
  expect(onScreen(rect(0, 110), at, view.width, view.height)).toBe(false);
 });

 it('follows the camera, not the world', () => {
  const far = rect(1000, 1000);
  expect(onScreen(far, camera(0, 0, 1), view.width, view.height)).toBe(false);
  expect(onScreen(far, camera(-995, -995, 1), view.width, view.height)).toBe(true);
 });

 it('follows the scale: zooming out brings distant images in', () => {
  const far = rect(1000, 1000);
  expect(onScreen(far, camera(0, 0, 1), view.width, view.height)).toBe(false);
  expect(onScreen(far, camera(0, 0, .05), view.width, view.height)).toBe(true);
 });

 it('admits what is just outside by the margin, and no further', () => {
  const at = camera(0, 0, 1);
  expect(onScreen(rect(-30, 0), at, view.width, view.height, 25)).toBe(true);
  expect(onScreen(rect(-30, 0), at, view.width, view.height, 15)).toBe(false);
 });
});

describe('boundsOf', () => {
 it('holds every rectangle it is given', () => {
  expect(boundsOf([rect(0, 0), rect(30, 20)])).toEqual({x: 0, y: 0, width: 40, height: 30});
 });

 it('is the rectangle itself for one, and null for none', () => {
  expect(boundsOf([rect(4, 5, 6, 7)])).toEqual({x: 4, y: 5, width: 6, height: 7});
  expect(boundsOf([])).toBeNull();
 });

 it('handles negative coordinates and a rectangle wholly inside another', () => {
  expect(boundsOf([rect(-50, -50, 5, 5), rect(0, 0)])).toEqual({x: -50, y: -50, width: 60, height: 60});
  expect(boundsOf([rect(0, 0, 100, 100), rect(10, 10)])).toEqual({x: 0, y: 0, width: 100, height: 100});
 });

 it('reads any iterable, so a caller need not build an array', () => {
  function* some(): Generator<Rect> { yield rect(0, 0); yield rect(10, 10); }
  expect(boundsOf(some())).toEqual({x: 0, y: 0, width: 20, height: 20});
 });
});
