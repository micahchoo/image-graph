import type {Point, Rect} from './types';
import type {PixelSize} from './dimensions';

/** The one height every thumbnail has in the whole-vault view. */
export const ROW_HEIGHT = 240;
/** The box a thumbnail is kept inside while exploring. */
export const EXPLORE_BOX = 300;
/** Whole-vault positions sit on this grid, which is the step a move snaps to. */
export const GRID = 40;
/** Only a guard against an unreadable record: the layout is no reason to distort a picture. */
const MAX_RATIO = 20;

/** Proportions, from pixels or from a rectangle that already carries them. */
export function ratioOf(size: PixelSize | Rect | undefined): number {
 const width = size?.width ?? 0, height = size?.height ?? 0;
 if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
 return Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, width / height));
}

/** Height-constrained: one height for every thumbnail, the width its own. */
export function gridSize(size: PixelSize | Rect | undefined): {width: number; height: number} {
 return {width: Math.max(1, Math.round(ROW_HEIGHT * ratioOf(size))), height: ROW_HEIGHT};
}

/** Contained: a tall picture and a wide one are both wholly visible in the same box. */
export function exploreSize(size: PixelSize | Rect | undefined, box = EXPLORE_BOX): {width: number; height: number} {
 const ratio = ratioOf(size);
 return ratio >= 1 ? {width: box, height: Math.max(1, Math.round(box / ratio))} : {width: Math.max(1, Math.round(box * ratio)), height: box};
}

/** How wide a row is allowed to be, so the whole vault stays about as tall as it is wide. */
export function rowWidth(count: number): number {
 return Math.max(ROW_HEIGHT, Math.ceil(Math.sqrt(Math.max(1, count))) * (ROW_HEIGHT + GRID));
}

/**
 * Wrap cells of one height into rows, left to right, in the order given.
 *
 * Widths differ, so a fixed pitch cannot be used: a picture twice as wide as it is tall would
 * cover its right-hand neighbour. The cursor advances by the cell's own width, rounded up to
 * the grid, so every position lands on the grid and no two cells come closer than the gap.
 */
export function packRows(cells: readonly {id: string; width: number; height: number}[], width: number, gap = GRID): Map<string, Point> {
 const positions = new Map<string, Point>();
 const step = (value: number) => Math.max(GRID, Math.ceil(value / GRID) * GRID);
 let x = 0, y = 0, rowHeight = 0;
 for (const cell of cells) {
  if (x && x + cell.width > width) { y += step(rowHeight) + gap; x = 0; rowHeight = 0; }
  positions.set(cell.id, {x, y});
  x += step(cell.width) + gap;
  rowHeight = Math.max(rowHeight, cell.height);
 }
 return positions;
}
