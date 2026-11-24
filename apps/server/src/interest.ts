import {
  INTEREST_RADIUS_CELLS,
  MAX_PLAYERS_PER_CELL,
  ROOM_TILE_ZOOM,
  type LonLat,
} from '@openstreet-racer/shared';
import { tileCellAt, tileCellAtXY, tileNeighbors, type TileCell } from '@openstreet-racer/world';

export interface InterestDelta {
  readonly centerCell: TileCell;
  readonly addedCells: readonly TileCell[];
  readonly removedCells: readonly TileCell[];
  readonly fullCells: readonly TileCell[];
}

export class InterestManager {
  private readonly clientCells = new Map<string, Set<string>>();
  private readonly cellClients = new Map<string, Set<string>>();

  constructor(
    private readonly radius = INTEREST_RADIUS_CELLS,
    private readonly maxPlayersPerCell = MAX_PLAYERS_PER_CELL,
  ) {}

  update(clientId: string, location: LonLat): InterestDelta {
    const centerCell = tileCellAt(location, ROOM_TILE_ZOOM);
    const desired = tileNeighbors(centerCell, this.radius);
    const desiredKeys = new Set(desired.map((cell) => cell.key));
    const currentKeys = this.clientCells.get(clientId) ?? new Set<string>();
    const removedCells: TileCell[] = [];
    const addedCells: TileCell[] = [];
    const fullCells: TileCell[] = [];

    for (const key of currentKeys) {
      if (desiredKeys.has(key)) continue;
      this.leaveCell(clientId, key);
      currentKeys.delete(key);
      removedCells.push(cellForKey(key));
    }

    for (const cell of desired) {
      if (currentKeys.has(cell.key)) continue;
      let members = this.cellClients.get(cell.key);
      if (members && members.size >= this.maxPlayersPerCell) {
        fullCells.push(cell);
        continue;
      }
      if (!members) {
        members = new Set();
        this.cellClients.set(cell.key, members);
      }
      members.add(clientId);
      currentKeys.add(cell.key);
      addedCells.push(cell);
    }

    if (currentKeys.size) this.clientCells.set(clientId, currentKeys);
    else this.clientCells.delete(clientId);

    return { centerCell, addedCells, removedCells, fullCells };
  }

  getPeers(clientId: string): Set<string> {
    const peers = new Set<string>();
    for (const key of this.clientCells.get(clientId) ?? []) {
      for (const member of this.cellClients.get(key) ?? []) {
        if (member !== clientId) peers.add(member);
      }
    }
    return peers;
  }

  getCellMembers(cellKey: string): ReadonlySet<string> {
    return this.cellClients.get(cellKey) ?? EMPTY_SET;
  }

  remove(clientId: string): Set<string> {
    const peers = this.getPeers(clientId);
    for (const key of this.clientCells.get(clientId) ?? []) this.leaveCell(clientId, key);
    this.clientCells.delete(clientId);
    return peers;
  }

  getCellCount(): number {
    return this.cellClients.size;
  }

  getClientCount(): number {
    return this.clientCells.size;
  }

  private leaveCell(clientId: string, key: string): void {
    const members = this.cellClients.get(key);
    if (!members) return;
    members.delete(clientId);
    if (!members.size) this.cellClients.delete(key);
  }
}

function cellForKey(key: string): TileCell {
  const [zoom, x, y] = key.split('/').map(Number);
  return tileCellAtXY(x, y, zoom);
}

const EMPTY_SET: ReadonlySet<string> = new Set();
