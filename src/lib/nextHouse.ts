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
// `heading` is the compass direction the car was pointing at this moment (degrees from north), or null when the
// GPS trail didn't have one. It is stored for Re-route to use later; the function itself doesn't interpret it.
export function markDeliveredState(s: ShiftState, id: string, now: number, heading: number | null = null): ShiftState {
  if (s.deliveredIds.includes(id)) return s;
  return {
    ...s,
    deliveredIds: [...s.deliveredIds, id],
    deliveredAt: { ...s.deliveredAt, [id]: now },
    headingAt: heading == null ? s.headingAt : { ...s.headingAt, [id]: heading },
    skippedIds: s.skippedIds.filter((x) => x !== id),
  };
}

// ---- the "you're near the next house" alert ----

export const NEAR_M = 100;         // road distance to the next house at which the alert fires
export const NEAR_LOOK_M = 150;    // straight-line distance at which the road distance is asked for
export const LOOK_EVERY_MS = 20_000;
export const MAX_LOOKS = 3;        // road-distance lookups for one approach to one house

export type NearState = { shift: number; houseId: string; outside: boolean; alerted: boolean; looks: number; lookedAt: number };

// One GPS fix. The straight line is only a cheap first filter: when the car is within NEAR_LOOK_M of the next house
// after being further away, the road distance is looked up (`lookup`), and nearResolve decides from it. A house on a
// parallel street is close on the line and far by road, so the lookup repeats (up to MAX_LOOKS, every LOOK_EVERY_MS)
// while the car stays close. A next house that is already close when it becomes next (the one two doors down) is
// never looked up, so a street of houses gives one alert on arrival, not one per door.
export function nearStep(prev: NearState | null, shift: number, houseId: string, straightM: number, now: number): { state: NearState; lookup: boolean } {
  const st: NearState = prev && prev.shift === shift && prev.houseId === houseId
    ? prev
    : { shift, houseId, outside: straightM > NEAR_LOOK_M, alerted: false, looks: 0, lookedAt: 0 };
  if (straightM > NEAR_LOOK_M) return { state: { ...st, outside: true, looks: 0 }, lookup: false };
  if (st.outside && !st.alerted && st.looks < MAX_LOOKS && now - st.lookedAt >= LOOK_EVERY_MS) {
    return { state: { ...st, looks: st.looks + 1, lookedAt: now }, lookup: true };
  }
  return { state: st, lookup: false };
}

// The road distance came back: alert if it is within NEAR_M. A null (no drivable road between them) never alerts.
export function nearResolve(state: NearState, roadM: number | null): { state: NearState; alert: boolean } {
  if (roadM !== null && roadM <= NEAR_M) return { state: { ...state, outside: false, alerted: true }, alert: true };
  return { state, alert: false };
}

// What the notification says about a house.
export function houseLine(h: Subscriber, depotNote: string | undefined, userNote: string | undefined): string {
  return [h.name, `${h.routeId}`, depotNote ? `📮 ${depotNote}` : "", userNote ? `✎ ${userNote}` : ""].filter(Boolean).join(" · ");
}
