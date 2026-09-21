import type {Camera, EdgeRecord, Endpoint, ImageAssets, Point, Rect, RegionShape} from './types';
import {edgeEndpoints, regionHandles, relationOf} from './graph';
import {isForeignRegion} from './annotations';
import {spansViewport, viewportRect} from './camera';
import {onScreen, overlaps, rectBetween} from './geometry';
import {type Draft, type Mode, regionFromDrag} from './gestures';
import {connectionStyle, shortenLabel} from './presentation';
import {midpointOf} from './routing';
import {ROUTE_LIMIT, type GraphScene} from './scene';
import {detailSize} from './thumbnails';
import {detached} from './dom';

/** Every colour on the canvas comes from the theme. The eight that did not ignored a light
 * theme and the owner's own accent, and were never measured for contrast. */
export interface Palette {bg: string; card: string; fg: string; accent: string; picked: string; region: string; regionHover: string; missing: string}

/** What the pointer and the tools are doing this frame. Everything else comes from the scene. */
export interface FrameState {
 camera: Camera;
 width: number; height: number; ratio: number;
 palette: Palette;
 mode: Mode;
 hovered: Endpoint | null;
 hoveredEdge: string | null;
 /** `image` suppresses routing: every rectangle moves each frame and a recomputed path flickers. */
 dragKind: string | null;
 marquee: {start: Point; last: Point} | null;
 draft: Draft | null;
 /** A zoom gesture in flight. The cached mosaic is not worth rebuilding mid-pinch. */
 zooming: boolean;
 /** Connections on the traced path, drawn emphasised. */
 highlight: ReadonlySet<string>;
}

interface LabelJob {text: string; a: Point; b: Point; alpha: number; priority: number}
interface TileLayer {canvas: HTMLCanvasElement; doc: Document; camera: Camera; width: number; height: number; ratio: number; positions: Map<string, Rect>; version: number; card: string; bg: string}

/** How far past the viewport a connection may reach and still be drawn, for its label. */
const EDGE_MARGIN = 240;
/** Below this scale nothing but rectangles is legible, so regions, arrows and labels stop. */
const DETAIL_SCALE = .06;
/** Bytes of detail thumbnail one frame may ask for, and how many images may ask. */
const DETAIL_BYTES = 64 * 1024 * 1024, DETAIL_COUNT = 120;
const relation = (edge: EdgeRecord) => relationOf(edge.properties) ?? 'related to';

/**
 * One frame of the interactive canvas.
 *
 * Everything it draws comes from the scene it is handed and the state of the frame; it owns
 * only its caches — the tile mosaic and the version that invalidates it. It never reads the
 * DOM beyond the document it makes a detached canvas in, so `tests/fake-canvas.ts` can drive
 * it and read back the calls it made.
 *
 * This is the richer sibling of `render.ts#renderScene`, which draws a still of the same graph
 * for a note embed and a PNG export. The two agree about culling, palette and captions because
 * both read `geometry.ts` and `presentation.ts`; they part company over caching, hover, drafts
 * and routed connections, which only a live canvas has.
 */
export class CanvasRenderer {
 private layer: TileLayer | null = null;
 private version = 0;

 constructor(private readonly doc: Document, private readonly assets: Pick<ImageAssets, 'thumbnail' | 'overviewThumbnail'>, private readonly redraw: () => void) {}

 /** A thumbnail arriving, or a theme change, means the cached mosaic shows the wrong thing. */
 invalidate(): void { this.version++; }

 /** Drop the cached bitmap and its backing store. */
 release(): void {
  const canvas = this.layer?.canvas;
  if (canvas) { canvas.width = 0; canvas.height = 0; }
  this.layer = null;
 }

 /** Draw one frame, and report how many rectangles the viewport held. */
 paint(ctx: CanvasRenderingContext2D, scene: GraphScene, state: FrameState): {visible: number} {
  const {camera, width: w, height: h, ratio, palette} = state, s = camera.scale;
  const positions = scene.positions;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, w, h);

