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
