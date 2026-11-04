import { useCallback, useEffect, useRef, useState } from "react";
import type { Optimization, RouteId, ShiftState } from "@/types";
import { anchorIdsFor } from "@/data/anchors";
import { SEED_ORDERS } from "@/data/seed-orders";
import { isAtLibrary } from "./location";
import { loadPaused } from "./paused";
import { facingAfter, insertStops, legMeters, orderCost, orderStops, plannedMeters, type StartSpec } from "./headingData";
import { appendRecord, buildRecord, routeBreakdown, type Leg } from "./history";
import { matrixIdOfHouse } from "./matrixAlias";
import { mergeOrder } from "./mergeOrder";
import { clearHouseNotifications, recordAlertError } from "./alerts";
import { markDeliveredState } from "./nextHouse";
import { onShiftChangedElsewhere } from "./shiftEvents";
import { haversineM, optimize as optimizeV2, type Coord } from "./optimizer-v2";
import {
  allSubscribers, importedSeed, isImportedRoute, revisionTag, subscribersForRoutes, subscribersForRoutesOn,
} from "./registry";
import { reopenShift, saveClosed } from "./reopen";
import { deliversOn, paperDayIndex } from "./schedule";
import { loadRateCents } from "./settings";
import { headingBefore, metersAt, stopTracking, trackDistance, trackedPoints, trackProfile } from "./tracking";
import {
  loadActiveShift, loadShift, saveShift, todayKey, newShift, clearShift,
  loadLastOrder, saveLastOrder, routeSetKey,
} from "./storage";

// Coordinates for every house that currently exists, imported routes included.
function coordLookup(): (id: string) => Coord | undefined {
  const byId = new Map<string, Coord>(allSubscribers().map((s) => [s.id, { lat: s.lat, lng: s.lng }]));
  return (id) => byId.get(id);
}

// Lets an imported house borrow the real driving distances of the built-in house at the same address.
function matrixLookup(): (id: string) => string | undefined {
  const byId = new Map<string, string | undefined>(allSubscribers().map((s) => [s.id, matrixIdOfHouse(s)]));
  return (id) => byId.get(id);
}

// Lets the "Finding your route" state paint before the solver blocks the JS thread.
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

// mergeOrder leaves houses it has never seen at the end; this slots them in properly.
function placeAdded(order: string[], saved: readonly string[] | null, seed: readonly string[] | null, routeIds: readonly string[]): string[] {
  const known = new Set([...(saved ?? []), ...(seed ?? [])]);
  const anchors = new Set(anchorIdsFor(routeIds, allSubscribers()));
  return placeNewHouses(order, known, anchors, coordLookup(), matrixLookup());
}

export type StartOptions = {
  startCoord?: Coord;              // live GPS fix; ignored when it's at the library
  excludeIds?: readonly string[];  // stopped houses, left out of the solve
};

// Exact pre-baked seed for this route set, or null when nothing matches.
// Subsets without an exact seed fall through to the on-device TS optimizer in
// start() instead of the old alpha-concat fallback (which left routes
// end-to-end instead of cross-route optimized).
function getExactSeed(routeIds: readonly string[]): string[] | null {
  // An imported route replaces a built-in one, so the baked seeds (built from the
  // old houses) can't apply; a route imported on its own has its own solved order.
  if (routeIds.some(isImportedRoute)) {
    return routeIds.length === 1 ? importedSeed(routeIds[0]) : null;
  }
  const seed = SEED_ORDERS[routeSetKey(routeIds)];
  return seed && seed.length ? seed : null;
}

// The order a route would be delivered in from the library right now, every house
// on it (all days): the last saved order if there is one, otherwise the seed.
// An update from a new PDF keeps this order and slots changes into it.
export async function currentRouteOrder(routeId: RouteId): Promise<string[]> {
  const ids = subscribersForRoutes([routeId]).map((s) => s.id);
  const saved = await loadLastOrder([routeId], revisionTag([routeId]));
  const seed = getExactSeed([routeId]);
  if (saved && saved.length) return mergeOrder(saved, ids, seed);
  if (seed) return mergeOrder(seed, ids, seed);
  throw new Error(`Route ${routeId} has no saved order or seed to build on.`);
}

