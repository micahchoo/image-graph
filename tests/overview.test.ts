import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest';

const {FakeTFile}=vi.hoisted(()=>({FakeTFile:class { path:string; stat:{mtime:number;size:number}; constructor(path:string,size=1){this.path=path;this.stat={mtime:1,size};} }}));
vi.mock('obsidian', () => ({TFile: FakeTFile}));

import {OverviewAtlas} from '../src/overview';

type File = InstanceType<typeof FakeTFile> & {text?:string;binary?:ArrayBuffer};
class Vault {
 files=new Map<string,File>(); originalReads=0; activeDecodes=0; maxDecodes=0; gate?:Promise<void>; release?:()=>void;
 getAbstractFileByPath(path:string){return this.files.get(path);}
 async read(file:File){return file.text??'';}
 async readBinary(file:File){if(!file.path.startsWith('_Image Graph/Thumbnails/'))this.originalReads++;return file.binary??new ArrayBuffer(1);}
 async createFolder(path:string){this.files.set(path,new FakeTFile(path) as File);}
 async create(path:string,text:string){const f=new FakeTFile(path,text.length) as File;f.text=text;this.files.set(path,f);return f;}
 async createBinary(path:string,binary:ArrayBuffer){const f=new FakeTFile(path,binary.byteLength) as File;f.binary=binary;this.files.set(path,f);return f;}
 async modify(file:File,text:string){file.text=text;}
 async modifyBinary(file:File,binary:ArrayBuffer){file.binary=binary;}
}
/** Slots a restored page reports as having no pixels, for the test that seeds a damaged PNG. */
let transparent=new Set<number>();
/** A canvas that behaves like one in the two ways the atlas depends on: assigning its size
 * clears it, and a tile drawn at a slot stays there until something clears or covers it. */
function canvas(){
 const tiles=new Set<string>();let size=0,sized=0;
 const ctx={clearRect(x:number,y:number){tiles.delete(`${x},${y}`);},drawImage(_s:unknown,x:number,y:number){tiles.add(`${x},${y}`);},
  getImageData(_x:number,_y:number,w:number,h:number){const data=new Uint8ClampedArray(w*h*4).fill(255);for(const slot of transparent){const x0=(slot%16)*32,y0=Math.floor(slot/16)*32;for(let y=y0;y<y0+32;y++)for(let x=x0;x<x0+32;x++)data[(y*w+x)*4+3]=0;}return {data};}};
 return {get width(){return size;},set width(v:number){size=v;sized++;tiles.clear();},get height(){return size;},set height(v:number){size=v;},tiles,sized:()=>sized,
  getContext:()=>ctx,toBlob(cb:(b:Blob)=>void){cb(new Blob([new Uint8Array([1])],{type:'image/png'}));}} as unknown as HTMLCanvasElement&{tiles:Set<string>;sized:()=>number};
}
function environment(vault:Vault){
 const win={setTimeout,clearTimeout,createEl:()=>canvas(),createImageBitmap:async(_blob:Blob)=>{vault.activeDecodes++;vault.maxDecodes=Math.max(vault.maxDecodes,vault.activeDecodes);if(vault.gate)await vault.gate;vault.activeDecodes--;return {width:512,height:512,close(){}};}};
 const doc={defaultView:win,createEl:()=>canvas()} as unknown as Document;
 return {app:{vault} as never,doc};
}
const image=(id:string)=>({id,path:`${id}.png`,x:0,y:0,width:1,height:1});
async function settle(){await Promise.resolve();await Promise.resolve();}

