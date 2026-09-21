import type {EdgeRecord, ImageRecord, RegionRecord} from './types';

export type RecordKind = 'images' | 'regions' | 'edges';
export type StoredRecord = ImageRecord | RegionRecord | EdgeRecord;
/** One record as it was and as it became. Absent on either side means it did not exist then. */
export interface Entry {kind: RecordKind; id: string; before?: StoredRecord; after?: StoredRecord}
export interface Step {label: string; entries: Entry[]}

/**
 * What the owner did, and how to put it back.
 *
 * A step is data, not a pair of closures: it names the records it touched and holds a copy of
 * each on both sides. Undo and redo are then the same loop read in opposite directions, and a
 * step can be inspected — which is how the menu can say *what* it will undo.
 *
 * Bounded, and a fresh step forgets the redo branch, as every editor does.
 */
export class History {
 private past: Step[] = [];
 private future: Step[] = [];
 constructor(private readonly limit = 50) {}
 push(step: Step): void {
  if (!step.entries.length) return;
  this.past.push(step); this.future = [];
  while (this.past.length > this.limit) this.past.shift();
 }
 undo(): Step | null { const step = this.past.pop(); if (!step) return null; this.future.push(step); return step; }
 redo(): Step | null { const step = this.future.pop(); if (!step) return null; this.past.push(step); return step; }
 /** The records to write, in the order to write them, to travel one step. */
 plan(step: Step, direction: 'undo' | 'redo'): Array<{kind: RecordKind; id: string; record?: StoredRecord}> {
  const entries = direction === 'undo' ? [...step.entries].reverse() : step.entries;
  return entries.map(entry => ({kind: entry.kind, id: entry.id, record: direction === 'undo' ? entry.before : entry.after}));
 }
 get labels(): {undo: string | null; redo: string | null} {
  return {undo: this.past.at(-1)?.label ?? null, redo: this.future.at(-1)?.label ?? null};
 }
 clear(): void { this.past = []; this.future = []; }
}
