import {describe, expect, it, vi} from 'vitest';
import {Jobs} from '../src/jobs';

describe('long work a person can see and stop', () => {
 it('reports the job with the most left to do', () => {
  const jobs = new Jobs(() => {});
  const small = jobs.start('sizes', 10), big = jobs.start('thumbnails', 1000);
  small.step(1); big.step(10);
  expect(jobs.current).toMatchObject({name: 'thumbnails', done: 10, total: 1000});
  big.finish();
  expect(jobs.current).toMatchObject({name: 'sizes'});
  small.finish();
  expect(jobs.current).toBeNull();
  expect(jobs.busy).toBe(false);
 });

 it('tells the view once per percent, not once per file', () => {
  const changed = vi.fn();
  const jobs = new Jobs(changed);
  const job = jobs.start('sizes', 1000);
  changed.mockClear();
  for (let done = 1; done <= 1000; done++) job.step(done);
  // Nought through a hundred: one report per percent the chip can actually show.
  expect(changed).toHaveBeenCalledTimes(101);
 });

 it('stops every job it can, and stays stopped', () => {
  const jobs = new Jobs(() => {});
  const stoppable = jobs.start('sizes', 10), sealed = jobs.start('export', 10, false);
  jobs.stop();
  expect(stoppable.signal.aborted).toBe(true);
  expect(sealed.signal.aborted).toBe(false);
  expect(jobs.stopped).toBe(true);
  // Anything started while stopped is born aborted, so the next catalog change cannot
  // quietly begin the whole pass again.
  expect(jobs.start('sizes', 10).signal.aborted).toBe(true);
  jobs.resume();
  expect(jobs.start('sizes', 10).signal.aborted).toBe(false);
 });

 it('counts nothing as no job at all', () => {
  const jobs = new Jobs(() => {});
  expect(jobs.current).toBeNull();
  const job = jobs.start('sizes', 0);
  expect(jobs.current).toMatchObject({done: 0, total: 0});
  job.step(0);
  job.finish();
  expect(jobs.busy).toBe(false);
 });
});
