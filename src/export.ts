import {TFile} from 'obsidian';
import type {App} from 'obsidian';
import type {EdgeRecord, GraphSnapshot, ImageRecord, Rect, ViewFrame} from './types';
import {detached} from './dom';
import {onScreen} from './geometry';
import {EXPORTS_ROOT, ensureFolder} from './folders';
import {renderScene} from './render';
import {DEFAULT_PALETTE, themePalette} from './presentation';
import {imageCaptions} from './presentation';

type CanvasNode = {id:string; type:'file'|'text'; x:number; y:number; width:number; height:number; file?:string; text?:string};
type CanvasEdge = {id:string; fromNode:string; toNode:string; fromSide?:string; toSide?:string; fromEnd:'none'|'arrow'; toEnd:'none'|'arrow'; label?:string};

export class GraphExporter {
 private readonly app: App;
 constructor(app: App) { this.app = app; }

 private async uniquePath(base: string): Promise<string> {
  const vault = this.app.vault; const dot = base.lastIndexOf('.'); const stem = dot >= 0 ? base.slice(0, dot) : base; const ext = dot >= 0 ? base.slice(dot) : '';
  let candidate = base; let i = 2;
  while (vault.getAbstractFileByPath(candidate)) candidate = `${stem}-${i++}${ext}`;
  return candidate;
 }

