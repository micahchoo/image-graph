import type {Camera, EdgeRecord, ImageRecord, Point, Rect, RegionRecord} from './types';
import {edgeEndpoints} from './edge-endpoints';
import {relationOf} from './properties';
import {onScreen, overlaps} from './geometry';
import {shortenLabel, type Palette} from './presentation';
export {DEFAULT_PALETTE, themePalette} from './presentation';
import {LANE, ROUTE_LIMIT, ROUTE_MIN_SCALE, routeOrthogonal} from './routing';
import {isForeignRegion} from './annotations';

export interface Scene {
 images: readonly ImageRecord[];
 positions: ReadonlyMap<string, Rect>;
 edges: readonly EdgeRecord[];
 regions: readonly RegionRecord[];
 /** Display names. Absent means draw no captions. */
 captions?: ReadonlyMap<string, string>;
}

export interface SceneView {
 camera: Camera;
 width: number;
 height: number;
 palette: Palette;
 /** Whatever the caller already holds for this image. Nothing is loaded here. */
 thumbnail(image: ImageRecord): CanvasImageSource | null;
}

/**
 * One still picture of a graph: cards, pictures, regions, connections and captions.
 *
 * There were two of these and they disagreed. `export.ts#visual` drew its own with `#111`,
 * `#333`, `#f2c94c` and `#fff` hardcoded, so an exported PNG ignored the theme and carried no
 * captions; a note that embeds a neighbourhood would have been a third. The interactive view
 * still has its own richer pass — caching, culling, hover, drafts. What the two share is the
 * scene: `tests/render.test.ts` holds this one to what the view draws, and a difference found
 * there is a defect here or there, never a style.
 */
export function renderScene(ctx: CanvasRenderingContext2D, scene: Scene, view: SceneView): void {
 const {camera, palette} = view, scale = camera.scale;
 const toScreen = (rect: Rect) => ({x: rect.x * scale + camera.x, y: rect.y * scale + camera.y, width: rect.width * scale, height: rect.height * scale});
 ctx.save();
 ctx.fillStyle = palette.bg;
 ctx.fillRect(0, 0, view.width, view.height);

 const shown = scene.images.filter(image => {
  const rect = scene.positions.get(image.id);
  return !!rect && onScreen(rect, camera, view.width, view.height);
 });

 for (const image of shown) {
  const box = toScreen(scene.positions.get(image.id)!);
  ctx.fillStyle = image.missing ? palette.missing : palette.card;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  const source = image.missing ? null : view.thumbnail(image);
  if (source) ctx.drawImage(source, box.x, box.y, box.width, box.height);
 }

 const byImage = new Set(shown.map(image => image.id));
 ctx.strokeStyle = palette.region;
 ctx.lineWidth = Math.max(1, 2 * Math.min(1, scale));
 for (const region of scene.regions) {
  const rect = byImage.has(region.imageId) ? scene.positions.get(region.imageId) : undefined;
  if (!rect) continue;
  const box = toScreen(rect), foreign = isForeignRegion(region);
  // A dashed outline is a region another plugin drew, in the view and so here.
  if (foreign) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  if (region.shape.type === 'rect') ctx.rect(box.x + region.shape.x * box.width, box.y + region.shape.y * box.height, region.shape.width * box.width, region.shape.height * box.height);
  else region.shape.points.forEach((point, index) => {
   const x = box.x + point.x * box.width, y = box.y + point.y * box.height;
   if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();
  if (foreign) ctx.setLineDash([]);
 }

 const regions = new Map(scene.regions.map(region => [region.id, region]));
 ctx.font = `${Math.max(10, Math.round(12 * Math.min(1, scale * 2)))}px ${palette.font}`;
 ctx.textBaseline = 'alphabetic';
 const drawn = scene.edges.filter(edge => byImage.has(edge.source.imageId) || byImage.has(edge.target.imageId));
 // The view routes a line around the pictures between its ends. A snapshot of that view must
 // show the line the owner saw, not a chord through them.
 const routing = scale > ROUTE_MIN_SCALE && drawn.length <= ROUTE_LIMIT;
 const toPoint = (p: Point): Point => ({x: p.x * scale + camera.x, y: p.y * scale + camera.y});
 for (const edge of drawn) {
  const {source, target} = edgeEndpoints(edge, scene.positions, regions);
  const path = (routing ? routeAround(edge, source, target, scene.positions) : [source, target]).map(toPoint);
  ctx.strokeStyle = ctx.fillStyle = palette.accent;
  ctx.lineWidth = 1.5;
  strokePath(ctx, path, 14);
  const arrow = (from: Point, to: Point) => {
   const at = Math.atan2(to.y - from.y, to.x - from.x), size = 8;
   ctx.beginPath(); ctx.moveTo(to.x, to.y);
   ctx.lineTo(to.x - Math.cos(at - .45) * size, to.y - Math.sin(at - .45) * size);
   ctx.lineTo(to.x - Math.cos(at + .45) * size, to.y - Math.sin(at + .45) * size);
   ctx.closePath(); ctx.fill();
  };
  // An arrowhead points along the segment it arrives on, not at the far end of the path.
  if (edge.direction === 'forward' || edge.direction === 'both') arrow(path[path.length - 2], path[path.length - 1]);
  if (edge.direction === 'reverse' || edge.direction === 'both') arrow(path[1], path[0]);
  const label = relationOf(edge.properties);
  if (label) { const a = path[Math.floor((path.length - 1) / 2)], b = path[Math.ceil((path.length - 1) / 2)] ?? a; ctx.fillStyle = palette.fg; ctx.fillText(label, (a.x + b.x) / 2 + 4, (a.y + b.y) / 2 - 4); }
 }

 if (scene.captions) {
  ctx.fillStyle = palette.fg;
  ctx.textBaseline = 'top';
  for (const image of shown) {
   const name = scene.captions.get(image.id);
   if (!name) continue;
   const box = toScreen(scene.positions.get(image.id)!);
   if (box.width < 40) continue;
   ctx.fillText(shortenLabel(name, box.width, text => ctx.measureText(text).width), box.x, box.y + box.height + 4);
  }
 }
 ctx.restore();
}

/** The same obstacles the view hands the router: every rectangle near the line but the two ends. */
function routeAround(edge: EdgeRecord, a: Point, b: Point, positions: ReadonlyMap<string, Rect>): Point[] {
 const area = {x: Math.min(a.x, b.x) - LANE * 2, y: Math.min(a.y, b.y) - LANE * 2, width: Math.abs(a.x - b.x) + LANE * 4, height: Math.abs(a.y - b.y) + LANE * 4};
 const obstacles: Rect[] = [];
 for (const [id, rect] of positions) if (id !== edge.source.imageId && id !== edge.target.imageId && overlaps(rect, area)) obstacles.push(rect);
 return (obstacles.length ? routeOrthogonal(a, b, obstacles) : null) ?? [a, b];
}

/** Rounded corners where the path turns, as the view strokes it. `radius` is in screen pixels. */
function strokePath(ctx: CanvasRenderingContext2D, path: readonly Point[], radius: number): void {
 ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y);
 if (path.length === 2) { ctx.lineTo(path[1].x, path[1].y); ctx.stroke(); return; }
 let shortest = Number.POSITIVE_INFINITY;
 for (let i = 1; i < path.length; i++) shortest = Math.min(shortest, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
 const r = Math.min(radius, shortest / 2);
 for (let i = 1; i < path.length - 1; i++) ctx.arcTo(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y, r);
 ctx.lineTo(path[path.length - 1].x, path[path.length - 1].y); ctx.stroke();
}