describe('OverviewAtlas',()=>{
 beforeEach(()=>{vi.useRealTimers();transparent=new Set();}); afterEach(()=>vi.restoreAllMocks());
 it('keeps page decoding bounded when many pages are requested',async()=>{
  const vault=new Vault();let release!:()=>void;vault.gate=new Promise<void>(r=>{release=r;});
  const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc),images=Array.from({length:20000},(_,i)=>image(`i${i}`));
  for(const im of images)vault.files.set(im.path,new FakeTFile(im.path) as File); atlas.sync(images);
  for(const im of images)atlas.get(im,()=>{});
  await settle(); expect(atlas.stats.decoding).toBe(2); expect(vault.maxDecodes).toBeLessThanOrEqual(2); release(); atlas.dispose();
 });
 it('reuses a valid persisted page without reading originals',async()=>{
  const vault=new Vault(),images=[image('a')];for(const im of images)vault.files.set(im.path,new FakeTFile(im.path) as File);
  const sig={id:'a',path:'a.png',mtime:1,size:1};
  vault.files.set('_Image Graph/Thumbnails/page-0.json',Object.assign(new FakeTFile('_Image Graph/Thumbnails/page-0.json'),{text:JSON.stringify({version:1,items:[sig]})}));
  vault.files.set('_Image Graph/Thumbnails/page-0.png',Object.assign(new FakeTFile('_Image Graph/Thumbnails/page-0.png'),{binary:new ArrayBuffer(1)}));
  const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc);atlas.sync(images);atlas.get(images[0],()=>{});await settle();await new Promise(r=>setTimeout(r,10));
  expect(vault.originalReads).toBe(0);expect(atlas.stats.ready).toBe(1);atlas.dispose();
 });
 it('deduplicates listeners and does not redraw or decode again on cache hits',async()=>{
  const vault=new Vault(),im=image('a');vault.files.set(im.path,new FakeTFile(im.path) as File);const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc);atlas.sync([im]);let calls=0;const ready=()=>{calls++;};atlas.get(im,ready);atlas.get(im,ready);await new Promise(r=>setTimeout(r,130));expect(calls).toBe(1);
  for(let n=0;n<100;n++)expect(atlas.get(im,ready)).not.toBeNull();
  await new Promise(r=>setTimeout(r,130));expect(calls).toBe(1);expect(vault.originalReads).toBe(1);atlas.dispose();
 });
 it('does not invoke queued callbacks after dispose',async()=>{
  const vault=new Vault(),im=image('a');vault.files.set(im.path,new FakeTFile(im.path) as File);const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc);atlas.sync([im]);let calls=0;atlas.get(im,()=>calls++);atlas.dispose();await new Promise(r=>setTimeout(r,130));expect(calls).toBe(0);
 });
 it('preserves a completed tile when catalog positions change',async()=>{
  const vault=new Vault(),a=image('a');vault.files.set(a.path,new FakeTFile(a.path) as File);const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc);atlas.sync([a]);atlas.get(a,()=>{});await new Promise(r=>setTimeout(r,130));const before=atlas.get(a,()=>{});expect(before).not.toBeNull();const reads=vault.originalReads;
  atlas.sync([{...a,x:999,y:333}]);const after=atlas.get(a,()=>{});expect(after?.source).toBe(before?.source);expect(vault.originalReads).toBe(reads);atlas.dispose();
 });
 it('keeps every other slot when one image leaves',async()=>{
  // A slot is an address. Closing the gap renumbered every later image, so every page
  // signature changed and the whole vault was decoded again for one departure.
  const vault=new Vault(),all=['a','b','c','d'].map(image);
  for(const im of all)vault.files.set(im.path,new FakeTFile(im.path) as File);
  const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc);
  atlas.sync(all);for(const im of all)atlas.get(im,()=>{});
  await new Promise(r=>setTimeout(r,160));
  const before=all.map(im=>atlas.get(im,()=>{})),reads=vault.originalReads;
  expect(before.every(crop=>crop!==null)).toBe(true);
  // 'b' goes. Everything else keeps its tile, and nothing is read again.
  const survivors=[all[0],all[2],all[3]];
  atlas.sync(survivors);
  for(const im of survivors)expect(atlas.get(im,()=>{})).toEqual(before[all.indexOf(im)]);
  await new Promise(r=>setTimeout(r,160));
  expect(vault.originalReads).toBe(reads);
  // A new image takes the empty slot rather than the end.
  const e=image('e');vault.files.set(e.path,new FakeTFile(e.path) as File);
  atlas.sync([...survivors,e]);
  atlas.get(e,()=>{});
  await new Promise(r=>setTimeout(r,160));
  expect(atlas.get(e,()=>{})).toMatchObject({x:before[1]!.x,y:before[1]!.y});
  expect(vault.originalReads).toBe(reads+1);
  for(const im of survivors)expect(atlas.get(im,()=>{})).toEqual(before[all.indexOf(im)]);
  atlas.dispose();
 });
 it('copies the existing prefix when an image is appended',async()=>{
  const vault=new Vault(),a=image('a'),b=image('b');for(const im of [a,b])vault.files.set(im.path,new FakeTFile(im.path) as File);const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc);atlas.sync([a]);atlas.get(a,()=>{});await new Promise(r=>setTimeout(r,130));const before=atlas.get(a,()=>{})!,reads=vault.originalReads;
  atlas.sync([a,b]);expect(atlas.get(a,()=>{})?.source).toBe(before.source);atlas.get(b,()=>{});await new Promise(r=>setTimeout(r,130));expect(vault.originalReads).toBe(reads+1);expect(atlas.get(a,()=>{})?.source).toBe(before.source);atlas.dispose();
 });
 it('keeps the tiles it carried over when the page loads again for a newcomer',async()=>{
  // Sizing a canvas clears it. The page that inherits the old canvas must not be sized again,
  // or every carried tile is transparent while still marked ready — and then saved that way.
  const vault=new Vault(),a=image('a'),b=image('b');for(const im of [a,b])vault.files.set(im.path,new FakeTFile(im.path) as File);const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc);
  atlas.sync([a]);atlas.get(a,()=>{});await new Promise(r=>setTimeout(r,130));
  const held=atlas.get(a,()=>{})!.source as ReturnType<typeof canvas>;expect(held.sized()).toBe(1);expect(held.tiles.has('0,0')).toBe(true);
  atlas.sync([a,b]);atlas.get(b,()=>{});await new Promise(r=>setTimeout(r,130));
  expect(atlas.get(b,()=>{})?.source).toBe(held);expect(held.sized()).toBe(1);
  expect(held.tiles.has('0,0')).toBe(true);expect(held.tiles.has('32,0')).toBe(true);atlas.dispose();
 });
 it('decodes a tile a saved page holds transparent, and saves the page again',async()=>{
  const vault=new Vault(),a=image('a'),b=image('b');for(const im of [a,b])vault.files.set(im.path,new FakeTFile(im.path) as File);
  const sig=(id:string)=>({id,path:`${id}.png`,mtime:1,size:1});
  vault.files.set('_Image Graph/Thumbnails/page-0.json',Object.assign(new FakeTFile('_Image Graph/Thumbnails/page-0.json'),{text:JSON.stringify({version:1,items:[sig('a'),sig('b')]})}));
  vault.files.set('_Image Graph/Thumbnails/page-0.png',Object.assign(new FakeTFile('_Image Graph/Thumbnails/page-0.png'),{binary:new ArrayBuffer(1)}));
  transparent=new Set([1]);
  const {app,doc}=environment(vault),atlas=new OverviewAtlas(app,doc);let saves=0;const modify=vault.modifyBinary.bind(vault);vault.modifyBinary=async(f,bin)=>{saves++;await modify(f,bin);};
  atlas.sync([a,b]);atlas.get(a,()=>{});await new Promise(r=>setTimeout(r,130));
  expect(vault.originalReads).toBe(1);expect(atlas.stats.ready).toBe(2);expect(saves).toBe(1);
  const held=atlas.get(b,()=>{})!.source as ReturnType<typeof canvas>;expect(held.tiles.has('32,0')).toBe(true);atlas.dispose();
 });
 it('reuses the expanded page after a fresh atlas instance',async()=>{
  const vault=new Vault(),a=image('a'),b=image('b');for(const im of [a,b])vault.files.set(im.path,new FakeTFile(im.path) as File);const first=environment(vault),atlas=new OverviewAtlas(first.app,first.doc);atlas.sync([a]);atlas.get(a,()=>{});await new Promise(r=>setTimeout(r,130));atlas.sync([a,b]);atlas.get(b,()=>{});await new Promise(r=>setTimeout(r,130));const reads=vault.originalReads;atlas.dispose();
  const second=environment(vault),reloaded=new OverviewAtlas(second.app,second.doc);reloaded.sync([a,b]);reloaded.get(a,()=>{});await new Promise(r=>setTimeout(r,130));expect(vault.originalReads).toBe(reads);expect(reloaded.stats.ready).toBe(2);reloaded.dispose();
 });
});
