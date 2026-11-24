# OpenStreetRacer (working title): Open-Source, Open-World Driving Game on Real Maps

**Vision:** A free, fully open-source open-world game set on the real planet. Anyone, anywhere opens it and the world is already there (real roads, real buildings, from OpenStreetMap). Players drive, then eventually build missions, add content, and play together. No corporate gatekeepers. Long-term it can grow into an open-source "GTA-style" sandbox.

**Legal note:** Don't use the GTA name, art, sounds, or code. Make an original game with its own name and assets. "GTA-style" is a design inspiration, not a branding or asset source.

---

## 1. Principles

1. **Playable at every phase.** Each milestone ends with something you can open in a browser and drive.
2. **Runs in the browser.** No install, works on phones and laptops, easy for contributors.
3. **Real world by default.** Roads and buildings come from open data, not hand-built levels.
4. **Everything open.** Code, tools, and assets are all under open licenses.
5. **Small PRs, boring tech.** Easy for strangers to contribute.

---

## 2. Tech Stack (proposed)

| Layer                                  | Choice                                          | Why                                                              |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Language                               | TypeScript                                      | One language client and server, huge contributor pool            |
| Build                                  | Vite + pnpm                                     | Fast, simple                                                     |
| Map / data                             | **OpenStreetMap** data via vector tiles         | Free, global, open                                               |
| Tile source (current)                  | OpenFreeMap public z14 vector tiles             | No API key; provides the live Phase 2 map                        |
| Tile source (future offline/self-host) | Self-hosted PMTiles on any static host          | Avoid dependency on a public tile service                        |
| 2D map view (Phase 1)                  | MapLibre GL JS                                  | Open-source fork of Mapbox GL, no token                          |
| 3D view (Phase 2+)                     | Three.js                                        | Mature, huge community                                           |
| Physics                                | Rapier (WASM)                                   | Fast, open, good vehicle support                                 |
| Road graph / routing (AI traffic, GPS) | Valhalla or OSRM (server) or own graph from OSM | Open routing engines                                             |
| Multiplayer (Phase 5)                  | Node `ws` with a versioned JSON protocol        | Custom z14 interest management; portable to a future Rust server |
| Persistence                            | SQLite → Postgres + PostGIS                     | Player-made content tied to coordinates                          |
| License (code)                         | **AGPL-3.0-or-later**                           | Already selected; keeps hosted forks open                        |
| License (assets)                       | CC0 / CC-BY only                                | Keep the whole repo clean                                        |

**Data license warning:** OSM data is **ODbL**. You must credit "© OpenStreetMap contributors" in the UI, and if you publish a derived database (like cached road graphs), it must stay ODbL. Game code can still be MIT or AGPL.

---

## 3. Architecture

```
/apps
  /web          Browser client (Vite + TS)
  /server       Node WebSocket multiplayer service (Phase 5 MVP)
/packages
  /game         Plain-data game state + fixed-step simulation
  /world        OSM tile fetch, road/building extraction, chunking
  /vehicle      Vehicle movement logic
  /ui           HUD, controls, menus, minimap
  /shared       Input/state types, constants, net protocol
/tools
  /tiles        Scripts to build/host PMTiles for a region
/docs
```

**Core idea: chunked world.** Slice the planet into tile cells (Web Mercator z14 is a good start). The client loads only the cells around the player, converts OSM features into game geometry (road meshes, building extrusions, collision shapes), and unloads distant cells. The same cell ID later becomes the multiplayer "room" and the key for player-made content.

---

## 4. Milestones

### Phase 0: Repo and foundation (day 1)

- [x] Create the local repository, choose AGPL-3.0-or-later, and add README, CONTRIBUTING, and CODE_OF_CONDUCT
- [x] pnpm workspace, Vite + TypeScript, ESLint/Prettier, and GitHub Actions CI
- [x] Add GitHub Pages deployment and pull-request preview workflows
- [x] Keep visible OSM attribution in the game UI

**Status:** The local production build is verified. A live Pages URL still requires a GitHub remote and the repository's Pages source to be enabled.

