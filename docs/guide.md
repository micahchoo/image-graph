# Storage and operation

## Vault files

Original images remain ordinary vault files.
The graph does not change their pixels during annotation.

`_Image Graph/Notes/` contains companion Markdown notes.
Each is named after its image and filed in the image's own folder, so `Photos/Harbour at dusk.png` has `_Image Graph/Notes/Photos/Harbour at dusk.md`.
Two images can share a name but not a path, so two notes can never collide.
A note made by an earlier version was named after an internal id; the plugin renames those the first time it loads, and tells you how many it moved.
An image extracted from a region takes the region's name: `_Image Graph/Notes/Extracted/Dark water · Harbour at dusk.md`.
Move a note anywhere you like. The plugin records where it went and never moves it again.
The `image` property links to the source image.
The `image_graph_id` property identifies its graph record.
The `connections` property lists one link for each connection, aimed at the companion note at the other end.
Obsidian's graph view draws these links, and it draws a link to a note that does not exist yet.
The `annotations` property appears when the Image Annotation plugin has attached one of the image's regions to a note, and lists a link to each note.
The plugin writes these four properties. Other properties and tags are user metadata.

`_Image Graph/Data/` contains JSON records for saved image positions, regions, and connections.
The plugin divides records across files to keep individual updates small.
The whole-vault grid is derived: each thumbnail has the same height and its own width, and the rows wrap in path order.
An image you move keeps the position you gave it and leaves the rows.
To put it back, use **Actions → Return every moved image to the grid**, or select the images first to release only those.
Region coordinates are relative to the parent image.
Select a region and drag one of its grips to resize it, or type the fractions under Region geometry.

`_Image Graph/Exports/` contains Canvas exports and rendered snapshots.
These files do not feed changes back into the graph.

`_Image Graph/Extracted/` contains images created by an explicit region extraction.
Each file is named after its region and source image, `Dark water · Harbour at dusk.png`, with a number added when that name is taken.
Their companion notes identify the source image and region.
When the region was drawn in Image Annotation, the companion's `source_notes` property links to the notes that region was attached to.
Each extracted image appears in the whole vault and connects to its source region with a “derived from” relationship.
Extraction places the new image on an unoccupied grid position and brings it into view.

## Image Annotation regions

