import {TFile} from 'obsidian';
import type {App} from 'obsidian';
import type {EdgeRecord, GraphSnapshot, ImageRecord, Rect, ViewFrame} from './types';
import {edgeEndpoints} from './graph';
import {detached} from './dom';

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
 private async ensureFolder(): Promise<void> {
  if (!this.app.vault.getAbstractFileByPath('_Image Graph')) await this.app.vault.createFolder('_Image Graph');
  if (!this.app.vault.getAbstractFileByPath('_Image Graph/Exports')) await this.app.vault.createFolder('_Image Graph/Exports');
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
  await this.ensureFolder();
  const {images, positions, edges} = this.selected(snapshot, frame); const ids = new Map(images.map((image) => [image.id, `image-${image.id}`]));
  const nodes: CanvasNode[] = images.map((image) => { const p = positions.get(image.id)!; return {id: ids.get(image.id)!, type:'file', file:image.path, x:Math.round(p.x), y:Math.round(p.y), width:Math.round(p.width), height:Math.round(p.height)}; });
  const canvasEdges: CanvasEdge[] = edges.map((edge) => {
   const direction = edge.direction; const label = typeof edge.properties?.relation === 'string' ? edge.properties.relation : undefined;
   return {id:`edge-${edge.id}`, fromNode:ids.get(edge.source.imageId)!, toNode:ids.get(edge.target.imageId)!, fromEnd:direction === 'reverse' || direction === 'both' ? 'arrow' : 'none', toEnd:direction === 'forward' || direction === 'both' ? 'arrow' : 'none', label};
  });
  const path = await this.uniquePath('_Image Graph/Exports/image-graph.canvas');
  return this.app.vault.create(path, JSON.stringify({nodes, edges:canvasEdges}, null, 2));
 }

 private async loadImage(image: ImageRecord): Promise<HTMLImageElement|null> {
  const doc = this.app.workspace.containerEl?.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) return null;
  const file = this.app.vault.getAbstractFileByPath(image.path); if (!(file instanceof TFile)) return null;
  const element = detached(doc,'img'); element.decoding = 'async'; element.src = this.app.vault.getResourcePath(file);
  try { await element.decode(); return element; } catch { element.remove(); return null; }
 }
 private visible(rect: Rect, frame: ViewFrame): boolean {
  const scale = frame.camera.scale; const left = (-frame.camera.x) / scale; const top = (-frame.camera.y) / scale; const right = left + frame.width / scale; const bottom = top + frame.height / scale;
  return rect.x + rect.width >= left && rect.y + rect.height >= top && rect.x <= right && rect.y <= bottom && rect.width * scale >= 1 && rect.height * scale >= 1;
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
  await this.ensureFolder(); const selected = this.selected(snapshot, frame); const doc = this.app.workspace.containerEl?.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) throw new Error('Visual export requires a document');
  const outputScale = Math.min(1, 4096 / Math.max(frame.width, frame.height), Math.sqrt(16_000_000 / Math.max(1, frame.width * frame.height)));
  const canvas = detached(doc,'canvas'); canvas.width = Math.max(1, Math.floor(frame.width * outputScale)); canvas.height = Math.max(1, Math.floor(frame.height * outputScale)); const context = canvas.getContext('2d'); if (!context) { canvas.remove(); throw new Error('Canvas is unavailable'); }
  context.scale(outputScale, outputScale);
  context.fillStyle = '#111'; context.fillRect(0, 0, frame.width, frame.height);
  const images = selected.images.filter((image) => this.visible(selected.positions.get(image.id)!, frame));
  for (let start = 0; start < images.length; start += 4) {
   const batch = await Promise.all(images.slice(start, start + 4).map(async (image) => {
    const rect = selected.positions.get(image.id)!;
    return [image, rect.width * frame.camera.scale >= 32 && rect.height * frame.camera.scale >= 32 ? await this.loadImage(image) : null] as const;
   }));
   for (const [image, loaded] of batch) { const p = selected.positions.get(image.id)!; const x = p.x * frame.camera.scale + frame.camera.x; const y = p.y * frame.camera.scale + frame.camera.y; if (loaded && p.width * frame.camera.scale >= 32 && p.height * frame.camera.scale >= 32) context.drawImage(loaded, x, y, p.width * frame.camera.scale, p.height * frame.camera.scale); else { context.fillStyle = '#333'; context.fillRect(x, y, p.width * frame.camera.scale, p.height * frame.camera.scale); } loaded?.remove(); }
  }
  const regions = new Map(snapshot.regions.map((region) => [region.id, region])); const pos = selected.positions;
  context.strokeStyle = '#f2c94c'; context.lineWidth = 2;
  for (const region of snapshot.regions.filter((r) => frame.imageIds.includes(r.imageId))) {
   const p = pos.get(region.imageId); if (!p) continue; context.beginPath(); if (region.shape.type === 'rect') context.rect((p.x + region.shape.x * p.width) * frame.camera.scale + frame.camera.x, (p.y + region.shape.y * p.height) * frame.camera.scale + frame.camera.y, region.shape.width * p.width * frame.camera.scale, region.shape.height * p.height * frame.camera.scale); else region.shape.points.forEach((point, i) => { const x = (p.x + point.x * p.width) * frame.camera.scale + frame.camera.x; const y = (p.y + point.y * p.height) * frame.camera.scale + frame.camera.y; i ? context.lineTo(x, y) : context.moveTo(x, y); }); context.closePath(); context.stroke();
  }
  context.strokeStyle = '#fff'; context.lineWidth = 1.5;
  for (const edge of selected.edges) {
   const {source:a,target:b} = edgeEndpoints(edge,pos,regions); const ax = a.x * frame.camera.scale + frame.camera.x; const ay = a.y * frame.camera.scale + frame.camera.y; const bx = b.x * frame.camera.scale + frame.camera.x; const by = b.y * frame.camera.scale + frame.camera.y;
   context.beginPath(); context.moveTo(ax, ay); context.lineTo(bx, by); context.stroke();
   const label = typeof edge.properties?.relation === 'string' ? edge.properties.relation : '';
   if (label) { context.fillStyle = '#fff'; context.font = '12px sans-serif'; context.fillText(label, (ax + bx) / 2 + 4, (ay + by) / 2 - 4); }
   const drawArrow = (x: number, y: number, angle: number): void => { const size = 8; context.beginPath(); context.moveTo(x, y); context.lineTo(x - Math.cos(angle - .45) * size, y - Math.sin(angle - .45) * size); context.lineTo(x - Math.cos(angle + .45) * size, y - Math.sin(angle + .45) * size); context.closePath(); context.fillStyle = '#fff'; context.fill(); };
   const angle = Math.atan2(by - ay, bx - ax); if (edge.direction === 'forward' || edge.direction === 'both') drawArrow(bx, by, angle); if (edge.direction === 'reverse' || edge.direction === 'both') drawArrow(ax, ay, angle + Math.PI);
  }
  return this.saveVisual(canvas,frame);
 }
 private async saveVisual(canvas:HTMLCanvasElement,frame:ViewFrame):Promise<TFile>{
  let blob: Blob;
  try { blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png')); }
  finally { canvas.remove(); }
  await this.ensureFolder();
  const pngPath = await this.uniquePath('_Image Graph/Exports/image-graph.png'); const png = await blob.arrayBuffer(); await this.app.vault.createBinary(pngPath, png);
  const canvasPath = await this.uniquePath('_Image Graph/Exports/image-graph-visual.canvas'); return this.app.vault.create(canvasPath, JSON.stringify({nodes:[{id:'visual-export',type:'file',file:pngPath,x:0,y:0,width:frame.width,height:frame.height}],edges:[]}, null, 2));
 }
}
