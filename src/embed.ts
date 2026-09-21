import type {GraphSnapshot, ImageRecord, Rect} from './types';
import {forceLayout, neighborhood, relationNeighborhood} from './graph';
import {boundsOf} from './geometry';
import {imageCaptions} from './presentation';
import {DEFAULT_PALETTE, renderScene, themePalette} from './render';

/** `path` is absent for a relation, which belongs to no one picture. */
export interface EmbedSpec {path: string | null; depth: number; relation: string | null; height: number}
export type EmbedRequest = {ok: true; spec: EmbedSpec} | {ok: false; problem: string};

const KEYS = ['depth', 'relation', 'height'] as const;
const MIN_HEIGHT = 120, MAX_HEIGHT = 900, DEFAULT_HEIGHT = 360;
/** Few enough to stay legible in a block. A glance, not a map: the footer says how many
 * there are in full, and the button opens the workspace where they all fit. */
const EMBED_LIMIT = 16;

/**
 * What a note asked for.
 *
 * One wikilink is the whole of the minimum form, because that is the question a person has:
 * *what is this picture connected to*. Everything else has a default. The block is the owner's
 * text and nothing writes back to it, so an unknown key is named rather than ignored: a silent
 * typo would leave them adjusting a setting that was never read.
 */
export function parseEmbed(source: string): EmbedRequest {
 let path = '';
 const spec: EmbedSpec = {path: null, depth: 1, relation: null, height: DEFAULT_HEIGHT};
 for (const raw of source.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const link = line.match(/^!?\[\[([^\]]+)\]\]$/);
  if (link) { if (!path) path = link[1]; continue; }
  const pair = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
  if (!pair) { if (!path) path = line; continue; }
  const [, key, value] = pair;
  if (key === 'depth') {
   const depth = Number(value);
   if (!Number.isFinite(depth) || depth < 1 || depth > 3) return {ok: false, problem: 'Give depth a whole number of hops from 1 to 3.'};
   spec.depth = Math.floor(depth);
  } else if (key === 'relation') spec.relation = value.trim() || null;
  else if (key === 'height') {
   const height = Number(value.replace(/px$/, ''));
   if (!Number.isFinite(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) return {ok: false, problem: `Give height a number of pixels from ${MIN_HEIGHT} to ${MAX_HEIGHT}.`};
   spec.height = Math.round(height);
  } else if (key === 'image') { if (!path) path = value.trim(); }
  else return {ok: false, problem: `“${key}” is not a setting here. Use image, ${KEYS.join(', ')}.`};
 }
 // A wikilink may carry an alias and a heading; neither names a different file.
 spec.path = path.replace(/^!?\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim() || null;
 if (!spec.path && !spec.relation) return {ok: false, problem: 'Name an image, as a wikilink: [[Photos/Harbour.png]] — or a relation.'};
 return {ok: true, spec};
}

export interface EmbedHost {
 getSnapshot(): GraphSnapshot;
 subscribe(callback: () => void): () => void;
 thumbnail(image: ImageRecord, ready: () => void, pixels?: number): CanvasImageSource | null;
 reveal(path: string): Promise<void>;
 exploreRelation(relation: string): Promise<void>;
}

/** The camera that shows all of `box` inside `width` by `height`, with room for captions. */
export function fitCamera(box: Rect, width: number, height: number, pad = 28) {
 const scale = Math.min(1.2, Math.max(.02, Math.min((width - pad * 2) / Math.max(1, box.width), (height - pad * 2 - 18) / Math.max(1, box.height))));
 return {scale, x: width / 2 - (box.x + box.width / 2) * scale, y: (height - 18) / 2 - (box.y + box.height / 2) * scale};
}

/**
 * A neighbourhood drawn inside a note.
 *
 * Still, not live: one render into one canvas, no animation frame, no hover, no spatial index.
 * Six of these in a note would otherwise be six render loops and six caches, and every budget
 * the renderer was measured against assumes a single view. The only interaction is one click,
 * which opens the workspace on that picture.
 */
export function renderEmbed(container: HTMLElement, source: string, host: EmbedHost, doc: Document): {dispose(): void} {
 const request = parseEmbed(source);
 let disposed = false, generation = 0, timer: number | undefined;
 const win = doc.defaultView;
 const draw = () => {
  if (disposed) return;
  const mine = ++generation;
  container.empty();
  container.addClass('image-graph-embed');
  if (!request.ok) { container.createEl('p', {cls: 'image-graph-embed-problem', text: request.problem}); return; }
  const {spec} = request;
  const snapshot = host.getSnapshot();
  const image = spec.path === null ? undefined : snapshot.images.find(item => item.path === spec.path);
  if (spec.path !== null && !image) {
   // Not an error: an image named before it exists is a note written ahead of the vault.
   container.createEl('p', {cls: 'image-graph-embed-problem', text: `${spec.path} is not in the image graph yet.`});
   return;
  }
  const graph = spec.relation ? relationNeighborhood(snapshot, spec.relation, EMBED_LIMIT) : neighborhood(snapshot, image!.id, spec.depth, new Set(), EMBED_LIMIT);
  if (!graph.ids.length) { container.createEl('p', {cls: 'image-graph-embed-problem', text: spec.relation ? `Nothing is connected by “${spec.relation}”.` : 'That image has no connections yet.'}); return; }
  const positions = forceLayout(snapshot.images, graph, spec.relation || !image ? null : image.id, new Set(), new Map());
  const width = Math.max(200, container.clientWidth || 640), ratio = win?.devicePixelRatio ?? 1;
  const canvas = container.createEl('canvas', {cls: 'image-graph-embed-canvas'});
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(spec.height * ratio);
  canvas.style.height = `${spec.height}px`;
  const ctx = canvas.getContext('2d');
  const shown = snapshot.images.filter(item => positions.has(item.id));
  if (ctx && shown.length) {
   ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
   const box = boundsOf(positions.values())!;
   const camera = fitCamera(box, width, spec.height);
   renderScene(ctx, {
    images: shown, positions, edges: graph.edges,
    regions: snapshot.regions.filter(region => positions.has(region.imageId)),
    captions: imageCaptions(shown, snapshot.regions, snapshot.edges),
   }, {
    camera, width, height: spec.height,
    palette: win ? themePalette(win.getComputedStyle(container)) : DEFAULT_PALETTE,
    // A thumbnail that is not decoded yet asks for one redraw, coalesced.
    thumbnail: item => host.thumbnail(item, () => { if (!disposed && mine === generation) schedule(); }, Math.max(64, Math.round(Math.max(item.width, item.height) * camera.scale * ratio))),
   });
  }
  const foot = container.createDiv({cls: 'image-graph-embed-foot'});
  const more = graph.capped ? ' (more in the workspace)' : '';
  foot.createSpan({text: spec.relation ? `Every “${spec.relation}” connection · ${graph.ids.length} images${more}` : `${(image!.path.split('/').pop() ?? image!.path)} · ${graph.ids.length} images, ${spec.depth} hop${spec.depth === 1 ? '' : 's'}${more}`});
  const open = foot.createEl('button', {text: 'Open in image graph'});
  open.onclick = () => { void (spec.relation && !image ? host.exploreRelation(spec.relation) : host.reveal(image!.path)); };
 };
 const schedule = () => {
  if (disposed || timer !== undefined || !win) return;
  timer = win.setTimeout(() => { timer = undefined; draw(); }, 120);
 };
 draw();
 const unsubscribe = host.subscribe(schedule);
 return {dispose() { disposed = true; if (timer !== undefined) win?.clearTimeout(timer); unsubscribe(); }};
}
