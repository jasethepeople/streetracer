# `@openstreet-racer/vehicle`

Keeps two vehicle implementations: the deterministic Phase 1 stepper and the Phase 2 Rapier raycast car. `RapierVehicle.step` consumes normalized `PlayerInput` at a fixed 60 Hz, returns plain-data car and wheel snapshots, and uses streamed building meshes as solid colliders. The package has no UI dependency.
