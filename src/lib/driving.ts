// How a shift was driven, worked out from its GPS track: distance, stops, speed, braking, houses driven past before
// they were delivered, and where delivery left the planned order. Pure (no phone modules), so it runs in Node tests
// and can be re-run on a stored shift whenever the rules improve.
//
// All of it is only as good as the phone's fixes: one every 5 s at best, a few metres to a few tens of metres off.
// The thresholds below are chosen for that, and the review screen says so.

import { trackDistance, type TrackPoint } from "./tracking";

export const STOP_SPEED_MS = 0.8;        // slower than this is standing still (about 3 km/h)
export const MIN_STOP_S = 20;            // a pause shorter than this is not counted as a stop
export const GAP_MS = 60_000;            // no fix for this long: the recording has a hole, not a stop
export const FAST_MS = 50 / 3.6;         // 50 km/h, the usual city limit; time above it is reported
export const HARD_MS2 = 3.0;             // m/s per second: braking or accelerating this hard is reported
export const PASS_M = 25;                // the track came this close to a house: the car drove past it
export const SAME_PASS_MS = 20_000;      // close approaches this near in time are one pass
export const DELIVERY_WINDOW_MS = 180_000; // a tick belongs to the pass within this of it
const SPEED_SPAN_S = 10;                 // the phone's speed stands for a leg only up to this long
const MAX_ACCURACY_M = 50;
const MAX_SPEED_MS = 45;                 // a jump faster than this between fixes is a glitch
const MIN_MOVE_M = 5;

type Fix = TrackPoint;
type P = { lat: number; lng: number };

function haversineM(a: P, b: P): number {
  const R = 6_371_000, r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Fixes in time order, without the ones too inaccurate to use.
export function goodFixes(points: readonly Fix[]): Fix[] {
  return [...points].filter((p) => p.acc === null || p.acc <= MAX_ACCURACY_M).sort((a, b) => a.t - b.t);
}

type Seg = { a: Fix; b: Fix; dt: number; d: number; v: number };

// The legs between consecutive good fixes with a usable speed. Holes in the recording and glitch jumps are left out.
function segments(fixes: readonly Fix[]): { segs: Seg[]; gapS: number } {
  const segs: Seg[] = [];
  let gapS = 0;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1], b = fixes[i];
    const ms = b.t - a.t;
    if (ms <= 0) continue;
    if (ms > GAP_MS) { gapS += ms / 1000; continue; }
    const dt = ms / 1000, d = haversineM(a, b);
    if (d / dt > MAX_SPEED_MS) continue;
    const noise = Math.max(MIN_MOVE_M, 0.5 * ((a.acc ?? 0) + (b.acc ?? 0)));
    const derived = d < noise ? 0 : d / dt;
    // The phone's own speed (from the radio's doppler shift) is steadier than position differences, when it is there.
    // Over a long leg the two end speeds say little about the stretch between them, so position is used instead.
    const v = a.sp != null && b.sp != null && dt <= SPEED_SPAN_S ? (a.sp + b.sp) / 2 : derived;
    segs.push({ a, b, dt, d, v });
  }
  return { segs, gapS };
}

export type DrivingStats = {
  movedM: number;            // distance moved (the same figure the history keeps)
  recordedS: number;         // time covered by fixes
  movingS: number;
  stoppedS: number;          // time in stops of MIN_STOP_S or more
  stops: number;
  longestStopS: number;
  gapS: number;              // time with no fixes (phone asleep, GPS off, tunnel)
  topKmh: number | null;
  avgMovingKmh: number | null;
  aboveLimitS: number;       // time over 50 km/h
  hardBrakes: number;
  hardAccels: number;
};

