// Roads you can't use: closed for construction, gated, a lane you're not allowed down. The map doesn't know, so
// this is your own list, and the optimizer plans around it (src/lib/blockedPlan.ts).
//
// One-way streets, turn bans and dead ends are already in the map the distances come from, so they don't belong
// here; put a road here only when the map thinks it's open and it isn't.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { normalizeStreet } from "./streets";

const KEY = "@rr/blocked/v1";
const PAIRS_KEY = "@rr/blocked/pairs/v1";

export type BlockedRoad = {
  id: string;
  street: string;        // the one form, so the router's name for it matches (src/lib/streets.ts)
  label: string;         // as you picked or typed it
  note?: string;
  addedAt: number;
  until: number | null;  // null until you remove it
};

export function makeBlocked(label: string, now: number, until: number | null = null, note?: string): BlockedRoad {
  const street = normalizeStreet(label);
  if (!street) throw new Error("Type or pick the road that is blocked.");
  return { id: String(now), street, label: label.trim(), addedAt: now, until, ...(note?.trim() ? { note: note.trim() } : {}) };
}

export const isLive = (b: BlockedRoad, now: number): boolean => b.until === null || b.until > now;

// The roads to plan around right now, newest first.
export function liveRoads(list: readonly BlockedRoad[], now: number): BlockedRoad[] {
  return list.filter((b) => isLive(b, now)).sort((a, b) => b.addedAt - a.addedAt);
}

export const liveStreets = (list: readonly BlockedRoad[], now: number): Set<string> =>
  new Set(liveRoads(list, now).map((b) => b.street));

// Names which roads are blocked, so pairs learnt for one list aren't reused for a different one.
export const signatureOf = (streets: ReadonlySet<string>): string => [...streets].sort().join("|");

export async function loadBlocked(): Promise<BlockedRoad[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  const v = JSON.parse(raw) as unknown;
  if (!Array.isArray(v)) throw new Error("The saved list of blocked roads isn't in the expected shape.");
  return v as BlockedRoad[];
}

export async function saveBlocked(list: readonly BlockedRoad[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(list));
}

export async function addBlocked(road: BlockedRoad): Promise<BlockedRoad[]> {
  const list = await loadBlocked();
  if (list.some((b) => b.street === road.street && b.until === null)) throw new Error(`${road.label} is already on the list.`);
  const next = [...list, road];
  await saveBlocked(next);
  return next;
}

export async function removeBlocked(id: string): Promise<BlockedRoad[]> {
  const next = (await loadBlocked()).filter((b) => b.id !== id);
  await saveBlocked(next);
  return next;
}

// ---- the house pairs whose road goes through a blocked street ----
//
// Working these out needs the router, so once learnt they are kept: a later shift, or a re-route with no signal,
// still steers around them. They are dropped when the list of blocked roads changes.

export type LearntPairs = { signature: string; pairs: string[] };

// The pairs learnt for exactly this list of blocked roads, and whether they were ever worked out for it: a list
// that has been planned for before needs one look to flag the stops, not a fresh search.
export async function loadPairs(signature: string): Promise<{ pairs: Set<string>; planned: boolean }> {
  const raw = await AsyncStorage.getItem(PAIRS_KEY);
  if (!raw) return { pairs: new Set(), planned: false };
  const v = JSON.parse(raw) as LearntPairs;
  if (!v || v.signature !== signature || !Array.isArray(v.pairs)) return { pairs: new Set(), planned: false };
  return { pairs: new Set(v.pairs), planned: true };
}

export async function savePairs(signature: string, pairs: ReadonlySet<string>): Promise<void> {
  await AsyncStorage.setItem(PAIRS_KEY, JSON.stringify({ signature, pairs: [...pairs] } satisfies LearntPairs));
}
