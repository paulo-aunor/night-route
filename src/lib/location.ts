import * as Location from "expo-location";
import { LIBRARY } from "@/data/routes";
import type { Coord } from "./optimizer-v2";

// Within this distance of the library, a GPS start is treated as a library
// start so the pre-baked OR-Tools seeds and saved orders still apply.
export const LIBRARY_RADIUS_M = 400;

export function metersBetween(a: Coord, b: Coord): number {
  const R = 6_371_000;
  const toR = (x: number) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat);
  const dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function isAtLibrary(c: Coord): boolean {
  return metersBetween(c, { lat: LIBRARY.lat, lng: LIBRARY.lng }) <= LIBRARY_RADIUS_M;
}

// Throws with a readable message when permission is denied, location services
// are off, or no fix arrives. Callers surface the message; nothing falls back
// to the library on its own.
export async function getCurrentCoord(): Promise<Coord> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== "granted") {
    throw new Error("Location permission was denied. Allow it for Night Route in Android settings.");
  }
  if (!(await Location.hasServicesEnabledAsync())) {
    throw new Error("Location is turned off on this phone. Turn it on and try again.");
  }
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { lat: pos.coords.latitude, lng: pos.coords.longitude };
}
