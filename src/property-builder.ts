import type {Properties, PropertyValue} from './types';
import {PropertyError, checkKey, parseProperties, parsePropertyValue, propertyMessage} from './properties';

type ValueType = 'text'|'number'|'boolean'|'list'|'object'|'null';
type Entry = {key: string; value: PropertyValue};

export function inferPropertyType(value: unknown): ValueType {
 if (value === null) return 'null';
 if (Array.isArray(value)) return 'list';
 if (typeof value === 'object') return 'object';
 if (typeof value === 'number') return 'number';
 if (typeof value === 'boolean') return 'boolean';
 return 'text';
}

/** Validate keys and values before writing metadata. Reserved keys apply only at the top level. */
export function validateProperties(properties: Properties, reservedKeys: string[] = []): void {
 parseProperties(properties, reservedKeys);
}

/* Obsidian augments HTMLElement with addClass and toggleClass; a bare DOM in a test does not
 * have them. These pick whichever is there. Written as `addClass?.(c) ?? classList.add(c)`
 * until 2026-09-21, which reads as a choice and is not one: addClass returns undefined, so the
 * right-hand side ran every time as well. Both happened to be idempotent — the next one copied
 * from them might not be. */
function addClass(element: HTMLElement, className: string): void {
 if (typeof element.addClass === 'function') element.addClass(className); else element.classList.add(className);
}
function setClass(element: HTMLElement, className: string, on: boolean): void {
 if (typeof element.toggleClass === 'function') element.toggleClass(className, on); else element.classList.toggle(className, on);
}
function makeElement(parent: HTMLElement, tag: string, className?: string): HTMLElement {
 const element = (parent as HTMLElement & {createEl: (tag:string) => HTMLElement}).createEl(tag);
 if (className) addClass(element, className);
 return element;
}
function button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
 const b = makeElement(parent, 'button') as HTMLButtonElement;
 b.type = 'button'; b.textContent = label; b.addEventListener('click', onClick); return b;
}
/** Show or clear a problem on one control, so a save is not the first time anyone hears about it. */
function mark(control: HTMLElement | undefined, note: HTMLElement, message: string | null): void {
 note.textContent = message ?? '';
 setClass(note, 'is-hidden', !message);
 if (!control) return;
 if (message) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid');
 setClass(control, 'is-invalid', !!message);
}

const FORMAT_LABELS: Record<ValueType, string> = {text: 'Text', number: 'Number', boolean: 'Yes / no', list: 'List', object: 'Group', null: 'Empty'};
/** A value as text, or nothing when it has no single-line reading. */
const scalarText = (value: PropertyValue): string => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const emptyFor = (type: ValueType): PropertyValue => type === 'object' ? {} : type === 'list' ? [] : type === 'boolean' ? false : type === 'null' ? null : '';
/** A control that only clears itself: the small × at the end of a row. */
function remover(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
 const b = button(parent, '×', onClick); addClass(b, 'image-graph-property-remove'); b.setAttribute('aria-label', label); b.title = label; return b;
}
/** The quiet "+ Add …" that ends a table or a group. */
function adder(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
 const b = button(parent, `+ ${label}`, onClick); addClass(b, 'image-graph-property-add'); return b;
}

/**
 * One value: a compact format selector and the control that format needs, side by side. A
 * list or a group opens a nested block under the row. Each row reads as one line — name,
 * format, value — the way Obsidian's own Properties panel does, so a panel of twelve
 * properties is twelve lines and not thirty-six.
 */
