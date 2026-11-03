import { anchorIdsFor } from "@/data/anchors";
import type { Subscriber } from "@/types";
import { matrixIdFor } from "./matrixAlias";
import { insertStops, orderStops } from "./headingData";
import { optimize, type Coord } from "./optimizer-v2";
import { deriveRouteId, type ParsedRoute, type ParsedSub } from "./pdfRouteList";
import type { ImportedRoute } from "./registry-core";

// Imported houses get an id built from the address, not from their position in
// the PDF, so a house stopped or noted today is the same house after next
// month's re-import.
export function subscriberId(routeId: string, address: string, taken: Set<string>): string {
  const slug = address.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `${routeId}~${slug}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
  taken.add(id);
  return id;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? "";
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

export const addressNoteKey = (address: string) => address.replace(/\s+/g, " ").trim().toUpperCase();

// Notes are joined with " · ". A re-import carries the old combined note and the
// PDF supplies its own again, so compare segment by segment or they'd stack up.
function joinNotes(...parts: (string | undefined)[]): { note?: string } {
  const segments = parts.flatMap((x) => (x ? x.split(" · ") : [])).map((x) => x.trim()).filter(Boolean);
  const unique = [...new Set(segments)];
  return unique.length > 0 ? { note: unique.join(" · ") } : {};
}

export type BuiltRoute = {
  imported: Omit<ImportedRoute, "rev">;
  unplaced: ParsedSub[];      // rows whose address couldn't be located; left out of the route
  seedKm: number;             // length of the library-start order
  estimatedStops: number;     // stops whose distances are straight-line estimates
};

// What an update did to a route that already existed.
export type RouteChanges = {
  kept: number;
  added: Subscriber[];                // on the new PDF, not on the route before
  removed: Subscriber[];              // on the route before, not on the new PDF
  idMap: ReadonlyMap<string, string>; // old id -> new id for every house that stayed
};

export type UpdatedRoute = BuiltRoute & { changes: RouteChanges };

function placeSubscribers(
  parsed: ParsedRoute,
  coords: readonly (Coord | null)[],
  carry: ReadonlyMap<string, string>,
): { id: string; subs: Subscriber[]; unplaced: ParsedSub[] } {
  if (coords.length !== parsed.subs.length) throw new Error("importRoute: coordinates don't line up with the stops.");
  const id = deriveRouteId(parsed.code);
  const taken = new Set<string>();
  const subs: Subscriber[] = [];
  const unplaced: ParsedSub[] = [];

  parsed.subs.forEach((p, i) => {
    const c = coords[i];
    if (!c) { unplaced.push(p); return; }
    subs.push({
      id: subscriberId(id, p.address, taken),
      name: p.name,
      address: p.address,
      postal: p.postal,
      city: p.city,
      routeId: id,
      lat: c.lat,
      lng: c.lng,
      schedule: p.schedule,
      ...joinNotes(p.note, carry.get(addressNoteKey(p.address))),
    });
  });
  if (subs.length === 0) throw new Error(`None of the ${parsed.subs.length} addresses on ${parsed.code} could be located.`);
  return { id, subs, unplaced };
}

function routeRecord(parsed: ParsedRoute, id: string, subs: readonly Subscriber[]): ImportedRoute["route"] {
  return {
    id,
    code: parsed.code,
    city: mostCommon(subs.map((s) => s.city)),
    postalPrefix: mostCommon(subs.map((s) => s.postal.slice(0, 3))),
  };
}

export function buildImportedRoute(
  parsed: ParsedRoute,
  coords: readonly (Coord | null)[],
  now: number,
  carry: ReadonlyMap<string, string> = new Map(),
): BuiltRoute {
  const { id, subs, unplaced } = placeSubscribers(parsed, coords, carry);

  const byId = new Map(subs.map((s) => [s.id, { lat: s.lat, lng: s.lng }]));
  const addressOf = new Map(subs.map((s) => [s.id, matrixIdFor(s.address, s.city)]));
  const anchors = anchorIdsFor([id], subs);
  // A quick straight-distance order gives the direction-aware search something good to start from.
  const quick = optimize({
    stopIds: subs.map((s) => s.id),
    coordOf: (x) => byId.get(x),
    matrixIdOf: (x) => addressOf.get(x),
    preKeep: anchors,
    timeBudgetMs: 1500,
  });
  const solved = orderStops({
    stopIds: subs.map((s) => s.id),
    coordOf: (x) => byId.get(x),
    matrixIdOf: (x) => addressOf.get(x),
    start: { kind: "library" },
    fixedIds: anchors,
    candidates: [quick.orderedIds],
    ms: 3500,
  });

  return {
    imported: {
      route: routeRecord(parsed, id, subs),
      importedAt: now,
      subs,
      seed: solved.orderedIds,
    },
    unplaced,
    seedKm: solved.distanceM / 1000,
    estimatedStops: solved.estimatedStops,
  };
}

// Update a route that already exists from a newer full list. Houses are matched
// by address. Those still listed keep their place in `existing.order`, houses new
// to the list are slotted in where they add the least driving, and houses no
// longer listed are dropped. `existing.order` must cover every house in `existing.subs`.
export function buildUpdatedRoute(
  parsed: ParsedRoute,
  coords: readonly (Coord | null)[],
  now: number,
  carry: ReadonlyMap<string, string>,
  existing: { subs: readonly Subscriber[]; order: readonly string[] },
): UpdatedRoute {
  const { id, subs, unplaced } = placeSubscribers(parsed, coords, carry);

  const oldById = new Map(existing.subs.map((s) => [s.id, s]));
  for (const oid of existing.order) if (!oldById.has(oid)) throw new Error(`updateRoute: ${oid} is in the order but not on the route.`);
  if (new Set(existing.order).size !== existing.subs.length || existing.order.length !== existing.subs.length) {
    throw new Error("updateRoute: the existing order doesn't list each house exactly once.");
  }

  // Pair old and new houses sharing an address, in route order on the old side and
  // list order on the new side, so two apartments at one address pair up one to one.
  const waiting = new Map<string, Subscriber[]>();
  for (const s of subs) {
    const k = addressNoteKey(s.address);
    waiting.set(k, [...(waiting.get(k) ?? []), s]);
  }
  const idMap = new Map<string, string>();
  const removed: Subscriber[] = [];
  const paired = new Set<string>();
  for (const oid of existing.order) {
    const old = oldById.get(oid)!;
    const candidates = waiting.get(addressNoteKey(old.address));
    const next = candidates?.shift();
    if (next) { idMap.set(oid, next.id); paired.add(next.id); } else removed.push(old);
  }
  const added = subs.filter((s) => !paired.has(s.id));

  // Anchored houses (C13's first nine) always lead, wherever the update finds them.
  const anchors = anchorIdsFor([id], subs);
  const anchorSet = new Set(anchors);
  const body = existing.order.flatMap((oid) => {
    const nid = idMap.get(oid);
    return nid && !anchorSet.has(nid) ? [nid] : [];
  });

  const byId = new Map(subs.map((s) => [s.id, { lat: s.lat, lng: s.lng }]));
  const addressOf = new Map(subs.map((s) => [s.id, matrixIdFor(s.address, s.city)]));
  const kept = [...anchors, ...body];
  const fresh = added.filter((s) => !anchorSet.has(s.id)).map((s) => s.id);
  const placed = insertStops({
    stopIds: [...kept, ...fresh],
    order: kept,
    add: fresh,
    fixedCount: anchors.length,
    coordOf: (x) => byId.get(x),
    matrixIdOf: (x) => addressOf.get(x),
    start: { kind: "library" },
  });

  return {
    imported: {
      route: routeRecord(parsed, id, subs),
      importedAt: now,
      subs,
      seed: placed.orderedIds,
    },
    unplaced,
    seedKm: placed.distanceM / 1000,
    estimatedStops: placed.estimatedStops,
    changes: { kept: idMap.size, added, removed, idMap },
  };
}
