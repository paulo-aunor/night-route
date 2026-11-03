// Delivery-order search that knows which way the car is facing.
//
// Plain distance matrices let the car reverse for free at every stop; a real drive can't, so "across the
// street, behind you" costs a loop round the block. Here every house has two states (the two directions of
// travel along its road). c[s*2+t][a*n+b] is the driving distance leaving house a facing state s and
// arriving at house b facing state t; start[t][b] is the same from where the shift begins.
//
// A leg takes the shortest way from the current direction and where it ends fixes the next direction. When
// two ways of arriving cost nearly the same (NEAR_TIE_M) the driver or navigation app may take either, so a
// plan is scored as if the worse one happens.
//
// Pure: no imports, so the app and scripts/bake-heading-seeds.mjs run the same code.

export const NEAR_TIE_M = 30;

export type Problem = {
  n: number;
  c: Float32Array[];       // four n*n tables, index s*2+t
  start: Float32Array[];   // two length-n rows, index t
};

export function makeCost(p: Problem, pen?: Float32Array): (o: ArrayLike<number>) => number {
  const n = p.n;
  const [c00, c01, c10, c11] = p.c;
  const [s0, s1] = p.start;
  return (o) => {
    const m = o.length;
    if (m === 0) return 0;
    const l0 = s0[o[0]], l1 = s1[o[0]];
    const lm = l0 < l1 ? l0 : l1;
    let w0 = l0 <= lm + NEAR_TIE_M ? l0 : -Infinity;
    let w1 = l1 <= lm + NEAR_TIE_M ? l1 : -Infinity;
    for (let i = 1; i < m; i++) {
      const ix = o[i - 1] * n + o[i];
      const extra = pen ? pen[ix] : 0;
      let n0 = -Infinity, n1 = -Infinity;
      if (w0 !== -Infinity) {
        const a = c00[ix], b = c01[ix], mn = a < b ? a : b;
        if (a <= mn + NEAR_TIE_M && w0 + a > n0) n0 = w0 + a;
        if (b <= mn + NEAR_TIE_M && w0 + b > n1) n1 = w0 + b;
      }
      if (w1 !== -Infinity) {
        const a = c10[ix], b = c11[ix], mn = a < b ? a : b;
        if (a <= mn + NEAR_TIE_M && w1 + a > n0) n0 = w1 + a;
        if (b <= mn + NEAR_TIE_M && w1 + b > n1) n1 = w1 + b;
      }
      w0 = n0 + extra; w1 = n1 + extra;
    }
    const r = w0 > w1 ? w0 : w1;
    return r === -Infinity ? Infinity : r;
  };
}

// Leg lengths along an order when every leg takes the shortest way from the current direction (first leg from the start).
export function legsGreedy(p: Problem, o: ArrayLike<number>): number[] {
  const n = p.n;
  let s = p.start[0][o[0]] <= p.start[1][o[0]] ? 0 : 1;
  const out = [p.start[s][o[0]]];
  for (let i = 1; i < o.length; i++) {
    const ix = o[i - 1] * n + o[i];
    const a = p.c[s * 2][ix], b = p.c[s * 2 + 1][ix];
    const t = a <= b ? 0 : 1;
    out.push(t === 0 ? a : b);
    s = t;
  }
  return out;
}

// The direction the car is facing at each house of an order (0 or 1), each leg taking the shortest way.
export function statesGreedy(p: Problem, o: ArrayLike<number>): number[] {
  const n = p.n;
  if (o.length === 0) return [];
  let s = p.start[0][o[0]] <= p.start[1][o[0]] ? 0 : 1;
  const out = [s];
  for (let i = 1; i < o.length; i++) {
    const ix = o[i - 1] * n + o[i];
    s = p.c[s * 2][ix] <= p.c[s * 2 + 1][ix] ? 0 : 1;
    out.push(s);
  }
  return out;
}

function bestPair(p: Problem, a: number, b: number): number {
  const ix = a * p.n + b;
  return Math.min(p.c[0][ix], p.c[1][ix], p.c[2][ix], p.c[3][ix]);
}

