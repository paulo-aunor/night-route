// Open-TSP solver for arbitrary subsets of stops. The start is a depot id
// (library by default) or a live GPS coordinate.
//
// Distances: where both ends are in the bundled OSRM matrix (src/lib/matrix.ts)
// the real driving distance is used. Anything else (a GPS fix, or a stop from a
// PDF imported after the matrix was built) falls back to straight line x 1.4,
// which orders stops about 4% worse than the real matrix (measured on the private build's real routes).
//
// Approach: build one numeric distance table for exactly the nodes involved,
// then nearest-neighbour seed, 2-opt until stable, or-opt-1/2/3 relocations.
// Deterministic for the same input. The start point is not part of the result.

import { LIBRARY } from "@/data/routes";
import { drivingDistance, LIBRARY_ID, matrixHasId } from "./matrix";

export type Coord = { lat: number; lng: number };

export type OptimizeInput = {
  startId?: string;              // id to start from; defaults to the library
  startCoord?: Coord;            // live GPS start; wins over startId when set
  coordOf: (id: string) => Coord | undefined;
  matrixIdOf?: (id: string) => string | undefined;   // lets a stop borrow another id's real distances
  stopIds: readonly string[];    // the subs to visit, any order
  preKeep?: readonly string[];   // optional fixed prefix (stays at the front)
  timeBudgetMs?: number;         // optional cap; defaults to 2500ms
  polishMs?: number;             // cap on the iterated-search polish; defaults to 1500ms
  stallLimit?: number;           // polish stops after this many attempts without a gain; defaults to 20
};

export type OptimizeResult = {
  orderedIds: string[];
  distanceM: number;             // total over the result, first leg included
  iterations: number;            // 2-opt + or-opt move count
  elapsedMs: number;
  estimatedStops: number;        // stops whose distances came from the straight-line estimate
};

const GPS_START = "__gps_start__";
export const CIRCUITY = 1.4;            // straight line -> road distance in KW (median of 60k sampled pairs: 1.33-1.44)
const LIBRARY_COORD: Coord = { lat: LIBRARY.lat, lng: LIBRARY.lng };

function matrixRowFor(id: string, matrixIdOf?: (id: string) => string | undefined): string | undefined {
  if (id === GPS_START) return undefined;
  return matrixIdOf?.(id) ?? (matrixHasId(id) ? id : undefined);
}

// Road distance guessed from the straight line, for places the distance matrix doesn't cover.
export function straightRoadMeters(a: Coord, b: Coord): number {
  return haversineM(a, b) * CIRCUITY;
}

export function haversineM(a: Coord, b: Coord): number {
  const R = 6_371_000;
  const toR = (x: number) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat);
  const dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

type Table = { n: number; d: Float64Array };

function buildTable(ids: readonly string[], mid: readonly (string | undefined)[], coordFor: (id: string) => Coord): Table {
  const n = ids.length;
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = mid[i];
      const b = mid[j];
      d[i * n + j] =
        a !== undefined && b !== undefined
          ? drivingDistance(a, b)
          : haversineM(coordFor(ids[i]), coordFor(ids[j])) * CIRCUITY;
    }
  }
  return { n, d };
}


// Standing at (or beside) a known house, the first leg should cost what it really
// costs from that house: the matrix knows one-way streets, a straight line doesn't.
// Without this, "go next door and come back later" looks cheaper than it is.
export const SNAP_M = 80;
function snapStart(t: Table, ids: readonly string[], mid: readonly (string | undefined)[], start: Coord, coordFor: (id: string) => Coord): void {
  let snap = -1;
  let best = Infinity;
  for (let k = 1; k < t.n; k++) {
    if (mid[k] === undefined) continue;
    const dd = haversineM(start, coordFor(ids[k]));
    if (dd < best) { best = dd; snap = k; }
  }
  if (snap < 0 || best > SNAP_M) return;
  const offset = best * CIRCUITY;
  for (let j = 1; j < t.n; j++) t.d[j] = j === snap ? offset : offset + t.d[snap * t.n + j];
}

function pathLength(t: Table, start: number, order: readonly number[]): number {
  if (order.length === 0) return 0;
  let total = t.d[start * t.n + order[0]];
  for (let i = 1; i < order.length; i++) total += t.d[order[i - 1] * t.n + order[i]];
  return total;
}

