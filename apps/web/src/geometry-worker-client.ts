import type { ChunkGeometry, TileCell, WorldFeature } from '@openstreet-racer/world';

interface GeometryResponse {
  requestId: number;
  geometry?: ChunkGeometry;
  error?: string;
}

interface PendingRequest {
  resolve: (geometry: ChunkGeometry) => void;
  reject: (error: Error) => void;
  timeout: number;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class GeometryWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor() {
    this.worker = new Worker(new URL('./geometry-worker.ts', import.meta.url), {
      type: 'module',
      name: 'openstreet-racer-geometry',
    });
    this.worker.addEventListener('message', (event: MessageEvent<GeometryResponse>) => {
      const request = this.pending.get(event.data.requestId);
      if (!request) return;
      window.clearTimeout(request.timeout);
      this.pending.delete(event.data.requestId);
      if (event.data.geometry) request.resolve(event.data.geometry);
      else request.reject(new Error(event.data.error ?? 'World geometry generation failed.'));
    });
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The world geometry worker stopped unexpectedly.');
      for (const [requestId, request] of this.pending) {
        window.clearTimeout(request.timeout);
        request.reject(error);
        this.pending.delete(requestId);
      }
    });
  }

  generate(cell: TileCell, features: WorldFeature[]): Promise<ChunkGeometry> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('World geometry generation timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.worker.postMessage({
          requestId,
          cell: { center: cell.center, halfSizeMeters: cell.halfSizeMeters },
          features,
        });
      } catch (error) {
        window.clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error('World geometry could not be queued.'));
      }
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const [requestId, request] of this.pending) {
      window.clearTimeout(request.timeout);
      request.reject(new Error('The world geometry worker was stopped.'));
      this.pending.delete(requestId);
    }
  }
}
