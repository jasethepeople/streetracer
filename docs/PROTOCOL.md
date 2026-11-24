# Multiplayer protocol v1

The wire format is UTF-8 JSON over WebSocket (`/ws`). `packages/shared/src/protocol.ts` is the TypeScript contract; this document defines the language-neutral rules so another server (including a future Rust implementation) can use the same protocol.

## Coordinates and ownership

- Room cells use Web Mercator z14 tile coordinates. Each driver subscribes to the 3×3 neighborhood around their current cell. Neighboring neighborhoods overlap so players remain visible while crossing a cell edge.
- Positions are WGS84 longitude/latitude in degrees. The car's vertical position is `altitudeMeters` above the local ground plane.
- Velocity is split into east, north, and up meters per second. Heading is radians clockwise from north, normalized to `[0, 2π)`; speed is meters per second and is signed for reverse.
- Clients simulate their own car locally and send snapshots. The server owns connection identity, anonymous handle, room membership, ordering, rate limits, and the canonical bounded snapshot it relays. It rejects invalid data and limits displacement; it does not yet run Rapier on the server, so this is not cheat-proof authoritative physics.

Every client and server message includes `version: 1`. Unknown types, unsupported versions, malformed JSON, binary frames, and messages over 4 KiB are rejected.

## Client → server

- `hello`: `{ version: 1, type: "hello", handle, car }`. Must be the first message. `car` uses the snapshot schema below.
- `state`: `{ version: 1, type: "state", seq, car }`. Increasing non-negative integer `seq`; send at 10 Hz. The server accepts at most 20 per second.
- `relocate`: `{ version: 1, type: "relocate", seq, car }`. Used after an explicit location change; limited to six per minute.
- `chat`: `{ version: 1, type: "chat", text }`. Plain text, max 160 Unicode code points, three messages per ten seconds.
- `ping`: `{ version: 1, type: "ping", clientTimeMs }`. The server returns a `pong` with the same timestamp and its own clock.
- `route`: `{ version: 1, type: "route", requestId, destination }`. Requests an A* route from the sender's current position to a WGS84 destination. The server allows two requests per minute and limits destinations to 7 km from the current position.- `missions-request`: `{ version: 1, type: "missions-request" }`. Asks for nearby mission offers (OSM-generated deliveries, taxi jobs, time trials, checkpoint races, and published community races). Rate-limited per connection.
- `mission-action`: `{ version: 1, type: "mission-action", action: "accept" | "start" | "checkpoint" | "complete" | "abandon", missionId, checkpointIndex? }`. The server validates timing, ordered checkpoints, and position radii; rewards are granted once per mission.
- `garage-action`: `{ version: 1, type: "garage-action", action: "buy" | "select" | "repair", vehicleId? }`. Buys, selects, or repairs vehicles from the catalog plus loaded mods.
- `leaderboard-request`: `{ version: 1, type: "leaderboard-request", raceId? }`. Requests best times for one race or all races in the area.
- `damage-report`: `{ version: 1, type: "damage-report", damage }`. Client-reported collision damage, clamped by the server.
- `race-create`: `{ version: 1, type: "race-create", title, destination }`. Publishes a community race from the sender's current position along a server-routed path (300 m–7 km). Rate-limited; the offer is persisted server-side and shown to nearby players.

