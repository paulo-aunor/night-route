// Distances along roads a car can use, from the public OpenStreetMap routing server (OSRM), instead of straight lines.
//
// Three uses: matching a shift's GPS track to the road network (the distance actually driven), the road distance
// between a car and the next house, and road distances from a house added by hand to the houses around it.
//
// This is the only place the app sends positions to a routing server. Callers say what they send. The public server
// is a shared demo (about one request a second is polite), so requests are spaced and kept few.

import type { TrackPoint } from "./tracking";
import { goodFixes, GAP_MS } from "./driving";
import { haversineM } from "./optimizer-v2";

export const OSRM = "https://router.project-osrm.org";
const REQUEST_GAP_MS = 1100;
const MATCH_MAX_POINTS = 10;     // the public server refuses 11 or more per request (checked 2026-11-09), however the docs read
const MIN_SPACING_M = 60;        // fixes closer than this are thinned out: on real drives 60 m gave the same distance as 25 m (within 0.2%) in half the requests
const MAX_JUMP_MS = 45;          // a leap faster than this between fixes (m/s) is a glitch, as in tracking.ts

export type RoadDeps = {
  fetchJson: (url: string) => Promise<unknown>;   // must throw on HTTP errors
  sleep: (ms: number) => Promise<void>;
};

export async function osrmJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "NightRoute/0.1 (demo)", Accept: "application/json" } });
    if (!res.ok) throw new Error(`The routing server answered ${res.status}.`);
    return await res.json();
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error("The routing server took too long to answer.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const realDeps: RoadDeps = { fetchJson: osrmJson, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

type P = { lat: number; lng: number };
const lonLat = (p: P) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

// ---- a shift's track ----

// The track as runs of fixes to match: split where the recording has a hole or the position jumps, thinned so fixes
// are at least MIN_SPACING_M apart (the last of a run is always kept), then cut into pieces the server accepts, each
// piece starting on the last point of the one before so the stretches join up.
export function matchingRuns(points: readonly TrackPoint[]): TrackPoint[][] {
  const fixes = goodFixes(points);
  const runs: TrackPoint[][] = [];
  let run: TrackPoint[] = [];
  for (const f of fixes) {
    const prev = run[run.length - 1];
    if (prev) {
      const dt = (f.t - prev.t) / 1000;
      if (dt <= 0) continue;
      if (dt * 1000 > GAP_MS || haversineM(prev, f) / dt > MAX_JUMP_MS) { runs.push(run); run = []; }
    }
    run.push(f);
  }
  runs.push(run);

  const pieces: TrackPoint[][] = [];
  for (const r of runs) {
    const thin: TrackPoint[] = [];
    for (const f of r) {
      const last = thin[thin.length - 1];
      if (!last || haversineM(last, f) >= MIN_SPACING_M) thin.push(f);
    }
    const tail = r[r.length - 1];
    if (thin.length > 0 && thin[thin.length - 1] !== tail && haversineM(thin[thin.length - 1], tail) > 5) thin.push(tail);
    for (let i = 0; i + 1 < thin.length; i += MATCH_MAX_POINTS - 1) pieces.push(thin.slice(i, i + MATCH_MAX_POINTS));
  }
  return pieces.filter((p) => p.length >= 2);
}

export type MatchResult = {
  meters: number;        // distance along the roads the track was matched to
  coverage: number;      // share of the submitted fixes the server could place on a road, 0 to 1
  pieces: number;
  unmatchedPieces: number;
};

type MatchBody = { code?: string; matchings?: { distance: number }[]; tracepoints?: (unknown | null)[] };

// The distance driven, along roads. Fixes the server can't place on a road (a car park, a lane it doesn't know) are
// left out, and `coverage` says how much that was. Throws when the server can't be reached.
export async function matchTrack(points: readonly TrackPoint[], deps: RoadDeps = realDeps, onProgress?: (done: number, total: number) => void): Promise<MatchResult> {
  const pieces = matchingRuns(points);
  let meters = 0, placed = 0, sent = 0, unmatchedPieces = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i > 0) await deps.sleep(REQUEST_GAP_MS);
    const radiuses = piece.map((p) => Math.round(Math.min(40, Math.max(15, (p.acc ?? 10) * 2)))).join(";");
    const url = `${OSRM}/match/v1/driving/${piece.map(lonLat).join(";")}?overview=false&gaps=ignore&tidy=true&radiuses=${radiuses}`;
    const body = (await deps.fetchJson(url)) as MatchBody;
    sent += piece.length;
    if (body.code === "NoMatch" || body.code === "NoSegment") { unmatchedPieces++; onProgress?.(i + 1, pieces.length); continue; }
    if (body.code !== "Ok" || !Array.isArray(body.matchings)) throw new Error(`The routing server couldn't match the track (${body.code ?? "no answer"}).`);
    meters += body.matchings.reduce((t, m) => t + m.distance, 0);
    placed += (body.tracepoints ?? []).filter((t) => t !== null).length;
    onProgress?.(i + 1, pieces.length);
  }
  return { meters, coverage: sent === 0 ? 0 : placed / sent, pieces: pieces.length, unmatchedPieces };
}

// ---- one car-to-house distance ----

// Road distance from one place to another, in metres. Null when there is no drivable route between them.
export async function roadDistanceM(from: P, to: P, deps: RoadDeps = realDeps): Promise<number | null> {
  const body = (await deps.fetchJson(`${OSRM}/route/v1/driving/${lonLat(from)};${lonLat(to)}?overview=false`)) as { code?: string; routes?: { distance: number }[] };
  if (body.code === "NoRoute") return null;
  if (body.code !== "Ok" || !body.routes?.[0]) throw new Error(`The routing server couldn't find a route (${body.code ?? "no answer"}).`);
  return body.routes[0].distance;
}

// ---- a house added by hand ----

export type RoadsAround = {
  out: Record<string, number>;   // from the new house to each neighbour, metres by road
  in: Record<string, number>;    // from each neighbour to the new house
  fromLibrary: number | null;    // from the library to the new house
};

// Road distances between a new house and the houses nearest it (and the library), both ways: two requests.
// `neighbours` are houses by id; any the server can't connect to the new house are left out of the answer.
export async function roadsAround(house: P, neighbours: readonly { id: string; lat: number; lng: number }[], library: P, deps: RoadDeps = realDeps): Promise<RoadsAround> {
  const others = [...neighbours, { id: "LIB", ...library }];
  const coords = [house, ...others].map(lonLat).join(";");
  const idx = others.map((_, i) => i + 1).join(";");
  const ask = async (q: string) => {
    const body = (await deps.fetchJson(`${OSRM}/table/v1/driving/${coords}?annotations=distance&${q}`)) as { code?: string; distances?: (number | null)[][] };
    if (body.code !== "Ok" || !body.distances) throw new Error(`The routing server couldn't give distances (${body.code ?? "no answer"}).`);
    return body.distances;
  };
  const outRow = (await ask(`sources=0&destinations=${idx}`))[0];
  await deps.sleep(REQUEST_GAP_MS);
  const inRows = await ask(`sources=${idx}&destinations=0`);
  const res: RoadsAround = { out: {}, in: {}, fromLibrary: null };
  others.forEach((o, i) => {
    const a = outRow[i], b = inRows[i]?.[0];
    if (o.id === "LIB") { res.fromLibrary = b ?? null; return; }
    if (a != null) res.out[o.id] = a;
    if (b != null) res.in[o.id] = b;
  });
  return res;
}