### Phase 1: Drive a dot on a real map (MVP)

- [x] MapLibre map in the browser with OpenStreetMap vector tiles via OpenFreeMap
- [x] Browser geolocation with a city-search fallback and Denver default
- [x] 2D car with arcade keyboard and touch joystick controls
- [x] Camera follows the car and rotates with its heading
- [x] Query rendered road geometry and apply soft snapping plus off-road slowdown in `packages/world`
- [x] HUD: speed, OSM street name, and minimap

**Status:** Desktop and phone-sized browser previews, tests, type checks, lint, formatting, and production build all pass. The live-site part remains pending GitHub Pages setup.

### Phase 2 foundation: simulation architecture

- [x] Keep car positions, velocities, and road constraints in the plain-data `packages/game/src/state.ts` module
- [x] Sample keyboard/touch controls into `PlayerInput` objects; game logic consumes them
- [x] Advance gameplay on fixed 60 Hz steps, independent of render frame rate
- [x] Keep rendering read-only and preserve the Phase 1 map, HUD, and road behavior

### Phase 2: Real driving physics + 3D world

- [x] Three.js scene synced to MapLibre coordinates through the floating local-meter origin
- [x] OpenFreeMap z14 OSM roads as width/class-aware ribbons with simple lane markings
- [x] OSM buildings extruded from height/level tags; stable varied height fallback for missing/short render tags
- [x] Ground, parks, and water rendered from OpenMapTiles landcover, landuse, water, and waterway layers
- [x] Rapier raycast vehicle with suspension, fixed-step inputs, and solid building colliders
- [x] Nearby z14 chunks stream in/out; geometry is generated in a worker and capped at 15,000 triangles per chunk
- [x] Chase and hood camera toggle; F3 FPS, draw-call, triangle, and chunk debug overlay
- [x] Day/night cycle and basic lighting
- [ ] Verify 60 FPS and hitch-free chunk transitions on a physical mid-range phone

**Status:** The 3D prototype is playable in the browser; 9 nearby cells load, the player aligns to a nearby road, and unit tests cover vehicle motion, heading, building collisions, tile addressing, and the triangle cap. The headless browser uses SwiftShader software rendering (5–8 FPS), so it cannot validate performance on real phone hardware.

**Done when:** you drive a physically simulated car through your real 3D street, buildings stop it, and chunk streaming meets the phone performance target.

### Phase 3: Living world

- [x] Build a road graph from OSM (nodes, edges, one-way, speed limits)
- [x] AI traffic cars following the graph, obeying lanes and basic intersections
- [x] Pedestrians on sidewalks/footways
- [x] Traffic lights at OSM-tagged signals
- [x] GPS route to a destination (own A* on the OSM road graph)
- [x] Procedural engine, tire, and ambient audio; master volume and mute controls

**Status:** The server builds cached OSM road graphs, simulates seeded traffic, pedestrians, and signal cycles per z14 cell, and broadcasts bounded snapshots. Clients interpolate nearby traffic, show controls, and can request/map A* routes. Live Denver data, routing, and two-browser multiplayer/chat were smoke-tested. Physical-phone performance is still unverified.

**Plan adjustment:** The original checklist called for CC0 sound assets. This implementation synthesizes engine, tire, and wind audio in the browser instead, so it needs no external audio files or asset-license changes.

**Plan alignment:** The request called this Phase 4; the checked-in plan places road graphs, traffic, pedestrians, signals, and routing in Phase 3. I kept the existing numbering so Phase 4 remains the distinct missions/economy/save-progress game loop.

### Phase 4: Game loop

- [x] OSM-generated deliveries, taxi jobs, time trials, and checkpoint races with visible pickup/checkpoint/destination markers
- [x] Server-validated mission starts, ordered race checkpoints, time bounds, one-time rewards, area earnings, and per-race leaderboards
- [x] Earn credits and buy/select a different vehicle; collision damage, paid repairs, and save/restore across server restarts
- [x] Vehicle variety: procedural sedan, truck, sport coupe, and motorbike with distinct handling; graphics, controls, audio, and English/Spanish menu settings
- [x] Browser IndexedDB settings/profile cache
- [ ] Community-contributed 3D vehicle models and performance upgrades

