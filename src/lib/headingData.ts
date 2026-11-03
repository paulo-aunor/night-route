// Orders stops with the direction-aware model (headingSearch.ts) using the road distances shipped in
// src/data/heading-matrix.ts. Houses the data doesn't cover (new addresses from an imported PDF) get a
// straight-line estimate that is the same whichever way the car faces, so they never help or hurt a direction.

import { CUT_THROUGH } from "@/data/cut-through";
import { HEADING_DATA_B64, HEADING_IDS } from "@/data/heading-matrix";
import { LIBRARY } from "@/data/routes";
import { insertCheapest, legsGreedy, makeCost, search, statesGreedy, type Problem } from "./headingSearch";
import { CIRCUITY, haversineM, SNAP_M, straightRoadMeters, type Coord } from "./optimizer-v2";

const N = HEADING_IDS.length;
const NONE = 65535;
const SAME_SPOT_TURN_M = 2000;   // turning round between two stops at one spot: a long way round, so never chosen

type Data = { index: Map<string, number>; tables: Uint16Array };
let decoded: Data | null = null;

// Base64 to bytes without depending on a global atob, which not every JS engine provides.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error("Base64 text has a length that isn't a multiple of 4.");
  const lookup = new Uint8Array(128).fill(255);
  for (let i = 0; i < 64; i++) lookup[B64.charCodeAt(i)] = i;
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let bits = 0;
    for (let k = 0; k < 4; k++) {
      const ch = text.charCodeAt(i + k);
      const v = ch === 61 ? 0 : ch < 128 ? lookup[ch] : 255;
      if (v === 255) throw new Error(`Invalid base64 character at ${i + k}.`);
      bits = (bits << 6) | v;
    }
    if (o < out.length) out[o++] = (bits >> 16) & 255;
    if (o < out.length) out[o++] = (bits >> 8) & 255;
    if (o < out.length) out[o++] = bits & 255;
  }
  return out;
}

function data(): Data {
  if (decoded) return decoded;
  const bytes = decodeBase64(HEADING_DATA_B64);
  if (bytes.length !== (4 * N * N + 2 * N) * 2) throw new Error("heading-matrix.ts is the wrong size for its list of houses");
  decoded = { index: new Map(HEADING_IDS.map((id, k) => [id, k])), tables: new Uint16Array(bytes.buffer) };
  return decoded;
}

const metres = (v: number) => (v === NONE ? Infinity : v);

// Penalty in metres for pairs whose route cuts through a car park or private lane, by house pair (either direction).
let penalties: Map<number, number> | null = null;
function cutThroughPenalties(): Map<number, number> {
  if (penalties) return penalties;
  const index = data().index;
  const map = new Map<number, number>();
  for (const [a, b, m] of CUT_THROUGH) {
    const ia = index.get(a), ib = index.get(b);
    if (ia === undefined || ib === undefined) throw new Error(`cut-through.ts names a house the road data doesn't have: ${a} or ${b}.`);
    const key = Math.min(ia, ib) * N + Math.max(ia, ib);
    map.set(key, Math.max(map.get(key) ?? 0, m));
  }
  penalties = map;
  return map;
}

// `at` says the car is at a known house (the one just delivered) facing one of its two directions, or `null` when
// that is not known; the first leg then costs what it really costs from that house instead of a straight-line guess.
export type StartSpec =
  | { kind: "library" }
  | { kind: "gps"; coord: Coord; at?: { houseId: string; facing: 0 | 1 | null } };

export type HeadingInput = {
  stopIds: readonly string[];
  coordOf: (id: string) => Coord | undefined;
  matrixIdOf?: (id: string) => string | undefined;   // lets a house borrow the road data of the built-in house at its address
  start: StartSpec;
};

type Built = { problem: Problem; index: Map<string, number>; estimated: number };

