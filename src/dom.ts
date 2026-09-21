/** Obsidian exposes its detached-element helper as a global in each workspace window. */
export function detached<K extends keyof HTMLElementTagNameMap>(doc:Document,tag:K):HTMLElementTagNameMap[K]{
 const owner=doc.defaultView;
 if(!owner)throw new Error('The image workspace window is closed.');
 return owner.createEl(tag);
}
