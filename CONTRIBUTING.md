# Contributing

Thanks for helping make OpenStreetRacer an open, playable map game on real OpenStreetMap data. Keep contributions small, readable, and scoped. The core loop is live: 3D driving, traffic, missions, an economy, multiplayer, community races, and mods.

## Development

Use Node.js 22 and pnpm 10:

```sh
pnpm install
pnpm dev
```

Before opening a pull request, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Add tests for coordinate conversions and road constraints in `packages/world`, for game logic in `packages/game`, and for server validation in `apps/server/tests`. Do not commit build output, map tiles, API keys, or personal location data. Keep Nominatim use user-initiated, cached, and below one request per second. Preserve visible OpenStreetMap attribution.

Pull requests run CI and, for same-repository branches, receive a GitHub Pages preview comment. The project is licensed under AGPL-3.0-or-later; contributions are submitted under that license.

## Roadmap

The roadmap lives in [BUILD_PLAN.md](BUILD_PLAN.md) and is updated as phases land. Good first contributions right now:

1. **Mods** — vehicles and missions are folder-based data plus small sandboxed scripts; read `docs/MODDING.md` and ship something fun.
2. **Translations** — the driver menu is a two-language string table today; see below for how to add one.
3. **Vehicle visuals** — community-contributed 3D vehicle models (CC0/CC-BY only) and performance upgrades are explicitly wanted.
4. **Persistence hardening** — player profiles and community races use a single-process JSON store; a transactional shared database (Postgres/PostGIS-ready schema) is the next infra step.
5. **Real-device verification** — confirm 60 FPS chunk streaming on a physical mid-range phone; our browser can only test software rendering.

## Translations

In-game text lives in one place: the `words` table in `apps/web/src/game-menu.ts`'s `GameMenu.t()`. Each entry is a `[English, Spanish]` pair:

```ts
coursePoint: ['Checkpoint', 'Control'],
```

To add a language (for example French):

1. Change the pair type to `[string, string, string]` and add a third entry to every key.
2. Extend `GameSettings.language` in `apps/web/src/progress-store.ts` (values are validated, so add `'fr'` there) and the language selector in the Settings tab.
3. Map the language code to an index in `t()` (`fr -> 2`) and set `root.lang` accordingly.
4. Keep game logic free of display strings — the server sends no UI text, so translation never changes the protocol.

CC0/CC-BY only for any contributed assets; never use names or art from commercial games.

## Architecture in one paragraph

`packages/game` holds plain-data game state and the fixed-step simulation plus the mod-script sandbox. `packages/world` turns OSM vector tiles into road graphs, routes, and chunk geometry. `packages/vehicle` holds the vehicle catalog and Rapier physics. `apps/server` is the authoritative Node WebSocket service: interest management, missions, economy, leaderboards, community content, and ambient-world simulation. `apps/web` is the browser client: MapLibre + Three.js rendering, input, menus, and networking. Renderers only read state; inputs are sampled into objects that game logic consumes.

## Contributor roadmap

Picked from BUILD_PLAN.md "What's next", roughly easiest first:

1. **Translations.** The driver menu speaks English and Spanish via paired strings in `apps/web/src/game-menu.ts` (see "Translating" below). New languages are small, self-contained PRs.
2. **Vehicle mods with community 3D models and performance upgrades.** The mod format and loaders accept data-only definitions today (see docs/MODDING.md); glTF model support and upgrade parts are open.
3. **Player props and ramps.** The race builder and waypoint pipeline are the template: drop geometry at real coordinates, validate on the server, store per cell, stream like chunks.
4. **Vote-based moderation.** Reports, hidden-until-reviewed content, and an admin panel over the community race store.
5. **Federation.** Implement the directory service sketched in docs/FEDERATION.md, starting with an in-game server URL field and reconnect flow.
6. **Production hardening.** Transactional shared database for profiles and community content, production-grade OSM pipeline, HTTPS/WSS deployment, and `ALLOWED_ORIGINS` configuration.
7. **Real-device performance.** Verify 60 FPS and hitch-free chunk streaming on a physical mid-range phone.

## Translating

The driver menu is translated with paired strings. In `apps/web/src/game-menu.ts`, the `t()` method reads a table of `[English, Español]` pairs keyed by string id. To add a language:

1. Change the pair type to `[English, Español, Français]` (or refactor to a keyed record of locales).
2. Extend `GameSettings.language` in `apps/web/src/progress-store.ts` with the new code and update the settings screen choices.
3. Set `root.lang` in `GameMenu.render()` accordingly.
4. Translate every entry; missing entries fall back to English.

Keep translations short — many labels render next to game HUD elements.
