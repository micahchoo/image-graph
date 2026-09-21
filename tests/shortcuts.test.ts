import {describe, expect, it} from 'vitest';
import {NUDGE, STRIDE, commandFor, swallows} from '../src/shortcuts';

const press=(key:string,held:Partial<KeyboardEvent>={})=>commandFor({key,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,...held} as KeyboardEvent);

describe('canvas shortcuts', () => {
 it('leaves every Obsidian chord alone', () => {
  for (const held of [{ctrlKey:true},{metaKey:true},{altKey:true}]) expect(press('r',held)).toBeNull();
  expect(press('z')).toBeNull();
  // The one chord the canvas answers, because the canvas is the editor here.
  expect(press('z',{ctrlKey:true})).toEqual({kind:'undo'});
  expect(press('Z',{metaKey:true,shiftKey:true})).toEqual({kind:'redo'});
  expect(press('z',{ctrlKey:true,altKey:true})).toBeNull();
  expect(press('4',{shiftKey:true})).toBeNull();
 });

 it('reads a tool, a mode and a menu', () => {
  expect(press('R')).toEqual({kind:'mode',mode:'rect'});
  expect(press('g')).toEqual({kind:'mode',mode:'polygon'});
  expect(press('Escape')).toEqual({kind:'cancel'});
  expect(press('v')).toEqual({kind:'cancel'});
  expect(press('Backspace')).toEqual({kind:'delete'});
  expect(press('F10',{shiftKey:true})).toEqual({kind:'menu'});
  expect(press('ContextMenu')).toEqual({kind:'menu'});
 });

 it('separates going home from the three zoom presets', () => {
  expect(press('0')).toEqual({kind:'home'});
  expect(press('0',{shiftKey:true})).toEqual({kind:'zoom',to:'reset'});
  expect(press('1',{shiftKey:true})).toEqual({kind:'zoom',to:'all'});
  expect(press('2',{shiftKey:true})).toEqual({kind:'zoom',to:'selection'});
 });

 it('nudges one step, or five with shift, and says which the arrow was', () => {
  expect(press('ArrowLeft')).toEqual({kind:'nudge',dx:-NUDGE,dy:0,far:false});
  expect(press('ArrowDown')).toEqual({kind:'nudge',dx:0,dy:NUDGE,far:false});
  expect(press('ArrowRight',{shiftKey:true})).toEqual({kind:'nudge',dx:STRIDE,dy:0,far:true});
  expect(STRIDE/NUDGE).toBe(5);
 });

 it('opens the panel from either way a keyboard sends a question mark', () => {
  expect(press('?')).toEqual({kind:'help'});
  expect(press('?',{shiftKey:true})).toEqual({kind:'help'});
  expect(press('/',{shiftKey:true})).toEqual({kind:'help'});
 });

 it('swallows only what Obsidian would otherwise act on', () => {
  expect(swallows({kind:'delete'})).toBe(true);
  expect(swallows({kind:'nudge',dx:0,dy:NUDGE,far:false})).toBe(true);
  expect(swallows({kind:'mode',mode:'rect'})).toBe(false);
  expect(swallows({kind:'cancel'})).toBe(false);
 });
});
