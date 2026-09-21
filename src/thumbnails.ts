import {DECODE_SLOTS, CACHE_BUDGET_BYTES} from './jobs';
import {App, TFile} from 'obsidian';
import type {ImageRecord} from './types';
import {detached} from './dom';
import {exploreSize, ratioOf} from './layout';

interface Entry {key:string;path:string;size:number;shape:number;ready:Set<()=>void>;canvas?:HTMLCanvasElement;failed?:boolean}
/** The picture's proportions, as hundredths, so a texture is keyed by shape as well as size. */
const shapeOf=(image:ImageRecord)=>Math.round(ratioOf(image)*100);
/** The texture for one entry: its longer side is the detail size, the shorter one follows. */
const textureSize=(entry:{size:number;shape:number})=>exploreSize({width:entry.shape,height:100},entry.size);
export function detailSize(pixels:number):number{return pixels<=256?256:pixels<=512?512:pixels<=1024?1024:2048;}
const BUDGET=CACHE_BUDGET_BYTES;

/** Resolution follows displayed pixels and the texture keeps the picture's proportions;
 * retained and queued textures share a byte budget. A square texture for a wide picture
 * spends its whole width on a quarter of the detail and looks soft wherever it is drawn. */
export class ThumbnailCache {
 private entries=new Map<string,Entry>();
 private queue:Entry[]=[];
 private running=0;
 private disposed=false;
 private bytes=0;
 constructor(private app:App,private doc:Document){}
 get(image:ImageRecord,ready:()=>void,pixels=256):CanvasImageSource|null{
  if(this.disposed||image.missing)return null;
  const size=detailSize(pixels),shape=shapeOf(image),key=`${image.path}\0${size}\0${shape}`,existing=this.entries.get(key);
  if(existing){this.entries.delete(key);this.entries.set(key,existing);if(!existing.canvas&&!existing.failed)existing.ready.add(ready);return existing.canvas??this.smaller(image.path,size,shape);}
  const entry:Entry={key,path:image.path,size,shape,ready:new Set([ready])};this.entries.set(key,entry);this.bytes+=size*size*4;this.queue.push(entry);
  while(this.bytes>BUDGET||this.entries.size>180){const oldest=this.entries.values().next().value;if(!oldest)break;this.drop(oldest);}
  this.queue=this.queue.filter(e=>this.entries.get(e.key)===e);
  this.pump();return this.smaller(image.path,size,shape);
 }
 private smaller(path:string,size:number,shape:number):HTMLCanvasElement|null{for(const candidate of [1024,512,256]){if(candidate>=size)continue;const entry=this.entries.get(`${path}\0${candidate}\0${shape}`);if(entry?.canvas)return entry.canvas;}return null;}
 private drop(entry:Entry){if(this.entries.get(entry.key)!==entry)return;this.entries.delete(entry.key);this.bytes-=entry.size*entry.size*4;entry.ready.clear();}
 invalidate(path:string){for(const entry of this.entries.values())if(entry.path===path)this.drop(entry);}
 private pump(){while(!this.disposed&&this.running<DECODE_SLOTS&&this.queue.length){const entry=this.queue.shift();if(!entry||this.entries.get(entry.key)!==entry)continue;this.running++;void this.load(entry).finally(()=>{this.running--;this.pump();});}}
 private async load(entry:Entry):Promise<void>{
  try{
   const file=this.app.vault.getAbstractFileByPath(entry.path);if(!(file instanceof TFile))throw new Error('Image missing');
   const bytes=await this.app.vault.readBinary(file);if(this.disposed||this.entries.get(entry.key)!==entry)return;
   const win=this.doc.defaultView;if(!win)return;
   const fit=textureSize(entry);
   const bitmap=await win.createImageBitmap(new Blob([bytes]),{resizeWidth:fit.width,resizeHeight:fit.height,resizeQuality:'high'});
   try{if(this.disposed||this.entries.get(entry.key)!==entry)return;const canvas=detached(this.doc,'canvas');canvas.width=fit.width;canvas.height=fit.height;const context=canvas.getContext('2d');if(!context)throw new Error('Image drawing unavailable');context.drawImage(bitmap,0,0);entry.canvas=canvas;}finally{bitmap.close();}
  }catch{entry.failed=true;}
  finally{if(!this.disposed&&this.entries.get(entry.key)===entry)for(const callback of entry.ready)callback();entry.ready.clear();}
 }
 dispose(){this.disposed=true;for(const entry of this.entries.values())entry.ready.clear();this.entries.clear();this.queue=[];this.bytes=0;}
 get stats(){return{cached:this.entries.size,queued:this.queue.length,decoding:this.running,bytes:this.bytes};}
}
