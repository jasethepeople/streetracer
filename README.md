# OpenStreetRacer

OpenStreetRacer is a free, open-source browser driving game on real OpenStreetMap streets. The browser renders a Three.js world from z14 OpenFreeMap vector tiles, streams roads and buildings around a Rapier-simulated vehicle, and shares deterministic OSM traffic, pedestrians, and traffic signals through the multiplayer server. The Driver menu adds real-world delivery, taxi, time-trial, and checkpoint-race missions; server-validated rewards, vehicle purchases, repairs, area scores, and race times; and settings for graphics, controls, audio, and language. The MapLibre view remains as a minimap. All vehicle visuals are original procedural shapes; no commercial-game assets, names, sounds, or code are used.

## Run locally

Requirements: Node.js 22 and pnpm 10.

```sh
pnpm install
pnpm dev
```

Open the local URL Vite prints. The game asks for browser location; allow it to start near you, or search for a city. The server loads nearby OSM data on first use and caches successful responses for six hours. To play a mission, open **Menu → Missions**, accept a job, then drive to the yellow pickup beacon; follow the green checkpoints and finish at the orange destination. Completing jobs earns money for the garage, where you can buy a truck, sport coupe, or motorbike and repair damage. Menu settings include graphics quality, keyboard/touch controls, master volume, mute, and English/Spanish menu text. Progress is stored by the game server; the browser keeps a local IndexedDB cache and settings. OpenFreeMap and public map services need no API keys. Nominatim lookup runs only after explicit search submission and is rate-limited.

Controls:

- **W / ↑** accelerate
- **S / ↓** brake or reverse
- **A / ←** steer left
- **D / →** steer right
- **Space** handbrake
- **C** toggle chase / hood camera
- **F3** show/hide FPS, draw-call, triangle, and chunk counters
- **Sound** starts after the first click/tap or key press; use the speed-card volume slider and **Mute** button.
- Click **Menu** for missions, garage, scores, and settings.
- On touchscreens, use the on-screen joystick and camera button.

## Multiplayer

`pnpm dev` starts the web client and Node WebSocket server together. Nearby anonymous players appear as interpolated 3D cars; the server groups players by nearby z14 cells, validates and bounds state updates, and relays text chat. It also shares deterministic OSM traffic, pedestrians, and traffic signals. Mission payouts and race times are checked on the server, with ordered checkpoints and minimum/maximum duration checks. The server persists progression in `.data/openstreet-racer/players.json`; Docker Compose uses a persistent `player-data` volume. The browser stores its anonymous player ID in local storage and caches the profile/settings in IndexedDB. There are no accounts or recovery flow: clearing that browser storage disconnects the device from its saved profile. The server stores no continuous player movement history, but an active mission temporarily includes its route coordinates. Client physics are not authoritative, so the anti-cheat checks are basic and do not make competitive play cheat-proof.

Test the relay with 20 simulated clients using `pnpm simulate`. For a single production process, run `pnpm build` then `pnpm preview`; Docker Compose is also available. See `docs/PROTOCOL.md` and `docs/DEPLOYMENT.md` for message semantics and deployment details.

The map includes visible `© OpenStreetMap contributors` attribution. OpenFreeMap also supplies the style's own attribution. The browser controls its User-Agent; the search request uses the page origin as its Referer. Nominatim's public service is for low-volume use, so the app uses explicit form submissions rather than autocomplete and keeps a bounded in-memory result cache. The server selects a regional public Overpass mirror for OSM road data and rate-limits/caches its requests. Set `OSM_CONTACT_EMAIL` to identify the server's User-Agent, or `OSM_OVERPASS_URL` to use a specific compatible endpoint. Public mirrors are best-effort; use a self-hosted or contracted data service for a public production game.

## Workspace

- `apps/web` — Vite app, Three.js renderer, z14 OpenFreeMap tile loader, geometry worker, chunk streaming, WebSocket client/chat, and MapLibre minimap.
- `apps/server` — Node `ws` service for nearby-player interest, bounded player/chat relays, cached OSM road graphs, deterministic ambient-world simulation, route and mission generation, and persistent progression/leaderboards; the versioned JSON protocol can be reimplemented independently.
- `packages/game` — plain-data game state and fixed 60 Hz simulation boundary.
- `packages/vehicle` — Rapier raycast-vehicle physics, a validated procedural vehicle catalog, and the deterministic Phase 1 vehicle stepper.
- `packages/world` — Web Mercator tile math, local coordinates, road ribbons, lane markings, land/building meshes, and road-aligned spawning.
- `packages/ui` — read-only HUD rendering and keyboard/touch input sampling.
- `packages/shared` — shared input/state/map data types, progression records, protocol messages, and network limits.
  Mods: drop folders with a `manifest.json` under `apps/web/public/mods/` (or a custom `MODS_DIR`) to add vehicles and scripted missions — see [docs/MODDING.md](docs/MODDING.md). Player-made street races are built in-game from the **Build** menu tab and validated server-side.

`pnpm simulate` runs 20 local clients for five seconds. For local play from a phone, keep the phone and computer on the same Wi-Fi and open the Vite network URL printed by `pnpm dev`; only the Vite port needs to be reachable because it proxies WebSocket traffic to the loopback-only server.

Useful commands:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm preview
pnpm simulate
```

## GitHub Pages

The repository includes CI, a `main`-branch Pages deploy, and pull-request previews. After creating a GitHub repository and pushing `main`, set **Settings → Pages → Build and deployment → Source** to **Deploy from a branch**, choose `gh-pages` and `/ (root)`. The first deployment is triggered by a push to `main`. Pull-request previews are posted as comments for same-repository PRs; GitHub does not grant write tokens to workflows triggered by fork PRs. GitHub Pages is static hosting: the game runs there, but multiplayer needs a separately hosted WebSocket server. Set `VITE_MULTIPLAYER_URL` to its `wss://` endpoint at build time and allow the Pages origin in `ALLOWED_ORIGINS`; without that, driving works but multiplayer remains disconnected.

## Map and geocoding services

OpenFreeMap's public Liberty vector style needs no key. Nominatim is queried only on explicit city-search submission; requests are delayed, cached in memory, and limited to at most one per second. Browsers cannot set a custom `User-Agent`, so the app sends its origin as the `Referer` and the normal browser User-Agent. If Nominatim changes its policy or blocks browser searches, the geocoder can be replaced without changing the map or game packages.

## License and data

The code is licensed under **GNU AGPL-3.0-or-later**; see `LICENSE`. OpenStreetMap data is © OpenStreetMap contributors and is available under the ODbL. MapLibre GL JS is BSD-3-Clause, Three.js is MIT, and Rapier is Apache-2.0. OpenFreeMap and OpenMapTiles attribution remains visible alongside the required OSM credit.The code is licensed under **GNU AGPL-3.0-or-later**; see `LICENSE`. OpenStreetMap data is © OpenStreetMap contributors and is available under the ODbL. MapLibre GL JS is BSD-3-Clause, Three.js is MIT, and Rapier is Apache-2.0. OpenFreeMap and OpenMapTiles attribution remains visible alongside the required OSM credit. Full data, library, and asset-licensing details (including the CC0/CC-BY policy for contributed assets) live in `docs/CREDITS.md`.
