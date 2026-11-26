# Streetracer Repair Report

Date: 2026-11-26  
Source supplied: `streetracer-kimi.zip` (treated as newer than GitHub and as the source of truth)  
Delivery: full updated source tree; no Git push; no deployment.

## Executive result

The car now has an executable forward-drive proof, the spawn blockage behind the reverse-only symptom is fixed, roads and ground use the intended materials, handling is tuned toward arcade driving, burnout/drift traction state drives tire smoke and screech, and the wanted system now has near-miss escalation, police pursuit, roadblocks, escape/re-acquisition, visible HUD state, and siren wiring.

Final verification from a clean copy:

- `corepack pnpm install --frozen-lockfile` — passed
- `corepack pnpm test` — **32 test files, 191 tests passed, 0 failed**
- `corepack pnpm -r --if-present typecheck` — passed for all 7 workspace projects
- `corepack pnpm --filter @openstreet-racer/web build` — passed
- `corepack pnpm lint` — passed with zero warnings/errors
- `corepack pnpm format:check` — passed
- Google Maps/Street View/paid API scan — clean; OpenStreetMap/OpenFreeMap path preserved

Baseline before the work: **28 test files, 128 tests passed**. Final: **32 test files, 191 tests passed**.

## 1. Reverse-only driving

### Diagnosis

The requested three suspect areas were checked in order:

1. **Input sign — ruled out.** W/ArrowUp/joystick-up produces positive throttle, and `main.ts` passes that input through to the runtime without inversion.
2. **Forward physics force — ruled out as the primary bug.** On clear ground, full throttle produces positive speed and forward displacement. The final regression test reaches more than 12 m/s and more than 25 m forward from standstill.
3. **Spawn blockage — confirmed root cause.** The car initially spawned at the raw geolocation origin. In real OSM areas, that point can be inside a building footprint. When the center chunk streamed in, the building trimesh collider could embed the chassis. Forward motion was then blocked while reverse could slowly free the car. A diagnostic in-engine run reproduced the reported behavior: forward throttle stayed at 0.00 m/s while brake/reverse crept at about -0.39 m/s in the blocked spawn scenario.

The old spawn-alignment guard also made this worse: any early player input could permanently veto road alignment, even if the car had not actually escaped the blocked origin.

### Fix

`apps/web/src/world-runtime.ts` now:

- extracts road lines and building rings from streamed center-cell features;
- samples nearby road points instead of blindly trusting the raw origin;
- rejects candidate spawns unless a car-sized footprint has at least 3.5 m clearance from building polygons;
- retries alignment as chunks/features arrive instead of giving up after one failed attempt;
- stops aligning only after the player has genuinely driven away, not merely touched a control;
- exposes the pure spawn-planning helpers for executable tests.

### Executable proof

- `packages/vehicle/src/rapier-vehicle.test.ts` proves forward drive: full throttle from standstill produces positive forward velocity, speed above 12 m/s, and more than 25 m of forward displacement.
- `apps/web/src/world-runtime.test.ts` proves a raw origin inside a building is rejected and a nearby road point with at least 3.5 m building clearance is selected. It also covers retry-until-clear behavior and the guard that prevents relocation after the player has actually driven away.

## 2. Road and ground colors/materials

### Root cause

There was no single literal `roads -> green` binding in the renderer. The inverted appearance came from three separate defects:

1. Paved `transportation` polygons, including pedestrian/paved areas, were routed to the `greens` geometry bucket in `packages/world/src/chunk-geometry.ts`, so drivable pavement could render as grass.
2. The base ground material was a dark olive-gray (`#747b62`) that read almost black under the renderer's ACES tone mapping and darker day/night phases.
3. The smoke `THREE.Points` object was visible at startup with all points at the origin and black vertex colors, creating a black square/artifact on the ground.

### Fix