  const shown = scene.spatial().query(viewportRect(camera, w, h));
  // Limit demand as well as cache size: a dense viewport can otherwise repeatedly evict and
  // re-request its own thumbnails on every completion redraw.
  const detailed: string[] = [];
  for (const id of shown) { const r = positions.get(id); if (r && r.width * s >= 32) detailed.push(id); }
  const centre = {x: (w / 2 - camera.x) / s, y: (h / 2 - camera.y) / s};
  if (detailed.length > DETAIL_COUNT) detailed.sort((a, b) => {
   const ar = positions.get(a)!, br = positions.get(b)!;
   return Math.hypot(ar.x + ar.width / 2 - centre.x, ar.y + ar.height / 2 - centre.y) - Math.hypot(br.x + br.width / 2 - centre.x, br.y + br.height / 2 - centre.y);
  });
  const wanted = new Set<string>();
  let bytes = 0;
  for (const id of detailed) {
   const r = positions.get(id)!, size = detailSize(Math.max(r.width, r.height) * s * ratio);
   if (bytes + size * size * 4 > DETAIL_BYTES || wanted.size >= DETAIL_COUNT) continue;
   wanted.add(id); bytes += size * size * 4;
  }

  // Below the detail threshold every image is one atlas tile, so a bitmap of the viewport and
  // its margin stands in for tens of thousands of draw calls while the camera pans.
  const layer = !detailed.length && !state.zooming && state.dragKind !== 'image' ? this.tileLayer(scene, state) : null;
  // Blit in device pixels: a fractional offset would resample the whole mosaic and soften it.
  if (layer) {
   ctx.setTransform(1, 0, 0, 1, 0, 0);
   ctx.drawImage(layer.canvas, Math.round((camera.x - layer.camera.x) * ratio), Math.round((camera.y - layer.camera.y) * ratio));
   ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  ctx.save(); ctx.translate(camera.x, camera.y); ctx.scale(s, s);
  if (state.mode === 'move' && !scene.exploration && 40 * s >= 12) this.grid(ctx, state);

  const hovered = state.hovered;
  const drawn = scene.shownEdges().filter(edge => {
   const source = positions.get(edge.source.imageId), target = positions.get(edge.target.imageId);
   return source && target && spansViewport(source, target, camera, w, h, EDGE_MARGIN);
  });
  const focus = {
   selected: scene.selectedImages, selectedEdge: scene.selectedEdge,
   hoveredImage: hovered?.imageId ?? null, hoveredEdge: state.hoveredEdge,
   path: state.highlight, filter: scene.exploration?.filter ?? '', exploring: Boolean(scene.exploration),
  };
  const styles = new Map(drawn.map(edge => [edge.id, connectionStyle(edge, relation(edge), focus)]));
  const activeRegions = new Set<string>();
  for (const edge of drawn) if (styles.get(edge.id)?.label) {
   if (edge.source.regionId) activeRegions.add(edge.source.regionId);
   if (edge.target.regionId) activeRegions.add(edge.target.regionId);
  }

  const captionBoxes: Rect[] = [];
  // A group reads as a group: each member keeps a thinner ring and one band holds them all.
  const many = scene.selectedImages.size > 1;
  const ring = (r: Rect, style: string, width: number) => { ctx.strokeStyle = style; ctx.lineWidth = width / s; ctx.strokeRect(r.x, r.y, r.width, r.height); };
  const outline = (id: string, r: Rect) => {
   if (scene.selectedImages.has(id)) ring(r, palette.picked, many ? 1.5 : 2);
   else if (scene.exploration?.isRoot(id)) ring(r, palette.accent, 2);
   else if (id === hovered?.imageId) { ctx.globalAlpha = .55; ring(r, palette.accent, 1.5); ctx.globalAlpha = 1; }
  };

  // Rings stay live so a selection never rebuilds the layer. Labels need 60 screen pixels of
  // image width, which no image reaches while the layer is in use.
  if (layer) {
   const ringed = new Set(scene.selectedImages);
   for (const id of scene.exploration?.roots ?? []) ringed.add(id);
   if (hovered) ringed.add(hovered.imageId);
   for (const id of ringed) { const r = positions.get(id); if (r && onScreen(r, camera, w, h)) outline(id, r); }
  } else for (const id of shown) {
   const image = scene.images.get(id), r = positions.get(id);
   if (!image || !r) continue;
   ctx.fillStyle = image.missing ? palette.missing : palette.card;
   ctx.fillRect(r.x, r.y, r.width, r.height);
   const thumb = wanted.has(id) ? this.assets.thumbnail(image, this.redraw, Math.max(r.width, r.height) * s * ratio) : null;
   if (thumb) ctx.drawImage(thumb, r.x, r.y, r.width, r.height);
   else {
    const tile = this.assets.overviewThumbnail(image, this.redraw);
    if (tile) ctx.drawImage(tile.source, tile.x, tile.y, tile.width, tile.height, r.x, r.y, r.width, r.height);
   }
   outline(id, r);
   if (r.width * s > 60) this.caption(ctx, scene, state, id, r, captionBoxes);
  }

  if (many) {
   const band = scene.bounds(scene.selectedImages);
   if (band) { ctx.save(); ctx.setLineDash([7 / s, 5 / s]); ring({x: band.x - 6 / s, y: band.y - 6 / s, width: band.width + 12 / s, height: band.height + 12 / s}, palette.picked, 1); ctx.restore(); }
  }

  if (s > DETAIL_SCALE) this.regions(ctx, scene, state, shown, activeRegions);

  // Labels are collected and placed after every line is drawn, so one can see the others and
  // none is buried under a later line.
  const labels: LabelJob[] = [];
  // Routing wants a settled layout: during an image drag every rectangle moves each frame.
  const routing = s > DETAIL_SCALE && drawn.length <= ROUTE_LIMIT && state.dragKind !== 'image';
  scene.setRouting(routing);
  for (const edge of drawn) {
   const {source: a, target: b} = edgeEndpoints(edge, positions, scene.regions), style = styles.get(edge.id)!;
   const path = routing ? scene.route(edge, a, b) : [a, b];
   ctx.globalAlpha = style.alpha;
   ctx.strokeStyle = ctx.fillStyle = style.emphasized ? palette.picked : palette.accent;
   ctx.lineWidth = style.width / s;
   this.strokePath(ctx, path, s);
   if (s > DETAIL_SCALE) {
    // An arrowhead points along the segment it arrives on, not at the far end of the path.
    if (edge.direction === 'forward' || edge.direction === 'both') this.arrow(ctx, path[path.length - 2], path[path.length - 1], s);
    if (edge.direction === 'reverse' || edge.direction === 'both') this.arrow(ctx, path[1], path[0], s);
    if (style.label) {
     const middle = midpointOf(path);
     labels.push({text: relation(edge), a: middle.a, b: middle.b, alpha: style.alpha, priority: edge.id === scene.selectedEdge || edge.id === state.hoveredEdge ? 0 : state.highlight.has(edge.id) ? 1 : 2});
    }
   }
  }
  ctx.globalAlpha = 1;
  this.drawLabels(ctx, scene, state, labels, captionBoxes);
  this.drafts(ctx, scene, state);
  ctx.restore();
  return {visible: shown.length};
 }

