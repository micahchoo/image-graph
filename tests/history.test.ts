import {describe, expect, it} from 'vitest';
import {History, type Step} from '../src/history';

const image = (id: string, x: number) => ({id, path: `${id}.png`, x, y: 0, width: 240, height: 240});
const step = (label: string, id: string, from: number, to: number): Step =>
 ({label, entries: [{kind: 'images', id, before: image(id, from), after: image(id, to)}]});

describe('what the owner did, and how to put it back', () => {
 it('reads one step in either direction', () => {
  const history = new History();
  history.push(step('move an image', 'a', 0, 40));
  const undone = history.undo()!;
  expect(history.plan(undone, 'undo')[0].record).toMatchObject({x: 0});
  expect(history.plan(undone, 'redo')[0].record).toMatchObject({x: 40});
  expect(history.undo()).toBeNull();
 });

 it('undoes a deletion by writing the record back, and redoes it by taking it away', () => {
  const history = new History();
  history.push({label: 'delete a region', entries: [{kind: 'regions', id: 'r', before: {id: 'r'} as never}]});
  const undone = history.undo()!;
  expect(history.plan(undone, 'undo')[0].record).toBeDefined();
  expect(history.plan(undone, 'redo')[0].record).toBeUndefined();
 });

 it('walks a cascade back in the order it happened', () => {
  // A region and its connection went together; the region must come back first.
  const cascade: Step = {label: 'delete a region', entries: [
   {kind: 'edges', id: 'e', before: {id: 'e'} as never},
   {kind: 'regions', id: 'r', before: {id: 'r'} as never},
  ]};
  const history = new History();
  history.push(cascade);
  expect(history.plan(history.undo()!, 'undo').map(item => item.id)).toEqual(['r', 'e']);
 });

 it('forgets the redo branch when something new happens', () => {
  const history = new History();
  history.push(step('one', 'a', 0, 40));
  history.undo();
  expect(history.labels.redo).toBe('one');
  history.push(step('two', 'b', 0, 40));
  expect(history.labels).toEqual({undo: 'two', redo: null});
 });

 it('keeps a step with nothing in it out of the history, and stays bounded', () => {
  const history = new History(3);
  history.push({label: 'nothing happened', entries: []});
  expect(history.labels.undo).toBeNull();
  for (const name of ['one', 'two', 'three', 'four']) history.push(step(name, 'a', 0, 40));
  expect(history.labels.undo).toBe('four');
  for (let n = 0; n < 3; n++) history.undo();
  expect(history.undo()).toBeNull();
 });

 it('names what it will undo, so a menu can say it', () => {
  const history = new History();
  expect(history.labels).toEqual({undo: null, redo: null});
  history.push(step('make a connection', 'a', 0, 40));
  expect(history.labels.undo).toBe('make a connection');
  history.clear();
  expect(history.labels).toEqual({undo: null, redo: null});
 });
});