// The reordering behind "Re-route from here". Delivered stops keep their place at
// the top, undelivered stops are re-solved from `here`, stopped houses stay at the
// bottom (hidden on screen, so Resume still works).
// A re-route or a start from a live location keeps the order the driver already has unless the new one is clearly
// shorter. The road model is within about 5% of real driving, and a predicted saving under about 3% turned out to
// be no saving on the real roads, so a smaller difference would only shuffle houses for nothing, and reshuffled houses are the ones that get driven past twice. The comparison leaves out the
// cut-through penalties: a mid-shift change made only to dodge one isn't worth the shuffle.
export const MIN_GAIN_M = 150;
export const MIN_GAIN_FRACTION = 0.03;
const worthChanging = (before: number, after: number): boolean => before - after >= Math.max(MIN_GAIN_M, MIN_GAIN_FRACTION * before);
const AT_HOUSE_M = 150;   // close enough to the house just delivered to count as standing at it

// Compass bearing (degrees from north, 0-360) along the great circle from a to b.
function bearingDeg(a: Coord, b: Coord): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const y = Math.sin(r(b.lng - a.lng)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Shortest angular distance between two compass bearings, 0-180.
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function planReroute(
  orderedIds: readonly string[],
  deliveredIds: readonly string[],
  stoppedIds: readonly string[],
  here: Coord,
  coordOf: (id: string) => Coord | undefined,
  matrixIdOf?: (id: string) => string | undefined,
  shiftStart?: Coord,   // where the shift began when it began from a live location; the library otherwise
  headingAt?: Record<string, number>,   // compass bearing (deg) recorded at each tick, from the GPS trail
): { orderedIds: string[]; stops: number; beforeM: number; afterM: number } {
  const stopped = new Set(stoppedIds);
  const delivered = new Set(deliveredIds);
  const doneInOrder = orderedIds.filter((id) => delivered.has(id));
  const remaining = orderedIds.filter((id) => !delivered.has(id) && !stopped.has(id));
  const hidden = orderedIds.filter((id) => !delivered.has(id) && stopped.has(id));
  if (remaining.length === 0) throw new Error("Nothing left to re-route.");
  // Standing near the house just delivered, the first leg costs what it really costs from that house, facing
  // the way the car was going. First try: a compass heading recorded at the tick. Fall back to an inference
  // from the tick order, and if the two disagree (about 180 apart) flip the inference to match what the
  // phone actually saw. Without a recorded heading the inference stands and the both-facings gate below
  // keeps the Re-route from making the drive longer.
  const last = deliveredIds[deliveredIds.length - 1];
  const prev = deliveredIds[deliveredIds.length - 2];
  const lastCoord = last === undefined ? undefined : coordOf(last);
  const prevCoord = prev === undefined ? undefined : coordOf(prev);
  const liveHeading = last !== undefined ? headingAt?.[last] : undefined;
  let at: { houseId: string; facing: 0 | 1 | null } | undefined;
  let headingSaysFlip = false;
  if (last !== undefined && lastCoord && haversineM(here, lastCoord) <= AT_HOUSE_M) {
    const begun: StartSpec = shiftStart ? { kind: "gps", coord: shiftStart } : { kind: "library" };
    const inferred = facingAfter({ stopIds: deliveredIds, order: deliveredIds, coordOf, matrixIdOf, start: begun });
    // If the live heading points roughly opposite to the direction the inferred model drove the last leg
    // in (the bearing from the previous house to the last), the model has the facing wrong. Flip it.
    if (liveHeading !== undefined && prevCoord && haversineM(prevCoord, lastCoord) > 20) {
      const flowBearing = bearingDeg(prevCoord, lastCoord);
      headingSaysFlip = angleDiff(flowBearing, liveHeading) > 120;
    }
    const facing: 0 | 1 | null = inferred === null ? null : headingSaysFlip ? ((1 - inferred) as 0 | 1) : inferred;
    at = { houseId: last, facing };
  }
  const start: StartSpec = { kind: "gps", coord: here, at };
  // Two starting points for the direction-aware search: the order as it stands, and a quick straight-distance order from here.
  const quick = optimizeV2({ stopIds: remaining, startCoord: here, coordOf, matrixIdOf, timeBudgetMs: 1000 });
  const solved = orderStops({ stopIds: remaining, coordOf, matrixIdOf, start, candidates: [remaining, quick.orderedIds], ms: 3000 });
  // When standing at the last house, the facing above is inferred from the tick order and can be wrong (parked across
  // the street, zig-zag deliveries, few ticks to go on): a new order that's shorter under the inferred facing can be
  // longer under the real one. So we check the saving under BOTH facings and only accept the new order when it's a
  // worthwhile saving either way the car might be pointing. Without `at` (standing between houses) there is nothing to
  // disambiguate, so the single start is checked as before.
  const startsToCheck: StartSpec[] = at
    ? ([0, 1] as const).map((f) => ({ kind: "gps", coord: here, at: { houseId: at.houseId, facing: f } }))
    : [start];
  const costOf = (s: StartSpec, order: readonly string[]) => orderCost({ stopIds: order, order, coordOf, matrixIdOf, start: s });
  const chosen = startsToCheck.every((s) => worthChanging(costOf(s, remaining), costOf(s, solved.orderedIds)))
    ? solved.orderedIds
    : remaining;
  // Road distance of the houses still to deliver, reported at the worse facing so the saving the UI shows holds up
  // whichever way the car is pointing.
  const metersFor = (order: readonly string[]) =>
    Math.max(...startsToCheck.map((s) => plannedMeters({ stopIds: remaining, order, coordOf, matrixIdOf, start: s })));
  const beforeM = metersFor(remaining);
  const afterM = metersFor(chosen);
  return { orderedIds: [...doneInOrder, ...chosen, ...hidden], stops: remaining.length, beforeM, afterM };
}

// The order for a shift that starts away from the library. The usual library order (when there is one) and a quick
// straight-distance order from here are both improved with the direction-aware search; the shorter one wins.
export function planFromGps(
  solvable: readonly string[],
  libraryOrder: readonly string[] | null,
  here: Coord,
  coordOf: (id: string) => Coord | undefined,
  matrixIdOf?: (id: string) => string | undefined,
): { orderedIds: string[]; beforeM: number | null; afterM: number } {
  const solvableSet = new Set(solvable);
  const quick = optimizeV2({ stopIds: solvable, startCoord: here, coordOf, matrixIdOf, timeBudgetMs: 1500 });
  const candidates = libraryOrder ? [libraryOrder.filter((id) => solvableSet.has(id)), quick.orderedIds] : [quick.orderedIds];
  const start: StartSpec = { kind: "gps", coord: here };
  const solved = orderStops({ stopIds: solvable, coordOf, matrixIdOf, start, candidates, ms: 4000 });
  // the previous order is the usual library order, now driven from where the shift starts
  const usual = libraryOrder ? libraryOrder.filter((id) => solvableSet.has(id)) : null;
  const cost = (order: readonly string[]) => orderCost({ stopIds: order, order, coordOf, matrixIdOf, start });
  const orderedIds = usual && !worthChanging(cost(usual), cost(solved.orderedIds)) ? usual : solved.orderedIds;
  return {
    orderedIds,
    beforeM: usual ? plannedMeters({ stopIds: usual, order: usual, coordOf, matrixIdOf, start }) : null,
    afterM: plannedMeters({ stopIds: orderedIds, order: orderedIds, coordOf, matrixIdOf, start }),
  };
}

// Houses that neither the saved order nor the baked seed knew about (ones added by hand) are slotted in where they add
// the least driving, instead of being left at the end of the list. C13's first nine stay first.
export function placeNewHouses(
  order: readonly string[],
  knownIds: ReadonlySet<string>,
  anchorIds: ReadonlySet<string>,
  coordOf: (id: string) => Coord | undefined,
  matrixIdOf?: (id: string) => string | undefined,
): string[] {
  const fresh = order.filter((id) => !knownIds.has(id));
  if (fresh.length === 0) return [...order];
  const base = order.filter((id) => knownIds.has(id));
  let lead = 0;
  while (lead < base.length && anchorIds.has(base[lead])) lead++;
  return insertStops({
    stopIds: [...base, ...fresh], order: base, add: fresh, fixedCount: lead, coordOf, matrixIdOf, start: { kind: "library" },
  }).orderedIds;
}

// A house added during a shift: slotted into the houses still to deliver where it adds the least driving from the
// last house delivered. What is already delivered stays where it is; stopped houses stay at the bottom, hidden.
export function insertIntoShift(
  orderedIds: readonly string[],
  deliveredIds: readonly string[],
  stoppedIds: readonly string[],
  houseId: string,
  coordOf: (id: string) => Coord | undefined,
  matrixIdOf?: (id: string) => string | undefined,
  shiftStart?: Coord,
): string[] {
  if (orderedIds.includes(houseId)) return [...orderedIds];
  const delivered = new Set(deliveredIds);
  const stopped = new Set(stoppedIds);
  const doneInOrder = orderedIds.filter((id) => delivered.has(id));
  const remaining = orderedIds.filter((id) => !delivered.has(id) && !stopped.has(id));
  const hidden = orderedIds.filter((id) => !delivered.has(id) && stopped.has(id));
  if (remaining.length === 0) return [...doneInOrder, houseId, ...hidden];
  const begun: StartSpec = shiftStart ? { kind: "gps", coord: shiftStart } : { kind: "library" };
  const last = deliveredIds[deliveredIds.length - 1];
  const lastCoord = last === undefined ? undefined : coordOf(last);
  const start: StartSpec = last !== undefined && lastCoord
    ? { kind: "gps", coord: lastCoord, at: { houseId: last, facing: facingAfter({ stopIds: deliveredIds, order: deliveredIds, coordOf, matrixIdOf, start: begun }) } }
    : begun;
  const placed = insertStops({ stopIds: [...remaining, houseId], order: remaining, add: [houseId], fixedCount: 0, coordOf, matrixIdOf, start });
  return [...doneInOrder, ...placed.orderedIds, ...hidden];
}

// Road distance of the shift as driven: `plannedM` along the whole order from where it started, `coveredM` along
// the houses delivered, in the order they were ticked. With `final` the houses Shift done counts as delivered
// follow, in the order they stand. Neither includes the drive home.
export function shiftDistances(s: ShiftState, stoppedIds: readonly string[], final: boolean): { plannedM: number; coveredM: number; legs: Leg[] } {
  const stopped = new Set(stoppedIds);
  const due = s.orderedIds.filter((id) => !stopped.has(id));
  const dueSet = new Set(due);
  const ticked = s.deliveredIds.filter((id) => dueSet.has(id));
  const tickedSet = new Set(ticked);
  const skipped = new Set(s.skippedIds);
  const walked = final ? [...ticked, ...due.filter((id) => !tickedSet.has(id) && !skipped.has(id))] : ticked;
  const start: StartSpec = s.startCoord ? { kind: "gps", coord: s.startCoord } : { kind: "library" };
  const coordOf = coordLookup(), matrixIdOf = matrixLookup();
  // the legs of the walk, each belonging to the route of the house it ends at
  const houses = new Map(allSubscribers().map((x) => [x.id, x]));
  const meters = legMeters({ stopIds: walked, order: walked, coordOf, matrixIdOf, start });
  const legs: Leg[] = walked.map((id, i) => {
    const route = houses.get(id)?.routeId;
    if (route === undefined) throw new Error(`House ${id} is on no route.`);
    return { route, meters: meters[i], t: tickedSet.has(id) ? s.deliveredAt?.[id] : null };
  });
  return {
    plannedM: plannedMeters({ stopIds: due, order: due, coordOf, matrixIdOf, start }),
    coveredM: meters.reduce((t, m) => t + m, 0),
    legs,
  };
}

// Writes the finished shift into the history (pay, counts, time, planned distance) before it is cleared,
// so a failure leaves the shift in place to try again.
export async function recordShift(s: ShiftState): Promise<void> {
  const [paused, rateCents] = await Promise.all([loadPaused(), loadRateCents()]);
  const stoppedIds = s.orderedIds.filter((id) => paused[id]);
  const subs = new Map(allSubscribers().map((x) => [x.id, x]));
  const { plannedM, coveredM, legs } = shiftDistances(s, stoppedIds, true);
  if (s.startedAt === null) throw new Error("This shift never started, so there is nothing to record.");
  const points = await trackedPoints(s.startedAt);   // the GPS recording; empty when there wasn't one
  const drivenM = points.length === 0 ? null : trackDistance(points).meters;
  const profile = points.length === 0 ? null : trackProfile(points).profile;
  const finishedAt = Date.now();
  const routeStats = routeBreakdown({ startedAt: s.startedAt, finishedAt, legs, drivenAt: profile ? (t) => metersAt(profile, t) : null });
  await appendRecord(buildRecord(s, {
    stoppedIds,
    rateCents,
    plannedM,
    coveredM,
    drivenM,
    routeStats,
    finishedAt,
    routeOf: (id) => subs.get(id)?.routeId,
  }));
  await stopTracking(s.startedAt, true);   // only once the shift is safely recorded; the points stay in case it is reopened
  await saveClosed(s, finishedAt);
}

export function useShift() {
  const [state, setState] = useState<ShiftState | null>(null);
  const [ready, setReady] = useState(false);

  // Mirror state to a ref so async callbacks (finish, finishAsDone) always see the
  // latest orderedIds even if React hasn't recomputed their memoized closure yet.
  // Without this, a fast drag → Shift-done sequence would save the pre-drag order.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    loadShift(todayKey()).then((s) => {
      setState(s);
      setReady(true);
    });
  }, []);

  const start = useCallback(async (routeIds: RouteId[], deliveryDayIdx?: number, opts?: StartOptions) => {
    const dayIdx = deliveryDayIdx ?? paperDayIndex();
    const eligibleIds = subscribersForRoutesOn(routeIds, dayIdx).map((s) => s.id);
    const excluded = new Set(opts?.excludeIds ?? []);
    const solvable = eligibleIds.filter((id) => !excluded.has(id));
    // Stopped houses stay in the order (hidden at render) so Resume works mid-shift.
    const hiddenTail = eligibleIds.filter((id) => excluded.has(id));

    const startCoord = opts?.startCoord;
    const fromGps = startCoord !== undefined && !isAtLibrary(startCoord);
    const coordOf = coordLookup();
    const revTag = revisionTag(routeIds);

    let orderedIds: string[];
    const optimizations: Optimization[] = [];
    if (fromGps) {
      // Away from the library: library-anchored seeds and saved orders don't fit,
      // so solve from where Paulo is standing.
      const saved = await loadLastOrder(routeIds, revTag);
      const seed = getExactSeed(routeIds);
      const base = saved && saved.length ? placeAdded(mergeOrder(saved, eligibleIds, seed), saved, seed, routeIds)
        : seed ? placeAdded(mergeOrder(seed, eligibleIds, seed), null, seed, routeIds) : null;
      await nextFrame();
      const plan = planFromGps(solvable, base, startCoord, coordOf, matrixLookup());
      orderedIds = [...plan.orderedIds, ...hiddenTail];
      if (plan.beforeM !== null) {
        optimizations.push({ at: Date.now(), kind: "start", houses: solvable.length, beforeM: plan.beforeM, afterM: plan.afterM });
      }
    } else {
      // Priority: saved last shift's order → exact seed → on-device solver.
      const saved = await loadLastOrder(routeIds, revTag);
      const seed = getExactSeed(routeIds);
      if (saved && saved.length) {
        orderedIds = placeAdded(mergeOrder(saved, eligibleIds, seed), saved, seed, routeIds);
      } else if (seed) {
        orderedIds = placeAdded(mergeOrder(seed, eligibleIds, seed), null, seed, routeIds);
      } else {
        const solvableSet = new Set(solvable);
        const preKeep = anchorIdsFor(routeIds, allSubscribers()).filter((id) => solvableSet.has(id));
        await nextFrame();
        const quick = optimizeV2({ stopIds: solvable, coordOf, matrixIdOf: matrixLookup(), preKeep, timeBudgetMs: 1000 });
        const r = orderStops({
          stopIds: solvable,
          coordOf,
          matrixIdOf: matrixLookup(),
          start: { kind: "library" },
          fixedIds: preKeep,
          candidates: [quick.orderedIds],
          ms: 3000,
        });
        orderedIds = [...r.orderedIds, ...hiddenTail];
      }
    }

    const s: ShiftState = {
      ...newShift(todayKey(), routeIds, orderedIds, dayIdx, fromGps ? "gps" : "library"),
      startCoord: fromGps ? startCoord : undefined,
      optimizations,
    };
    await saveShift(s);
    setState(s);
    return s;
  }, []);

  // Re-order everything not yet delivered, starting from `here`. Delivered stops
  // stay put at the top; stopped houses stay hidden at the bottom.
  const rerouteFrom = useCallback(async (here: Coord, stoppedIds: readonly string[]) => {
    const s = stateRef.current;
    if (!s) throw new Error("No shift in progress.");
    await nextFrame();
    const plan = planReroute(s.orderedIds, s.deliveredIds, stoppedIds, here, coordLookup(), matrixLookup(), s.startCoord, s.headingAt);
    setState((prev) => {
      if (!prev) return prev;
      const note: Optimization = { at: Date.now(), kind: "reroute", houses: plan.stops, beforeM: plan.beforeM, afterM: plan.afterM };
      const next: ShiftState = { ...prev, orderedIds: plan.orderedIds, startMode: "gps", optimizations: [...(prev.optimizations ?? []), note] };
      void saveShift(next);
      return next;
    });
    return { stops: plan.stops, beforeM: plan.beforeM, afterM: plan.afterM };
  }, []);

  const reorder = useCallback(async (orderedIds: string[]) => {
    setState((prev) => {
      if (!prev) return prev;
      const next: ShiftState = { ...prev, orderedIds };
      void saveShift(next);
      return next;
    });
  }, []);

  const markDelivered = useCallback(async (id: string) => {
    const s = stateRef.current;
    const now = Date.now();
    // Read the car's heading from the shift's GPS trail; tracking.ts writes every ~5 s. A missing or stale
    // heading (long stop, no fix) returns null and the tick stores no heading for this house.
    let heading: number | null = null;
    if (s && s.startedAt !== null) {
      try { heading = headingBefore(await trackedPoints(s.startedAt), now); }
      catch { heading = null; }
    }
    setState((prev) => {
      if (!prev) return prev;
      const next = markDeliveredState(prev, id, now, heading);
      if (next === prev) return prev;
      void saveShift(next);
      return next;
    });
  }, []);

  const unmarkDelivered = useCallback(async (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      const next: ShiftState = {
        ...prev,
        deliveredIds: prev.deliveredIds.filter((x) => x !== id),
        deliveredAt: Object.fromEntries(Object.entries(prev.deliveredAt ?? {}).filter(([k]) => k !== id)),
      };
      void saveShift(next);
      return next;
    });
  }, []);

  const markSkipped = useCallback(async (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      const next: ShiftState = {
        ...prev,
        skippedIds: prev.skippedIds.includes(id)
          ? prev.skippedIds
          : [...prev.skippedIds, id],
        deliveredIds: prev.deliveredIds.filter((x) => x !== id),
      };
      void saveShift(next);
      return next;
    });
  }, []);

  // Finish: save current order for reuse next shift with these routes, then clear the shift.
  const finish = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    await recordShift(s);
    if (s.startMode !== "gps") await saveLastOrder(s.routeIds, s.orderedIds, revisionTag(s.routeIds));
    await clearShift(todayKey());
    setState(null);
    void clearHouseNotifications().catch(recordAlertError);
  }, []);

  // Shift done: save order, clear the shift. Same as finish; the button is just always-available
  // so Paulo can end the shift even when some stops are unmarked.
  const finishAsDone = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    await recordShift(s);
    if (s.startMode !== "gps") await saveLastOrder(s.routeIds, s.orderedIds, revisionTag(s.routeIds));
    await clearShift(todayKey());
    setState(null);
    void clearHouseNotifications().catch(recordAlertError);
  }, []);

  // A house added by hand while a shift is open. It joins this shift only when it is on one of its routes and gets
  // paper on its day; returns the new order when it did, null when not (it is simply there from the next shift).
  const addToShift = useCallback(async (houseId: string): Promise<string[] | null> => {
    const s = stateRef.current;
    if (!s) return null;
    const house = allSubscribers().find((x) => x.id === houseId);
    if (!house) throw new Error("That house isn't on any route.");
    if (!s.routeIds.includes(house.routeId) || (s.deliveryDayIdx !== undefined && !deliversOn(house.schedule, s.deliveryDayIdx))) return null;
    const paused = await loadPaused();
    await nextFrame();
    const orderedIds = insertIntoShift(s.orderedIds, s.deliveredIds, s.orderedIds.filter((id) => paused[id]), houseId, coordLookup(), matrixLookup(), s.startCoord);
    const next: ShiftState = { ...s, orderedIds };
    await saveShift(next);
    setState(next);
    return orderedIds;
  }, []);

  // Undo for Shift done: puts the shift that just ended back as tonight's.
  const reopen = useCallback(async () => {
    const s = await reopenShift(todayKey(), Date.now());
    setState(s);
    return s;
  }, []);

  const reset = useCallback(async () => {
    const s = stateRef.current;
    if (s?.startedAt != null) await stopTracking(s.startedAt);
    await clearShift(todayKey());
    setState(null);
    void clearHouseNotifications().catch(recordAlertError);
  }, []);

  // The shift on disk changed behind this screen (a house ticked from a notification): take that copy, so the next
  // save here doesn't put the old one back.
  const reload = useCallback(async () => {
    setState(await loadActiveShift());
  }, []);
  useEffect(() => onShiftChangedElsewhere(() => { void reload(); }), [reload]);

  return { state, ready, start, rerouteFrom, reorder, markDelivered, unmarkDelivered, markSkipped, finish, finishAsDone, addToShift, reopen, reload, reset };
}