 // ---- parts -------------------------------------------------------------------------------

 /** The 40px grid, drawn only in Move mode and only while its dots are far enough apart. */
 private grid(ctx: CanvasRenderingContext2D, state: FrameState): void {
  const {camera, width: w, height: h} = state, s = camera.scale;
  const left = Math.floor(-camera.x / s / 40) * 40, top = Math.floor(-camera.y / s / 40) * 40;
  ctx.beginPath();
  let points = 0;
  for (let x = left; x < (w - camera.x) / s && points < 20000; x += 40) {
   for (let y = top; y < (h - camera.y) / s && points < 20000; y += 40) { ctx.moveTo(x + 1 / s, y); ctx.arc(x, y, 1 / s, 0, Math.PI * 2); points++; }
  }
  ctx.fillStyle = state.palette.fg; ctx.globalAlpha = .2; ctx.fill(); ctx.globalAlpha = 1;
 }

 /** A picture's name under it, and the badge on a starting picture, where neither collides. */
 private caption(ctx: CanvasRenderingContext2D, scene: GraphScene, state: FrameState, id: string, r: Rect, taken: Rect[]): void {
  const s = state.camera.scale, {palette} = state;
  ctx.font = `${12 / s}px sans-serif`; ctx.fillStyle = palette.fg;
  const label = scene.caption(id) + (scene.exploration?.pinned.has(id) ? ' · pinned' : '');
  const text = shortenLabel(label, r.width, value => ctx.measureText(value).width);
  const box = {x: r.x, y: r.y + r.height + 3 / s, width: r.width, height: 19 / s};
  if (!scene.spatial().query(box).length && !taken.some(other => overlaps(box, other))) {
   ctx.fillText(text, r.x, box.y + 13 / s); taken.push(box);
  }
  if (scene.exploration?.isRoot(id)) {
   const badge = 'Starting image', width = ctx.measureText(badge).width + 12 / s;
   const at = {x: r.x, y: r.y - 25 / s, width, height: 20 / s};
   taken.push(at);
   ctx.fillStyle = palette.accent; ctx.fillRect(at.x, at.y, at.width, at.height);
   ctx.fillStyle = palette.bg; ctx.fillText(badge, at.x + 6 / s, at.y + 14 / s);
  }
 }

