// The rules behind the notifications, kept free of any phone module so they can be tested in Node.

import type { ShiftState, Subscriber } from "@/types";

export type PausedMap = Readonly<Record<string, true>>;

// The first house still to deliver: not ticked, not Stopped, and still on a route.
export function nextStop(s: ShiftState, paused: PausedMap, houses: ReadonlyMap<string, Subscriber>): Subscriber | null {
  const done = new Set(s.deliveredIds);
  for (const id of s.orderedIds) {
    if (done.has(id) || paused[id]) continue;
    const h = houses.get(id);
    if (h) return h;
  }
  return null;
}

export function stopsLeft(s: ShiftState, paused: PausedMap, houses: ReadonlyMap<string, Subscriber>): number {
  const done = new Set(s.deliveredIds);
  return s.orderedIds.filter((id) => !done.has(id) && !paused[id] && houses.has(id)).length;
}

// Ticking a house, whether in the app or from a notification. Ticking one already ticked changes nothing.
export function markDeliveredState(s: ShiftState, id: string, now: number): ShiftState {
  if (s.deliveredIds.includes(id)) return s;
  return {
    ...s,
    deliveredIds: [...s.deliveredIds, id],
    deliveredAt: { ...s.deliveredAt, [id]: now },
    skippedIds: s.skippedIds.filter((x) => x !== id),
  };
}

// ---- the "you're near the next house" alert ----

export const NEAR_M = 100;

export type NearState = { shift: number; houseId: string; outside: boolean; alerted: boolean };

// One GPS fix. The alert fires once per next house, when the car comes inside NEAR_M from outside it. A next house
// that is already inside NEAR_M when it becomes next (the one two doors down) does not alert, so a street of
// houses gives one alert on arrival, not one per door.
export function nearStep(prev: NearState | null, shift: number, houseId: string, distM: number): { state: NearState; alert: boolean } {
  const st: NearState = prev && prev.shift === shift && prev.houseId === houseId
    ? prev
    : { shift, houseId, outside: distM > NEAR_M, alerted: false };
  if (distM > NEAR_M) return { state: { ...st, outside: true }, alert: false };
  if (st.outside && !st.alerted) return { state: { ...st, outside: false, alerted: true }, alert: true };
  return { state: { ...st, outside: false }, alert: false };
}

// What the notification says about a house.
export function houseLine(h: Subscriber, depotNote: string | undefined, userNote: string | undefined): string {
  return [h.name, `${h.routeId}`, depotNote ? `📮 ${depotNote}` : "", userNote ? `✎ ${userNote}` : ""].filter(Boolean).join(" · ");
}
