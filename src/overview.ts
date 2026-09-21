import {DECODE_SLOTS, CACHE_BUDGET_BYTES} from './jobs';
import {App, TFile} from 'obsidian';
import type {ImageRecord} from './types';
import {detached} from './dom';
import type {JobHandle, Jobs} from './jobs';
import {THUMBNAILS_ROOT, ensureFolder} from './folders';

const TILE=32, SIDE=512, PER_PAGE=256, ROOT=THUMBNAILS_ROOT;
const PAGE_BYTES=SIDE*SIDE*4, BUDGET=CACHE_BUDGET_BYTES, GRACE=1000;
type Signature={id:string;path:string;mtime:number;size:number};
type Crop={source:CanvasImageSource;x:number;y:number;width:number;height:number};
/** `images` is a slot array: a hole is an image that left, and holes are never closed up. */
interface Page {index:number;images:Array<ImageRecord|null>;blanks:number;canvas?:HTMLCanvasElement;ready:Set<number>;queued:boolean;loading:boolean;complete:boolean;used:number;listeners:Set<()=>void>}

/** Tiny resident atlas tiles, with only two originals being decoded at a time. */
export class OverviewAtlas {
 private pages:Page[]=[];
 private indices=new Map<string,{page:Page;slot:number}>();
 private paths=new Map<string,string>();
 private queue:Page[]=[];
 private running=0;
 private disposed=false;
 private layout='';
 private callbacks=new Set<()=>void>();
 private timer:number|undefined;
 private folders:Promise<void>|undefined;
 private order:string[]|null=null;
 private pendingImages:ImageRecord[]=[];
 private waiting=new Map<string,{image:ImageRecord;ready:()=>void}>();
 private orderWrite:Promise<void>=Promise.resolve();
 private job:JobHandle|undefined;
 constructor(private app:App,private doc:Document,private jobs?:Jobs){
  void this.readOrder().then(ids=>{if(this.disposed)return;this.order=ids;this.sync(this.pendingImages);const waiting=[...this.waiting.values()];this.waiting.clear();for(const entry of waiting)this.get(entry.image,entry.ready);});
 }
 private async readOrder():Promise<string[]>{
  try{const file=this.app.vault.getAbstractFileByPath(`${ROOT}/layout.json`);if(!(file instanceof TFile))return[];const data:unknown=JSON.parse(await this.app.vault.read(file));if(data&&typeof data==='object'&&'version'in data&&data.version===1&&'ids'in data&&Array.isArray(data.ids)&&data.ids.every((id:unknown)=>typeof id==='string')){const seen=new Set<string>();return data.ids.filter(id=>!id||(!seen.has(id)&&(seen.add(id),true)));}}catch{/* Rebuild derived slots if the layout cache is unavailable. */}return[];
 }

