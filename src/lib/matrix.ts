// Pre-built OSRM driving-distance matrix for every geocoded point in the app
// (library + every subscriber). Bundled with the APK — ~700 KB JSON parses
// once on first access and gives O(1) distance lookups keyed by sub ID.
//
// Regenerate via scripts/build-osrm-matrix.py whenever the subscriber list or
// coordinates change (then copy scripts/night-matrix.json to src/data/).

import raw from "@/data/night-matrix.json";

type MatrixData = { ids: string[]; matrix: number[][] };

const data = raw as MatrixData;
const idToIndex = new Map<string, number>(data.ids.map((id, i) => [id, i]));

export function matrixHasId(id: string): boolean {
  return idToIndex.has(id);
}

// Driving distance in meters between two points (by sub ID or "library").
// Returns Infinity if either id is missing from the matrix.
export function drivingDistance(fromId: string, toId: string): number {
  const i = idToIndex.get(fromId);
  const j = idToIndex.get(toId);
  if (i === undefined || j === undefined) return Infinity;
  return data.matrix[i][j];
}

export const LIBRARY_ID = "library";
