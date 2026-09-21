import {describe,expect,it} from 'vitest';
import {findExtractionPosition} from '../src/extraction';
import type {ImageRecord} from '../src/types';

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
