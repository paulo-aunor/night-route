// Address -> coordinates for imported routes.
//
// Known addresses (anything already in the app, built-in or previously imported)
// are reused, so re-importing a route costs no lookups. New ones go to
// Nominatim (OpenStreetMap) at its limit of one request per second. Apartment
// units share their building's coordinates, so each building is looked up once.
//
// "No match" and "lookup failed" are different: a miss is reported per address,
// a network or server failure throws and stops the import.

export type Coord = { lat: number; lng: number };

export type GeoDeps = {
  fetchJson: (url: string) => Promise<unknown>;   // must throw on HTTP errors
  sleep: (ms: number) => Promise<void>;
  known: ReadonlyMap<string, Coord>;              // addressKey -> coordinates
};

export type GeoProgress = { done: number; total: number; lookups: number };

export class GeocodeCancelled extends Error {
  constructor() { super("Geocoding was cancelled."); }
}

// Waterloo Region plus a margin. A hit outside this box is a wrong match.
const BOX = { latMin: 43.25, latMax: 43.75, lngMin: -80.75, lngMax: -80.15 };
const NOMINATIM_GAP_MS = 1100;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

// "30 SHADYBROOK CRES" -> "14 FAIRVIEW BLVD"
export function streetOnly(address: string): string {
  return collapse(address.replace(/\s+(?:APT|UNIT|SUITE|STE|#)\s*\S+.*$/i, "").replace(/\s+#\S+.*$/, ""));
}

export function addressKey(address: string, city: string): string {
  return `${streetOnly(address).toUpperCase()}|${collapse(city).toUpperCase()}`;
}

function inBox(c: Coord): boolean {
  return c.lat >= BOX.latMin && c.lat <= BOX.latMax && c.lng >= BOX.lngMin && c.lng <= BOX.lngMax;
}

// The request Nominatim's usage policy asks for: a User-Agent that says who is asking. Throws on HTTP errors.
export async function nominatimJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": "NightRoute/0.1 (demo)", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`The address lookup service answered ${res.status}. Try again in a minute.`);
  return res.json();
}

type Match = { coord: Coord; label: string };

async function lookup(deps: GeoDeps, q: string): Promise<Match | null> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ca&q=" + encodeURIComponent(q);
  const body = await deps.fetchJson(url);
  if (!Array.isArray(body) || body.length === 0) return null;
  const hit = body[0] as { lat?: string; lon?: string; display_name?: string };
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const coord = { lat, lng };
  return inBox(coord) ? { coord, label: hit.display_name ?? "" } : null;
}

// One address, for a house added by hand. Reuses coordinates the app already has for that building; otherwise asks
// Nominatim, and returns the place it matched so the match can be checked before the house is saved.
export type FoundAddress = { coord: Coord; label: string; reused: boolean };

export async function findAddress(row: GeoRow, deps: GeoDeps): Promise<FoundAddress | null> {
  const known = deps.known.get(addressKey(row.address, row.city));
  if (known) return { coord: known, label: "a building already on your routes", reused: true };
  const street = streetOnly(row.address);
  const first = await lookup(deps, [street, row.city, "ON", row.postal].filter(Boolean).join(", "));
  if (first) return { ...first, reused: false };
  await deps.sleep(NOMINATIM_GAP_MS);
  const second = await lookup(deps, `${street}, ${row.city}, ON`);
  return second ? { ...second, reused: false } : null;
}

export type GeoRow = { address: string; city: string; postal: string };

export type GeoResult = {
  coords: (Coord | null)[];   // same order as the input rows; null = not found
  reused: number;             // buildings answered from known coordinates
  lookedUp: number;           // buildings answered by Nominatim
};

export async function geocodeRows(
  rows: readonly GeoRow[],
  deps: GeoDeps,
  onProgress?: (p: GeoProgress) => void,
  shouldCancel?: () => boolean,
): Promise<GeoResult> {
  // One lookup per distinct building.
  const keyOf = rows.map((r) => addressKey(r.address, r.city));
  const firstRowFor = new Map<string, number>();
  keyOf.forEach((k, i) => { if (!firstRowFor.has(k)) firstRowFor.set(k, i); });

  const resolved = new Map<string, Coord | null>();
  let reused = 0;
  let lookedUp = 0;
  let lookups = 0;
  let done = 0;
  const total = firstRowFor.size;

  for (const [key, i] of firstRowFor) {
    if (shouldCancel?.()) throw new GeocodeCancelled();
    const known = deps.known.get(key);
    if (known) {
      resolved.set(key, known);
      reused++;
    } else {
      const street = streetOnly(rows[i].address);
      const city = rows[i].city;
      if (lookups > 0) await deps.sleep(NOMINATIM_GAP_MS);
      lookups++;
      let c = (await lookup(deps, `${street}, ${city}, ON, ${rows[i].postal}`))?.coord ?? null;
      if (!c) {
        await deps.sleep(NOMINATIM_GAP_MS);
        lookups++;
        c = (await lookup(deps, `${street}, ${city}, ON`))?.coord ?? null;
      }
      resolved.set(key, c);
      if (c) lookedUp++;
    }
    done++;
    onProgress?.({ done, total, lookups });
  }

  return { coords: keyOf.map((k) => resolved.get(k) ?? null), reused, lookedUp };
}
