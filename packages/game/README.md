# `@openstreet-racer/game`

Owns the plain-data game state and fixed 60 Hz simulation boundary. The Rapier vehicle publishes car snapshots here; renderers read snapshots only. Geographic state uses a floating local origin that recenters as the player drives, without changing world position.