- Paved transportation polygons now route to the asphalt road mesh at the appropriate road height.
- Base ground is now green (`#607f4f`); green spaces remain green (`#53704a`).
- Road material remains dark asphalt (`#30363a`).
- Surface-to-material bindings are centralized in `CHUNK_SURFACE_MATERIALS` and applied by `WorldRenderer.addChunk`.
- Startup smoke particles remain hidden until live puffs exist, removing the black origin artifact.

### Executable proof

- `packages/world/src/chunk-geometry.test.ts` proves road lines and paved transportation areas route to the roads mesh while parks/green space route to greens.
- `apps/web/src/world-renderer.test.ts` proves roads bind to dark asphalt, ground/greens bind to green-dominant materials, every surface is bound exactly once, and materials are distinct.

## 3. Arcade driving, tire spin, burnouts, and drift

### Vehicle tuning and traction model

`packages/vehicle/src/rapier-vehicle.ts` now includes:

- stronger arcade engine force (1.75x);
- stronger arcade braking (1.4x);
- hard-launch burnout detection from near standstill;
- a 0.9-second maximum burnout phase with reduced initial force and rear grip;
- handbrake rear-grip reduction for slides and drifts;
- `TractionState` exposing burnout intensity, sliding state, slip amount, and wheel-spin rate.

Measured test behavior:

- hard launch produces wheel spin above 10 rad/s and peak burnout above 0.5;
- the car moves less than 2 m during the initial 0.5 s burnout phase;
- after hookup it exceeds 12 m/s;
- handbrake use produces a measurable slide state and slip.

### Smoke and audio wiring

- `WorldRuntime.render()` passes live traction state into `WorldRenderer.render()` each frame.
- `WorldRenderer` now calls its previously dead particle and police update paths every frame.
- Burnout smoke emits from both rear tires.
- Sliding/drifting emits rear-tire smoke; hard drifts can add front-tire smoke.
- Smoke emission is frame-rate independent and capped by the existing particle budget.
- Engine damage smoke is now actually updated/spawned.
- `vehicle-audio.ts` uses traction state for burnout revs and slide/burnout screech.

The emission decisions are pure, exported, and tested without requiring WebGL.

## 4. GTA-style wanted and police chase

### Escalation

Wanted heat now responds to:

- crashes and existing reckless-driving events;
- near-misses at genuinely close range and meaningful player speed;
- sustained reckless streaks through the existing escalation logic.

Near-miss detection was tightened to avoid treating ordinary opposing-lane traffic as a crime:

- radius reduced from 6 m to 3 m;
- player speed must be at least 8 m/s;
- closing-speed scaling remains 0.08 to 0.3 heat between 6 and 30 m/s.

### Police response and roadblocks

Server wanted logic now exposes and uses:

- explicit roadblock gating at wanted level 4;
- police pursuit status: clear, chase, roadblock, or evading;
- siren audibility within 250 m;
- active police-unit pursuit behavior integrated with the existing server loop.

### Escape and re-acquisition

Escape now supports:

- 8 seconds with broken police line of sight; or
- 3 seconds at least 350 m away from active units.

If police regain line of sight, escape state resets and pursuit/roadblock behavior resumes.

### HUD and siren

- HUD renders clear wanted stars (`★★★☆☆` style).
- HUD exposes and visibly renders `IN PURSUIT` / `EVADING` state.
- Siren state is exposed through HUD data and wired to the existing vehicle audio siren path.
- Higher wanted levels continue to drive the existing police/roadblock presentation.

## 5. Files changed