 private validateFrame(frame: ViewFrame): void {
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0) throw new Error('Export frame must have positive dimensions');
  if (!Number.isFinite(frame.camera.x) || !Number.isFinite(frame.camera.y) || !Number.isFinite(frame.camera.scale) || frame.camera.scale <= 0) throw new Error('Export frame camera is invalid');
  for (const id of frame.imageIds) { const position = frame.positions[id]; if (!position || ![position.x, position.y, position.width, position.height].every(Number.isFinite) || position.width <= 0 || position.height <= 0) throw new Error(`Export frame position is missing for ${id}`); }
 }
 private selected(snapshot: GraphSnapshot, frame: ViewFrame): {images:ImageRecord[]; positions:Map<string,Rect>; edges:EdgeRecord[]} {
  const selected = new Set(frame.imageIds); const images = snapshot.images.filter((image) => selected.has(image.id));
  const positions = new Map(images.map((image) => [image.id, frame.positions[image.id] ?? image]));
  const actualIds = new Set(images.map(image => image.id));
  const requestedEdges = frame.edgeIds ? new Set(frame.edgeIds) : undefined;
  const edges = snapshot.edges.filter((edge) => actualIds.has(edge.source.imageId) && actualIds.has(edge.target.imageId) && (!requestedEdges || requestedEdges.has(edge.id)));
  return {images, positions, edges};
 }
 async canvas(snapshot: GraphSnapshot, frame: ViewFrame): Promise<TFile> {
  this.validateFrame(frame);
  await ensureFolder(this.app, EXPORTS_ROOT);
  const {images, positions, edges} = this.selected(snapshot, frame); const ids = new Map(images.map((image) => [image.id, `image-${image.id}`]));
  const nodes: CanvasNode[] = images.map((image) => { const p = positions.get(image.id)!; return {id: ids.get(image.id)!, type:'file', file:image.path, x:Math.round(p.x), y:Math.round(p.y), width:Math.round(p.width), height:Math.round(p.height)}; });
  const canvasEdges: CanvasEdge[] = edges.map((edge) => {
   const direction = edge.direction; const label = typeof edge.properties?.relation === 'string' ? edge.properties.relation : undefined;
   return {id:`edge-${edge.id}`, fromNode:ids.get(edge.source.imageId)!, toNode:ids.get(edge.target.imageId)!, fromEnd:direction === 'reverse' || direction === 'both' ? 'arrow' : 'none', toEnd:direction === 'forward' || direction === 'both' ? 'arrow' : 'none', label};
  });
  const path = await this.uniquePath(`${EXPORTS_ROOT}/image-graph.canvas`);
  return this.app.vault.create(path, JSON.stringify({nodes, edges:canvasEdges}, null, 2));
 }

 private async loadImage(image: ImageRecord): Promise<HTMLImageElement|null> {
  const doc = this.app.workspace.containerEl?.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) return null;
  const file = this.app.vault.getAbstractFileByPath(image.path); if (!(file instanceof TFile)) return null;
  const element = detached(doc,'img'); element.decoding = 'async'; element.src = this.app.vault.getResourcePath(file);
  try { await element.decode(); return element; } catch { element.remove(); return null; }
 }
 /** Worth loading an original for: on screen, and at least a pixel of it. */
 private visible(rect: Rect, frame: ViewFrame): boolean {
  const scale = frame.camera.scale;
  return onScreen(rect, frame.camera, frame.width, frame.height) && rect.width * scale >= 1 && rect.height * scale >= 1;
 }
 async visual(snapshot: GraphSnapshot, frame: ViewFrame, source?:HTMLCanvasElement): Promise<TFile> {
  this.validateFrame(frame);
  if(source){
   const scale=Math.min(1,4096/Math.max(frame.width,frame.height),Math.sqrt(16_000_000/(frame.width*frame.height)));
   const copy=detached(source.ownerDocument,'canvas');copy.width=Math.max(1,Math.floor(frame.width*scale));copy.height=Math.max(1,Math.floor(frame.height*scale));
   const context=copy.getContext('2d');if(!context)throw new Error('Canvas is unavailable');
   context.drawImage(source,0,0,copy.width,copy.height);
   return this.saveVisual(copy,frame);
  }
  await ensureFolder(this.app, EXPORTS_ROOT); const selected = this.selected(snapshot, frame); const doc = this.app.workspace.containerEl?.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) throw new Error('Visual export requires a document');
  const outputScale = Math.min(1, 4096 / Math.max(frame.width, frame.height), Math.sqrt(16_000_000 / Math.max(1, frame.width * frame.height)));
  const canvas = detached(doc,'canvas'); canvas.width = Math.max(1, Math.floor(frame.width * outputScale)); canvas.height = Math.max(1, Math.floor(frame.height * outputScale)); const context = canvas.getContext('2d'); if (!context) { canvas.remove(); throw new Error('Canvas is unavailable'); }
  context.scale(outputScale, outputScale);
  /* Every picture is loaded before anything is drawn, because `renderScene` never loads: it
   * is handed whatever the caller already holds, which is a thumbnail in the view and a note,
   * and the original here. Four at a time, as before. */
  const loaded = new Map<string, HTMLImageElement>();
  const wanted = selected.images.filter((image) => { const rect = selected.positions.get(image.id); return !!rect && rect.width * frame.camera.scale >= 32 && rect.height * frame.camera.scale >= 32 && this.visible(rect, frame); });
  for (let start = 0; start < wanted.length; start += 4) {
   const batch = await Promise.all(wanted.slice(start, start + 4).map(async (image) => [image.id, await this.loadImage(image)] as const));
   for (const [id, element] of batch) if (element) loaded.set(id, element);
  }
  try {
   const view = this.app.workspace.containerEl;
   renderScene(context, {
    images: selected.images,
    positions: selected.positions,
    edges: selected.edges,
    regions: snapshot.regions.filter((region) => frame.imageIds.includes(region.imageId)),
    captions: imageCaptions(selected.images, snapshot.regions, snapshot.edges),
   }, {
    camera: frame.camera, width: frame.width, height: frame.height,
    palette: view ? themePalette(getComputedStyle(view)) : DEFAULT_PALETTE,
    thumbnail: (image) => loaded.get(image.id) ?? null,
   });
  } finally { for (const element of loaded.values()) element.remove(); }
  return this.saveVisual(canvas,frame);
 }
 private async saveVisual(canvas:HTMLCanvasElement,frame:ViewFrame):Promise<TFile>{
  let blob: Blob;
  try { blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png')); }
  finally { canvas.remove(); }
  await ensureFolder(this.app, EXPORTS_ROOT);
  const pngPath = await this.uniquePath(`${EXPORTS_ROOT}/image-graph.png`); const png = await blob.arrayBuffer(); await this.app.vault.createBinary(pngPath, png);
  const canvasPath = await this.uniquePath(`${EXPORTS_ROOT}/image-graph-visual.canvas`); return this.app.vault.create(canvasPath, JSON.stringify({nodes:[{id:'visual-export',type:'file',file:pngPath,x:0,y:0,width:frame.width,height:frame.height}],edges:[]}, null, 2));
 }
}
