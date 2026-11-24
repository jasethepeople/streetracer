# Credits

OpenStreetRacer is licensed **AGPL-3.0-or-later** (see `LICENSE`). This file records
the data sources, third-party libraries, and asset policy.

## Map data

- **© OpenStreetMap contributors** — map data is ODbL and must stay attributed.
  The game UI shows "© OpenStreetMap contributors" at all times, and any derived
  cached road graph that is published must remain ODbL.
- Vector tiles are served by OpenFreeMap (styles/tiles are free to use; see
  <https://openfreemap.org/>) over Protomaps/PMTiles-compatible infrastructure.

## Third-party libraries

| Library        | License      | Use                     |
| -------------- | ------------ | ----------------------- |
| MapLibre GL JS | BSD-3-Clause | Map rendering (Phase 1) |
| Three.js       | MIT          | 3D rendering            |
| Rapier         | Apache-2.0   | Vehicle physics (WASM)  |

Runtime dependencies are declared in each package's `package.json`; this table
covers the ones that ship to players.

## Game assets

- All vehicles, buildings, and props are **original procedural geometry** written
  for this repository (no third-party meshes). They are covered by the repo's
  AGPL license.
- Sounds are procedurally generated in `apps/web/src/vehicle-audio.ts`; no
  sampled audio is bundled.

## Contributed assets policy

Community contributions of models, textures, or audio must be **CC0 or CC-BY
only** (CC-BY must include attribution lines in `docs/CREDITS.md` or the mod's
`manifest.json`). Contributions under any other license, or of unknown origin
(including "ripped" game assets), will be rejected. Vehicle mods loaded from a
`mods/` folder should credit their authors in the mod `manifest.json`.