The [Image Annotation](https://github.com/micahchoo/image-annotation) plugin marks image regions and attaches them to notes.
Image Graph reads its index, `Image Annotation/index.json`, and shows those regions on their images with a dashed outline.
It reads the file, not the plugin, so the regions stay while Image Annotation is disabled and go when the file does.
A region whose image is not in the vault is not shown.

Select a foreign region to see its name and the notes it is attached to. Each opens the note or paragraph.
**Open in Image Annotation** opens its editor there, and **Annotate in Image Annotation** on any image opens that plugin's editor on it.
Both appear only while Image Annotation is loaded.

You can connect a foreign region and extract an image from it. You cannot move, resize, rename, or delete it here.
Edit or delete it in Image Annotation. The graph never writes to that plugin's files.

A connection to a region Image Annotation later deletes keeps its record, drawn to the middle of the image.
Run **Remove connections to deleted Image Annotation regions** to delete them. Undo restores them.

A web image Image Annotation saved is named by a hash. If the graph makes a companion note for one, the note takes the name of the note the image was clipped from, and carries `source_url` and `source_note`.
The graph fills those two once and keeps whatever you change them to.

## Find an image

Select **Find image** in the toolbar and type part of a name or folder.
The command palette has the same search under **Find an image in the graph**.

Right-click an image in the file explorer and select **Find in image graph**.
The workspace opens with that image in the middle of the view.

In the graph, the arrow keys go from image to image.
Hold Shift to add the next image to the selection.
When one image is selected, the file explorer highlights its file, and scrolls to it if auto-reveal is on, as it does for the open note.
The arrow keys move the images themselves while the Move tool is on.

## Four ways to explore

**Explore** acts on what you chose.

| What you chose | What you get |
| --- | --- |
| An image or a region | That image and its connections, one hop out |
| Several images | All of them, each with its connections, one hop out |
| A connection | Both images it joins, and their connections |
| A relation, from the arrow beside **Explore** | Every image that relation joins, across the vault |
| Nothing | A reminder of the two ways above |

A connection gives you its two ends because that is the thing you pointed at.
Several images give you a smaller space to draw in: none of them is anchored, so you can move and pin every one.
Drawing a connection while exploring moves nothing; changing the depth lets unpinned images settle again.
To see every connection with the same label, use the arrow beside **Explore**, or right-click the connection and select **Explore every “…” connection**.

A relation has no starting image and no hop count.
Choose a different relation from the list at the bottom of the workspace, or select **Vault** to leave.

## Show a graph inside a note

Write a fenced block with the language `image-graph`:

````
```image-graph
[[Photos/Harbour at dusk.png]]
depth: 2
```
````

The note shows that image and its connections, with a button to open the workspace there.
Use `relation: resembles` instead of `depth` to show one relation.
Use `height: 240` to change the size of the block.

You do not have to write the block yourself.
Explore what you want to show, then select **Actions → Copy this view as a note block** and paste it, or **Actions → Add this view to a note…** and choose the note.

The block is yours. The plugin reads it and never writes to it.
The picture is still: to move, zoom, or edit anything, open the workspace.

## Undo

`Ctrl` or `⌘` with `Z` undoes the last change to the graph: a move, a region, a connection, or a deletion.
Add Shift to do it again.
The Actions menu names what it will undo.

Undo covers the graph, not your notes.
A caption or a property you write in a companion note is part of that note, and the editor undoes it.

## Without the plugin

Original images and companion notes remain accessible.
Obsidian can read the companion YAML, tags, and image links.
Native Canvas can open the exports.
Region editing and graph exploration require the plugin.

## Large vaults

The plugin reads each image header one time to learn its proportions, and records them in `_Image Graph/Thumbnails/sizes.json`.
It reads two files at a time in the background.
A chip at the bottom of the workspace names the work and counts it down. Select ✕ on the chip, or run **Stop background work**, to stop it.
Nothing is lost: each pass records every file it finishes, so it starts again where it stopped.
The first session with a large vault must read all the images. Later sessions use the record.

The whole-vault view uses 32-pixel thumbnails at distant zoom levels.
The plugin stores these thumbnails in atlas pages under `_Image Graph/Thumbnails/`.
Each page contains up to 256 thumbnails.
These pages are disposable cache files, not source images or annotations.

The first overview fills progressively as two background tasks read the source images.
The plugin does not decode all original images at once.
Later sessions reuse atlas pages when source paths, sizes, and modification times match.
Navigation reuses the loaded pages.
New images fill new slots without replacing existing thumbnails.
Deleted images or changed source files can require updates to affected pages.

Up to 120 central visible cards request larger thumbnails through a bounded cache.
Other visible cards retain their overview thumbnails.
Detail thumbnails adapt to the displayed size, up to 2048 pixels on their longest side.
A detail thumbnail keeps the proportions of its image.
The detail cache has a 96 MiB budget and two concurrent image decoders.
The current viewport can show every image without retaining every full-size source in memory.

The exploration view limits the displayed neighborhood to keep layout work bounded.
This limit does not remove records from the vault.
Source file size, display size, and connection density affect performance.

## Recovery

Missing images retain their saved records.
A malformed data file produces an error instead of an empty replacement.

1. Keep a backup before editing graph data outside Obsidian.
2. If a data file is invalid, restore that file from a backup.
3. Reload the plugin after the repair.

Simultaneous edits across devices need normal vault backup and synchronization practices.
This version does not claim automatic conflict resolution for every sync conflict.

## Development checks

```sh
npm run check
npm run lint
npm test
npm run build
```

The [runtime report](verification.md) records checks in the authorized development vault.