 private regions(ctx: CanvasRenderingContext2D, scene: GraphScene, state: FrameState, shown: readonly string[], active: ReadonlySet<string>): void {
  const s = state.camera.scale, {palette} = state, hovered = state.hovered;
  const resizing = state.draft?.kind === 'resize' ? state.draft : null;
  for (const id of shown) {
   const r = scene.positions.get(id);
   if (!r) continue;
   for (const region of scene.regionsOf(id)) {
    const chosen = region.id === scene.selectedRegion;
    const shape = resizing?.regionId === region.id ? resizing.shape : region.shape;
    const foreign = isForeignRegion(region);
    const lit = chosen || region.id === hovered?.regionId || active.has(region.id);
    ctx.globalAlpha = lit ? 1 : (scene.exploration?.isRoot(id) ? .2 : .12);
    // A dashed outline is a region another plugin drew: shown here, edited there.
    if (foreign) ctx.setLineDash([6 / s, 4 / s]);
    ctx.strokeStyle = chosen ? palette.picked : region.id === hovered?.regionId ? palette.regionHover : palette.region;
    ctx.lineWidth = (chosen ? 3 : lit ? 1.5 : 1) / s;
    this.shape(ctx, r, shape); ctx.stroke(); ctx.globalAlpha = 1;
    if (foreign) ctx.setLineDash([]);
    // Grips appear only where they can be gripped: eight inside 24 screen pixels is a smear.
    if (chosen && !foreign && Math.min(r.width, r.height) * s > 48) {
     ctx.fillStyle = palette.picked;
     const size = 4 / s;
     for (const grip of regionHandles(shape)) ctx.fillRect(r.x + grip.x * r.width - size, r.y + grip.y * r.height - size, size * 2, size * 2);
    }
   }
  }
 }

 /** The band, the rectangle being dragged and the polygon being clicked out. */
 private drafts(ctx: CanvasRenderingContext2D, scene: GraphScene, state: FrameState): void {
  const s = state.camera.scale, {palette} = state;
  if (state.marquee) {
   const band = rectBetween(state.marquee.start, state.marquee.last);
   ctx.save(); ctx.setLineDash([6 / s, 4 / s]); ctx.strokeStyle = palette.picked; ctx.lineWidth = 1 / s;
   ctx.strokeRect(band.x, band.y, band.width, band.height); ctx.restore();
  }
  const draft = state.draft;
  if (draft?.kind === 'region') {
   const r = scene.positions.get(draft.imageId);
   if (r) { ctx.strokeStyle = palette.picked; ctx.lineWidth = 2 / s; this.shape(ctx, r, regionFromDrag(draft.start, draft.last, r)); ctx.stroke(); }
  }
  if (draft?.kind === 'polygon') {
   const r = scene.positions.get(draft.imageId);
   if (!r) return;
   ctx.strokeStyle = palette.picked; ctx.lineWidth = 2 / s;
   this.shape(ctx, r, {type: 'polygon', points: draft.points}); ctx.stroke();
   for (const [index, p] of draft.points.entries()) {
    ctx.beginPath(); ctx.arc(r.x + p.x * r.width, r.y + p.y * r.height, (index === 0 ? 6 : 4) / s, 0, Math.PI * 2);
    ctx.fillStyle = index === 0 ? palette.region : palette.picked; ctx.fill();
   }
  }
 }

