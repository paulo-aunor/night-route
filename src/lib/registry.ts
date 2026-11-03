// Persistent route registry: built-in routes plus routes imported from PDFs,
// with hide / activate / delete / restore. The logic lives in registry-core.ts;
// this file adds storage and a React hook.
//
// Every change is saved before it is applied, and a failure to save or to read
// is reported to the caller, never swallowed.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";
import { DEPOT_NOTES } from "@/data/depot-notes";
import { ROUTES } from "@/data/routes";
import { SUBSCRIBERS } from "@/data/subscribers";
import type { Route, Subscriber } from "@/types";
import { addressKey, type Coord } from "./geocode";
import { addressNoteKey } from "./importRoute";
import * as core from "./registry-core";
import { deliversOn } from "./schedule";

const KEY = "@rr/registry/v1";
const BUILT_INS: core.BuiltIns = { routes: ROUTES, subs: SUBSCRIBERS };

type Snapshot = { ready: boolean; error: string | null; state: core.RegistryState };

let snap: Snapshot = { ready: false, error: null, state: core.EMPTY_STATE };
const listeners = new Set<() => void>();
const emit = (next: Partial<Snapshot>) => {
  snap = { ...snap, ...next };
  listeners.forEach((l) => l());
};

function parseState(raw: string): core.RegistryState {
  const v = JSON.parse(raw) as Partial<core.RegistryState>;
  if (!v || typeof v.imported !== "object" || v.imported === null || !Array.isArray(v.hidden) || !Array.isArray(v.removed)) {
    throw new Error("the saved data isn't in the expected shape");
  }
  if (v.added !== undefined && !Array.isArray(v.added)) throw new Error("the saved data isn't in the expected shape");
  return { imported: v.imported, hidden: v.hidden, removed: v.removed, added: v.added ?? [] };
}

let loading: Promise<void> | null = null;
export function loadRegistry(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        emit({ ready: true, error: null, state: raw ? parseState(raw) : core.EMPTY_STATE });
      } catch (e) {
        emit({ ready: true, error: `Couldn't read your saved routes: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
  }
  return loading;
}

let writes: Promise<unknown> = Promise.resolve();
function mutate(change: (s: core.RegistryState) => core.RegistryState): Promise<void> {
  const run = writes.then(async () => {
    if (snap.error) {
      throw new Error("Your saved routes couldn't be read, so changes are blocked to avoid overwriting them.");
    }
    const next = change(snap.state);
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
    emit({ state: next });
  });
  writes = run.catch(() => undefined);
  return run;
}

export const registry = {
  importRoute: (incoming: Omit<core.ImportedRoute, "rev">) => mutate((s) => core.importRoute(s, incoming)),
  hide: (id: string) => mutate((s) => core.hideRoute(s, BUILT_INS, id)),
  activate: (id: string) => mutate((s) => core.activateRoute(s, id)),
  remove: (id: string) => mutate((s) => core.deleteRoute(s, BUILT_INS, id)),
  restore: (id: string) => mutate((s) => core.restoreRoute(s, BUILT_INS, id)),
  addHouse: (house: Subscriber) => mutate((s) => core.addHouse(s, BUILT_INS, house)),
  removeAddedHouse: (id: string) => mutate((s) => core.removeAddedHouse(s, id)),
};

// ---- reads (synchronous, from the current state) ----

export const visibleRoutes = (): Route[] => core.visibleRoutes(snap.state, BUILT_INS);
export const effectiveRoutes = (): Route[] => core.effectiveRoutes(snap.state, BUILT_INS);
export const managedRoutes = (): core.RouteEntry[] => core.managedRoutes(snap.state, BUILT_INS);
export const allSubscribers = (): Subscriber[] => core.effectiveSubs(snap.state, BUILT_INS);
export const isImportedRoute = (id: string): boolean => core.isImported(snap.state, id);
export const isAddedHouse = (id: string): boolean => core.isAddedHouse(snap.state, id);
export const revisionTag = (routeIds: readonly string[]): string => core.revisionTag(snap.state, routeIds);
export const importedSeed = (id: string): string[] | null => snap.state.imported[id]?.seed ?? null;

export const subscribersForRoutes = (routeIds: readonly string[]): Subscriber[] =>
  core.subscribersFor(snap.state, BUILT_INS, routeIds);

export const subscribersForRoutesOn = (routeIds: readonly string[], dayIdx: number): Subscriber[] =>
  subscribersForRoutes(routeIds).filter((s) => deliversOn(s.schedule, dayIdx));

export function countByRoute(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of allSubscribers()) counts[s.routeId] = (counts[s.routeId] ?? 0) + 1;
  return counts;
}

export function countByRouteOn(dayIdx: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of allSubscribers()) {
    if (!deliversOn(s.schedule, dayIdx)) continue;
    counts[s.routeId] = (counts[s.routeId] ?? 0) + 1;
  }
  return counts;
}

// Coordinates the app already has, by building, so a re-import needs no lookups.
export function knownCoordinates(): Map<string, Coord> {
  const known = new Map<string, Coord>();
  for (const s of allSubscribers()) known.set(addressKey(s.address, s.city), { lat: s.lat, lng: s.lng });
  return known;
}

// Depot delivery notes on a route's houses, by address, so replacing the route
// from a PDF keeps them (the notes are keyed by the old house ids).
export function carriedNotes(routeId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of subscribersForRoutes([routeId])) {
    const note = DEPOT_NOTES[s.id] ?? s.note;
    if (note) out.set(addressNoteKey(s.address), note);
  }
  return out;
}

export function useRegistry(): Snapshot {
  useEffect(() => {
    void loadRegistry();
  }, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snap,
  );
}
