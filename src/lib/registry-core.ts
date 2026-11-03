// Pure route registry logic: which routes exist, which are shown, and what each
// action does to the saved state. No React, no storage, so it runs in Node tests.
//
// Built-in routes ship inside the app (src/data). Imported routes come from PDFs.
//   hidden   - kept, just not offered on the home screen (activate to bring back)
//   removed  - a built-in route the user deleted; Restore brings it back
//   added    - houses typed in by hand (a new start), kept beside the route's own houses
// Deleting an imported route erases its data.

import type { Route, Subscriber } from "@/types";

export type ImportedRoute = {
  route: Route;
  rev: number;            // bumps on every import; saved orders for older revisions are ignored
  importedAt: number;
  subs: Subscriber[];
  seed: string[];         // library-start order, solved when the route was imported
};

export type RegistryState = {
  imported: Record<string, ImportedRoute>;
  hidden: string[];
  removed: string[];
  added: Subscriber[];
};

export type BuiltIns = { routes: readonly Route[]; subs: readonly Subscriber[] };

export const EMPTY_STATE: RegistryState = { imported: {}, hidden: [], removed: [], added: [] };

export type RouteStatus = "active" | "hidden" | "removed";
export type RouteEntry = { route: Route; status: RouteStatus; imported: boolean; stops: number };

const without = (list: readonly string[], id: string) => list.filter((x) => x !== id);
const withId = (list: readonly string[], id: string) => (list.includes(id) ? [...list] : [...list, id]);

const isBuiltInId = (b: BuiltIns, id: string) => b.routes.some((r) => r.id === id);

// Routes that currently exist, hidden ones included.
export function effectiveRoutes(s: RegistryState, b: BuiltIns): Route[] {
  const builtIn = b.routes.filter((r) => !s.imported[r.id] && !s.removed.includes(r.id));
  const imported = Object.values(s.imported).map((i) => i.route);
  return [...builtIn, ...imported];
}

// Routes offered on the home screen.
export function visibleRoutes(s: RegistryState, b: BuiltIns): Route[] {
  return effectiveRoutes(s, b).filter((r) => !s.hidden.includes(r.id));
}

export function isImported(s: RegistryState, id: string): boolean {
  return !!s.imported[id];
}

// Every house on a route that currently exists (hidden routes included, so a
// shift already in progress keeps working).
export function effectiveSubs(s: RegistryState, b: BuiltIns): Subscriber[] {
  const live = new Set(effectiveRoutes(s, b).map((r) => r.id));
  const builtIn = b.subs.filter((x) => live.has(x.routeId) && !s.imported[x.routeId]);
  const imported = Object.values(s.imported).flatMap((i) => i.subs);
  const added = s.added.filter((x) => live.has(x.routeId));
  return [...builtIn, ...imported, ...added];
}

export function subscribersFor(s: RegistryState, b: BuiltIns, routeIds: readonly string[]): Subscriber[] {
  const want = new Set(routeIds);
  return effectiveSubs(s, b).filter((x) => want.has(x.routeId));
}

// Routes the manager screen lists: hidden ones, plus built-ins that were removed.
export function managedRoutes(s: RegistryState, b: BuiltIns): RouteEntry[] {
  const subs = effectiveSubs(s, b);
  const count = (id: string) => subs.filter((x) => x.routeId === id).length;
  const out: RouteEntry[] = [];
  for (const r of effectiveRoutes(s, b)) {
    if (s.hidden.includes(r.id)) out.push({ route: r, status: "hidden", imported: isImported(s, r.id), stops: count(r.id) });
  }
  for (const id of s.removed) {
    const r = b.routes.find((x) => x.id === id);
    if (r && !s.imported[id]) out.push({ route: r, status: "removed", imported: false, stops: b.subs.filter((x) => x.routeId === id).length });
  }
  return out;
}