 private arrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, s: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x), size = 9 / s;
  ctx.beginPath(); ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - .45), to.y - size * Math.sin(angle - .45));
  ctx.lineTo(to.x - size * Math.cos(angle + .45), to.y - size * Math.sin(angle + .45));
  ctx.closePath(); ctx.fill();
 }

 private shape(ctx: CanvasRenderingContext2D, r: Rect, shape: RegionShape): void {
  ctx.beginPath();
  if (shape.type === 'rect') ctx.rect(r.x + shape.x * r.width, r.y + shape.y * r.height, shape.width * r.width, shape.height * r.height);
  else {
   shape.points.forEach((p, i) => {
    if (i) ctx.lineTo(r.x + p.x * r.width, r.y + p.y * r.height); else ctx.moveTo(r.x + p.x * r.width, r.y + p.y * r.height);
   });
   if (shape.points.length > 2) ctx.closePath();
  }
 }

 /** Corners are rounded so a right-angled path reads as one line rather than three. */
 private strokePath(ctx: CanvasRenderingContext2D, path: Point[], s: number): void {
  ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y);
  if (path.length === 2) { ctx.lineTo(path[1].x, path[1].y); ctx.stroke(); return; }
  let shortest = Infinity;
  for (let i = 1; i < path.length; i++) shortest = Math.min(shortest, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  const radius = Math.min(14 / s, shortest / 2);
  for (let i = 1; i < path.length - 1; i++) ctx.arcTo(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y, radius);
  ctx.lineTo(path[path.length - 1].x, path[path.length - 1].y); ctx.stroke();
 }

 private drawLabels(ctx: CanvasRenderingContext2D, scene: GraphScene, state: FrameState, labels: LabelJob[], captions: Rect[]): void {
  if (!labels.length) return;
  const s = state.camera.scale, {palette} = state;
  ctx.font = `${12 / s}px sans-serif`;
  const height = 20 / s, taken: Rect[] = [...captions];
  for (const label of labels.sort((a, b) => a.priority - b.priority)) {
   const box = this.labelBox(scene, state, label.a, label.b, ctx.measureText(label.text).width + 8 / s, height, taken);
   if (!box) continue;
   taken.push(box);
   ctx.globalAlpha = label.alpha;
   ctx.fillStyle = palette.bg; ctx.fillRect(box.x, box.y, box.width, box.height);
   ctx.fillStyle = palette.fg; ctx.fillText(label.text, box.x + 4 / s, box.y + 14 / s);
  }
  ctx.globalAlpha = 1;
 }

 /**
  * A label at the midpoint of a connection lands on an image about half the time. Try a few
  * points along the line and a step to either side, and take the first clear of the images and
  * of the labels already placed.
  */
 private labelBox(scene: GraphScene, state: FrameState, a: Point, b: Point, width: number, height: number, taken: Rect[]): Rect | null {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
  const offX = -dy / length * height * 1.15, offY = dx / length * height * 1.15;
  const viewport = viewportRect(state.camera, state.width, state.height);
  for (const along of [.5, .4, .6, .3, .7, .2, .8]) for (const side of [0, -1, 1, -2, 2]) {
   const box = {x: a.x + dx * along + offX * side - width / 2, y: a.y + dy * along + offY * side - height / 2, width, height};
   if (scene.spatial().query(box).length || taken.some(other => overlaps(box, other))) continue;
   if (box.x < viewport.x || box.y < viewport.y || box.x + box.width > viewport.x + viewport.width || box.y + box.height > viewport.y + viewport.height) continue;
   return box;
  }
  return null;
 }

 /**
  * Atlas tiles for the whole shown set, rendered once into a bitmap covering the viewport and
  * a margin. Reused until the scale, the data, or the camera leaves that margin. Selection
  * rings and labels stay outside it, so a click never rebuilds it.
  */
 private tileLayer(scene: GraphScene, state: FrameState): TileLayer | null {
  const {camera, ratio, palette} = state;
  const margin = Math.round(Math.min(state.width, state.height) * .25 * ratio) / ratio;
  const width = state.width + margin * 2, height = state.height + margin * 2;
  const doc = this.doc;
  const held = this.layer?.doc === doc ? this.layer : (this.release(), null);
  if (held && held.ratio === ratio && held.width === width && held.height === height && held.camera.scale === camera.scale
   && held.positions === scene.positions && held.version === this.version && held.card === palette.card && held.bg === palette.bg) {
   const dx = camera.x - held.camera.x, dy = camera.y - held.camera.y;
   if (dx <= 0 && dy <= 0 && dx + width >= state.width && dy + height >= state.height) return held;
  }
  const canvas = held?.canvas ?? detached(doc, 'canvas');
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const at: Camera = {scale: camera.scale, x: camera.x + margin, y: camera.y + margin};
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, width, height);
  ctx.translate(at.x, at.y); ctx.scale(at.scale, at.scale);
  for (const id of scene.spatial().query(viewportRect(at, width, height))) {
   const image = scene.images.get(id), r = scene.positions.get(id);
   if (!image || !r) continue;
   ctx.fillStyle = image.missing ? palette.missing : palette.card;
   ctx.fillRect(r.x, r.y, r.width, r.height);
   const tile = this.assets.overviewThumbnail(image, this.redraw);
   if (tile) ctx.drawImage(tile.source, tile.x, tile.y, tile.width, tile.height, r.x, r.y, r.width, r.height);
  }
  this.layer = {canvas, doc, camera: at, width, height, ratio, positions: scene.positions, version: this.version, card: palette.card, bg: palette.bg};
  return this.layer;
 }
}
