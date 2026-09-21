/** How many image decodes may run at once, per cache. Three caches each held this literal. */
export const DECODE_SLOTS = 2;
/** Bytes one bitmap cache may hold. Two caches take one each, so the plugin's ceiling is twice this plus the renderer's detail budget. */
export const CACHE_BUDGET_BYTES = 96 * 1024 * 1024;

export interface JobState {
 /** What to call it in one short phrase, in the person's words. */
 name: string;
 done: number;
 total: number;
 /** False while a job is finishing work it cannot abandon safely. */
 stoppable: boolean;
}

export interface JobHandle {
 readonly signal: AbortSignal;
 step(done: number, total?: number): void;
 finish(): void;
}

/**
 * The one place that knows what long work is running.
 *
 * Reading twenty thousand image headers and building twenty thousand thumbnails are the two
 * passes that make a first session slow, and neither could be seen except as a number wedged
 * into the status line, or stopped at all. A registry gives both a single chip to report to
 * and a single command to stop, and it gives the view one thing to read rather than one
 * method per cache.
 *
 * Stopping is honest only because both passes cache per item: each stops where it is and
 * resumes with nothing lost. A job that cannot be abandoned safely says `stoppable: false`.
 */
export class Jobs {
 private jobs = new Map<number, JobState & {controller: AbortController}>();
 private nextId = 1;
 private paused = false;
 constructor(private readonly changed: () => void) {}

 start(name: string, total: number, stoppable = true): JobHandle {
  const id = this.nextId++;
  const controller = new AbortController();
  const job = {name, done: 0, total, stoppable, controller};
  this.jobs.set(id, job);
  if (this.paused) controller.abort();
  this.changed();
  let reported = -1;
  return {
   signal: controller.signal,
   step: (done, count) => {
    job.done = done; if (count !== undefined) job.total = count;
    // One report per percent: the chip cannot show more and every report costs a frame.
    const percent = job.total ? Math.floor(done / job.total * 100) : 0;
    if (percent !== reported) { reported = percent; this.changed(); }
   },
   finish: () => { if (this.jobs.delete(id)) this.changed(); },
  };
 }

 /** The job worth showing: the one with the most left to do. */
 get current(): JobState | null {
  let best: JobState | null = null, most = -1;
  for (const job of this.jobs.values()) {
   const left = Math.max(0, job.total - job.done);
   if (left > most) { most = left; best = {name: job.name, done: job.done, total: job.total, stoppable: job.stoppable}; }
  }
  return best;
 }
 get busy(): boolean { return this.jobs.size > 0; }
 get stopped(): boolean { return this.paused; }

 /** Stop everything and stay stopped, so the next catalog change does not start it again. */
 stop(): void {
  this.paused = true;
  for (const job of this.jobs.values()) if (job.stoppable) job.controller.abort();
  this.changed();
 }
 resume(): void { if (!this.paused) return; this.paused = false; this.changed(); }
 dispose(): void { for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); }
}
