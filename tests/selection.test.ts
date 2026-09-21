import {describe, expect, it} from 'vitest';
import {NOTHING, imageSelection, keepImages, prune, selectTarget, selectedImages, type Selection} from '../src/selection';

const image=(imageId:string)=>({endpoint:{imageId}});
const region=(imageId:string,regionId:string)=>({endpoint:{imageId,regionId}});
const edge=(edgeId:string)=>({edgeId});
const shown=(selection:Selection)=>({kind:selection.kind,images:[...selectedImages(selection)].sort(),
 region:selection.kind==='region'?selection.regionId:null,edge:selection.kind==='edge'?selection.id:null});

describe('selection', () => {
 it('rings exactly what it edits', () => {
  expect(shown(selectTarget(NOTHING,image('a')))).toEqual({kind:'images',images:['a'],region:null,edge:null});
  expect(shown(selectTarget(NOTHING,region('a','r1')))).toEqual({kind:'region',images:['a'],region:'r1',edge:null});
  expect(shown(selectTarget(NOTHING,edge('e1')))).toEqual({kind:'edge',images:[],region:null,edge:'e1'});
  expect(shown(selectTarget(imageSelection(['a']),null))).toEqual({kind:'none',images:[],region:null,edge:null});
 });

 it('keeps no image ringed while a connection is edited', () => {
  // Was: shift-clicking a connection left the image selected as well, so the canvas ringed the
  // image, the panel edited the connection, and Delete removed the connection.
  const after=selectTarget(imageSelection(['a']),edge('e1'),true);
  expect(shown(after)).toEqual({kind:'edge',images:[],region:null,edge:'e1'});
 });

 it('never edits a region whose image is deselected', () => {
  // Was: shift-clicking an already-selected image that carries a region dropped the image from
  // the set and set the region, so the Actions menu could find no endpoint for it.
  const after=selectTarget(imageSelection(['a']),region('a','r1'),true);
  expect(shown(after)).toEqual({kind:'none',images:[],region:null,edge:null});
  expect(shown(selectTarget(imageSelection(['b']),region('a','r1'),true))).toEqual({kind:'images',images:['a','b'],region:null,edge:null});
 });

 it('extends and collapses an image selection with shift', () => {
  const two=selectTarget(selectTarget(NOTHING,image('a')),image('b'),true);
  expect(shown(two).images).toEqual(['a','b']);
  expect(shown(selectTarget(two,image('a'),true)).images).toEqual(['b']);
  expect(selectTarget(selectTarget(two,image('a'),true),image('b'),true)).toBe(NOTHING);
  // Shift on empty canvas keeps what is selected; a plain click clears it.
  expect(selectTarget(two,null,true)).toBe(two);
 });

 it('drops only what the vault lost', () => {
  const all={image:()=>true,region:()=>true,edge:()=>true};
  const two=imageSelection(['a','b']);
  expect(prune(two,all)).toBe(two);
  expect(shown(prune(two,{...all,image:id=>id==='b'}))).toEqual({kind:'images',images:['b'],region:null,edge:null});
  expect(prune(two,{...all,image:()=>false})).toBe(NOTHING);
  const one={kind:'region',imageId:'a',regionId:'r1'} as const;
  expect(prune(one,all)).toBe(one);
  expect(prune(one,{...all,region:()=>false})).toBe(NOTHING);
  expect(prune(one,{...all,image:()=>false})).toBe(NOTHING);
  expect(prune({kind:'edge',id:'e1'},{...all,edge:()=>false})).toBe(NOTHING);
 });

 it('keeps the images when exploration ends', () => {
  expect(shown(keepImages({kind:'region',imageId:'a',regionId:'r1'}))).toEqual({kind:'images',images:['a'],region:null,edge:null});
  expect(keepImages({kind:'edge',id:'e1'})).toBe(NOTHING);
 });
});
