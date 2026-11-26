import { describe, expect, it } from 'vitest';
import { WantedSystem, WANTED_LEVELS } from './wanted-system';

describe('wanted-system (client mirror)', () => {
  it('rises and falls with collisions and escaping', () => {
    const system = new WantedSystem();
    expect(system.heat).toBe(0);
    system.registerCollision(0.5);
    expect(system.heat).toBe(0);
    system.registerCollision(8);
    expect(system.heat).toBeGreaterThan(0);
    const before = system.heat;
    system.tick(14, 0, false, 1);
    expect(system.heat).toBeLessThan(before);
  });

  it('builds heat while pursuit is active', () => {
    const system = new WantedSystem();
    for (let index = 0; index < 60; index += 1) system.tick(30, 0, true, 1 / 60);
    expect(system.heat).toBeGreaterThan(0);
  });

  it('maps heat onto stars without dropping below the server level', () => {
    const system = new WantedSystem();
    system.applyServerPursuit(3);
    expect(system.tick(20, 0, true, 0.1).wantedLevel).toBe(3);
    const fresh = new WantedSystem();
    expect(fresh.tick(0, 0, false, 0).wantedLevel).toBe(0);
    expect(WANTED_LEVELS).toBe(5);
  });

  it('ignores server levels above the cap', () => {
    const system = new WantedSystem();
    system.applyServerPursuit(99);
    expect(system.tick(0, 0, true, 0.001).wantedLevel).toBe(WANTED_LEVELS);
  });

  it('reset clears local heat and server level', () => {
    const system = new WantedSystem();
    system.applyServerPursuit(2);
    system.registerCollision(10);
    system.reset();
    expect(system.heat).toBe(0);
    expect(system.tick(0, 0, false, 0).wantedLevel).toBe(0);
  });
});

describe('client near-miss heat', () => {
  it('raises heat for fast near misses and ignores slow brushes', () => {
    const system = new WantedSystem();
    system.registerNearMiss(2);
    system.registerNearMiss(5.9);
    expect(system.heat).toBe(0);
    system.registerNearMiss(6);
    const low = system.heat;
    expect(low).toBeGreaterThan(0);
    const fast = new WantedSystem();
    fast.registerNearMiss(30);
    expect(fast.heat).toBeGreaterThan(low);
    fast.registerNearMiss(120);
    expect(fast.heat).toBeLessThanOrEqual(1);
  });

  it('repeated near-misses can earn a star', () => {
    const system = new WantedSystem();
    for (let index = 0; index < 10; index += 1) system.registerNearMiss(30);
    expect(system.tick(0, 0, false, 0).wantedLevel).toBeGreaterThanOrEqual(1);
  });
});

describe('client chase state and siren exposure', () => {
  it('reports clear with no wanted level', () => {
    const system = new WantedSystem();
    const tick = system.tick(0, 0, false, 0.1);
    expect(tick.chaseState).toBe('clear');
    expect(tick.siren).toBe(false);
  });

  it('reports chase and siren while police visibly engage', () => {
    const system = new WantedSystem();
    system.applyServerPursuit(2);
    const tick = system.tick(20, 0, true, 0.1, { visible: true, sirenAudible: true });
    expect(tick.chaseState).toBe('chase');
    expect(tick.siren).toBe(true);
  });

  it('reports evading when line of sight is broken', () => {
    const system = new WantedSystem();
    system.applyServerPursuit(3);
    const tick = system.tick(25, 0, true, 0.1, { visible: false, sirenAudible: false });
    expect(tick.chaseState).toBe('evading');
    expect(tick.siren).toBe(false);
  });

  it('keeps the siren audible while evading inside siren range', () => {
    const system = new WantedSystem();
    system.applyServerPursuit(1);
    const tick = system.tick(15, 0, true, 0.1, { visible: false, sirenAudible: true });
    expect(tick.chaseState).toBe('evading');
    expect(tick.siren).toBe(true);
  });

  it('stays silent when no pursuit is active even with stale engagement info', () => {
    const system = new WantedSystem();
    system.registerCollision(10);
    const tick = system.tick(0, 0, false, 0.1, { visible: true, sirenAudible: true });
    expect(tick.siren).toBe(false);
  });
});

describe('detectNearMisses', () => {
  const player = {
    position: { longitude: 0, latitude: 0 },
    headingRadians: 0,
    speedMetersPerSecond: 20,
  };
  const metersNorth = (meters: number): number => meters / 111_320;
  const metersEast = (meters: number): number => meters / 111_320;

  it('flags an oncoming vehicle within the near-miss radius', async () => {
    const { detectNearMisses } = await import('./wanted-system');
    const oncoming = {
      id: 'car-1',
      position: { longitude: 0, latitude: metersNorth(2.5) },
      headingRadians: Math.PI, // driving south toward the player
      speedMetersPerSecond: 15,
    };
    const events = detectNearMisses(player, [oncoming]);
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe('car-1');
    expect(events[0]!.closingSpeedMetersPerSecond).toBeCloseTo(35, 1);
  });

  it('ignores ordinary opposing-lane passes beyond the tightened radius', async () => {
    const { detectNearMisses } = await import('./wanted-system');
    // An oncoming car in the neighbouring lane passes ~3.5 m to the side at a
    // combined closing speed of 30 m/s: legal city driving, not a near miss.
    const opposingLane = {
      id: 'car-lane',
      position: { longitude: metersEast(3.5), latitude: metersNorth(1) },
      headingRadians: Math.PI,
      speedMetersPerSecond: 15,
    };
    expect(detectNearMisses(player, [opposingLane])).toHaveLength(0);
    // The same pass at door-mirror distance is reckless and counts.
    const doorMirror = {
      ...opposingLane,
      id: 'car-mirror',
      position: { longitude: metersEast(1), latitude: metersNorth(1) },
    };
    const events = detectNearMisses(player, [doorMirror]);
    expect(events).toHaveLength(1);
    expect(events[0]!.closingSpeedMetersPerSecond).toBeGreaterThan(20);
  });

  it('ignores brushes while the player is driving slowly', async () => {
    const { detectNearMisses } = await import('./wanted-system');
    const slowPlayer = { ...player, speedMetersPerSecond: 5 };
    const oncoming = {
      id: 'car-slow',
      position: { longitude: 0, latitude: metersNorth(2.5) },
      headingRadians: Math.PI,
      speedMetersPerSecond: 15,
    };
    expect(detectNearMisses(slowPlayer, [oncoming])).toHaveLength(0);
  });

  it('ignores vehicles that are far away or barely closing', async () => {
    const { detectNearMisses } = await import('./wanted-system');
    const farAway = {
      id: 'car-far',
      position: { longitude: 0, latitude: metersNorth(40) },
      headingRadians: Math.PI,
      speedMetersPerSecond: 30,
    };
    const sameDirection = {
      id: 'car-same',
      position: { longitude: 0, latitude: metersNorth(2.5) },
      headingRadians: 0,
      speedMetersPerSecond: 19,
    };
    expect(detectNearMisses(player, [farAway, sameDirection])).toHaveLength(0);
    // A parked car the player bears down on at 20 m/s still counts.
    const parked = {
      id: 'car-parked',
      position: { longitude: 0, latitude: metersNorth(2.5) },
      headingRadians: 0,
      speedMetersPerSecond: 0,
    };
    const events = detectNearMisses(player, [parked]);
    expect(events).toHaveLength(1);
    expect(events[0]!.closingSpeedMetersPerSecond).toBeCloseTo(20, 1);
  });
});
