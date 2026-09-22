import type {App, TFile} from 'obsidian';

/**
 * Point the file explorer at a file the way it points at the note that was just opened:
 * highlighted, and — when the owner has auto-reveal on — its folders opened and the row
 * scrolled into view. Focus stays where it is.
 *
 * `onFileOpen` is the explorer's own handler for the workspace's `file-open` event, and it is
 * undocumented. The graph is not a file view, so nothing fires that event for an image; this
 * calls what the event would have called. Read from Obsidian 1.10: it sets `activeDom` and
 * `is-active`, then `revealActiveFile` if auto-reveal is on, which is the whole of what a note
 * gets. The documented `revealInFolder` is not used because it makes the explorer the active
 * leaf, and a selection made with the arrow keys must not lose the canvas. Absent, nothing
 * happens, never a broken explorer.
 */
export function mirrorInExplorer(app: App, file: TFile): void {
 for (const leaf of app.workspace.getLeavesOfType('file-explorer')) {
  const view: unknown = leaf.view;
  if (view && typeof view === 'object' && 'onFileOpen' in view && typeof view.onFileOpen === 'function') {
   try { (view.onFileOpen as (file: TFile) => void).call(view, file); } catch (error) { console.warn('Image Graph: the file explorer refused to show the image', error); }
  }
 }
}