// Key part for saved orders: empty while every route is built-in (so existing
// saved orders keep working), otherwise names each imported route's revision.
export function revisionTag(s: RegistryState, routeIds: readonly string[]): string {
  return [...routeIds]
    .sort()
    .filter((id) => s.imported[id])
    .map((id) => `${id}:${s.imported[id].rev}`)
    .join(",");
}

// ---- actions: each returns the next state, or throws with a message for the user ----

export function importRoute(s: RegistryState, incoming: Omit<ImportedRoute, "rev">): RegistryState {
  const id = incoming.route.id;
  const prev = s.imported[id];
  return {
    imported: { ...s.imported, [id]: { ...incoming, rev: (prev?.rev ?? 0) + 1 } },
    hidden: without(s.hidden, id),
    removed: without(s.removed, id),
    // the incoming list is the whole route now; a house added by hand is in it or was deliberately dropped
    added: s.added.filter((h) => h.routeId !== id),
  };
}

export function hideRoute(s: RegistryState, b: BuiltIns, id: string): RegistryState {
  if (!effectiveRoutes(s, b).some((r) => r.id === id)) throw new Error(`Route ${id} doesn't exist.`);
  return { ...s, hidden: withId(s.hidden, id) };
}

export function activateRoute(s: RegistryState, id: string): RegistryState {
  return { ...s, hidden: without(s.hidden, id) };
}

export function deleteRoute(s: RegistryState, b: BuiltIns, id: string): RegistryState {
  if (!effectiveRoutes(s, b).some((r) => r.id === id)) throw new Error(`Route ${id} doesn't exist.`);
  const imported = { ...s.imported };
  delete imported[id];
  // A built-in route (or one an import replaced) is marked removed, not erased,
  // so it can be restored; an imported-only route is simply gone.
  const removed = isBuiltInId(b, id) ? withId(s.removed, id) : [...s.removed];
  // Houses added by hand go with an imported route; on a built-in route that can come back they wait for the restore.
  const keepAdded = isBuiltInId(b, id) && !s.imported[id];
  return { imported, hidden: without(s.hidden, id), removed, added: keepAdded ? s.added : s.added.filter((h) => h.routeId !== id) };
}

export function restoreRoute(s: RegistryState, b: BuiltIns, id: string): RegistryState {
  if (!s.removed.includes(id)) throw new Error(`Route ${id} wasn't removed.`);
  if (!isBuiltInId(b, id)) throw new Error(`Route ${id} can't be restored.`);
  return { ...s, removed: without(s.removed, id) };
}

// ---- houses added by hand ----

const sameAddress = (a: Subscriber, b: Subscriber) =>
  `${a.address}|${a.postal}`.toUpperCase().replace(/\s+/g, " ").trim() === `${b.address}|${b.postal}`.toUpperCase().replace(/\s+/g, " ").trim();

export function addHouse(s: RegistryState, b: BuiltIns, house: Subscriber): RegistryState {
  if (!effectiveRoutes(s, b).some((r) => r.id === house.routeId)) throw new Error(`Route ${house.routeId} doesn't exist.`);
  const all = effectiveSubs(s, b);
  if (all.some((x) => x.id === house.id)) throw new Error(`A house with id ${house.id} already exists.`);
  if (all.some((x) => x.routeId === house.routeId && sameAddress(x, house))) {
    throw new Error(`${house.address} is already on route ${house.routeId}.`);
  }
  return { ...s, added: [...s.added, house] };
}

export function isAddedHouse(s: RegistryState, id: string): boolean {
  return s.added.some((h) => h.id === id);
}

// Only houses added by hand can be removed; a house from a route list is Stopped instead.
export function removeAddedHouse(s: RegistryState, id: string): RegistryState {
  if (!isAddedHouse(s, id)) throw new Error("That house wasn't added by hand, so it can't be removed. Stop it instead.");
  return { ...s, added: s.added.filter((h) => h.id !== id) };
}
