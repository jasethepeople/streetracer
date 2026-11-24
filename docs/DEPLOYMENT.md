# Run and deploy OpenStreetRacer

## Development

Requirements: Node.js 22 and pnpm 10.

```sh
pnpm install
pnpm dev
```

This starts Vite and the WebSocket server together. Open `http://localhost:5173`; use two browser tabs to test nearby drivers. The server listens on port 3001 and Vite proxies `/ws` to it. The WebSocket server binds to localhost by default in development; Vite proxies its `/ws` endpoint, so only port 5173 needs to be reachable from a phone on the same Wi‑Fi. Open the computer's LAN address on port 5173 and allow it through the local firewall.

## OSM road data

The server fetches a small area of road, sidewalk, crossing, speed-limit, one-way, and traffic-control data from a region-selected public Overpass mirror when nearby cells are first visited. Requests are serialized and rate-limited; successful responses are cached for six hours under `.cache/openstreet-racer/osm`. Set `OSM_CONTACT_EMAIL` to identify the server in its User-Agent. Set `OSM_OVERPASS_URL` only to override automatic mirror selection with a compatible endpoint. Docker Compose persists this cache in the `osm-cache` volume.

Public mirrors are best-effort community services, not an availability guarantee for a public game. Before inviting public players, use a self-hosted or contracted OSM data service.

Run the automated 20-client simulation with:

```sh
pnpm simulate
```

The default run lasts five seconds. Set `LOAD_TEST_DURATION_MS` to change the duration. It prints update/relay totals, elapsed time, CPU time, and health metrics, then exits nonzero if peers fail to receive state.

## Build and run one production process

```sh
pnpm build
pnpm preview
```

The server serves the built web app and WebSocket endpoint on the same port (default 3001). Configure `HOST` and `PORT` in the environment if needed. For a browser served from a different origin, set `VITE_MULTIPLAYER_URL` at build time to the server's `wss://` endpoint and set `ALLOWED_ORIGINS` to a comma-separated list of exact origins; leave both unset for same-origin deployment.

## Docker Compose

From the repository root:

```sh
docker compose up --build -d
```

The app is available at `http://localhost:3001`. The service binds inside the container on `0.0.0.0:3001` and publishes port 3001. Compose persists the six-hour OSM cache in `osm-cache` and player profiles/leaderboards in `player-data`. Set `OSM_CONTACT_EMAIL`, `OSM_OVERPASS_URL`, and `ALLOWED_ORIGINS` in the shell before `docker compose up`; Compose passes them into the server. For an Internet-facing deployment, terminate HTTPS/WSS at a reverse proxy and configure it to forward WebSocket upgrades to the container. The built-in server does not terminate TLS.

The server uses anonymous browser IDs, not accounts. It stores a player profile, active mission (including its route coordinates), completed-mission IDs, area earnings, and best race times in `.data/openstreet-racer/players.json`; it does not store a continuous movement trail. The browser's local storage holds the ID and IndexedDB holds a cache/settings, so clearing browser storage loses access to that anonymous profile. The JSON store is a single-process MVP: do not run multiple server replicas against separate local files and expect shared progression; use a transactional shared database before horizontal scaling. Server checks constrain mission payouts and race completion (pickup/destination radius, ordered checkpoints, and time bounds), but driving physics remain client-authoritative and leaderboard checks are not cheat-proof. Rate limits, validation, cell capacity, connection caps, and slow-client disconnection reduce abuse but do not replace moderation or DDoS protection.
