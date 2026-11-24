import {
  createChunkGeometry,
  type ChunkGeometry,
  type TileCell,
  type WorldFeature,
} from '@openstreet-racer/world';

interface GeometryRequest {
  requestId: number;
  cell: TileCell;
  features: WorldFeature[];
}

interface GeometryResponse {
  requestId: number;
  geometry?: ChunkGeometry;
  error?: string;
}

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<GeometryRequest>) => void) | null;
  postMessage(message: GeometryResponse, transfer?: Transferable[]): void;
};

worker.onmessage = ({ data }) => {
  try {
    const geometry = createChunkGeometry(data.cell, data.features);
    const transfer = [
      geometry.ground.positions.buffer,
      geometry.ground.normals.buffer,
      geometry.ground.indices.buffer,
      geometry.roads.positions.buffer,
      geometry.roads.normals.buffer,
      geometry.roads.indices.buffer,
      geometry.markings.positions.buffer,
      geometry.markings.normals.buffer,
      geometry.markings.indices.buffer,
      geometry.buildings.positions.buffer,
      geometry.buildings.normals.buffer,
      geometry.buildings.indices.buffer,
      geometry.greens.positions.buffer,
      geometry.greens.normals.buffer,
      geometry.greens.indices.buffer,
      geometry.waters.positions.buffer,
      geometry.waters.normals.buffer,
      geometry.waters.indices.buffer,
    ] as Transferable[];
    worker.postMessage({ requestId: data.requestId, geometry }, transfer);
  } catch (error) {
    worker.postMessage({
      requestId: data.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
