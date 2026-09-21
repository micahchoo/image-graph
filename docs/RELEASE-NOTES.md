# Unreleased

Regions from the Image Annotation plugin.

- Regions drawn in Image Annotation appear on their images with a dashed outline. The graph reads that plugin's index and never writes to it.
- Select one to see the notes it is attached to. Open it in Image Annotation, or open that plugin's editor on any image, while it is loaded.
- Connections can reach a foreign region. **Remove connections to deleted Image Annotation regions** clears the ones whose region is gone, and undo restores them.
- Extracted images are named after their region and source, `Dark water · Harbour at dusk.png`, instead of an id.
- An extracted image's companion links to the notes its Image Annotation region was attached to. Companion notes that already exist carry an `annotations` property with the same links.
- A web image Image Annotation saved gets a companion named after the note it was clipped from, with `source_url` and `source_note`.

Snapshots and note embeds draw what the workspace draws.

- Labels and captions in exports and embeds used a font string the canvas cannot parse, so they were drawn at 10px in the default face. They now use the interface font at the intended size.
- Connections in a snapshot go around the images between their ends, as they do in the workspace, instead of cutting through them.
- A missing image is painted in the error colour in a snapshot, as in the workspace, instead of looking like an ordinary card.
- Regions from Image Annotation are dashed in a snapshot, as in the workspace.
- A recording canvas in the tests holds the still renderer to what the workspace draws.

# 0.2.1

A clearer exploration graph.

- Images occupy hop-based bands around the starting image. Fit connections centers the starting image.
- Relevant connections stand out. Other connections and region outlines stay faint.
- Selection and hover reveal relation labels. Labels avoid images, captions, and other labels.
- Extracted images use their region names as captions. Full filenames remain in Properties.
- Connections route around unrelated images where a short route is available.
- Layout spacing reserves room for captions and keeps manually pinned images fixed.

Checked in Image vault with 20,005 images and a 16-image, three-hop exploration.
All 76 behavior tests and the release-script test pass.
Physical mobile interaction and multi-device synchronization remain unverified.

# 0.2.0

Canvas interaction, after a study of Penpot's workspace.

- One selection replaces three fields that were kept in step by hand. Two states
  the old model could reach are now unrepresentable: an image ringed while a
  connection was edited, and a region edited while its image was deselected.
- The wheel scrolls the canvas and `Ctrl` or `⌘` with the wheel zooms, which is
  what Obsidian's own canvas does. **A plain scroll no longer zooms.** A
  trackpad can now pan, which it could not before.
- The pointer names what it is over before you press: a ring on the image or
  region under it, a thicker connection, and a cursor that says which.
- Shift-drag selects every image the band touches. Dragging one image of a
  selection carries all of them. Arrow keys move the selection one grid step,
  five with `Shift`.
- A selected region carries grips. Dragging one resizes it; before this a region
  could only be redrawn or typed as numbers.
- `?` lists every shortcut. `Shift` with `0`, `1` or `2` zooms to 100%, to
  everything, or to the selection.
- A spatial index backs the renderer and the hit test, so both cost the viewport
  rather than the vault.

Verified against the same vault of 20,005 generated images with trusted input:
band selection, a region grip resizing and saving, several images moving
together, and hover naming an image against a region. See
[performance](https://github.com/micahchoo/image-graph/blob/0.2.0/docs/PERFORMANCE.md)
and [verification](https://github.com/micahchoo/image-graph/blob/0.2.0/docs/verification.md).

# 0.1.0

First release.

- Open every image in the vault as one workspace, with thumbnails at each zoom level.
- Draw rectangle and polygon regions that stay inside their parent image.
- Connect images, regions, or both, and label each connection through its `relation` property.
- Describe any selection with named properties in Text, Number, List, or group form. No YAML is required.
- Explore one image through one, two, or three connection steps, expand single neighbors, pin images, and trace the shortest path between two of them.
- Create a new image from a region, with a companion note recording its source image and source region.
- Export the current graph, the selection, or the whole vault as an editable Canvas, or the viewport as a visual snapshot.

Image properties and tags live in ordinary companion Markdown notes, so they stay readable with the plugin disabled. See the [storage guide](https://github.com/micahchoo/image-graph/blob/0.1.0/docs/guide.md).

Verified on desktop against a vault of 20,000 generated 2048 × 2048 images. Physical mobile interaction, multi-device synchronization, and performance for other image formats and sizes are not verified. See [development verification](https://github.com/micahchoo/image-graph/blob/0.1.0/docs/verification.md).
