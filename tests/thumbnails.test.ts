import {describe,expect,it,vi} from 'vitest';
const{File}=vi.hoisted(()=>({File:class{constructor(public path:string){}}}));
vi.mock('obsidian',()=>({TFile:File}));
import {ThumbnailCache} from '../src/thumbnails';
const image=(id:string)=>({id,path:`${id}.png`,x:0,y:0,width:240,height:240});
function setup(gate?:Promise<void>){
 const read=vi.fn(async()=>new ArrayBuffer(8));
 const decode=vi.fn(async(_blob:Blob,options:{resizeWidth:number})=>{if(options.resizeWidth>256&&gate)await gate;return{close(){}};});
 const doc={defaultView:{createImageBitmap:decode,createEl:()=>({width:0,height:0,getContext:()=>({drawImage(){}})})}} as unknown as Document;
 const app={vault:{getAbstractFileByPath:(path:string)=>new File(path),readBinary:read}} as never;
 return{cache:new ThumbnailCache(app,doc),read,decode};
}
describe('adaptive image detail',()=>{
 it('loads a display-sized texture and reuses it on redraw',async()=>{
  const{cache,read}=setup(),im=image('a'),ready=vi.fn();
  expect(cache.get(im,ready,900)).toBeNull();
  await vi.waitFor(()=>expect(ready).toHaveBeenCalledOnce());
  const texture=cache.get(im,ready,900) as HTMLCanvasElement;
  expect(texture.width).toBe(1024);expect(texture.height).toBe(1024);
  for(let n=0;n<30;n++)expect(cache.get(im,ready,900)).toBe(texture);
  expect(read).toHaveBeenCalledOnce();cache.dispose();
 });
 it('keeps lower detail visible while sharper detail loads',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),{cache}=setup(gate),im=image('a'),ready=vi.fn();
  cache.get(im,ready,100);await vi.waitFor(()=>expect(ready).toHaveBeenCalledOnce());
  const small=cache.get(im,ready,100);expect(cache.get(im,ready,1800)).toBe(small);release();
  await vi.waitFor(()=>expect((cache.get(im,ready,1800) as HTMLCanvasElement).width).toBe(2048));cache.dispose();
 });
 it('bounds memory and concurrent decoding for large images',()=>{
  const{cache}=setup();for(let n=0;n<30;n++)cache.get(image(String(n)),()=>{},2000);
  expect(cache.stats.bytes).toBeLessThanOrEqual(96*1024*1024);expect(cache.stats.decoding).toBeLessThanOrEqual(2);cache.dispose();
 });
});