- `missions-request`: `{ version: 1, type: "missions-request" }`. Asks for nearby mission offers and the sender's active mission. Limited to one request per five seconds.
- `mission-action`: `{ version: 1, type: "mission-action", action, missionId, checkpointIndex? }` with `action` one of `accept`, `start`, `checkpoint`, `complete`, `abandon`. The server validates each transition: a mission must be accepted before it starts, checkpoints must be reported in order, completion is bounded by the offer's time limit, and each offer pays out once per player per day.
- `garage-action`: `{ version: 1, type: "garage-action", action, vehicleId? }` with `action` one of `buy`, `select`, `repair`. The server owns the player's money and owned vehicles; `buy` and `repair` fail when funds are insufficient.
- `leaderboard-request`: `{ version: 1, type: "leaderboard-request", raceId? }`. Returns the best completed times for a race, or for the sender's area when `raceId` is omitted.
- `damage-report`: `{ version: 1, type: "damage-report", damage }`. Client-reported collision damage in `[0, 100]`; the server clamps it and only increases damage over time. Repairs cost money.
- `race-create`: `{ version: 1, type: "race-create", title, destination }`. Publishes a community street race from the sender's current position to a destination 300 m–7 km away. The server routes it on the OSM road graph, stores it for players on the same server, and replies with `race-created`. Limited to three per hour per player.

Snapshot schema:Snapshot schema:

```json
{
  "position": { "longitude": -104.99, "latitude": 39.74 },
  "altitudeMeters": 0.6,
  "velocity": {
    "eastMetersPerSecond": 0,
    "northMetersPerSecond": 0,
    "upMetersPerSecond": 0
  },
  "headingRadians": 0,
  "speedMetersPerSecond": 0
}
```

The server rejects non-finite values and coordinates outside geographic bounds; it normalizes heading, clamps altitude/speed/vertical velocity, limits horizontal velocity magnitude to 36 m/s, and limits ordinary snapshot displacement using elapsed server time. Relocations may change regions, but are rate-limited.

## Server → client

- `welcome`: assigned `playerId`, sanitized `handle`, server time, and the player's persisted `profile` (money, owned/selected vehicle, damage, active mission, stats).
- `missions`: nearby `offers` plus the sender's `activeMission` (null when idle).
- `progress`: the sender's updated `profile` after any mission, garage, damage, or race event.
- `leaderboard`: `{ snapshot }` with best race times for the requested scope.
- `race-created`: the freshly persisted community-race `offer`, echoed to its publisher.
- `roster`: current nearby `players` on join and when interest changes.
- `states`: a batch of changed nearby players, flushed every 100 ms.
- `player-left`: a nearby player left the shared interest area or disconnected.
- `chat`: sanitized text, sender identity, and server time.
- `world`: a bounded shared-world `snapshot` sent every 500 ms. It contains `status`, up to 48 deterministic ambient actors, up to 24 traffic controls, and `serverTimeMs`. Each actor has an id, kind, WGS84 position, heading, and speed; traffic controls include kind, state, position, and time remaining.
- `pong`: echoed client timestamp and server time.
- `error`: stable error `code` and readable `message`.
- `route-result`: `{ result }`, with `requestId` and either `{ ok: true, points, distanceMeters, travelTimeSeconds }` or `{ ok: false, message }`.- `missions`: `{ offers, activeMission }` — nearby generated offers plus community races, and the sender's active mission if one is underway.
- `progress`: `{ profile }` — the authoritative player profile: money, owned vehicles, selected vehicle, damage, completed-mission IDs, area earnings, and best race times. Sent after every progression change.
- `leaderboard`: `{ snapshot }` — best times for the requested race or area.
- `race-created`: `{ offer }` — confirmation that a published community race was stored and is now listed for nearby players.

Public player entries have `{ id, handle, car, serverTimeMs }`. Clients retain recent snapshots, render 100 ms behind, interpolate position/heading, and extrapolate velocity for at most 150 ms. They remove players absent from the latest roster.

## Initial limits

- 64 players per z14 cell; at most 96 relayed peers per client.
- 2,000 open connections per process.
- 60 total inbound messages/second and 20 state snapshots/second per connection.
- 256 KiB server-side socket backpressure limit; slow consumers are disconnected. World snapshots are capped at 12 KiB; route requests are limited to two per minute.
- Handles are anonymous and there are no accounts or voice chat, but v1.5 adds a persistent server-side profile per anonymous browser ID (money, owned vehicles, active mission, best times) kept in a single-process JSON store. OSM road data is cached server-side for six hours; player vehicle physics are still not authoritative.
