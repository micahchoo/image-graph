import type {Properties} from './types';

type ValueType = 'text'|'number'|'boolean'|'list'|'object'|'null';
type JsonValue = null | string | number | boolean | JsonValue[] | {[key:string]: JsonValue};
type Entry = {key:string; value:JsonValue};

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function inferPropertyType(value: unknown): ValueType {
 if (value === null) return 'null';
 if (Array.isArray(value)) return 'list';
 if (typeof value === 'object') return 'object';
 if (typeof value === 'number') return 'number';
 if (typeof value === 'boolean') return 'boolean';
 return 'text';
}

/** Validate keys before writing metadata. Reserved keys apply only to this (top-level) object. */
export function validateProperties(properties: Properties, reservedKeys: string[] = []): void {
 const reserved = new Set(reservedKeys);
 const check = (value: unknown, top: boolean): void => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(child => check(child, false)); return; }
  for (const [key, child] of Object.entries(value)) {
   if (!key.trim()) throw new Error('Enter a property name.');
   if (BAD_KEYS.has(key)) throw new Error(`Use a different property name than “${key}”.`);
   if (top && reserved.has(key)) throw new Error(`Choose a different property name than “${key}”; it is reserved.`);
   check(child, false);
  }
 };
 check(properties, true);
}

function makeElement(parent: HTMLElement, tag: string, className?: string): HTMLElement {
 const element = (parent as HTMLElement & {createEl: (tag:string) => HTMLElement}).createEl(tag);
 if (className) element.addClass?.(className) ?? element.classList.add(className);
 return element;
}
function button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
 const b = makeElement(parent, 'button') as HTMLButtonElement;
 b.type = 'button'; b.textContent = label; b.addEventListener('click', onClick); return b;
}
function fieldLabel(parent: HTMLElement, text: string, control: HTMLElement): HTMLLabelElement {
 const wrapper = makeElement(parent, 'label', 'image-graph-property-field') as HTMLLabelElement;
 const caption = makeElement(wrapper, 'span'); caption.textContent = text;
 wrapper.appendChild(control);
 return wrapper;
}
const FORMAT_LABELS: Record<ValueType, string> = {text: 'Text', number: 'Number', boolean: 'Yes / no', list: 'List', object: 'Group of properties', null: 'Empty'};
class ValueEditor {
 readonly root: HTMLElement;
 private type: ValueType;
 private control?: HTMLInputElement | HTMLSelectElement;
 private children: ValueEditor[] = [];
 private entries: Entry[] = [];
 private onChange: () => void;
  constructor(parent: HTMLElement, value: JsonValue, onChange: () => void) {
  this.onChange = onChange; this.type = inferPropertyType(value); this.root = makeElement(parent, 'div', 'image-graph-property-value'); this.render(value);
 }
 private render(value: JsonValue): void {
  this.root.empty?.(); this.root.replaceChildren(); this.children = []; this.entries = [];
  const select = makeElement(this.root, 'select') as HTMLSelectElement; this.control = select;
  for (const t of ['text','number','boolean','list','object','null'] as ValueType[]) { const option = makeElement(select, 'option') as HTMLOptionElement; option.value = t; option.textContent = FORMAT_LABELS[t]; if (t === this.type) option.selected = true; }
  select.setAttribute('aria-label', 'Format'); fieldLabel(this.root, 'Format', select);
  select.addEventListener('change', () => { let previous: JsonValue; try { previous = this.getValue(); } catch { previous = this.type === 'object' ? {} : this.type === 'list' ? [] : this.type === 'boolean' ? false : this.type === 'null' ? null : ''; } this.type = select.value as ValueType; let next: JsonValue = ''; if (this.type === 'object') next = typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? previous : {}; else if (this.type === 'list') next = Array.isArray(previous) ? previous : []; else if (this.type === 'null') next = null; else if (this.type === 'boolean') next = typeof previous === 'boolean' ? previous : false; else if (this.type === 'number') next = typeof previous === 'number' ? previous : ''; else next = typeof previous === 'string' || typeof previous === 'number' ? String(previous) : ''; this.render(next); this.onChange(); });
  if (this.type === 'object') this.renderObject((value && typeof value === 'object' && !Array.isArray(value)) ? value : {});
  else if (this.type === 'list') this.renderList(Array.isArray(value) ? value : []);
  else if (this.type === 'null') { const note = makeElement(this.root, 'span', 'image-graph-property-content-label'); note.textContent = 'Content: Empty'; }
  else { const input = makeElement(this.root, 'input') as HTMLInputElement; this.control = input; input.setAttribute('aria-label', this.type === 'boolean' ? 'Yes' : 'Content'); input.type = this.type === 'boolean' ? 'checkbox' : this.type === 'number' ? 'number' : 'text'; if (this.type === 'boolean') { input.checked = value === true; const field = fieldLabel(this.root, 'Yes', input); const hint = makeElement(field, 'span'); hint.textContent = 'Unchecked means no'; } else { input.value = typeof value === 'string' || typeof value === 'number' ? String(value) : ''; fieldLabel(this.root, 'Content', input); } }
 }
 private renderObject(value: {[key:string]:JsonValue}): void {
  const caption = makeElement(this.root, 'span', 'image-graph-property-content-label'); caption.textContent = 'Content';
  const list = makeElement(this.root, 'div', 'image-graph-property-children');
  for (const [key, child] of Object.entries(value)) this.addEntry(list, key, child);
  button(this.root, 'Add property', () => { this.addEntry(list, '', '', true); this.onChange(); });
 }
 private addEntry(list: HTMLElement, key: string, value: JsonValue, focus = false): void {
  const row = makeElement(list, 'div', 'image-graph-property-row'); const keyInput = makeElement(row, 'input') as HTMLInputElement; keyInput.type = 'text'; keyInput.value = key; keyInput.placeholder = 'Example: Creator'; keyInput.setAttribute('aria-label', 'Property name'); fieldLabel(row, 'Property name', keyInput);
  const editor = new ValueEditor(row, value, this.onChange); this.children.push(editor); this.entries.push({key: '', value});
  if (focus) keyInput.focus();
  const entry = this.entries[this.entries.length - 1]; Object.defineProperty(entry, 'key', {get: () => keyInput.value});
  button(row, 'Remove property', () => { row.remove(); const index = this.entries.indexOf(entry); if (index >= 0) { this.children.splice(index, 1); this.entries.splice(index, 1); } this.onChange(); });
 }
 private renderList(value: JsonValue[]): void {
  const caption = makeElement(this.root, 'span', 'image-graph-property-content-label'); caption.textContent = 'Content';
  const list = makeElement(this.root, 'div', 'image-graph-property-list');
  value.forEach(child => this.addItem(list, child)); button(this.root, 'Add item', () => { this.addItem(list, '', true); this.onChange(); });
 }
 private addItem(list: HTMLElement, value: JsonValue, focus = false): void { const row = makeElement(list, 'div', 'image-graph-property-list-item'); const editor = new ValueEditor(row, value, this.onChange); this.children.push(editor); if (focus) { const focusable = row.querySelector('input[aria-label="Content"], input[aria-label="Yes"]'); if (focusable instanceof HTMLElement) focusable.focus(); } button(row, 'Remove item', () => { row.remove(); this.children = this.children.filter(x => x !== editor); this.onChange(); }); }
 getValue(): JsonValue {
  if (this.type === 'object') { const result: {[key:string]:JsonValue} = {}; this.entries.forEach((entry, i) => { const key = entry.key.trim(); if (!key) throw new Error('Enter a property name.'); if (BAD_KEYS.has(key)) throw new Error(`Use a different property name than “${key}”.`); if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`Use a unique property name; “${key}” appears more than once.`); result[key] = this.children[i].getValue(); }); return result; }
  if (this.type === 'list') return this.children.map(child => child.getValue());
  if (this.type === 'null') return null;
  const input = this.root.querySelector('input[aria-label="Content"], input[aria-label="Yes"]') as HTMLInputElement;
  if (this.type === 'boolean') return input.checked;
  if (this.type === 'number') { if (!input.value.trim()) throw new Error('Enter a number for Content.'); const n = Number(input.value); if (!Number.isFinite(n)) throw new Error('Enter a finite number for Content.'); return n; }
  return input.value;
 }
 dispose(): void { this.root.replaceChildren(); this.children = []; this.entries = []; }
}

