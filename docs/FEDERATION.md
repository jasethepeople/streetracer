# Federation design (not yet implemented)

OpenStreetRacer servers are regional by nature: the OSM cache, community races, and player profiles all live on one machine. This document sketches how independent servers for different regions could list themselves in a public directory so players can find and hop between them. It is a design record only — nothing here is implemented.

## Goals

- Anyone can run a server for their region (school, city, country) and have it discoverable without a central gatekeeper.
- Players can move between servers without losing their identity, and community races stay region-local.
- The directory itself stays dumb: it lists, it does not arbitrate.

## Non-goals (for now)

- Global leaderboards or globally shared community races. Region-local content is a feature, not a bug.
- Accounts or SSO. Anonymous player IDs stay server-scoped.

## Server directory

A directory is a small static-ish HTTP service with two endpoints:

- `PUT /servers` — a server registers itself with a signed body: `{ name, region, url (wss://…), protocolVersion, playerCount, createdAt, renewalToken }`. The signature uses a key the server generated at first boot; the directory stores the public key from the first registration and requires the same key for updates, which prevents name/URL hijacking by third parties.
- `GET /servers?region=…` — returns healthy entries sorted by distance to the requester (coarse IP geo is fine).

Entries expire unless renewed (heartbeat every 10 minutes). Abuse controls: one registration per IP per hour, per-entry size caps, and a manual blocklist file operators can PR to the directory repo.

## Client flow

1. The game ships with a default directory URL and lets players add others (settings field).
2. On the connection screen the client fetches the directory, shows nearby servers with region names and player counts.
3. Connecting is just pointing the existing WebSocket client at the chosen server; the protocol is versioned (`version: 1`) precisely so mixed-version fleets stay possible.
4. The build-time `VITE_MULTIPLAYER_URL` override is the existing seam: today it pins one server at build time; federation turns it into a runtime picker backed by the directory.

## Identity portability

Player profiles are server-authoritative and keyed by a browser-generated anonymous ID. For federation:

- Keep the same anonymous ID across servers (it is a random UUID from browser storage, so it can be reused verbatim).
- Do not replicate progression. Money and vehicles are per-server; a "new car can't follow you" rule avoids sync conflicts and gives each community its own economy.
- Handles are cosmetic and re-derived from the same browser value, so no handle-transfer machinery is needed.

## Content boundaries

- Community races are published to and served from one server. A directory entry can advertise `contentPolicy` fields later (e.g. `moderation: "reports"`) so clients can display it before connecting.
- Mods stay folder-based per deployment; a federated server lists its loaded mods in its directory entry so clients can preflight.

## Upgrade path

1. **Phase A (directory only):** publish the directory service spec, add a server URL field to the in-game settings (today the only override is the build-time `VITE_MULTIPLAYER_URL`), and let players paste server addresses.
2. **Phase B (self-listing):** servers auto-register with a directory via the signed `PUT` flow and heartbeat.
3. **Phase C (in-game browser):** the connection screen lists directory entries; the client picks the nearest healthy server.