// Distances between exactly these houses, indexed by position in stopIds. Ordering adds the cut-through penalties;
// measuring a distance that will really be driven leaves them out.
export function buildProblem(input: HeadingInput & { withPenalties?: boolean }): Built {
  const d = data();
  const pen = input.withPenalties === false ? null : cutThroughPenalties();
  const ids = input.stopIds;
  const n = ids.length;
  const coords = ids.map((id) => {
    const c = input.coordOf(id);
    if (!c) throw new Error(`No coordinates for ${id}.`);
    return c;
  });
  const known = ids.map((id) => d.index.get(input.matrixIdOf?.(id) ?? id) ?? -1);
  const estimated = known.filter((k) => k < 0).length;

  const c = [0, 1, 2, 3].map(() => new Float32Array(n * n));
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const ka = known[a], kb = known[b];
      if (ka >= 0 && kb >= 0) {
        if (ka === kb) {
          // Two stops at one spot: the car stays where it is, still facing the way it was. Leaving this free in both
          // directions would read as an open tie, and the search assumes the worse facing after every tie.
          for (let q = 0; q < 4; q++) c[q][a * n + b] = q === 0 || q === 3 ? 0 : SAME_SPOT_TURN_M;
          continue;
        }
        const extra = pen ? pen.get(Math.min(ka, kb) * N + Math.max(ka, kb)) ?? 0 : 0;
        for (let q = 0; q < 4; q++) c[q][a * n + b] = metres(d.tables[q * N * N + ka * N + kb]) + extra;
      } else {
        const e = straightRoadMeters(coords[a], coords[b]);
        for (let q = 0; q < 4; q++) c[q][a * n + b] = e;
      }
    }
  }

  const start = [new Float32Array(n), new Float32Array(n)];
  if (input.start.kind === "library") {
    const from: Coord = { lat: LIBRARY.lat, lng: LIBRARY.lng };
    for (let b = 0; b < n; b++) {
      for (let t = 0; t < 2; t++) {
        start[t][b] = known[b] >= 0 ? metres(d.tables[4 * N * N + t * N + known[b]]) : straightRoadMeters(from, coords[b]);
      }
    }
  } else if (input.start.at && d.index.has(input.matrixIdOf?.(input.start.at.houseId) ?? input.start.at.houseId)) {
    // At the house just delivered, facing a known way: the real distances from that house.
    const here = input.start.coord;
    const { houseId, facing } = input.start.at;
    const fi = d.index.get(input.matrixIdOf?.(houseId) ?? houseId) as number;
    const there = input.coordOf(houseId);
    if (!there) throw new Error(`No coordinates for ${houseId}.`);
    const offset = haversineM(here, there) * CIRCUITY;
    for (let b = 0; b < n; b++) {
      for (let t = 0; t < 2; t++) {
        if (known[b] < 0 || known[b] === fi) { start[t][b] = known[b] === fi ? offset : offset + straightRoadMeters(there, coords[b]); continue; }
        const extra = pen ? pen.get(Math.min(fi, known[b]) * N + Math.max(fi, known[b])) ?? 0 : 0;
        const from = (s: number) => metres(d.tables[(s * 2 + t) * N * N + fi * N + known[b]]);
        start[t][b] = offset + extra + (facing === null ? Math.min(from(0), from(1)) : from(facing));
      }
    }
  } else {
    // Standing at (or beside) a known house, the first leg costs what it really costs from that house.
    const here = input.start.coord;
    let snap = -1;
    let snapDist = Infinity;
    for (let k = 0; k < n; k++) {
      if (known[k] < 0) continue;
      const m = haversineM(here, coords[k]);
      if (m < snapDist) { snapDist = m; snap = k; }
    }
    const useSnap = snap >= 0 && snapDist <= SNAP_M;
    for (let b = 0; b < n; b++) {
      for (let t = 0; t < 2; t++) {
        if (useSnap && known[b] >= 0) {
          const offset = snapDist * CIRCUITY;
          start[t][b] = b === snap ? offset : offset + Math.min(c[t][snap * n + b], c[2 + t][snap * n + b]);
        } else {
          start[t][b] = straightRoadMeters(here, coords[b]);
        }
      }
    }
  }
  return { problem: { n, c, start }, index: new Map(ids.map((id, k) => [id, k])), estimated };
}

export type HeadingOrderInput = HeadingInput & {
  fixedIds?: readonly string[];        // delivered first, in this order, never moved
  candidates: readonly (readonly string[])[];   // starting orders worth improving; the best result wins
  ms: number;                          // total time budget
};

export type HeadingOrderResult = {
  orderedIds: string[];
  distanceM: number;
  estimatedStops: number;
  candidateCosts?: number[];   // the cost of each starting order before it was improved, same measure as distanceM
};

