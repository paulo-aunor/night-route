// Steers an order away from roads you marked blocked.
//
// The road data can't be changed, so the way round it is to find which legs drive down a blocked road and make
// those pairs expensive, then order again. A new order has different legs, so it takes a few rounds to settle.
// Legs that are still blocked at the end are handed back, to be flagged on the stop.

import type { Coord } from "./optimizer-v2";

export type BlockedLeg = { from: string | null; to: string; streets: string[] };   // from === null: the leg out of the start

export type BlockedPlanInput = {
  order: readonly string[];
  startCoord: Coord;                                   // the library, or where the shift starts
  coordOf: (id: string) => Coord | undefined;
  blocked: ReadonlySet<string>;                        // road names, in the one form
  known?: ReadonlySet<string>;                         // pairs already learnt, so a round can be skipped
  streetOfHouse: (id: string) => string;               // a house on the blocked road has to be reached down it
  reorder: (pairs: ReadonlySet<string>) => string[];   // order again with these pairs made expensive
  streetsOnLegs: (points: readonly Coord[]) => Promise<string[][]>;
  rounds?: number;
};

export type BlockedPlan = {
  orderedIds: string[];
  pairs: Set<string>;        // every pair found to use a blocked road
  remaining: BlockedLeg[];   // legs of the final order that still use one
  rounds: number;
};

const key = (from: string, to: string) => `${from}>${to}`;

export async function planAroundBlocked(input: BlockedPlanInput): Promise<BlockedPlan> {
  const rounds = input.rounds ?? 3;
  const pairs = new Set(input.known ?? []);
  let order = pairs.size > 0 ? input.reorder(pairs) : [...input.order];
  let used = 0;

  if (input.blocked.size === 0) return { orderedIds: order, pairs, remaining: [], rounds: 0 };

  // A house on the blocked road can only be reached down it, so a leg into or out of one is never worth steering
  // around: it is reported and left alone.
  const unavoidable = (id: string | null) => id !== null && input.blocked.has(input.streetOfHouse(id));

  // The order with the fewest blocked legs wins, and ties go to the one found first, which is the shorter: making
  // a pair expensive distorts the route, so it is only kept when it buys a leg back.
  let best: { order: string[]; remaining: BlockedLeg[] } | null = null;

  for (let round = 0; round < rounds; round++) {
    used = round + 1;
    const coords = [input.startCoord, ...order.map((id) => {
      const c = input.coordOf(id);
      if (!c) throw new Error(`No coordinates for ${id}.`);
      return c;
    })];
    const legs = await input.streetsOnLegs(coords);
    const remaining: BlockedLeg[] = [];
    let found = 0;
    legs.forEach((streets, i) => {
      const hit = streets.filter((s) => input.blocked.has(s));
      if (hit.length === 0) return;
      const from = i === 0 ? null : order[i - 1];
      const to = order[i];
      remaining.push({ from, to, streets: hit });
      // the leg out of the start can't be swapped for another pair, so it is only ever reported
      if (from === null || unavoidable(from) || unavoidable(to)) return;
      if (!pairs.has(key(from, to))) { pairs.add(key(from, to)); found++; }
    });
    if (best === null || remaining.length < best.remaining.length) best = { order: [...order], remaining };
    if (found === 0) break;                   // nothing left worth steering around: this is as good as it gets
    if (round === rounds - 1) break;          // no round left to measure a new order in, so don't make one
    order = input.reorder(pairs);
  }
  if (best === null) throw new Error("planAroundBlocked: no order was checked.");
  return { orderedIds: best.order, pairs, remaining: best.remaining, rounds: used };
}
