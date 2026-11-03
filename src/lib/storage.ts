import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RouteId, ShiftState } from "@/types";

const KEY_PREFIX = "@rr/shift/";
// v13: bumped 2026-10-19 to pick up the B21+A7+A11 subset seed (cross-route
// optimized, 209 stops · 33.77 km · 89.8 min, vs ~42 km alpha-concat fallback).
// v14: bumped 2026-10-23 so the direction-aware seeds (scripts/bake-heading-seeds.mjs)
// replace orders saved from the old seeds, which sent the car round blocks to reverse.
const LAST_ORDER_PREFIX = "@rr/lastOrder/v14/";

export function todayKey(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export async function loadShift(date: string): Promise<ShiftState | null> {
  const raw = await AsyncStorage.getItem(KEY_PREFIX + date);
  return raw ? JSON.parse(raw) : null;
}

// The shift that is open, whatever date it was saved under (the key is the UTC date it started on, which is not
// always today's). The notifications run without a screen and cannot assume today's key.
export async function loadActiveShift(): Promise<ShiftState | null> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(KEY_PREFIX));
  let best: ShiftState | null = null;
  for (const k of keys) {
    const raw = await AsyncStorage.getItem(k);
    if (!raw) continue;
    const s = JSON.parse(raw) as ShiftState;
    if (s.finishedAt === null && s.startedAt !== null && (best === null || s.startedAt > (best.startedAt ?? 0))) best = s;
  }
  return best;
}

export async function saveShift(state: ShiftState): Promise<void> {
  await AsyncStorage.setItem(KEY_PREFIX + state.date, JSON.stringify(state));
}

export async function clearShift(date: string): Promise<void> {
  await AsyncStorage.removeItem(KEY_PREFIX + date);
}

export function newShift(
  date: string,
  routeIds: RouteId[],
  orderedIds: string[],
  deliveryDayIdx: number,
  startMode: "library" | "gps" = "library",
): ShiftState {
  return {
    date,
    routeIds,
    startedAt: Date.now(),
    finishedAt: null,
    deliveredIds: [],
    skippedIds: [],
    orderedIds,
    deliveryDayIdx,
    startMode,
  };
}

export function routeSetKey(routeIds: readonly string[]): string {
  return [...routeIds].sort().join("+");
}

// `revTag` names the revision of each imported route in the set ("" when every
// route is built in, which keeps existing saved orders valid). Re-importing a
// route changes its houses, so orders saved for the old revision stop matching.
const orderKey = (routeIds: readonly string[], revTag: string) =>
  LAST_ORDER_PREFIX + routeSetKey(routeIds) + (revTag ? `#${revTag}` : "");

export async function loadLastOrder(routeIds: readonly string[], revTag = ""): Promise<string[] | null> {
  const raw = await AsyncStorage.getItem(orderKey(routeIds, revTag));
  return raw ? JSON.parse(raw) : null;
}

export async function saveLastOrder(routeIds: readonly string[], orderedIds: string[], revTag = ""): Promise<void> {
  await AsyncStorage.setItem(orderKey(routeIds, revTag), JSON.stringify(orderedIds));
}