// Orders the stops by improving each candidate order with the direction-aware search and keeping the shortest.
export function orderStops(input: HeadingOrderInput): HeadingOrderResult {
  if (input.stopIds.length === 0) return { orderedIds: [], distanceM: 0, estimatedStops: 0 };
  if (input.candidates.length === 0) throw new Error("orderStops needs at least one starting order.");
  const { problem, index, estimated } = buildProblem(input);
  const fixed = (input.fixedIds ?? []).map((id) => {
    const k = index.get(id);
    if (k === undefined) throw new Error(`Fixed stop ${id} isn't among the stops to order.`);
    return k;
  });
  const fixedSet = new Set(fixed);
  const stops = input.stopIds.map((_, k) => k);

  let best: { order: number[]; cost: number } | null = null;
  const candidateCosts: number[] = [];
  const cost = makeCost(problem);
  for (let i = 0; i < input.candidates.length; i++) {
    const ks = input.candidates[i].map((id) => {
      const k = index.get(id);
      if (k === undefined) throw new Error(`Starting order has ${id}, which isn't among the stops to order.`);
      return k;
    });
    if (new Set(ks).size !== stops.length || ks.length !== stops.length) {
      throw new Error("A starting order must list every stop exactly once.");
    }
    const start = fixed.concat(ks.filter((k) => !fixedSet.has(k)));
    candidateCosts.push(cost(start));
    const r = search(problem, start, { fixed: fixed.length, stops, ms: input.ms / input.candidates.length, seed: 1 + i });
    if (best === null || r.cost < best.cost) best = { order: r.order, cost: r.cost };
  }
  if (best === null) throw new Error("orderStops: no result.");
  return { orderedIds: best.order.map((k) => input.stopIds[k]), distanceM: best.cost, estimatedStops: estimated, candidateCosts };
}

// The distance score of an order without the cut-through penalties: what driving it is expected to cost. Used to
// judge whether changing an order is worth it, so a change made only to dodge a penalty doesn't count.
export function orderCost(input: HeadingInput & { order: readonly string[] }): number {
  if (input.order.length === 0) return 0;
  const { problem, index } = buildProblem({ ...input, stopIds: input.order, withPenalties: false });
  return makeCost(problem)(input.order.map((id) => index.get(id) as number));
}

// Which way the car is facing after delivering `order` in that order (0 or 1, as in the road data), or null when
// the last house isn't in the road data.
export function facingAfter(input: HeadingInput & { order: readonly string[] }): 0 | 1 | null {
  if (input.order.length === 0) return null;
  const { problem, index, estimated } = buildProblem({ ...input, stopIds: input.order, withPenalties: false });
  const last = input.order[input.order.length - 1];
  const known = (input.matrixIdOf?.(last) ?? last);
  if (estimated > 0 && !data().index.has(known)) return null;
  const states = statesGreedy(problem, input.order.map((id) => index.get(id) as number));
  return states[states.length - 1] as 0 | 1;
}

export type HeadingInsertInput = HeadingInput & {
  order: readonly string[];            // existing order, kept exactly
  add: readonly string[];              // houses to slot in
  fixedCount: number;                  // the first N of `order` stay at the front
};

// Slots new houses into an existing order where they add the least driving. stopIds must list order then add.
export function insertStops(input: HeadingInsertInput): HeadingOrderResult {
  const { problem, index, estimated } = buildProblem(input);
  const idx = (id: string) => {
    const k = index.get(id);
    if (k === undefined) throw new Error(`${id} isn't among the stops.`);
    return k;
  };
  const merged = insertCheapest(problem, input.order.map(idx), input.add.map(idx), input.fixedCount);
  return {
    orderedIds: merged.map((k) => input.stopIds[k]),
    distanceM: makeCost(problem)(merged),
    estimatedStops: estimated,
  };
}

// Road distance of each leg of an order (the first from the start), each leg taking the shortest way from the
// direction the car is facing.
export function legMeters(input: HeadingInput & { order: readonly string[] }): number[] {
  if (input.order.length === 0) return [];
  const { problem, index } = buildProblem({ ...input, stopIds: input.order, withPenalties: false });
  return legsGreedy(problem, input.order.map((id) => index.get(id) as number));
}

export function plannedMeters(input: HeadingInput & { order: readonly string[] }): number {
  return legMeters(input).reduce((t, m) => t + m, 0);
}
