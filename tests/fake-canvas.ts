/**
 * A 2D context that remembers what it was asked to draw. There is no canvas in the test
 * runner, so a renderer is judged on the calls it makes: which colour was set before which
 * rectangle, whether a dash was set before a stroke, how many corners a line turned.
 *
 * Every method call is one entry, `name(arg, arg)`, with numbers rounded so a test can read
 * them; every property set is `name=value`. `measureText` answers 6px per character, so a
 * label's width is predictable.
 */
export interface Recorded {ctx: CanvasRenderingContext2D; calls: string[]; font(): string}
export function recordingContext(): Recorded {
 const calls: string[] = [];
 const state: Record<string, unknown> = {font: '10px sans-serif'};
 const show = (value: unknown): string => typeof value === 'number' ? String(Math.round(value * 100) / 100) : Array.isArray(value) ? `[${value.map(show).join(',')}]` : typeof value === 'string' ? JSON.stringify(value) : typeof value === 'object' && value ? '{}' : String(value);
 const ctx = new Proxy({} as Record<string, unknown>, {
  get(_, name: string) {
   if (name === 'measureText') return (text: string) => ({width: text.length * 6});
   if (name in state) return state[name];
   return (...args: unknown[]) => { calls.push(`${name}(${args.map(show).join(',')})`); };
  },
  set(_, name: string, value: unknown) {
   // A canvas silently refuses a font it cannot parse and keeps the one it had. `var()` is
   // one it cannot parse: there is no element to resolve it against.
   if (name === 'font' && typeof value === 'string' && /var\(/.test(value)) { calls.push(`font=REJECTED ${value}`); return true; }
   state[name] = value; calls.push(`${name}=${show(value)}`); return true;
  },
 }) as unknown as CanvasRenderingContext2D;
 return {ctx, calls, font: () => state.font as string};
}
