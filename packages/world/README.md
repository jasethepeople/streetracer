# `@openstreet-racer/world`

Provides Web Mercator z14 tile addressing, local east/north meter conversion, road queries, road-aligned spawn selection, and bounded chunk-mesh generation. The browser decodes OpenFreeMap/OpenMapTiles vector tiles, then a Web Worker builds road ribbons and lane markings, tagged or deterministic-fallback building extrusions, ground, landcover, parks, and water. Every chunk is capped at 15,000 triangles. Mesh and collision data share the same local coordinates.
