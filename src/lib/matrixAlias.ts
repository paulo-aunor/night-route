import { SUBSCRIBERS } from "@/data/subscribers";
import type { Subscriber } from "@/types";
import { matrixHasId } from "./matrix";

// The bundled distance matrix is keyed by the built-in house ids. A house
// imported from a PDF gets a new id but is usually the same address, so it can
// borrow the built-in house's real driving distances. Only addresses the matrix
// has never seen fall back to the straight-line estimate.

const key = (address: string, city: string) =>
  `${address.replace(/\s+/g, " ").trim().toUpperCase()}|${city.replace(/\s+/g, " ").trim().toUpperCase()}`;

const byAddress = new Map<string, string>();
for (const s of SUBSCRIBERS) if (matrixHasId(s.id)) byAddress.set(key(s.address, s.city), s.id);

export function matrixIdFor(address: string, city: string): string | undefined {
  return byAddress.get(key(address, city));
}

// The road data for a house: the built-in house at its address, or for a house added by hand, the nearby one it was
// given as a twin.
export function matrixIdOfHouse(s: Pick<Subscriber, "address" | "city" | "roadTwin">): string | undefined {
  return matrixIdFor(s.address, s.city) ?? s.roadTwin;
}
