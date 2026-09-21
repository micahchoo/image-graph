import {describe, expect, it} from 'vitest';
import {connectionStyle, imageCaptions, shortenLabel, type ConnectionFocus} from '../src/presentation';
import type {EdgeRecord, ImageRecord, RegionRecord} from '../src/types';

const edge:EdgeRecord={id:'ab',source:{imageId:'a'},target:{imageId:'b'},direction:'both',properties:{relation:'resembles'}};
const focus:ConnectionFocus={selected:new Set(['root']),selectedEdge:null,hoveredImage:null,hoveredEdge:null,path:new Set(),filter:'',exploring:true};
describe('graph presentation',()=>{
 it('keeps background links quiet and reveals adjacent links on selection or hover',()=>{
  expect(connectionStyle(edge,'resembles',focus)).toMatchObject({label:false,alpha:.14});
  expect(connectionStyle(edge,'resembles',{...focus,selected:new Set(['a'])}).label).toBe(true);
  expect(connectionStyle(edge,'resembles',{...focus,hoveredImage:'b'}).label).toBe(true);
 });
 it('preserves a highlighted path even through nonmatching relations',()=>{
  expect(connectionStyle(edge,'resembles',{...focus,filter:'other',path:new Set(['ab'])})).toMatchObject({label:true,alpha:1,emphasized:true});
  expect(connectionStyle(edge,'resembles',{...focus,filter:'other',selected:new Set(['a'])})).toMatchObject({label:false,alpha:.09});
  expect(connectionStyle(edge,'resembles',{...focus,filter:'resembles'}).label).toBe(true);
 });
 it('names extracted images from their source region without changing paths',()=>{
  const images:ImageRecord[]=[{id:'a',path:'Photos/landscape.png',x:0,y:0,width:240,height:240},{id:'b',path:'_Image Graph/Extracted/region-abcdef.png',x:0,y:0,width:240,height:240}];
  const regions:RegionRecord[]=[{id:'r',imageId:'a',label:'Mountain',shape:{type:'rect',x:0,y:0,width:1,height:1},properties:{}}];
  const derived:EdgeRecord={...edge,source:{imageId:'b'},target:{imageId:'a',regionId:'r'},properties:{relation:'derived from'}};
  expect(imageCaptions(images,regions,[derived]).get('b')).toBe('Mountain · landscape');
  expect(images[1].path).toBe('_Image Graph/Extracted/region-abcdef.png');
 });
 it('fits captions without overflowing and retains short names',()=>{
  const measure=(text:string)=>text.length*8;
  expect(shortenLabel('short',100,measure)).toBe('short');
  expect(measure(shortenLabel('a very long crop name',64,measure))).toBeLessThanOrEqual(64);
  expect(shortenLabel('long',2,measure)).toBe('');
 });
});
