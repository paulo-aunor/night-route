import type { Subscriber } from "@/types";

interface Point { lat: number; lng: number; }

function distMeters(a: Point, b: Point): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function tourLength(anchor: Point, ordered: Subscriber[]): number {
  if (!ordered.length) return 0;
  let total = distMeters(anchor, ordered[0]);
  for (let i = 1; i < ordered.length; i++) total += distMeters(ordered[i - 1], ordered[i]);
  return total;
}

function nearestNeighbour(anchor: Point, stops: Subscriber[]): Subscriber[] {
  const remaining = [...stops];
  const path: Subscriber[] = [];
  let cursor: Point = anchor;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = distMeters(cursor, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const d = distMeters(cursor, remaining[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const [next] = remaining.splice(bestIdx, 1);
    path.push(next);
    cursor = next;
  }
  return path;
}

function twoOpt(anchor: Point, initial: Subscriber[]): Subscriber[] {
  const n = initial.length;
  if (n < 4) return initial;
  const path = [...initial];
  let improved = true;
  let passes = 0;
  const MAX_PASSES = 20;

  while (improved && passes < MAX_PASSES) {
    improved = false;
    passes++;
    for (let i = 0; i < n - 1; i++) {
      const a = i === 0 ? anchor : path[i - 1];
      const b = path[i];
      for (let k = i + 1; k < n; k++) {
        const c = path[k];
        const d = k === n - 1 ? null : path[k + 1];
        const before = distMeters(a, b) + (d ? distMeters(c, d) : 0);
        const after = distMeters(a, c) + (d ? distMeters(b, d) : 0);
        if (after + 1e-6 < before) {
          let left = i, right = k;
          while (left < right) {
            const tmp = path[left]; path[left] = path[right]; path[right] = tmp;
            left++; right--;
          }
          improved = true;
        }
      }
    }
  }
  return path;
}

export interface OptimizeResult {
  ordered: Subscriber[];
  distanceMeters: number;
  passes: number;
}

export function optimize(anchor: Point, stops: Subscriber[]): OptimizeResult {
  if (!stops.length) return { ordered: [], distanceMeters: 0, passes: 0 };
  const nn = nearestNeighbour(anchor, stops);
  const nnLen = tourLength(anchor, nn);
  const refined = twoOpt(anchor, nn);
  const refinedLen = tourLength(anchor, refined);
  return {
    ordered: refinedLen < nnLen ? refined : nn,
    distanceMeters: Math.min(nnLen, refinedLen),
    passes: 1,
  };
}