class ValueEditor {
 readonly root: HTMLElement;
 private type: ValueType;
 private control?: HTMLInputElement | HTMLSelectElement;
 private children: ValueEditor[] = [];
 private entries: Entry[] = [];
 private onChange: () => void;
 // What the owner last had in each format. Switching Format used to discard the value
 // outright, so one wrong click on the dropdown lost the text with no way back.
 private remembered = new Map<ValueType, PropertyValue>();
 constructor(parent: HTMLElement, value: PropertyValue, onChange: () => void) {
  this.onChange = onChange; this.type = inferPropertyType(value); this.root = makeElement(parent, 'div', 'image-graph-property-value'); this.render(value);
 }
 private remember(): void {
  try { this.remembered.set(this.type, this.getValue()); } catch { /* an unfinished value is not worth keeping */ }
 }
 /** Carry the old value across a format change where it still means something. */
 private convert(next: ValueType, previous: PropertyValue): PropertyValue {
  const kept = this.remembered.get(next);
  if (kept !== undefined) return kept;
  if (next === 'object') return previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  if (next === 'list') return Array.isArray(previous) ? previous : previous === '' || previous === null ? [] : [previous];
  if (next === 'null') return null;
  if (next === 'boolean') return typeof previous === 'boolean' ? previous : false;
  if (next === 'number') return typeof previous === 'number' ? previous : typeof previous === 'string' && previous.trim() && Number.isFinite(Number(previous)) ? Number(previous) : '';
  if (Array.isArray(previous)) return previous.length === 1 ? scalarText(previous[0]) : previous.map(scalarText).filter(Boolean).join(', ');
  return scalarText(previous);
 }
 private render(value: PropertyValue): void {
  this.root.replaceChildren(); this.children = []; this.entries = [];
  setClass(this.root, 'is-nested', this.type === 'object' || this.type === 'list');
  const select = makeElement(this.root, 'select', 'image-graph-property-type') as HTMLSelectElement; this.control = select;
  for (const t of ['text','number','boolean','list','object','null'] as ValueType[]) { const option = makeElement(select, 'option') as HTMLOptionElement; option.value = t; option.textContent = FORMAT_LABELS[t]; if (t === this.type) option.selected = true; }
  select.setAttribute('aria-label', 'Format'); select.title = 'Format';
  select.addEventListener('change', () => {
   this.remember();
   let previous: PropertyValue; try { previous = this.getValue(); } catch { previous = emptyFor(this.type); }
   const next = select.value as ValueType;
   const carried = this.convert(next, previous);
   this.type = next; this.render(carried); this.onChange();
  });
  if (this.type === 'object') this.renderObject((value && typeof value === 'object' && !Array.isArray(value)) ? value : {});
  else if (this.type === 'list') this.renderList(Array.isArray(value) ? value : []);
  else if (this.type === 'null') { const note = makeElement(this.root, 'span', 'image-graph-property-empty'); note.textContent = 'No value'; }
  else {
   const input = makeElement(this.root, 'input', 'image-graph-property-input') as HTMLInputElement; this.control = input;
   input.setAttribute('aria-label', this.type === 'boolean' ? 'Yes' : 'Value');
   input.type = this.type === 'boolean' ? 'checkbox' : this.type === 'number' ? 'number' : 'text';
   if (this.type === 'boolean') { input.checked = value === true; input.title = 'Checked means yes'; }
   else { input.value = scalarText(value); input.placeholder = this.type === 'number' ? '0' : 'Value'; }
   input.addEventListener('input', this.onChange); input.addEventListener('change', this.onChange);
  }
 }
 private renderObject(value: {[key:string]: PropertyValue}): void {
  const list = makeElement(this.root, 'div', 'image-graph-property-nested');
  for (const [key, child] of Object.entries(value)) this.addEntry(list, key, child);
  adder(list, 'Add property', () => { this.addEntry(list, '', '', true); this.onChange(); });
 }
 private addEntry(list: HTMLElement, key: string, value: PropertyValue, focus = false): void {
  const row = makeElement(list, 'div', 'image-graph-property-row');
  const keyInput = makeElement(row, 'input', 'image-graph-property-name') as HTMLInputElement; keyInput.type = 'text'; keyInput.value = key; keyInput.placeholder = 'Name'; keyInput.setAttribute('aria-label', 'Property name');
  keyInput.addEventListener('input', this.onChange);
  const editor = new ValueEditor(row, value, this.onChange); this.children.push(editor); this.entries.push({key: '', value});
  if (focus) keyInput.focus();
  const entry = this.entries[this.entries.length - 1]; Object.defineProperty(entry, 'key', {get: () => keyInput.value});
  remover(row, 'Remove property', () => { row.remove(); const index = this.entries.indexOf(entry); if (index >= 0) { this.children.splice(index, 1); this.entries.splice(index, 1); } this.onChange(); });
  // The adder stays last as rows are added under it.
  const add = list.querySelector(':scope > .image-graph-property-add'); if (add) list.appendChild(add);
 }
 private renderList(value: PropertyValue[]): void {
  const list = makeElement(this.root, 'div', 'image-graph-property-nested');
  value.forEach(child => this.addItem(list, child));
  adder(list, 'Add item', () => { this.addItem(list, '', true); this.onChange(); });
 }
 private addItem(list: HTMLElement, value: PropertyValue, focus = false): void {
  const row = makeElement(list, 'div', 'image-graph-property-item'); const editor = new ValueEditor(row, value, this.onChange); this.children.push(editor);
  if (focus) editor.focusTarget?.focus();
  remover(row, 'Remove item', () => { row.remove(); const index = this.children.indexOf(editor); if (index >= 0) this.children.splice(index, 1); this.onChange(); });
  const add = list.querySelector(':scope > .image-graph-property-add'); if (add) list.appendChild(add);
 }
 /** The control to point at when this editor's value is the problem. */
 get focusTarget(): HTMLElement | undefined { return this.control; }
 getValue(path: Array<string|number> = []): PropertyValue {
  if (this.type === 'object') { const result: {[key:string]: PropertyValue} = {}; this.entries.forEach((entry, i) => { const key = entry.key.trim(); const where = [...path, key || '(unnamed)']; checkKey(entry.key, where); if (Object.prototype.hasOwnProperty.call(result, key)) throw new PropertyError(`Use a unique property name; “${key}” appears more than once.`, where); result[key] = this.children[i].getValue(where); }); return result; }
  if (this.type === 'list') return this.children.map((child, index) => child.getValue([...path, index]));
  if (this.type === 'null') return null;
  // The one input this editor made, held since render: not re-found by a selector that can drift from it.
  const input = this.control as HTMLInputElement | undefined;
  if (!input) throw new PropertyError('This value has no input to read.', path);
  if (this.type === 'boolean') return input.checked;
  if (this.type === 'number') { if (!input.value.trim()) throw new PropertyError('Enter a number.', path); const n = Number(input.value); if (!Number.isFinite(n)) throw new PropertyError('Enter a finite number.', path); return n; }
  return parsePropertyValue(input.value, path);
 }
 dispose(): void { this.root.replaceChildren(); this.children = []; this.entries = []; this.remembered.clear(); }
}