 sync(images:ImageRecord[]):void{
  if(this.disposed)return;
  this.pendingImages=images;if(this.order===null)return;
  const byId=new Map(images.filter(i=>!i.missing).map(i=>[i.id,i]));
  /* A slot is an address, not a position. Closing the gap when an image left moved every
   * later image into a different slot, so every page's signature changed and the whole cache
   * was thrown away: one departure cost a re-decode of the vault. Measured 2026-09-21 on
   * 20,015 images — 894 originals re-read in ten seconds, and not one cached page used.
   * A departure now leaves a hole, and the next arrival takes the lowest one. */
  const slots=this.order.map(id=>byId.has(id)?id:'');
  const taken=new Set(slots.filter(Boolean));
  const holes:number[]=[];for(let slot=0;slot<slots.length;slot++)if(!slots[slot])holes.push(slot);
  for(const id of [...byId.keys()].filter(id=>!taken.has(id)).sort()){const hole=holes.shift();if(hole===undefined)slots.push(id);else slots[hole]=id;}
  while(slots.length&&!slots[slots.length-1])slots.pop();
  const active=slots.map(id=>id?byId.get(id)??null:null);
  const layout=active.map(image=>image?`${image.id}\0${image.path}`:'').join('\n');
  if(layout===this.layout)return;
  const orderChanged=slots.join('\n')!==this.order.join('\n');this.order=slots;
  this.layout=layout;this.indices.clear();this.paths.clear();
  const oldPages=this.pages;this.pages=[];
  for(let start=0;start<active.length;start+=PER_PAGE){
   const index=start/PER_PAGE,items=active.slice(start,start+PER_PAGE),old=oldPages[index];
   const exact=!!old&&old.images.length===items.length&&old.images.every((image,i)=>image?.id===items[i]?.id&&image?.path===items[i]?.path);
   const page=exact?old:this.newPage(index,items);
   /* Carry the pixels over and re-mark only the slots that did not change. An all-or-nothing
    * copy threw a whole page away when one of its 256 images left. */
   if(!exact&&old?.canvas){
    page.canvas=old.canvas;
    page.images.forEach((image,slot)=>{
     const was=old.images[slot];
     if(!image)page.ready.add(slot);
     else if(was&&was.id===image.id&&was.path===image.path&&old.ready.has(slot))page.ready.add(slot);
    });
   }
   this.pages.push(page);
   page.images.forEach((image,slot)=>{if(!image)return;this.indices.set(image.id,{page,slot});this.paths.set(image.path,image.id);});
  }
  for(const page of oldPages)if(this.pages[page.index]!==page)page.listeners.clear();
  this.queue=this.queue.filter(page=>this.current(page));
  if(orderChanged){const text=JSON.stringify({version:1,ids:slots});this.orderWrite=this.orderWrite.then(async()=>{if(this.disposed)return;await this.ensureFolders();if(this.disposed)return;const path=`${ROOT}/layout.json`,file=this.app.vault.getAbstractFileByPath(path);if(file instanceof TFile)await this.app.vault.modify(file,text);else await this.app.vault.create(path,text);}).catch((error:unknown)=>console.warn('Image Graph thumbnail slots:',error));}
 }
 private newPage(index:number,images:Array<ImageRecord|null>):Page{return{index,images,blanks:images.filter(image=>!image).length,ready:new Set(),queued:false,loading:false,complete:false,used:0,listeners:new Set()};}
 private current(page:Page){return !this.disposed&&this.pages[page.index]===page;}
 /** Retained pages are bounded like the detail cache, because a mosaic of the whole vault
  * would otherwise grow a megabyte for every 256 images and never give any of it back.
  * A page the frame being drawn has just asked for is never dropped, so a full-vault redraw
  * cannot evict its own tiles; a dropped page reloads from its saved PNG, not from originals.
  * A loading page is never dropped either: load() holds the canvas across its yields, and
  * would go on drawing into a released one and then save it. */
 private evict(){
  const resident=this.pages.filter(page=>page.canvas);let bytes=resident.length*PAGE_BYTES;
  if(bytes<=BUDGET)return;
  const cutoff=Date.now()-GRACE;
  for(const page of resident.sort((a,b)=>a.used-b.used)){
   if(bytes<=BUDGET)break;
   if(page.used>cutoff||!page.canvas||page.loading||page.queued)continue;
   page.canvas.width=0;page.canvas.height=0;page.canvas=undefined;page.ready.clear();page.complete=false;bytes-=PAGE_BYTES;
  }
 }
 get(image:ImageRecord,ready:()=>void):Crop|null{
  if(this.disposed||image.missing)return null;
  if(this.order===null){this.waiting.set(image.id,{image,ready});return null;}
  const entry=this.indices.get(image.id);if(!entry)return null;const{page,slot}=entry;
  page.used=Date.now();
  if(!page.complete)page.listeners.add(ready);
  if(!page.complete&&!page.queued&&!page.loading){page.queued=true;this.queue.push(page);this.pump();}
  return page.canvas&&page.ready.has(slot)?{source:page.canvas,x:(slot%16)*TILE,y:Math.floor(slot/16)*TILE,width:TILE,height:TILE}:null;
 }
 invalidate(path:string):void{
  const id=this.paths.get(path),entry=id?this.indices.get(id):undefined;if(!entry)return;
  const old=entry.page,page=this.newPage(old.index,old.images);page.listeners=old.listeners;this.pages[page.index]=page;
  page.images.forEach((image,slot)=>{if(image)this.indices.set(image.id,{page,slot});});this.notify(page);
 }
 private notify(page:Page){
  if(!this.current(page))return;for(const cb of page.listeners)this.callbacks.add(cb);
  if(page.complete)page.listeners.clear();
  if(this.timer!==undefined||!this.callbacks.size)return;
  this.timer=this.doc.defaultView?.setTimeout(()=>{this.timer=undefined;const callbacks=[...this.callbacks];this.callbacks.clear();if(!this.disposed)for(const cb of callbacks)cb();},100);
 }
 private pump(){
  if(this.jobs&&(this.job||this.queue.length||this.running))this.track();
  if(this.job?.signal.aborted){for(const page of this.queue)page.queued=false;this.queue=[];this.job.finish();this.job=undefined;return;}
  while(!this.disposed&&this.running<DECODE_SLOTS&&this.queue.length){const page=this.queue.shift()!;if(!this.current(page)||!page.queued)continue;page.queued=false;page.loading=true;this.running++;void this.load(page).finally(()=>{page.loading=false;this.running--;this.notify(page);this.pump();});}
 }
 /** Counted in images rather than pages, because that is the number a person can feel. */
 private track(){
  if(!this.jobs)return;
  // Walks every page, so it is never called from the steady state of a redraw.
  const {ready,total,pending}=this.stats;
  if(!pending&&!this.queue.length&&!this.running){this.job?.finish();this.job=undefined;return;}
  if(!this.job)this.job=this.jobs.start('Building overview thumbnails',total);
  this.job.step(ready,total);
 }
 private signature(image:ImageRecord):Signature|null{const file=this.app.vault.getAbstractFileByPath(image.path);return file instanceof TFile?{id:image.id,path:image.path,mtime:file.stat.mtime,size:file.stat.size}:null;}
 private async cached(page:Page,items:Array<Signature|null>):Promise<boolean>{
  try{
   const meta=this.app.vault.getAbstractFileByPath(`${ROOT}/page-${page.index}.json`),png=this.app.vault.getAbstractFileByPath(`${ROOT}/page-${page.index}.png`);
   if(!(meta instanceof TFile)||!(png instanceof TFile))return false;
   const value:unknown=JSON.parse(await this.app.vault.read(meta));
   if(!value||typeof value!=='object'||!('version'in value)||value.version!==1||!('items'in value)||JSON.stringify(value.items)!==JSON.stringify(items))return false;
   const bytes=await this.app.vault.readBinary(png);if(!this.current(page))return true;
   const bitmap=await this.doc.defaultView!.createImageBitmap(new Blob([bytes]));
   try{if(!this.current(page))return true;if(bitmap.width!==SIDE||bitmap.height!==SIDE)return false;const canvas=detached(this.doc,'canvas');canvas.width=SIDE;canvas.height=SIDE;const ctx=canvas.getContext('2d');if(!ctx)return false;ctx.drawImage(bitmap,0,0);page.canvas=canvas;page.images.forEach((image,i)=>{if(!image||items[i])page.ready.add(i);});page.complete=true;this.evict();return true;}finally{bitmap.close();}
  }catch{return false;}
 }
 private async load(page:Page):Promise<void>{
  try{
   const items=page.images.map(image=>image?this.signature(image):null);
   if(await this.cached(page,items)||!this.current(page))return;
   const win=this.doc.defaultView;if(!win)return;
   const canvas=page.canvas??detached(this.doc,'canvas');canvas.width=SIDE;canvas.height=SIDE;const ctx=canvas.getContext('2d');if(!ctx)return;page.canvas=canvas;
   for(let slot=0;slot<page.images.length;slot++){
    if(!this.current(page))return;
    if(page.ready.has(slot))continue;
    const held=page.images[slot];
    if(!held){page.ready.add(slot);continue;}
    const source=this.app.vault.getAbstractFileByPath(held.path);
    if(source instanceof TFile)try{
     const bytes=await this.app.vault.readBinary(source);if(!this.current(page))return;
     const bitmap=await win.createImageBitmap(new Blob([bytes]),{resizeWidth:TILE,resizeHeight:TILE,resizeQuality:'medium'});
     try{if(!this.current(page))return;ctx.drawImage(bitmap,(slot%16)*TILE,Math.floor(slot/16)*TILE,TILE,TILE);page.ready.add(slot);}finally{bitmap.close();}
    }catch{/* Unreadable originals remain placeholders; do not repeatedly retry. */}
    if(slot%8===7){this.notify(page);this.track();if(this.job?.signal.aborted)return;await new Promise<void>(resolve=>win.setTimeout(resolve,0));}
   }
   page.complete=true;this.evict();this.notify(page);
   // Incomplete pages are retried next session, not stored as successful tiles.
   if(page.ready.size===page.images.length)await this.save(page,items,canvas);
  }catch(error){if(this.current(page)){page.complete=true;console.warn('Image Graph overview cache:',error);}}
 }
 private async ensureFolders(){
  // Memoised because every page save asks, and the answer cannot change back.
  if(!this.folders)this.folders=ensureFolder(this.app,ROOT).catch((error:unknown)=>{this.folders=undefined;throw error;});
  await this.folders;
 }
 private async save(page:Page,items:Array<Signature|null>,canvas:HTMLCanvasElement){
  const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob||!this.current(page))return;
  await this.ensureFolders();if(!this.current(page))return;
  const pngPath=`${ROOT}/page-${page.index}.png`,metaPath=`${ROOT}/page-${page.index}.json`,bytes=await blob.arrayBuffer();
  const png=this.app.vault.getAbstractFileByPath(pngPath);if(png instanceof TFile)await this.app.vault.modifyBinary(png,bytes);else await this.app.vault.createBinary(pngPath,bytes);
  if(!this.current(page))return;
  const text=JSON.stringify({version:1,items}),meta=this.app.vault.getAbstractFileByPath(metaPath);if(meta instanceof TFile)await this.app.vault.modify(meta,text);else await this.app.vault.create(metaPath,text);
 }
 dispose(){this.disposed=true;if(this.timer!==undefined)this.doc.defaultView?.clearTimeout(this.timer);this.callbacks.clear();this.waiting.clear();this.pendingImages=[];for(const page of this.pages)page.listeners.clear();this.pages=[];this.indices.clear();this.paths.clear();this.queue=[];}
 get stats(){let ready=0,pending=0;for(const page of this.pages){ready+=Math.max(0,page.ready.size-page.blanks);if(page.queued||page.loading)pending+=page.images.length-page.ready.size;}return{ready,total:this.indices.size,pending,decoding:this.running};}
}