- `apps/server/src/index.ts` — server near-miss detection, pursuit escape updates, roadblock gating, siren/pursuit integration.
- `apps/server/src/wanted-system.ts` — near-miss heat, roadblock gate, pursuit status, siren range, escape/re-acquisition state.
- `apps/server/tests/wanted-pursuit.test.ts` — new server pursuit/roadblock/escape tests.
- `apps/server/tests/wanted-system.test.ts` — updated wanted-system coverage.
- `apps/web/src/main.ts` — traction-to-audio wiring, near-miss detection, pursuit HUD state, siren wiring.
- `apps/web/src/styles.css` — visible wanted chase/evading label and siren presentation.
- `apps/web/src/vehicle-audio.ts` — burnout rev and traction-based screech support.
- `apps/web/src/vehicle-audio.test.ts` — burnout/screech audio tests.
- `apps/web/src/wanted-system.ts` — client near-miss registration, chase state, siren state, near-miss helper.
- `apps/web/src/wanted-system.test.ts` — expanded client wanted tests.
- `apps/web/src/world-renderer.ts` — material binding table, ground color fix, startup smoke visibility fix, tire/engine smoke updates, police animation updates.
- `apps/web/src/world-renderer.test.ts` — material mapping and smoke-emission tests.
- `apps/web/src/world-runtime.ts` — building-clear spawn selection, retryable spawn alignment, traction passthrough, exported spawn-planning helpers.
- `apps/web/src/world-runtime.test.ts` — new spawn-clearance and alignment-planning tests.
- `packages/ui/src/hud.ts` — optional wanted HUD state, stars, chase labels, siren state.
- `packages/ui/src/hud.test.ts` — wanted HUD tests.
- `packages/vehicle/src/rapier-vehicle.ts` — arcade tuning, burnout model, handbrake drift, traction state.
- `packages/vehicle/src/rapier-vehicle.test.ts` — forward-drive proof, burnout proof, handbrake-slide proof.
- `packages/world/src/chunk-geometry.ts` — paved transportation polygons route to roads instead of greens.
- `packages/world/src/chunk-geometry.test.ts` — road/green geometry routing proof.

## 6. Verification details

### Full clean-copy and extracted-archive gates

First executed from `/tmp/streetracer-final-check2` after copying the final source without `node_modules`, `dist`, or `.git`; then repeated from `/tmp/streetracer-archive-check/streetracer`, extracted directly from the delivered `streetracer-fixed.zip`:

```text
corepack pnpm install --frozen-lockfile  PASS
corepack pnpm test                       PASS — 32 files, 191 tests
corepack pnpm -r --if-present typecheck PASS — 7 projects
corepack pnpm --filter @openstreet-racer/web build PASS
corepack pnpm lint                       PASS — 0 warnings/errors
corepack pnpm format:check               PASS
```

The delivered ZIP also passed `unzip -t` with no compressed-data errors.

### Focused proof suites

- `packages/vehicle/src/rapier-vehicle.test.ts` — 7/7 passed
- `apps/web/src/world-runtime.test.ts` — 12/12 passed
- `apps/web/src/world-renderer.test.ts` — 11/11 passed
- `packages/world/src/chunk-geometry.test.ts` — 6/6 passed
- `apps/web/src/wanted-system.test.ts` — 16/16 passed
- `apps/server/tests/wanted-pursuit.test.ts` — 14/14 passed
- `packages/ui/src/hud.test.ts` — 9/9 passed

### Third-party review result

An independent reviewer initially returned REVISE for formatting, missing spawn tests, near-miss false positives, invisible HUD chase labels, sticky escape state, and a dead smoke-size field. Those findings were fixed. The follow-up independent review returned PASS.

## 7. What was not verified

- No live browser playtest was performed.
- No real-GPU/WebGL visual inspection of the final smoke animation was performed in this environment.
- No phone/touchscreen playtest was performed.
- No live multiplayer server or production OSM/OpenFreeMap fetch was exercised during final verification.
- Arcade feel is supported by measured physics tests, but subjective fun still needs a real playtest.
- The build emits only the existing large-chunk advisory warnings; this does not block compilation.

## 8. Constraints honored

- No push to GitHub.
- No deployment.
- No Google Maps or Google Street View.
- No paid API or key added.
- OpenStreetMap/OpenFreeMap path preserved.
- Wanted/police system, mission generator, multiplayer, and ledger pieces were not removed.
- Repository layout and build system were preserved.