// Greedy nearest-neighbour tour from `start` over `stops` (in their given order for ties).
function nearestNeighbour(t: Table, start: number, stops: readonly number[]): number[] {
  const left = [...stops];
  const order: number[] = [];
  let cur = start;
  while (left.length > 0) {
    let bestAt = 0;
    let bestD = Infinity;
    for (let k = 0; k < left.length; k++) {
      const dd = t.d[cur * t.n + left[k]];
      if (dd < bestD) { bestD = dd; bestAt = k; }
    }
    cur = left[bestAt];
    order.push(cur);
    left.splice(bestAt, 1);
  }
  return order;
}

// 2-opt: reversing order[i+1..j] swaps edges (a,b),(c,d) for (a,c),(b,d).
// The driving matrix is asymmetric (one-way streets), so the stretch between b
// and c costs something different when driven backwards. Running sums of forward
// and backward edge costs make the reversal's true cost available in O(1).
// a, b, c, d are re-read on every step because a reversal moves them.
function twoOpt(t: Table, start: number, order: number[], deadline: number): number {
  const { n: stride, d } = t;
  const n = order.length;
  const fwd = new Float64Array(n);   // fwd[k] = cost of driving order[0] -> ... -> order[k]
  const bwd = new Float64Array(n);   // bwd[k] = cost of driving order[k] -> ... -> order[0]
  const rebuild = () => {
    for (let k = 1; k < n; k++) {
      fwd[k] = fwd[k - 1] + d[order[k - 1] * stride + order[k]];
      bwd[k] = bwd[k - 1] + d[order[k] * stride + order[k - 1]];
    }
  };
  rebuild();
  let moves = 0;
  let improved = true;
  while (improved) {
    if (Date.now() > deadline) return moves;
    improved = false;
    for (let i = -1; i < n - 2; i++) {
      for (let j = i + 2; j < n; j++) {
        const a = i < 0 ? start : order[i];
        const b = order[i + 1];
        const c = order[j];
        const nx = j + 1 < n ? order[j + 1] : -1;
        const delta =
          d[a * stride + c] + (nx < 0 ? 0 : d[b * stride + nx]) + (bwd[j] - bwd[i + 1]) -
          d[a * stride + b] - (nx < 0 ? 0 : d[c * stride + nx]) - (fwd[j] - fwd[i + 1]);
        if (delta < -0.5) {
          let lo = i + 1, hi = j;
          while (lo < hi) { const tmp = order[lo]; order[lo] = order[hi]; order[hi] = tmp; lo++; hi--; }
          rebuild();
          improved = true;
          moves++;
        }
      }
      if (Date.now() > deadline) return moves;
    }
  }
  return moves;
}

// Or-opt: lift a run of 1-3 stops and reinsert it elsewhere.
function orOpt(t: Table, start: number, order: number[], deadline: number): number {
  const { n: stride, d } = t;
  const n = order.length;
  let moves = 0;
  let improved = true;
  while (improved) {
    if (Date.now() > deadline) return moves;
    improved = false;
    for (const segLen of [1, 2, 3]) {
      for (let i = 0; i < n - segLen; i++) {
        const segStart = order[i];
        const segEnd = order[i + segLen - 1];
        const before = i === 0 ? start : order[i - 1];
        const after = i + segLen < n ? order[i + segLen] : -1;
        const removedCost =
          d[before * stride + segStart] +
          (after < 0 ? 0 : d[segEnd * stride + after]) -
          (after < 0 ? 0 : d[before * stride + after]);

        for (let j = -1; j < n; j++) {
          if (j >= i - 1 && j <= i + segLen - 1) continue;
          const insertAfter = j < 0 ? start : order[j];
          const insertBefore = j + 1 < n && (j + 1 < i || j + 1 >= i + segLen) ? order[j + 1] : -1;
          const between = insertBefore < 0 ? 0 : d[insertAfter * stride + insertBefore];
          const insertCost =
            d[insertAfter * stride + segStart] +
            (insertBefore < 0 ? 0 : d[segEnd * stride + insertBefore]) -
            between;
          if (insertCost - removedCost < -0.5) {
            const seg = order.splice(i, segLen);
            const target = j < i ? j + 1 : j + 1 - segLen;
            order.splice(target, 0, ...seg);
            improved = true;
            moves++;
            i = -1; break;       // indices shifted; restart this segment length
          }
        }
        if (Date.now() > deadline) return moves;
      }
    }
  }
  return moves;
}