export function drivingStats(points: readonly Fix[]): DrivingStats {
  const fixes = goodFixes(points);
  const { segs, gapS } = segments(fixes);
  let movingS = 0, movingM = 0, aboveLimitS = 0, recordedS = 0, top = 0;
  let stoppedS = 0, stops = 0, longestStopS = 0, run = 0;
  const endRun = () => {
    if (run >= MIN_STOP_S) { stops++; stoppedS += run; longestStopS = Math.max(longestStopS, run); }
    run = 0;
  };
  for (const s of segs) {
    recordedS += s.dt;
    if (s.v >= STOP_SPEED_MS) {
      endRun();
      movingS += s.dt; movingM += s.v * s.dt;
      if (s.v > FAST_MS) aboveLimitS += s.dt;
      if (s.v > top) top = s.v;
    } else {
      run += s.dt;
    }
  }
  endRun();

  // Braking and acceleration over spans of at most a few seconds. With the phone's own speed at both fixes the change
  // between them is used directly; without it, the speeds of two consecutive legs are compared (smoother, so it
  // misses the shorter ones). At one fix every 5 s only the hard ones show, and a short one may be missed or split.
  let hardBrakes = 0, hardAccels = 0, lastBrakeT = -Infinity, lastAccelT = -Infinity;
  const hard = (accel: number, vBefore: number, vAfter: number, t: number) => {
    if (accel <= -HARD_MS2 && vBefore >= 5 && t - lastBrakeT > 3000) { hardBrakes++; lastBrakeT = t; }
    if (accel >= HARD_MS2 && vAfter >= 4 && t - lastAccelT > 3000) { hardAccels++; lastAccelT = t; }
  };
  const hasSpeed = (s: Seg) => s.a.sp != null && s.b.sp != null;
  for (let k = 0; k < segs.length; k++) {
    const s1 = segs[k];
    if (s1.dt > 6) continue;
    if (hasSpeed(s1)) {
      hard(((s1.b.sp as number) - (s1.a.sp as number)) / s1.dt, s1.a.sp as number, s1.b.sp as number, s1.b.t);
      continue;
    }
    const s2 = segs[k + 1];
    if (!s2 || s2.a.t !== s1.b.t || hasSpeed(s2)) continue;   // not consecutive, or measured legs are handled above
    const dtm = (s1.dt + s2.dt) / 2;
    if (dtm > 6) continue;
    hard((s2.v - s1.v) / dtm, s1.v, s2.v, s1.b.t);
  }

  return {
    movedM: trackDistance(points).meters,
    recordedS, movingS, stoppedS, stops, longestStopS, gapS,
    topKmh: segs.length === 0 ? null : top * 3.6,
    avgMovingKmh: movingS === 0 ? null : (movingM / movingS) * 3.6,
    aboveLimitS, hardBrakes, hardAccels,
  };
}

// ---- houses driven past before they were delivered ----

export type HouseAt = { id: string; lat: number; lng: number };
export type PassEvent = { t: number; distM: number };
export type HousePasses = {
  id: string;
  before: PassEvent[];      // passes earlier than the one the delivery tick belongs to
  deliveredAt: number;      // time of the delivery pass
};

const KLAT = 111_320;

// Every time the track came within PASS_M of the house: each stretch of close approach is one event, at its closest.
function passEvents(house: HouseAt, fixes: readonly Fix[]): PassEvent[] {
  const kx = KLAT * Math.cos((house.lat * Math.PI) / 180);
  const hx = house.lng * kx, hy = house.lat * KLAT;
  const hits: PassEvent[] = [];
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1], b = fixes[i];
    const ms = b.t - a.t;
    if (ms <= 0 || ms > GAP_MS) continue;
    const ax = a.lng * kx, ay = a.lat * KLAT, bx = b.lng * kx, by = b.lat * KLAT;
    if (hx < Math.min(ax, bx) - PASS_M || hx > Math.max(ax, bx) + PASS_M || hy < Math.min(ay, by) - PASS_M || hy > Math.max(ay, by) + PASS_M) continue;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((hx - ax) * dx + (hy - ay) * dy) / len2));
    const d = Math.hypot(hx - (ax + u * dx), hy - (ay + u * dy));
    if (d <= PASS_M) hits.push({ t: a.t + u * ms, distM: d });
  }
  // Close approaches within SAME_PASS_MS of the previous one belong to the same pass; its time is the closest approach.
  const events: (PassEvent & { lastHit: number })[] = [];
  for (const h of hits) {
    const last = events[events.length - 1];
    if (last && h.t - last.lastHit <= SAME_PASS_MS) {
      if (h.distM < last.distM) { last.distM = h.distM; last.t = h.t; }
      last.lastHit = h.t;
    } else {
      events.push({ ...h, lastHit: h.t });
    }
  }
  return events.map(({ t, distM }) => ({ t, distM }));
}

// For each ticked house: the passes the car made before the one it was delivered on. `tickAt` is when each was ticked.
// A house with no pass near its tick (the track never came close, or it was not recorded then) is left out, as is a
// house that was never ticked: nothing says when it was delivered.
export function passesBeforeDelivery(houses: readonly HouseAt[], points: readonly Fix[], tickAt: Readonly<Record<string, number>>): { found: HousePasses[]; unmatched: number } {
  const fixes = goodFixes(points);
  const found: HousePasses[] = [];
  let unmatched = 0;
  for (const h of houses) {
    const tick = tickAt[h.id];
    if (tick === undefined) continue;
    const events = passEvents(h, fixes);
    let delivery = -1, best = Infinity;
    events.forEach((e, i) => {
      const gap = Math.abs(e.t - tick);
      if (gap <= DELIVERY_WINDOW_MS && gap < best) { best = gap; delivery = i; }
    });
    if (delivery < 0) { unmatched++; continue; }
    found.push({ id: h.id, before: events.slice(0, delivery), deliveredAt: events[delivery].t });
  }
  return { found, unmatched };
}

// ---- where delivery left the planned order ----

export type OrderShift = { id: string; planned: number; delivered: number };

