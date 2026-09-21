# Storage and operation

## Vault files

Original images remain ordinary vault files.
The graph does not change their pixels during annotation.

`_Image Graph/Images/` contains companion Markdown notes.
The `image` property links to the source image.
The `image_graph_id` property identifies its graph record.
Other properties and tags are user metadata.

`_Image Graph/Data/` contains JSON records for saved image positions, regions, and connections.
The plugin divides records across files to keep individual updates small.
Region coordinates are relative to the parent image.

`_Image Graph/Exports/` contains Canvas exports and rendered snapshots.
These files do not feed changes back into the graph.

`_Image Graph/Extracted/` contains images created by an explicit region extraction.
Their companion notes identify the source image and region.
Each extracted image appears in the whole vault and connects to its source region with a “derived from” relationship.
Extraction places the new image on an unoccupied grid position and brings it into view.

## Without the plugin

Original images and companion notes remain accessible.
Obsidian can read the companion YAML, tags, and image links.
Native Canvas can open the exports.
Region editing and graph exploration require the plugin.

## Large vaults

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
