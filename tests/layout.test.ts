import {describe, expect, it} from 'vitest';
import {EXPLORE_BOX, GRID, ROW_HEIGHT, exploreSize, gridSize, packRows, ratioOf, rowWidth} from '../src/layout';
import {readImageSize} from '../src/dimensions';

const png = (width: number, height: number) => {
 const bytes = new Uint8Array(24);
 bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
 new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
 return bytes;
};
const jpeg = (width: number, height: number) => {
 const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 1, 0x11, 0, 0, 0, 0, 0, 0, 0, 0]);
 const view = new DataView(bytes.buffer); view.setUint16(13, height); view.setUint16(15, width);
 return bytes;
};

describe('image header sizes', () => {
 it('reads PNG, JPEG, GIF, WebP and BMP', () => {
  expect(readImageSize(png(1600, 400))).toEqual({width: 1600, height: 400});
  expect(readImageSize(jpeg(640, 1280))).toEqual({width: 640, height: 1280});
  const gif = new Uint8Array(10); gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); gif.set([0x20, 0x03, 0x58, 0x02], 6);
  expect(readImageSize(gif)).toEqual({width: 800, height: 600});
  const webp = new Uint8Array(30); webp.set([...'RIFF'].map(c => c.charCodeAt(0)), 0); webp.set([...'WEBP'].map(c => c.charCodeAt(0)), 8);
  webp.set([...'VP8X'].map(c => c.charCodeAt(0)), 12); webp.set([0x3f, 0x00, 0x00], 24); webp.set([0x1f, 0x00, 0x00], 27);
  expect(readImageSize(webp)).toEqual({width: 64, height: 32});
  const bmp = new Uint8Array(26); bmp.set([0x42, 0x4d], 0);
  new DataView(bmp.buffer).setInt32(18, 120, true); new DataView(bmp.buffer).setInt32(22, -60, true);
  expect(readImageSize(bmp)).toEqual({width: 120, height: 60});
 });
 it('returns null rather than a guess', () => {
  expect(readImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  expect(readImageSize(new TextEncoder().encode('<svg width="10" height="4"/>'))).toBeNull();
  expect(readImageSize(png(0, 400))).toBeNull();
 });
});

describe('thumbnail sizing', () => {
 it('constrains the height and lets the width follow', () => {
  expect(gridSize({width: 1600, height: 400})).toEqual({width: ROW_HEIGHT * 4, height: ROW_HEIGHT});
  expect(gridSize({width: 400, height: 1600})).toEqual({width: ROW_HEIGHT / 4, height: ROW_HEIGHT});
  expect(gridSize(undefined)).toEqual({width: ROW_HEIGHT, height: ROW_HEIGHT});
 });
 it('keeps a tall and a wide picture wholly inside one explore box', () => {
  const wide = exploreSize({width: 1600, height: 400}), tall = exploreSize({width: 400, height: 1600});
  expect(wide).toEqual({width: EXPLORE_BOX, height: EXPLORE_BOX / 4});
  expect(tall).toEqual({width: EXPLORE_BOX / 4, height: EXPLORE_BOX});
  for (const fit of [wide, tall]) { expect(fit.width).toBeLessThanOrEqual(EXPLORE_BOX); expect(fit.height).toBeLessThanOrEqual(EXPLORE_BOX); }
 });
 it('reads proportions back from a laid-out rectangle', () => {
  expect(ratioOf(gridSize({width: 1600, height: 400}))).toBe(4);
  expect(exploreSize(gridSize({width: 1600, height: 400}))).toEqual(exploreSize({width: 1600, height: 400}));
 });
 it('survives a record with no usable size', () => {
  expect(ratioOf({width: 0, height: 0} as never)).toBe(1);
  expect(ratioOf({width: Number.NaN, height: 4} as never)).toBe(1);
  expect(gridSize({width: 100000, height: 1}).width).toBe(ROW_HEIGHT * 20);
 });
});

describe('whole-vault row packing', () => {
 const cells = (widths: number[]) => widths.map((width, index) => ({id: `i${index}`, width, height: ROW_HEIGHT}));
 it('never overlaps, whatever the widths', () => {
  const items = cells([960, 60, 240, 480, 240, 120, 720]);
  const at = packRows(items, rowWidth(items.length));
  for (const a of items) for (const b of items) {
   if (a.id >= b.id) continue;
   const p = at.get(a.id)!, q = at.get(b.id)!;
   const apart = p.x + a.width <= q.x || q.x + b.width <= p.x || p.y + a.height <= q.y || q.y + b.height <= p.y;
   expect(apart, `${a.id} and ${b.id}`).toBe(true);
  }
 });
 it('puts every position on the grid and wraps the row', () => {
  const items = cells([240, 240, 240, 240, 240, 240]);
  const at = packRows(items, 600);
  for (const cell of items) { const p = at.get(cell.id)!; expect(p.x % GRID).toBe(0); expect(p.y % GRID).toBe(0); }
  expect(at.get('i0')!.y).toBe(0);
  expect(at.get('i2')!.y).toBeGreaterThan(0);
 });
 it('gives a cell wider than the row a row of its own', () => {
  const at = packRows(cells([240, 2000, 240]), 600);
  expect(at.get('i1')!.y).toBeGreaterThan(at.get('i0')!.y);
  expect(at.get('i2')!.y).toBeGreaterThan(at.get('i1')!.y);
 });
});
