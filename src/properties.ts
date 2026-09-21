import type {Properties, PropertyValue} from './types';

/** The property a companion note carries its connections in. `links.ts` writes the value. */
export const LINKS_KEY = 'connections';
/** Keys the plugin writes into a companion note itself. An owner's property cannot use them. */
/** The property a companion note carries Image Annotation's attachments in. `links.ts` writes the value. */
export const ANNOTATIONS_KEY = 'annotations';
export const RESERVED_KEYS = ['image', 'image_graph_id', LINKS_KEY, ANNOTATIONS_KEY] as const;
/** Keys that would reach Object.prototype through a plain assignment. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Where a value sits inside a property, as a path a person can read: `sources / 2 / url`. */
export type PropertyPath = Array<string | number>;
export class PropertyError extends Error {
 constructor(message: string, readonly path: PropertyPath = []) {super(message);}
 /** `relation` for a top-level key, `sources / 2` for an item inside one. */
 get where(): string {return this.path.map(step => typeof step === 'number' ? String(step + 1) : step).join(' / ');}
 /** The message a person should read, with the location when there is one. */
 get detail(): string {return this.path.length ? `${this.message} (in ${this.where})` : this.message;}
}

/**
 * A value with named fields. Two strengths, and the difference matters: `isRecord` admits any
 * object that is not an array, which is what parsing untrusted JSON wants; `isPlainObject` also
 * refuses anything with a prototype, which is what deciding a property may be STORED wants —
 * a Date is an object and is not a property value.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
 !!value && typeof value === 'object' && !Array.isArray(value);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
 isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;

export function checkKey(key: string, path: PropertyPath = [], reserved: readonly string[] = []): void {
 if (!key.trim()) throw new PropertyError('Enter a property name.', path);
 if (UNSAFE_KEYS.has(key)) throw new PropertyError(`Use a different property name than “${key}”.`, path);
 if (reserved.includes(key)) throw new PropertyError(`Choose a different property name than “${key}”; it is reserved for the plugin.`, path);
}

/**
 * Narrow one value to what a companion note can hold, naming what is wrong and where.
 *
 * This is the single definition of the value set. Storage validated a JSON copy of a record,
 * so a Date arrived as a string and an undefined arrived as a missing key: both changed
 * silently before anything could object. Parse the value the owner actually submitted.
 */
export function parsePropertyValue(value: unknown, path: PropertyPath = []): PropertyValue {
 if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
 if (typeof value === 'number') {
  if (!Number.isFinite(value)) throw new PropertyError('Enter a finite number.', path);
  return value;
 }
 if (Array.isArray(value)) return value.map((item, index) => parsePropertyValue(item, [...path, index]));
 if (isPlainObject(value)) {
  const result: Record<string, PropertyValue> = {};
  for (const [key, child] of Object.entries(value)) {
   checkKey(key, [...path, key]);
   result[key] = parsePropertyValue(child, [...path, key]);
  }
  return result;
 }
 if (value === undefined) throw new PropertyError('Give this property a value, or remove it.', path);
 if (value instanceof Date) throw new PropertyError('Enter the date as text, for example 2026-09-20.', path);
 throw new PropertyError(`A property cannot hold a ${typeof value}.`, path);
}

/** Narrow a whole mapping, rejecting reserved and repeated names. */
export function parseProperties(value: unknown, reserved: readonly string[] = []): Properties {
 if (!isPlainObject(value)) throw new PropertyError('Properties must be a mapping of names to values.');
 const result: Properties = {};
 for (const [key, child] of Object.entries(value)) {
  checkKey(key, [key], reserved);
  if (Object.prototype.hasOwnProperty.call(result, key)) throw new PropertyError(`Use a unique property name; “${key}” appears more than once.`, [key]);
  result[key] = parsePropertyValue(child, [key]);
 }
 return result;
}

/** The message to show a person, for any error a save can raise. */
export function propertyMessage(error: unknown): string {
 if (error instanceof PropertyError) return error.detail;
 return error instanceof Error ? error.message : String(error);
}