**Status:** The Denver live browser smoke test generated missions from real OSM places, showed the Driver menu/garage/settings (English/Spanish, graphics/controls/audio), and rendered the 3D world. Automated tests cover server mission validation, checkpoint order, persisted rewards, race leaderboards, vehicle purchases, damage/repair, and vehicle switching. The server profile is authoritative and persisted to a single-process JSON file; the browser IndexedDB copy is a cache, not offline progression. The anonymous player ID is in browser local storage and has no account-recovery path. Folder-loaded vehicle mods extend the catalog with validated procedural vehicles (sample pack in `apps/web/public/mods/`); community-contributed 3D models and performance upgrades remain open.

**Plan adjustment:** The original checklist said local IndexedDB progression. Server authority is safer for rewards and leaderboards, so this MVP persists gameplay progress on the server and mirrors it to IndexedDB for local display; settings remain local. The JSON store is deliberately single-process and should be replaced by a transactional shared database before horizontal scaling. Vehicle models remain original procedural geometry; contributed assets and performance upgrades are deferred.

### Phase 5: Multiplayer and "everyone's game"

- [x] Node `ws` server owns room membership, z14-cell interest, and bounded canonical player-state relays
- [x] Nearby players appear as interpolated 3D cars; text chat is rate-limited and length-limited
- [x] Anonymous handles for the MVP; accounts and OAuth remain deferred
- [x] Server-simulated traffic, pedestrians, and traffic controls are shared by nearby players in bounded snapshots
- [x] Community street races: any player publishes a race from their current street to a searched destination; it is stored server-side, listed for nearby players, and playable as a checkpoint race with its own leaderboard (JSON store for now; PostGIS, ramps, props, and vote moderation remain open)
- [ ] Player-made props, ramps, and vote-based moderation on top of the race layer
- [ ] Federation: design recorded in `docs/FEDERATION.md`; the directory service and in-game server browser are not implemented

**Status:** Automated server tests confirm nearby clients receive the same ambient-world snapshot and route results; the 20-client player relay simulation passes. Players publish street races from the in-game menu, and nearby players see and run them with separate leaderboards. A physical-phone test and public deployment are still outstanding. Plain `ws` was selected over Colyseus because this MVP only needs custom cell interest and validation; the versioned JSON protocol is documented separately for a future Rust implementation.

### Phase 6: Community and modding

- [x] Vehicle mods: drop a folder with a `manifest.json` under the served `mods/` directory and its vehicles join the garage catalog (server and browser loaders validate ID prefixes, sizes, and folder-name match)
- [x] Mod API: mission mods (kind, reward, time multiplier, OSM place categories) with sandboxed rule scripts evaluated by a purpose-built Lisp-style interpreter — hard step/depth caps, no host objects reachable, identical behavior in browser and server
- [x] In-game race builder: drive to spots and drop up to five checkpoints from the Build menu tab; the server routes each leg with A*, bounds the course, and publishes it for nearby players
- [x] Docs: `docs/MODDING.md` (format, script language reference, sandbox evaluation, tutorial), sample mission mod, contributor roadmap, and translation guide in `CONTRIBUTING.md`

**Status:** Mission mods load from the same folder layout as vehicle mods; rules run in `packages/game/src/mod-script.ts` (a ~380-line interpreter with 4,000-step, depth-48, 512-character caps and no loops, closures, or property access), so scripts cannot reach the network, storage, or the DOM by construction, and the server clamps every script result before use. The Build tab drops checkpoints at the car's position and publishes waypoint courses through the existing validated race pipeline. A combined sample mod (`apps/web/public/mods/sample-rally/`) ships one vehicle plus two scripted missions, and every published race still lands on the same server-side leaderboard as in Phase 5. Translation is a documented two-language string table awaiting a third column.

### Phase 7: Wanted system and police pursuit