export interface PropertyBuilder {
 /** The parsed mapping, or a PropertyError naming the field. */
 getValue(): Properties;
 /** Mark every field that is not ready, and report how many. Safe to call on each keystroke. */
 check(): number;
 dispose(): void;
}

/**
 * The table of properties: one row each. No prose above it — a reserved name is reported on
 * the row the moment it is typed, and an empty table says in one line what goes here.
 */
export function renderPropertyBuilder(container: HTMLElement, properties: Properties, options: {reservedKeys?: string[]; onChange?: (properties: Properties) => void} = {}): PropertyBuilder {
 const reserved = options.reservedKeys ?? [];
 parseProperties(properties, reserved);
 const root = makeElement(container, 'div', 'image-graph-property-builder');
 const entries = makeElement(root, 'div', 'image-graph-property-entries');
 const empty = makeElement(root, 'p', 'image-graph-property-help'); empty.textContent = 'No properties yet. A property is a name and a value — creator, and a person’s name.';
 const rows: Array<{row: HTMLElement; keyInput: HTMLInputElement; editor: ValueEditor; note: HTMLElement}> = [];
 const showEmpty = () => setClass(empty, 'is-hidden', rows.length > 0);
 // Invalid intermediate rows are allowed while editing; getValue remains the explicit boundary.
 const notify = () => { api.check(); showEmpty(); try { options.onChange?.(api.getValue()); } catch { /* wait for the user to finish the row */ } };
 const add = (key: string, value: PropertyValue, focus = false) => {
  const row = makeElement(entries, 'div', 'image-graph-property-row');
  const keyInput = makeElement(row, 'input', 'image-graph-property-name') as HTMLInputElement; keyInput.value = key; keyInput.placeholder = 'Name'; keyInput.setAttribute('aria-label', 'Property name');
  keyInput.addEventListener('input', notify);
  const editor = new ValueEditor(row, value, notify);
  const note = makeElement(row, 'span', 'image-graph-property-problem'); note.setAttribute('role', 'alert'); addClass(note, 'is-hidden');
  const record = {row, keyInput, editor, note};
  rows.push(record);
  if (focus) keyInput.focus();
  remover(row, 'Remove property', () => { row.remove(); rows.splice(rows.indexOf(record), 1); notify(); });
  row.appendChild(note);
 };
 Object.entries(properties).forEach(([key, value]) => add(key, value));
 adder(root, 'Add property', () => { add('', '', true); notify(); });
 showEmpty();

 const api: PropertyBuilder = {
  getValue: () => {
   const result: Properties = {};
   for (const {keyInput, editor} of rows) {
    const key = keyInput.value.trim();
    checkKey(keyInput.value, [key || '(unnamed)'], reserved);
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new PropertyError(`Use a unique property name; “${key}” appears more than once.`, [key]);
    result[key] = editor.getValue([key]);
   }
   return result;
  },
  check: () => {
   const seen = new Set<string>(); let problems = 0;
   for (const {keyInput, editor, note} of rows) {
    const key = keyInput.value.trim();
    let message: string | null = null; let target: HTMLElement | undefined = keyInput;
    try {
     checkKey(keyInput.value, [], reserved);
     if (seen.has(key)) throw new PropertyError(`Use a unique property name; “${key}” appears more than once.`);
     seen.add(key);
     target = editor.focusTarget;
     editor.getValue();
    } catch (error) { message = propertyMessage(error); }
    if (message) problems++;
    mark(keyInput, note, message && target === keyInput ? message : null);
    if (target !== keyInput) mark(target, note, message);
   }
   return problems;
  },
  dispose: () => { rows.forEach(({editor}) => editor.dispose()); rows.length = 0; root.remove(); },
 };
 return api;
}
