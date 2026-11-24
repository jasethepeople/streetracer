import type { ChunkGeometry, TileCell, WorldFeature } from '@openstreet-racer/world';
import { tileNeighbors, tileCellAt, tileCellAtXY, WORLD_TILE_ZOOM } from '@openstreet-racer/world';
import type { LonLat } from '@openstreet-racer/shared';
import { GeometryWorkerClient } from './geometry-worker-client';
import { fetchWorldFeatures } from './vector-world';

export interface ChunkSink {
  addChunk(cell: TileCell, geometry: ChunkGeometry): void;
  removeChunk(key: string): void;
}

interface ChunkJob {
  readonly cell: TileCell;
  readonly generation: number;
}

const ACTIVE_RADIUS = 1;
const MAX_CONCURRENT_LOADS = 2;
const RETRY_DELAY_MS = 12_000;

export class ChunkStreamer {
  private readonly worker = new GeometryWorkerClient();
  private readonly activeKeys = new Set<string>();
  private readonly loadingKeys = new Set<string>();
  private readonly queuedKeys = new Set<string>();
  private readonly failedUntil = new Map<string, number>();
  private readonly queue: ChunkJob[] = [];
  private center: TileCell | null = null;
  private generation = 0;
  private loadingCount = 0;
  private disposed = false;

  constructor(
    private readonly renderer: ChunkSink,
    private readonly physics: ChunkSink,
    private readonly onStatus: (message: string) => void,
    private readonly onChunkReady: (
      cell: TileCell,
      features: readonly WorldFeature[],
    ) => void = () => {},
  ) {}

  getStats(): { active: number; loading: number; queued: number } {
    return { active: this.activeKeys.size, loading: this.loadingCount, queued: this.queue.length };
  }

  update(location: LonLat): void {
    if (this.disposed) return;
    const nextCenter = tileCellAt(location, WORLD_TILE_ZOOM);
    this.center = nextCenter;
    const wanted = tileNeighbors(nextCenter, ACTIVE_RADIUS);
    const wantedKeys = new Set(wanted.map((cell) => cell.key));
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index];
      if (!job || (job.generation === this.generation && wantedKeys.has(job.cell.key))) continue;
      this.queuedKeys.delete(job.cell.key);
      this.queue.splice(index, 1);
    }

    for (const key of [...this.activeKeys]) {
      const cell = parseTileKey(key);
      if (!withinRadius(cell, nextCenter, ACTIVE_RADIUS)) {
        this.renderer.removeChunk(key);
        this.physics.removeChunk(key);
        this.activeKeys.delete(key);
      }
    }

    for (const cell of wanted) {
      if (
        this.activeKeys.has(cell.key) ||
        this.loadingKeys.has(cell.key) ||
        this.queuedKeys.has(cell.key) ||
        (this.failedUntil.get(cell.key) ?? 0) > Date.now()
      ) {
        continue;
      }
      this.queue.push({ cell, generation: this.generation });
      this.queuedKeys.add(cell.key);
    }
    this.queue.sort(
      (left, right) => distance(left.cell, nextCenter) - distance(right.cell, nextCenter),
    );
    this.pump();
    if (this.activeKeys.size < wanted.length) {
      const unavailable = wanted.filter(
        (cell) => (this.failedUntil.get(cell.key) ?? 0) > Date.now(),
      ).length;
      this.onStatus(
        `Loading nearby streets · ${this.activeKeys.size} of ${wanted.length} cells ready${unavailable ? ` · ${unavailable} unavailable` : ''}`,
      );
    }
  }

  reset(): void {
    this.generation += 1;
    this.center = null;
    this.queue.length = 0;
    this.queuedKeys.clear();
    this.failedUntil.clear();
    for (const key of this.activeKeys) {
      this.renderer.removeChunk(key);
      this.physics.removeChunk(key);
    }
    this.activeKeys.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.worker.dispose();
  }

  private pump(): void {
    while (!this.disposed && this.loadingCount < MAX_CONCURRENT_LOADS && this.queue.length) {
      const job = this.queue.shift();
      if (!job) return;
      this.queuedKeys.delete(job.cell.key);
      if (job.generation !== this.generation || this.activeKeys.has(job.cell.key)) continue;
      this.loadingKeys.add(job.cell.key);
      this.loadingCount += 1;
      void this.load(job).finally(() => {
        this.loadingKeys.delete(job.cell.key);
        this.loadingCount -= 1;
        if (this.center) {
          this.update(this.center.center);
          this.pump();
        }
      });
    }
  }

  private async load(job: ChunkJob): Promise<void> {
    try {
      const features: WorldFeature[] = await fetchWorldFeatures(job.cell);
      const geometry = await this.worker.generate(job.cell, features);
      if (
        this.disposed ||
        job.generation !== this.generation ||
        !this.center ||
        !withinRadius(job.cell, this.center, ACTIVE_RADIUS)
      ) {
        return;
      }
      this.physics.addChunk(job.cell, geometry);
      this.renderer.addChunk(job.cell, geometry);
      this.activeKeys.add(job.cell.key);
      this.failedUntil.delete(job.cell.key);
      this.onChunkReady(job.cell, features);
      this.onStatus(`Real streets ready · ${this.activeKeys.size} nearby cells`);
    } catch (error) {
      if (job.generation !== this.generation || this.disposed) return;
      this.failedUntil.set(job.cell.key, Date.now() + RETRY_DELAY_MS);
      const message = error instanceof Error ? error.message : 'A world tile could not be loaded.';
      this.onStatus(`Map tile unavailable · retrying soon (${message})`);
    }
  }
}

function parseTileKey(key: string): TileCell {
  const [z, x, y] = key.split('/').map(Number);
  return tileCellAtXY(x, y, z);
}

function withinRadius(first: TileCell, second: TileCell, radius: number): boolean {
  const scale = 2 ** first.z;
  const rawX = Math.abs(first.x - second.x);
  const wrappedX = Math.min(rawX, scale - rawX);
  return Math.max(wrappedX, Math.abs(first.y - second.y)) <= radius;
}

function distance(first: TileCell, second: TileCell): number {
  const scale = 2 ** first.z;
  const rawX = Math.abs(first.x - second.x);
  const wrappedX = Math.min(rawX, scale - rawX);
  return Math.max(wrappedX, Math.abs(first.y - second.y));
}