- [x] Server-authoritative heat: speeding above the road's OSM limit, red-light running, and hard impacts each raise heat; heat carries into 0–5 wanted stars, persisted with the player profile
- [x] Police pursuit AI: units spawn 220–420 m away per star, chase on the road graph, roadblocks form at 4+ stars ahead of the player's route, rams deal damage both ways, disabled units linger then despawn
- [x] Busted and wrecked flow: 3 s of police contact while wanted busts you (fine capped at 15% of balance), 100% damage wrecks you (repair bill at 25 cents/damage); both respawn you and clear heat
- [x] Heat missions: getaway, hot-delivery, and lay-low offers generated from wanted state, with hidden cooldown multipliers and hideout destinations
- [x] Client mirror: wanted-stars HUD with flash/vignette, procedural two-tone siren, police cars in 3D and on the minimap, heat reported to the server (rate-limited and clamped), spark explosion at full heat
- [ ] Physical-phone check of pursuit performance (police cars + traffic + city geometry at 60 FPS)

**Status:** The server owns the truth: it evaluates speed/red-light/impact heat on a bounded tick, spawns and advances police units along the road graph, and emits `pursuit`, `busted`, and `wrecked` messages. The client only mirrors heat for a responsive HUD and reports collisions back, which the server clamps — a hacked client cannot grant itself stars. 128 automated tests cover the rules; lint, build, and typecheck are clean.

---

## 5. Key Technical Risks

| Risk                                                    | Mitigation                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OSM data is messy or missing (no heights, odd geometry) | Defaults and procedural fallbacks; never assume tags exist                                                                             |
| Tile servers rate-limit or disappear                    | Use PMTiles on static hosting; document self-hosting                                                                                   |
| Mobile performance                                      | Strict chunk budget, LODs, instancing, test on a mid-range phone every milestone                                                       |
| Coordinate precision at world scale                     | Use a local origin that re-centers (floating origin)                                                                                   |
| Multiplayer cheating / abuse                            | Validate and bound relayed state, rate-limit chat/updates, cap rooms/connections; add server physics only if competitive modes need it |
| Moderation of player-made content                       | Start with reports + admin tools; keep content opt-in per region                                                                       |
| Scope creep                                             | Ship each phase before starting the next                                                                                               |

---

## 6. First Week Checklist

1. Repo + license + CI
2. MapLibre map showing your own city
3. A dot you can drive with the keyboard
4. Geolocation start point
5. Post it publicly and ask for contributors

---

## 7. Credits and Data

- Map data: © OpenStreetMap contributors (ODbL)
- Map rendering: MapLibre GL JS (BSD)
- 3D: Three.js (MIT), Physics: Rapier (Apache-2.0)

## What's next

The core loop is in: real 3D OSM streets, traffic and pedestrians, missions that pay credits, a garage with purchasable vehicles, damage and repairs, community street races publishable from your own street, folder-loaded vehicle mods, multiplayer with chat and shared ambient world, and a full wanted/police system with busted, wrecked, and heat-mission flows. The next priorities, in order:

1. **Real-device verification.** Confirm 60 FPS and hitch-free chunk streaming on a physical mid-range phone; the available browser only offers SwiftShader software rendering.
2. **Pursuit playtesting.** Tune star escalation and police speed on real streets — the constants live at the top of `apps/server/src/wanted-system.ts` and were reasoned out, not playtested. Verify the busted/fine economy feels fair alongside mission rewards.
3. **Production hardening before public play.** Move player profiles and community races from single-process JSON files to a transactional shared database, switch the OSM source to a production-grade one (the current Overpass usage is fine for development but unsuitable for a busy public server), deploy behind HTTPS/WSS, and set `ALLOWED_ORIGINS`.
4. **Deeper community content.** Player-placed props and ramps, and vote-based moderation (report + hide-by-default + admin tools) over published races. Mission and script mods exist; more script hooks (custom objective logic, per-mission rules) are the natural extension.
5. **Federation.** Implement the directory service sketched in `docs/FEDERATION.md`, starting with an in-game server URL field (today only the build-time `VITE_MULTIPLAYER_URL` override exists) and a reconnect flow.
