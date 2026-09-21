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
