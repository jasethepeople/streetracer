import { describe, expect, it } from 'vitest';
import type { LonLat } from '@openstreet-racer/shared';
import { tileCellAt, tileCellAtXY } from '@openstreet-racer/world';
import { InterestManager } from '../src/interest';

describe('InterestManager', () => {
  it('subscribes nearby players to overlapping cell neighborhoods', () => {
    const manager = new InterestManager();
    const location = denver();
    const first = manager.update('a', location);
    const second = manager.update('b', location);

    expect(first.addedCells).toHaveLength(9);
    expect(second.addedCells).toHaveLength(9);
    expect(manager.getPeers('a')).toEqual(new Set(['b']));
    expect(manager.getPeers('b')).toEqual(new Set(['a']));
  });

  it('adds neighboring cells before a client crosses a room boundary', () => {
    const manager = new InterestManager();
    const start = tileCellAt(denver());
    const next = tileCellAtXY(start.x + 1, start.y, start.z);
    manager.update('a', denver());
    manager.update('b', denver());

    const moved = manager.update('a', next.center);

    expect(moved.centerCell.key).toBe(next.key);
    expect(moved.addedCells.length).toBeGreaterThan(0);
    expect(moved.removedCells.length).toBeGreaterThan(0);
    expect(manager.getPeers('a')).toEqual(new Set(['b']));
  });

  it('stops relaying after a client leaves every shared cell', () => {
    const manager = new InterestManager();
    manager.update('a', denver());
    manager.update('b', denver());
    const farAway = tileCellAtXY(1_000, 4_000, 14);

    manager.update('a', farAway.center);

    expect(manager.getPeers('a').size).toBe(0);
    expect(manager.getPeers('b').has('a')).toBe(false);
  });

  it('enforces a per-cell capacity and deletes empty cells', () => {
    const manager = new InterestManager(0, 2);
    const location = denver();
    const key = tileCellAt(location).key;
    manager.update('a', location);
    manager.update('b', location);

    const full = manager.update('c', location);
    expect(full.fullCells.map((cell) => cell.key)).toEqual([key]);
    expect(manager.getCellMembers(key).size).toBe(2);
    expect(manager.getClientCount()).toBe(2);

    manager.remove('a');
    manager.remove('b');
    expect(manager.getCellCount()).toBe(0);
  });
});

function denver(): LonLat {
  return { longitude: -104.9903, latitude: 39.7392 };
}