// Small deterministic generator so the same input always gives the same order.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Iterated local search: swap two nearby runs of stops (a "double bridge"),
// re-run 2-opt and or-opt on the result, keep it only if the path got shorter.
// Plain 2-opt/or-opt stops at the first local optimum, and which optimum it
// reaches changes with tiny cost differences (up to ~7% in testing); this
// removes that luck. Stops after `stallLimit` attempts in a row without a gain.
function iterate(t: Table, start: number, order: number[], deadline: number, stallLimit: number): number {
  const n = order.length;
  if (n < 8) return 0;
  const rng = mulberry32(n * 7919 + 17);
  let best = order.slice();
  let bestLen = pathLength(t, start, best);
  let stall = 0;
  let gains = 0;
  const span = Math.max(3, Math.min(50, Math.floor(n / 4)));
  while (stall < stallLimit && Date.now() < deadline) {
    const p1 = 1 + Math.floor(rng() * (n - 3));
    const p2 = Math.min(n - 1, p1 + 1 + Math.floor(rng() * span));
    const p3 = Math.min(n, p2 + 1 + Math.floor(rng() * span));
    if (p2 <= p1 || p3 <= p2) { stall++; continue; }
    const cand = [...best.slice(0, p1), ...best.slice(p2, p3), ...best.slice(p1, p2), ...best.slice(p3)];
    twoOpt(t, start, cand, deadline);
    orOpt(t, start, cand, deadline);
    const len = pathLength(t, start, cand);
    if (len < bestLen - 0.5) { best = cand; bestLen = len; stall = 0; gains++; }
    else stall++;
  }
  for (let i = 0; i < n; i++) order[i] = best[i];
  return gains;
}

export function optimize(input: OptimizeInput): OptimizeResult {
  const t0 = Date.now();
  const deadline = t0 + (input.timeBudgetMs ?? 2500);

  const preKeep = [...(input.preKeep ?? [])];
  const preKeepSet = new Set(preKeep);
  const stops = input.stopIds.filter((id) => !preKeepSet.has(id));
  const startKey = input.startCoord ? GPS_START : (input.startId ?? LIBRARY_ID);

  const coordFor = (id: string): Coord => {
    if (id === GPS_START) {
      if (!input.startCoord) throw new Error("optimize: GPS start requested without a coordinate");
      return input.startCoord;
    }
    if (id === LIBRARY_ID) return LIBRARY_COORD;
    const c = input.coordOf(id);
    if (!c) throw new Error(`optimize: no coordinates for ${id}`);
    return c;
  };

  // Node 0 is the start, then the fixed prefix, then the stops to order.
  const ids = [startKey, ...preKeep, ...stops];
  // Which matrix row (if any) stands in for each node; the GPS start has none.
  const mid = ids.map((id) => matrixRowFor(id, input.matrixIdOf));
  const table = buildTable(ids, mid, coordFor);
  if (input.startCoord) snapStart(table, ids, mid, input.startCoord, coordFor);
  const preIdx = preKeep.map((_, k) => 1 + k);
  const stopIdx = stops.map((_, k) => 1 + preKeep.length + k);
  const solverStart = preIdx.length > 0 ? preIdx[preIdx.length - 1] : 0;

  const order = nearestNeighbour(table, solverStart, stopIdx);
  const twoOptMoves = twoOpt(table, solverStart, order, deadline);
  const orOptMoves = orOpt(table, solverStart, order, deadline);
  // Polish with iterated local search, capped well inside the budget so Start never hangs.
  const polishUntil = Math.min(deadline, Date.now() + (input.polishMs ?? 1500));
  const polishGains = iterate(table, solverStart, order, polishUntil, input.stallLimit ?? 20);

  const full = [...preIdx, ...order];
  return {
    orderedIds: full.map((k) => ids[k]),
    distanceM: pathLength(table, 0, full),
    iterations: twoOptMoves + orOptMoves + polishGains,
    elapsedMs: Date.now() - t0,
    estimatedStops: mid.slice(1 + preKeep.length).filter((m) => m === undefined).length,
  };
}
