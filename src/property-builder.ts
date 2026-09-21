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
/** Show or clear a problem on one control, so a save is not the first time anyone hears about it. */
function mark(control: HTMLElement | undefined, note: HTMLElement, message: string | null): void {
 note.textContent = message ?? '';
 note.toggleClass?.('is-hidden', !message) ?? note.classList.toggle('is-hidden', !message);
 if (!control) return;
 if (message) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid');
 control.toggleClass?.('is-invalid', !!message) ?? control.classList.toggle('is-invalid', !!message);
}

const FORMAT_LABELS: Record<ValueType, string> = {text: 'Text', number: 'Number', boolean: 'Yes / no', list: 'List', object: 'Group of properties', null: 'Empty'};
/** A value as text, or nothing when it has no single-line reading. */
const scalarText = (value: PropertyValue): string => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const emptyFor = (type: ValueType): PropertyValue => type === 'object' ? {} : type === 'list' ? [] : type === 'boolean' ? false : type === 'null' ? null : '';

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
  this.root.empty?.(); this.root.replaceChildren(); this.children = []; this.entries = [];
  const select = makeElement(this.root, 'select') as HTMLSelectElement; this.control = select;
  for (const t of ['text','number','boolean','list','object','null'] as ValueType[]) { const option = makeElement(select, 'option') as HTMLOptionElement; option.value = t; option.textContent = FORMAT_LABELS[t]; if (t === this.type) option.selected = true; }
  select.setAttribute('aria-label', 'Format'); fieldLabel(this.root, 'Format', select);
  select.addEventListener('change', () => {
   this.remember();
   let previous: PropertyValue; try { previous = this.getValue(); } catch { previous = emptyFor(this.type); }
   const next = select.value as ValueType;
   const carried = this.convert(next, previous);
   this.type = next; this.render(carried); this.onChange();
  });
  if (this.type === 'object') this.renderObject((value && typeof value === 'object' && !Array.isArray(value)) ? value : {});
  else if (this.type === 'list') this.renderList(Array.isArray(value) ? value : []);
  else if (this.type === 'null') { const note = makeElement(this.root, 'span', 'image-graph-property-content-label'); note.textContent = 'Content: Empty'; }
  else { const input = makeElement(this.root, 'input') as HTMLInputElement; this.control = input; input.setAttribute('aria-label', this.type === 'boolean' ? 'Yes' : 'Content'); input.type = this.type === 'boolean' ? 'checkbox' : this.type === 'number' ? 'number' : 'text'; if (this.type === 'boolean') { input.checked = value === true; const field = fieldLabel(this.root, 'Yes', input); const hint = makeElement(field, 'span'); hint.textContent = 'Unchecked means no'; } else { input.value = typeof value === 'string' || typeof value === 'number' ? String(value) : ''; fieldLabel(this.root, 'Content', input); input.addEventListener('input', this.onChange); } }
 }
 private renderObject(value: {[key:string]: PropertyValue}): void {
  const caption = makeElement(this.root, 'span', 'image-graph-property-content-label'); caption.textContent = 'Content';
  const list = makeElement(this.root, 'div', 'image-graph-property-children');
  for (const [key, child] of Object.entries(value)) this.addEntry(list, key, child);
  button(this.root, 'Add property', () => { this.addEntry(list, '', '', true); this.onChange(); });
 }
 private addEntry(list: HTMLElement, key: string, value: PropertyValue, focus = false): void {
  const row = makeElement(list, 'div', 'image-graph-property-row'); const keyInput = makeElement(row, 'input') as HTMLInputElement; keyInput.type = 'text'; keyInput.value = key; keyInput.placeholder = 'Example: Creator'; keyInput.setAttribute('aria-label', 'Property name'); fieldLabel(row, 'Property name', keyInput);
  keyInput.addEventListener('input', this.onChange);
  const editor = new ValueEditor(row, value, this.onChange); this.children.push(editor); this.entries.push({key: '', value});
  if (focus) keyInput.focus();
  const entry = this.entries[this.entries.length - 1]; Object.defineProperty(entry, 'key', {get: () => keyInput.value});
  button(row, 'Remove property', () => { row.remove(); const index = this.entries.indexOf(entry); if (index >= 0) { this.children.splice(index, 1); this.entries.splice(index, 1); } this.onChange(); });
 }
 private renderList(value: PropertyValue[]): void {
  const caption = makeElement(this.root, 'span', 'image-graph-property-content-label'); caption.textContent = 'Content';
  const list = makeElement(this.root, 'div', 'image-graph-property-list');
  value.forEach(child => this.addItem(list, child)); button(this.root, 'Add item', () => { this.addItem(list, '', true); this.onChange(); });
 }
 private addItem(list: HTMLElement, value: PropertyValue, focus = false): void { const row = makeElement(list, 'div', 'image-graph-property-list-item'); const editor = new ValueEditor(row, value, this.onChange); this.children.push(editor); if (focus) { const focusable = row.querySelector('input[aria-label="Content"], input[aria-label="Yes"]'); if (focusable instanceof HTMLElement) focusable.focus(); } button(row, 'Remove item', () => { row.remove(); this.children = this.children.filter(x => x !== editor); this.onChange(); }); }
 /** The control to point at when this editor's value is the problem. */
 get focusTarget(): HTMLElement | undefined { return this.control; }
 getValue(path: Array<string|number> = []): PropertyValue {
  if (this.type === 'object') { const result: {[key:string]: PropertyValue} = {}; this.entries.forEach((entry, i) => { const key = entry.key.trim(); const where = [...path, key || '(unnamed)']; checkKey(entry.key, where); if (Object.prototype.hasOwnProperty.call(result, key)) throw new PropertyError(`Use a unique property name; “${key}” appears more than once.`, where); result[key] = this.children[i].getValue(where); }); return result; }
  if (this.type === 'list') return this.children.map((child, index) => child.getValue([...path, index]));
  if (this.type === 'null') return null;
  const input = this.root.querySelector('input[aria-label="Content"], input[aria-label="Yes"]') as HTMLInputElement;
  if (this.type === 'boolean') return input.checked;
  if (this.type === 'number') { if (!input.value.trim()) throw new PropertyError('Enter a number for Content.', path); const n = Number(input.value); if (!Number.isFinite(n)) throw new PropertyError('Enter a finite number for Content.', path); return n; }
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

export function renderPropertyBuilder(container: HTMLElement, properties: Properties, options: {reservedKeys?: string[]; onChange?: (properties: Properties) => void} = {}): PropertyBuilder {
 const reserved = options.reservedKeys ?? [];
 parseProperties(properties, reserved);
 const root = makeElement(container, 'div', 'image-graph-property-builder');
 const intro = makeElement(root, 'p', 'image-graph-property-help'); intro.textContent = 'Add details about your selection. For example, use creator as the property name and a person’s name as its content.';
 if (reserved.length) { const taken = makeElement(root, 'p', 'image-graph-property-help'); taken.textContent = `The plugin writes ${reserved.join(' and ')} itself, so those names are not available.`; }
 const entries = makeElement(root, 'div', 'image-graph-property-entries');
 const rows: Array<{row: HTMLElement; keyInput: HTMLInputElement; editor: ValueEditor; note: HTMLElement}> = [];
 // Invalid intermediate rows are allowed while editing; getValue remains the explicit boundary.
 const notify = () => { api.check(); try { options.onChange?.(api.getValue()); } catch { /* wait for the user to finish the row */ } };
 const add = (key: string, value: PropertyValue, focus = false) => {
  const row = makeElement(entries, 'div', 'image-graph-property-row');
  const keyInput = makeElement(row, 'input') as HTMLInputElement; keyInput.value = key; keyInput.placeholder = 'Example: Creator'; keyInput.setAttribute('aria-label', 'Property name'); fieldLabel(row, 'Property name', keyInput);
  keyInput.addEventListener('input', notify);
  const editor = new ValueEditor(row, value, notify);
  const note = makeElement(row, 'span', 'image-graph-property-problem'); note.setAttribute('role', 'alert'); note.addClass?.('is-hidden') ?? note.classList.add('is-hidden');
  const record = {row, keyInput, editor, note};
  rows.push(record);
  if (focus) keyInput.focus();
  button(row, 'Remove property', () => { row.remove(); rows.splice(rows.indexOf(record), 1); notify(); });
 };
 Object.entries(properties).forEach(([key, value]) => add(key, value));
 button(root, 'Add property', () => { add('', '', true); notify(); });

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
