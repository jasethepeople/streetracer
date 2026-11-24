# Modding OpenStreetRacer

Mods are folders of **data files plus small sandboxed scripts**. Drop a folder under the served `mods/` directory, list it in `mods/index.json`, and its vehicles and missions join the game on the next server start. No code is compiled, nothing touches the network, storage, or the DOM from inside a mod, and every value a mod produces is validated by the server.

## Quick start: the tutorial mod

`apps/web/public/mods/sample-missions/` is a working example you can copy. It defines two missions, one of which scales its reward with a script. `apps/web/public/mods/sample-rally/` shows a mod that combines vehicles and missions in one manifest.

To try it locally:

```sh
pnpm install && pnpm build && pnpm dev
```

Open the game, connect, and the mod's missions appear in the Missions tab alongside generated ones. Their IDs start with `mod-` and the creator shows the mod name.

## Folder layout

```
mods/
  index.json                 # lists mod manifests, e.g. ["sample-rally/manifest.json"]
  my-mod/
    manifest.json            # vehicles and/or missions (schema below)
```

`mods/index.json` may list at most 32 manifests; each path must be `<folder>/manifest.json`. The manifest's `id` must equal its folder name. Invalid mods are skipped with a console warning; the rest of the game keeps running.

## Manifest schema

Shared fields:

| Field           | Type   | Rules                                 |
| --------------- | ------ | ------------------------------------- |
| `schemaVersion` | number | Must be `1`                           |
| `id`            | string | `a-z0-9-`, 1–32 chars, matches folder |
| `name`          | string | Display name, ≤ 72 chars              |
| `version`       | string | Your choice                           |
| `description`   | string | Your choice                           |

### `vehicles` (optional)

Data-only vehicle definitions; see `sample-rally/manifest.json` and `packages/vehicle/src/catalog.ts` for the validated fields (dimensions, handling, cost). Vehicle IDs must start with `mod-<mod id>-`.

### `missions` (optional, at most 8 per mod)

| Field             | Type     | Rules                                                                                                        |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `id`              | string   | `a-z0-9-`, 1–48 chars; becomes `mod-<mod id>-<id>` internally                                                |
| `kind`            | string   | `delivery`, `taxi`, `time-trial`, or `checkpoint-race`                                                       |
| `title`           | string   | 1–72 chars                                                                                                   |
| `rewardCents`     | number   | Integer 100–10,000 (before script multipliers)                                                               |
| `timeMultiplier`  | number   | 0.5–3, scales the time limit (default 1)                                                                     |
| `placeCategories` | string[] | Subset of `shop`, `park`, `school`, `restaurant`, `attraction`, `fuel station`; empty means any nearby place |
| `rules`           | object   | Optional scripts: `rewardMultiplier`, `timeLimitMultiplier` (see below)                                      |

Each day the server places every mod mission between two real OSM places matching `placeCategories` near the player, routes it over the road graph, and offers it like any other mission. Rewards stay inside server-enforced bounds no matter what the scripts compute.

## Script sandbox

Mission mods can attach two hooks:

- `rewardMultiplier` — multiplies `rewardCents`. Result is clamped to **0.5–2.0** by the server.
- `timeLimitMultiplier` — multiplies the time limit. Result is clamped to **0.5–3.0**.

Scripts are written in **ModScript**, a tiny Lisp-style expression language interpreted by `packages/game/src/mod-script.ts`. The same interpreter runs in the browser and on the server.

### Why a custom language?

The plan asked us to evaluate a compiled Lisp (Fennel or Janet to WASM) against a restricted JavaScript sandbox:

| Option                     | Verdict                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fennel / Janet via WASM    | Real languages, but each brings a 300 KB–1 MB runtime, an FFI boundary for every value, a build toolchain for contributors, and it still needs host-side caps to guarantee termination. Heavy for two numeric hooks.                                                                                                                                                                      |
| Restricted JS (`Function`) | Familiar, but a browser cannot truly isolate in-process JS: constructor and `globalThis` escapes defeat parameter shadowing, so scripts could reach the network or DOM, and step budgets cannot be enforced synchronously. Not acceptable for untrusted content.                                                                                                                          |
| **ModScript (chosen)**     | ~4 KB of auditable TypeScript. Isolation by construction: no function values, no loops, no property access, no globals — scripts only compute numbers and strings through a fixed interpreter with hard step/depth/size caps, so evaluation always terminates. Trade-off: it is a small language by design; bigger behaviors should become data fields or new hooks, not script features. |

If mission modding ever needs real functions or loops, the migration path is a QuickJS-WASM isolate — not raw `eval`.

### Language reference

Values are numbers and strings. Getters read mission context:

| Form / getter                                                   | Meaning                                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `speed`                                                         | Car speed in m/s (0 at offer time)                                |
| `damage`                                                        | Damage fraction 0–1 (0 at offer time)                             |
| `distance`                                                      | Routed course length in meters                                    |
| `elapsed`                                                       | Expected travel time in seconds                                   |
| `missions`                                                      | Missions the player has completed (0 at offer time)               |
| `place-category`                                                | Destination place category, e.g. `"shop"`                         |
| `(category-is "shop")`                                          | 1 if the destination category matches                             |
| `(+ a b ...)` `(- a b)` `(* a b ...)` `(/ a b)`                 | Arithmetic; division by zero yields a huge number, never an error |
| `(< a b)` `(<= a b)` `(> a b)` `(>= a b)` `(= a b)` `(!= a b)`  | Comparisons return 1 or 0                                         |
| `(and x ...)` `(or x ...)` `(not x)`                            | Booleans                                                          |
| `(min a b)` `(max a b)` `(abs x)` `(floor x)` `(clamp x lo hi)` | Helpers                                                           |
| `(if cond then else)`                                           | `else` optional, defaults to 0                                    |

Getters work bare (`distance`) or as zero-argument calls (`(distance)`). The script's final value is the hook result; for multipliers anything non-numeric counts as 1. Scripts are capped at 512 characters, 512 tokens, 4,000 evaluation steps, and depth 48 — invalid or oversized scripts are rejected when the mod loads, and the whole mod is skipped with a warning.

### Examples

Reward 1.5× for courses longer than 2.5 km, otherwise 1×:

```lisp
(if (> distance 2500) 1.5 1)
```

Gently tighten the time limit for short sprints:

```lisp
(if (< distance 1200) 1.2 1)
```

Pay a premium for museum deliveries:

```lisp
(if (category-is "attraction") 1.8 1)
```

## Rules all mods follow

1. **Server authority.** The server loads mods, validates every field, clamps every script result, and re-checks all completed missions before paying rewards. A mod cannot grant itself money.
2. **No I/O from scripts.** ModScript has no network, storage, DOM, or clock access — it cannot even express them.
3. **Deterministic IDs.** Mod mission IDs embed the mod id, mission id, and the day's seed, so "already completed today" dedupe works and rewards are one-time per day.
4. **Failing closed.** Anything invalid is skipped with a console warning at startup; the game and the other mods keep running.

## Shipping a mod

1. Put your folder under `apps/web/public/mods/` (or the server's own mods directory in production).
2. Add its manifest path to `mods/index.json`.
3. Run the server and check the console for skip warnings.
4. Keep only CC0 or CC-BY assets and text you have the rights to publish. OSM-derived content follows the ODbL attribution rules in README.md.
