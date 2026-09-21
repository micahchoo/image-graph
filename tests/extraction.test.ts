import {describe,expect,it} from 'vitest';
import {MAX_EXTRACT_SIDE, extractionPath, findExtractionPosition, regionCrop} from '../src/extraction';
import type {ImageRecord, RegionShape} from '../src/types';

const image=(id:string,x:number,y:number,width=240,height=240):ImageRecord=>({id,path:`${id}.png`,x,y,width,height});
const overlap=(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number})=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;

describe('findExtractionPosition',()=>{
 it('avoids the parent itself and snaps a mixed-aspect crop to the 40px grid',()=>{
  const parent=image('parent',0,0),result=findExtractionPosition([parent],parent,180,420);
  expect(result.x%40).toBe(0);expect(result.y%40).toBe(0);expect(overlap({...result,width:180,height:420},parent)).toBe(false);
 });
 it('avoids dense twenty-thousand-image layouts without mutating source records',()=>{
  const parent=image('parent',0,0),images=[parent];
  for(let y=-100;y<100;y++)for(let x=-100;x<100;x++)images.push(image(`i-${x}-${y}`,x*280,y*280));
  const before=JSON.stringify(images),result=findExtractionPosition(images,parent,240,240);
  expect(JSON.stringify(images)).toBe(before);expect(Math.abs(result.x%40)).toBe(0);expect(Math.abs(result.y%40)).toBe(0);expect(images.some(other=>overlap({...result,width:240,height:240},other))).toBe(false);
 });
 it('supports excluding an existing extracted image while retaining all other collisions',()=>{
  const parent=image('parent',0,0),existing=image('crop',280,0),other=image('other',560,0),result=findExtractionPosition([parent,existing,other],parent,240,240,'crop');
  expect(overlap({...result,width:240,height:240},parent)).toBe(false);expect(overlap({...result,width:240,height:240},other)).toBe(false);
 });
});

const rect=(x:number,y:number,width:number,height:number):RegionShape=>({type:'rect',x,y,width,height});

describe('regionCrop',()=>{
 it('reads the fraction of the original the rectangle names',()=>{
  expect(regionCrop(rect(.25,.5,.5,.25),400,200)).toMatchObject({sourceX:100,sourceY:100,sourceWidth:200,sourceHeight:50,width:200,height:50,scale:1});
 });
 it('bounds a polygon by the box around its corners',()=>{
  // Fractions of the image, so the pixel widths are floats; drawImage takes them as they are.
  const shape:RegionShape={type:'polygon',points:[{x:.2,y:.1},{x:.6,y:.3},{x:.4,y:.5}]};
  const crop=regionCrop(shape,1000,1000);
  expect(crop.sourceX).toBeCloseTo(200,6);expect(crop.sourceY).toBeCloseTo(100,6);
  expect(crop.sourceWidth).toBeCloseTo(400,6);expect(crop.sourceHeight).toBeCloseTo(400,6);
  expect(crop.width).toBe(400);expect(crop.height).toBe(400);
 });
 it('refuses a region with no area rather than writing a 1x1 picture',()=>{
  expect(()=>regionCrop(rect(.5,.5,0,.5),800,800)).toThrow('no area');
  expect(()=>regionCrop(rect(.5,.5,.5,0),800,800)).toThrow('no area');
  expect(()=>regionCrop({type:'polygon',points:[{x:.3,y:0},{x:.3,y:.4},{x:.3,y:.8}]},800,800)).toThrow('no area');
 });
 it('holds the crop inside the picture when a shape reaches past its edge',()=>{
  const shape:RegionShape={type:'polygon',points:[{x:-2,y:-2},{x:3,y:-2},{x:3,y:3}]};
  const crop=regionCrop(shape,600,400);
  expect(crop).toMatchObject({sourceX:0,sourceY:0,sourceWidth:600,sourceHeight:400});
 });
 it('caps the longer side and keeps the proportions',()=>{
  const crop=regionCrop(rect(0,0,1,1),20000,10000);
  expect(Math.max(crop.width,crop.height)).toBe(MAX_EXTRACT_SIDE);
  expect(crop.width/crop.height).toBeCloseTo(2,5);
  expect(crop.sourceWidth).toBe(20000);
 });
 it('never enlarges a small region',()=>{
  expect(regionCrop(rect(0,0,.01,.01),1000,1000)).toMatchObject({scale:1,width:10,height:10});
 });
 it('keeps at least one pixel of a region thinner than one',()=>{
  const crop=regionCrop(rect(0,0,1,.00002),100000,10);
  expect(crop.width).toBeGreaterThanOrEqual(1);
  expect(crop.height).toBeGreaterThanOrEqual(1);
 });
 it('names an extracted picture after its region and source, and steps past a taken name',()=>{
  const taken=new Set(['_Image Graph/Extracted/Dark water · Harbour at dusk.png']);
  expect(extractionPath('Dark water','Photos/Harbour at dusk.png',p=>taken.has(p))).toBe('_Image Graph/Extracted/Dark water · Harbour at dusk 2.png');
  expect(extractionPath('  ','Photos/Harbour at dusk.png',()=>false)).toBe('_Image Graph/Extracted/Region · Harbour at dusk.png');
  expect(extractionPath('a/b|c','x.jpg',()=>false)).toBe('_Image Graph/Extracted/a-b-c · x.png');
 });

});
