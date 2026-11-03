// A new start typed in by hand: validates the form and builds the house the registry stores.

import type { Subscriber } from "@/types";
import { haversineM, SNAP_M } from "./optimizer-v2";

// The two delivery patterns in the route lists.
export const SCHEDULES = [
  { value: "Mon-Sat", label: "Every day" },
  { value: "FriSat", label: "Fri and Sat only" },
] as const;
export type ScheduleValue = (typeof SCHEDULES)[number]["value"];

export type NewHouseInput = {
  name: string;
  address: string;
  postal: string;
  city: string;
  routeId: string;
  schedule: ScheduleValue;
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const POSTAL = /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/;

// Cleans the form into the shape the route lists use (upper case, "N1G 9G5"). Throws a message fit to show.
export function cleanHouseInput(input: NewHouseInput): NewHouseInput {
  const address = collapse(input.address).toUpperCase();
  if (!/^\d+[A-Z]?\s+\S/.test(address)) throw new Error("The address needs a house number and a street, like 14 FAIRVIEW BLVD.");
  const city = collapse(input.city);
  if (!city) throw new Error("Pick a city.");
  if (!input.routeId) throw new Error("Pick a route.");
  let postal = collapse(input.postal).toUpperCase();
  if (postal) {
    if (!POSTAL.test(postal)) throw new Error("The postal code should look like N1G 9G5, or be left empty.");
    postal = `${postal.slice(0, 3)} ${postal.slice(-3)}`;
  }
  return { name: collapse(input.name).toUpperCase() || "NEW START", address, postal, city, routeId: input.routeId, schedule: input.schedule };
}

export const newHouseId = (routeId: string, now: number): string => `ADD-${routeId}-${now.toString(36)}`;

// A house the road data has never seen would be priced from the straight line, and the search then assumes the worst
// about which way the car faces after it, so it lands blocks from its real neighbours. Instead it borrows the road
// data of the nearest house that has some, if one is within SNAP_M: the new house is then ordered as that
// house's neighbour.
export function findRoadTwin(
  coord: { lat: number; lng: number },
  houses: readonly Subscriber[],
  matrixIdOf: (h: Subscriber) => string | undefined,
): string | undefined {
  let best: string | undefined;
  let bestM = SNAP_M;
  for (const h of houses) {
    const id = matrixIdOf(h);
    if (id === undefined) continue;
    const m = haversineM(coord, h);
    if (m <= bestM) { bestM = m; best = id; }
  }
  return best;
}

export function buildHouse(input: NewHouseInput, coord: { lat: number; lng: number }, now: number, roadTwin?: string): Subscriber {
  const c = cleanHouseInput(input);
  return {
    id: newHouseId(c.routeId, now),
    routeId: c.routeId,
    name: c.name,
    address: c.address,
    postal: c.postal,
    city: c.city,
    schedule: c.schedule,
    lat: coord.lat,
    lng: coord.lng,
    ...(roadTwin ? { roadTwin } : {}),
  };
}