// Houses delivered out of the planned order: the ones outside the longest run that stayed in order. `planned` and
// `delivered` are ranks among the houses that were both planned and ticked.
export function orderDeviation(plannedOrder: readonly string[], deliveredOrder: readonly string[]): { compared: number; outOfOrder: number; shifts: OrderShift[] } {
  const plannedIndex = new Map(plannedOrder.map((id, i) => [id, i]));
  const delivered = deliveredOrder.filter((id) => plannedIndex.has(id));
  const compared = delivered.length;
  if (compared === 0) return { compared: 0, outOfOrder: 0, shifts: [] };
  const rankOf = new Map([...delivered].sort((a, b) => (plannedIndex.get(a) as number) - (plannedIndex.get(b) as number)).map((id, i) => [id, i]));
  const seq = delivered.map((id) => rankOf.get(id) as number);   // planned rank of each house, in delivery order
  // longest increasing subsequence with its members
  const tails: number[] = [], tailIdx: number[] = [], prev: number[] = new Array(seq.length).fill(-1);
  seq.forEach((v, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  });
  const keep = new Set<number>();
  for (let i = tailIdx[tails.length - 1]; i >= 0; i = prev[i]) keep.add(i);
  const shifts = delivered
    .map((id, i) => ({ id, planned: seq[i], delivered: i }))
    .filter((_, i) => !keep.has(i))
    .sort((a, b) => Math.abs(b.planned - b.delivered) - Math.abs(a.planned - a.delivered));
  return { compared, outOfOrder: compared - keep.size, shifts };
}

// ---- a whole shift ----

export type ShiftAnalysis = {
  stats: DrivingStats;
  passes: { houses: number; total: number; unmatched: number; list: HousePasses[] };
  order: { compared: number; outOfOrder: number; shifts: OrderShift[] } | null;
  timePerHouse: { ticked: number; medianS: number | null; meanS: number | null; slowest: { id: string; s: number }[] };
};

export type AnalysisInput = {
  points: readonly Fix[];
  houses: readonly HouseAt[];                 // every house on the shift, with coordinates
  tickAt: Readonly<Record<string, number>>;   // when each house was ticked
  tickOrder: readonly string[];               // houses in the order they were ticked
  plannedOrder: readonly string[] | null;     // the order the shift started with; null when it wasn't kept
  startedAt: number;
};

export function analyzeShift(input: AnalysisInput): ShiftAnalysis {
  const stats = drivingStats(input.points);
  const { found, unmatched } = passesBeforeDelivery(input.houses, input.points, input.tickAt);
  const passed = found.filter((f) => f.before.length > 0);
  const order = input.plannedOrder ? orderDeviation(input.plannedOrder, input.tickOrder) : null;

  // Time per house: the gap from the previous tick (the first from the shift's start). Gaps over 15 minutes are
  // breaks, not houses, and are left out.
  const gaps: { id: string; s: number }[] = [];
  let prev = input.startedAt;
  for (const id of input.tickOrder) {
    const t = input.tickAt[id];
    if (t === undefined) continue;
    const s = (t - prev) / 1000;
    if (s >= 0 && s <= 900) gaps.push({ id, s });
    prev = t;
  }
  const sorted = gaps.map((g) => g.s).sort((a, b) => a - b);
  const medianS = sorted.length === 0 ? null : sorted[(sorted.length - 1) >> 1] / 2 + sorted[sorted.length >> 1] / 2;
  const meanS = sorted.length === 0 ? null : sorted.reduce((t, x) => t + x, 0) / sorted.length;
  return {
    stats,
    passes: { houses: passed.length, total: passed.reduce((t, f) => t + f.before.length, 0), unmatched, list: passed.sort((a, b) => b.before.length - a.before.length) },
    order,
    timePerHouse: { ticked: gaps.length, medianS, meanS, slowest: [...gaps].sort((a, b) => b.s - a.s).slice(0, 5) },
  };
}

// The few numbers the history keeps for each shift, so reports can add them up without opening the track.
export type DrivingSummary = {
  stops: number; stoppedS: number; topKmh: number | null; avgMovingKmh: number | null; aboveLimitS: number;
  hardBrakes: number; hardAccels: number; passedHouses: number; passes: number; outOfOrder: number | null; gapS: number;
};

export function summarize(a: ShiftAnalysis): DrivingSummary {
  return {
    stops: a.stats.stops, stoppedS: a.stats.stoppedS, topKmh: a.stats.topKmh, avgMovingKmh: a.stats.avgMovingKmh,
    aboveLimitS: a.stats.aboveLimitS, hardBrakes: a.stats.hardBrakes, hardAccels: a.stats.hardAccels,
    passedHouses: a.passes.houses, passes: a.passes.total, outOfOrder: a.order ? a.order.outOfOrder : null, gapS: a.stats.gapS,
  };
}