// The K nearest houses to each house, by best-case distance in either direction.
export function neighbourLists(p: Problem, stops: readonly number[], K: number): Map<number, number[]> {
  const lists = new Map<number, number[]>();
  for (const a of stops) {
    const d: [number, number][] = [];
    for (const b of stops) if (b !== a) d.push([Math.min(bestPair(p, a, b), bestPair(p, b, a)), b]);
    d.sort((x, y) => x[0] - y[0]);
    lists.set(a, d.slice(0, K).map((x) => x[1]));
  }
  return lists;
}

// The K houses cheapest to reach first from the start.
export function startNeighbours(p: Problem, stops: readonly number[], K: number): Set<number> {
  const d = stops.map((k) => [Math.min(p.start[0][k], p.start[1][k]), k] as [number, number]).sort((x, y) => x[0] - y[0]);
  return new Set(d.slice(0, K).map((x) => x[1]));
}

export type SearchOptions = {
  fixed?: number;               // the first N houses of the order never move
  stops: readonly number[];     // houses being ordered
  ms: number;                   // time budget
  seed?: number;
  pen?: Float32Array;           // per-pair corrections added to a leg's cost
};
export type SearchResult = { order: number[]; cost: number; kicks: number };

// Don't-look-bit local search: 2-opt and or-opt (1-3 houses, either way round), moves limited to near neighbours.
function improve(
  cost: (o: ArrayLike<number>) => number,
  order: number[],
  fixed: number,
  near: Map<number, number[]>,
  startNear: Set<number>,
  active: Iterable<number>,
  deadline: number,
): { order: number[]; cost: number } {
  let cur = order.slice();
  let best = cost(cur);
  const queue = [...active];
  const queued = new Set(queue);
  const pos = new Map<number, number>();
  const reindex = () => cur.forEach((k, i) => pos.set(k, i));
  reindex();
  const push = (k: number) => { if (!queued.has(k)) { queued.add(k); queue.push(k); } };
  const accept = (cand: number[], c: number, touched: number[]) => {
    cur = cand; best = c; reindex();
    for (const k of touched) { push(k); for (const nb of near.get(k) ?? []) push(nb); }
  };

  while (queue.length > 0 && Date.now() < deadline) {
    const x = queue.shift() as number;
    queued.delete(x);
    const i = pos.get(x);
    if (i === undefined || i < fixed) continue;
    let moved = false;

    // 2-opt: make x adjacent to one of its neighbours by reversing the stretch between them
    const targets = near.get(x) ?? [];
    for (const v of targets) {
      const j = pos.get(v);
      if (j === undefined || moved) continue;
      const a = j > i ? i + 1 : j + 1;
      const b = j > i ? j : i;
      if (a < fixed || a >= b) continue;
      const cand = cur.slice(0, a).concat(cur.slice(a, b + 1).reverse(), cur.slice(b + 1));
      const c = cost(cand);
      if (c < best - 1e-6) { accept(cand, c, [cur[a - 1] ?? cur[a], cur[a], cur[b], cur[b + 1] ?? cur[b]]); moved = true; }
    }
    // 2-opt that brings x to the front, when x is one of the houses cheapest to reach from the start
    if (!moved && fixed === 0 && startNear.has(x) && i > 0) {
      const cand = cur.slice(0, i + 1).reverse().concat(cur.slice(i + 1));
      const c = cost(cand);
      if (c < best - 1e-6) { accept(cand, c, [cur[0], cur[i], cur[i + 1] ?? cur[i]]); moved = true; }
    }
    if (moved) { push(x); continue; }

    // or-opt: move a stretch of 1-3 houses containing x next to a neighbour of either end (or to the front)
    for (let len = 1; len <= 3 && !moved; len++) {
      for (let st = i - len + 1; st <= i && !moved; st++) {
        if (st < fixed || st + len > cur.length) continue;
        const seg = cur.slice(st, st + len);
        const rest = cur.slice(0, st).concat(cur.slice(st + len));
        const slots = new Set<number>();
        for (const e of len === 1 ? [seg[0]] : [seg[0], seg[len - 1]]) {
          for (const v of near.get(e) ?? []) {
            const pv = rest.indexOf(v);
            if (pv >= 0) { slots.add(pv); slots.add(pv + 1); }
          }
        }
        if (startNear.has(x)) slots.add(fixed);
        for (const ins of slots) {
          if (ins < fixed || moved) continue;
          for (const flip of len === 1 ? [false] : [false, true]) {
            const piece = flip ? seg.slice().reverse() : seg;
            const cand = rest.slice(0, ins).concat(piece, rest.slice(ins));
            const c = cost(cand);
            if (c < best - 1e-6) { accept(cand, c, [...seg, rest[ins - 1] ?? seg[0], rest[ins] ?? seg[0]]); moved = true; break; }
          }
        }
      }
    }
    if (moved) push(x);
  }
  return { order: cur, cost: best };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Iterated local search from `start`: improve, then repeatedly shake a stretch and keep the result if it is shorter.
export function search(p: Problem, start: number[], opts: SearchOptions): SearchResult {
  const fixed = opts.fixed ?? 0;
  const deadline = Date.now() + opts.ms;
  const cost = makeCost(p, opts.pen);
  const near = neighbourLists(p, opts.stops, 12);
  const startNear = startNeighbours(p, opts.stops, 6);
  const rnd = mulberry32(opts.seed ?? 1);
  let cur = improve(cost, start, fixed, near, startNear, opts.stops, deadline);
  let best = cur;
  let kicks = 0;
  const free = cur.order.length - fixed;
  while (Date.now() < deadline && free >= 8) {
    kicks++;
    const o = cur.order.slice();
    const w = Math.min(free, 12 + Math.floor(rnd() * 30));
    const a0 = fixed + Math.floor(rnd() * (free - w + 1));
    const touched = new Set<number>();
    let kicked: number[];
    if (rnd() < 0.5) {
      // swap two neighbouring stretches inside a window
      const c1 = a0 + 1 + Math.floor(rnd() * (w - 2));
      const c2 = c1 + 1 + Math.floor(rnd() * (a0 + w - c1 - 1 || 1));
      kicked = o.slice(0, a0).concat(o.slice(c1, c2), o.slice(a0, c1), o.slice(c2));
      kicked.slice(a0, a0 + w).forEach((k) => touched.add(k));
    } else {
      // relocate a short stretch somewhere nearby
      const len = 1 + Math.floor(rnd() * 4);
      const from = a0 + Math.floor(rnd() * Math.max(1, w - len));
      const seg = o.splice(from, len);
      const to = Math.max(fixed, Math.min(o.length, a0 + Math.floor(rnd() * w)));
      o.splice(to, 0, ...seg);
      o.slice(Math.min(from, to), Math.min(o.length, Math.max(from, to) + len)).forEach((k) => touched.add(k));
      kicked = o;
    }
    const cand = improve(cost, kicked, fixed, near, startNear, touched, deadline);
    if (cand.cost < cur.cost - 1e-6) { cur = cand; if (cand.cost < best.cost) best = cand; }
  }
  return { order: best.order, cost: best.cost, kicks };
}

// Adds houses to an order that already exists without disturbing it: each round puts in whichever
// (house, position) pair adds the least, with the same scoring as the search.
export function insertCheapest(p: Problem, order: number[], add: readonly number[], fixed = 0, pen?: Float32Array): number[] {
  const cost = makeCost(p, pen);
  const cur = order.slice();
  const pending = [...add];
  while (pending.length > 0) {
    let bestCost = Infinity, bestPending = -1, bestPos = -1;
    for (let q = 0; q < pending.length; q++) {
      for (let pos = fixed; pos <= cur.length; pos++) {
        const c = cost(cur.slice(0, pos).concat(pending[q], cur.slice(pos)));
        if (c < bestCost) { bestCost = c; bestPending = q; bestPos = pos; }
      }
    }
    if (bestPending < 0) throw new Error("insertCheapest: no position gives a finite distance.");
    cur.splice(bestPos, 0, pending[bestPending]);
    pending.splice(bestPending, 1);
  }
  return cur;
}