export function renderPropertyBuilder(container: HTMLElement, properties: Properties, options: {reservedKeys?: string[]; onChange?: (properties: Properties) => void} = {}): {getValue: () => Properties; dispose: () => void} {
 validateProperties(properties, options.reservedKeys);
 const root = makeElement(container, 'div', 'image-graph-property-builder');
 const intro = makeElement(root, 'p', 'image-graph-property-help'); intro.textContent = 'Add details about your selection. For example, use creator as the property name and a person’s name as its content.';
 const entries = makeElement(root, 'div', 'image-graph-property-entries');
 const editors: ValueEditor[] = [];
 // Invalid intermediate rows are allowed while editing; getValue remains the explicit validation boundary.
 const notify = () => { try { options.onChange?.(api.getValue()); } catch { /* wait for the user to finish the row */ } };
 const add = (key: string, value: JsonValue, focus = false) => { const row = makeElement(entries, 'div', 'image-graph-property-row'); const keyInput = makeElement(row, 'input') as HTMLInputElement; keyInput.value = key; keyInput.placeholder = 'Example: Creator'; keyInput.setAttribute('aria-label', 'Property name'); fieldLabel(row, 'Property name', keyInput); const editor = new ValueEditor(row, value, notify); editors.push(editor); if (focus) keyInput.focus(); button(row, 'Remove property', () => { row.remove(); editors.splice(editors.indexOf(editor), 1); notify(); }); };
 Object.entries(properties).forEach(([key, value]) => add(key, value as JsonValue)); button(root, 'Add property', () => { add('', '', true); notify(); });
 const api = {getValue: () => { const result: Properties = {}; const rows = [...entries.children] as HTMLElement[]; rows.forEach((row, i) => { const key = (row.querySelector('input[aria-label="Property name"]') as HTMLInputElement).value.trim(); if (!key) throw new Error('Enter a property name.'); if (BAD_KEYS.has(key)) throw new Error(`Use a different property name than “${key}”.`); if (options.reservedKeys?.includes(key)) throw new Error(`Choose a different property name than “${key}”; it is reserved.`); if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`Use a unique property name; “${key}” appears more than once.`); result[key] = editors[i].getValue(); }); return result; }, dispose: () => { editors.forEach(editor => editor.dispose()); root.remove(); } };
 return api;
}
